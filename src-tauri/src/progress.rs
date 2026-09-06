//! User-defined project milestones and explainable progress metrics.
//!
//! This module intentionally does not infer completion from Codex usage,
//! token counts, line counts, commits, or elapsed time. A user owns the
//! milestone list and its progress values; the backend only validates those
//! values, persists them outside the project directory, and performs a pure
//! weighted-average calculation.
//!
//! The first persistence implementation is a small, versioned JSON document
//! under Tauri's application-data directory. It is deliberately a reversible
//! MVP: it keeps no prompts, source text, command output, credentials, or
//! telemetry. SQLite remains the right next step when event history,
//! migrations, retention, and concurrent writers become requirements.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const SCHEMA_VERSION: u8 = 1;
const STORE_FILE_NAME: &str = "project-progress-v1.json";
const STATUS_SOURCE: &str = "local.project_progress";
const MAX_STORE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROJECT_RECORDS: usize = 200;
const MAX_MILESTONES: usize = 100;
const MAX_ID_CHARS: usize = 64;
const MAX_TITLE_CHARS: usize = 200;
const MAX_PROJECT_PATH_CHARS: usize = 4096;
const MAX_WEIGHT: u16 = 1_000;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// The only input needed to read the user-owned milestones for one project.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProgressRequest {
    pub project_path: String,
}

/// Replaces the complete milestone list for one project. Replacing the list
/// (rather than patching individual rows) keeps the first IPC surface small
/// and makes the persisted snapshot deterministic.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectProgressRequest {
    pub project_path: String,
    pub milestones: Vec<MilestoneInput>,
}

/// A milestone is user-authored. `progress_percent` is explicit input; the
/// backend never guesses it from events, commits, or file counts.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneInput {
    pub id: String,
    pub title: String,
    pub weight: u16,
    pub progress_percent: u8,
    pub status: MilestoneStatus,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MilestoneStatus {
    Planned,
    InProgress,
    Done,
    Blocked,
}

impl MilestoneStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::InProgress => "inProgress",
            Self::Done => "done",
            Self::Blocked => "blocked",
        }
    }

    fn accepts_progress(self, progress_percent: u8) -> bool {
        match self {
            Self::Planned => progress_percent == 0,
            Self::InProgress => (1..=99).contains(&progress_percent),
            Self::Done => progress_percent == 100,
            Self::Blocked => progress_percent < 100,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProgressSnapshot {
    pub schema_version: u8,
    pub source: String,
    pub project_path: String,
    pub updated_at: u64,
    pub confidence: String,
    pub milestones: Vec<MilestoneInput>,
    pub completion: CompletionMetric,
    pub health: HealthMetric,
}

/// A bounded index of all milestone snapshots saved by this application.
///
/// The index is intentionally separate from a project snapshot: callers that
/// render a desktop widget need to compare projects, while the normal project
/// screen should continue to load one explicitly selected path.  Paths are
/// local, user-selected paths; no project contents are read here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProgressListSnapshot {
    pub schema_version: u8,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub projects: Vec<ProjectProgressSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionMetric {
    /// `unknown` means there are no weighted user milestones. `derived` means
    /// only that the displayed integer was calculated from those milestones;
    /// it is never a claim that the project passed acceptance.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub evidence: Vec<ProgressEvidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthMetric {
    /// Health is a deliberately narrow, derived signal from user milestones.
    /// It is `unknown` with no milestones; otherwise the evidence below makes
    /// clear that Git/test/build/acceptance inputs are not included yet.
    pub status: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub signals: Vec<HealthSignal>,
    pub evidence: Vec<ProgressEvidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSignal {
    pub kind: String,
    pub value: u64,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub evidence: Vec<ProgressEvidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvidence {
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressStore {
    schema_version: u8,
    projects: Vec<StoredProjectProgress>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredProjectProgress {
    project_path: String,
    milestones: Vec<MilestoneInput>,
    updated_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CompletionCalculation {
    percent: Option<u8>,
    total_weight: u64,
    weighted_points: u64,
    done_count: u64,
    blocked_count: u64,
    unfinished_count: u64,
}

/// Read one project snapshot from local app data. The blocking file work is
/// moved off Tauri's async executor so a large-but-bounded JSON file cannot
/// freeze the UI thread.
#[tauri::command]
pub async fn get_project_progress(
    app: AppHandle,
    request: ProjectProgressRequest,
) -> Result<ProjectProgressSnapshot, String> {
    let project = canonical_project(&request.project_path)?;
    let store_path = progress_store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || get_project_progress_sync(&store_path, &project))
        .await
        .map_err(|error| format!("项目进度读取线程异常结束：{error}"))?
}

/// Read every user-authored milestone snapshot retained by the local store.
/// This does not scan the filesystem or infer progress from Git activity.
#[tauri::command]
pub async fn list_project_progress(app: AppHandle) -> Result<ProjectProgressListSnapshot, String> {
    let store_path = progress_store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let projects = read_project_progress_snapshots_from_path(&store_path)?;
        Ok(ProjectProgressListSnapshot {
            schema_version: SCHEMA_VERSION,
            source: STATUS_SOURCE.to_string(),
            updated_at: now_millis(),
            confidence: if projects.is_empty() {
                "unknown".to_string()
            } else {
                "medium".to_string()
            },
            projects,
        })
    })
    .await
    .map_err(|error| format!("项目进度列表读取线程异常结束：{error}"))?
}

/// Internal bounded reader shared by the widget aggregate and the public
/// listing command.  Kept `pub(crate)` so the widget cannot duplicate the
/// store format or accidentally bypass validation.
pub(crate) fn read_project_progress_snapshots_from_path(
    store_path: &Path,
) -> Result<Vec<ProjectProgressSnapshot>, String> {
    let _guard = store_guard()?;
    let store = load_store(store_path)?;
    Ok(store
        .projects
        .iter()
        .map(|record| {
            build_snapshot(
                Path::new(&record.project_path),
                record.milestones.clone(),
                record.updated_at,
            )
        })
        .collect())
}

/// Resolve the progress store path for another local adapter without exposing
/// the app-data layout as part of the frontend API.
pub(crate) fn progress_store_path_for_widget(app: &AppHandle) -> Result<PathBuf, String> {
    progress_store_path(app)
}

/// Validate and replace one project's user-authored milestones. No command,
/// prompt, source body, credential, or remote request is accepted here.
#[tauri::command]
pub async fn save_project_progress(
    app: AppHandle,
    request: SaveProjectProgressRequest,
) -> Result<ProjectProgressSnapshot, String> {
    let project = canonical_project(&request.project_path)?;
    let milestones = validate_milestones(request.milestones)?;
    let store_path = progress_store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        save_project_progress_sync(&store_path, &project, milestones)
    })
    .await
    .map_err(|error| format!("项目进度保存线程异常结束：{error}"))?
}

fn get_project_progress_sync(
    store_path: &Path,
    project: &Path,
) -> Result<ProjectProgressSnapshot, String> {
    let _guard = store_guard()?;
    let store = load_store(store_path)?;
    let project_key = project_key(project)?;
    let record = store
        .projects
        .iter()
        .find(|record| record.project_path == project_key);
    match record {
        Some(record) => Ok(build_snapshot(
            project,
            record.milestones.clone(),
            record.updated_at,
        )),
        None => Ok(build_snapshot(project, Vec::new(), now_millis())),
    }
}

fn save_project_progress_sync(
    store_path: &Path,
    project: &Path,
    milestones: Vec<MilestoneInput>,
) -> Result<ProjectProgressSnapshot, String> {
    let _guard = store_guard()?;
    let mut store = load_store(store_path)?;
    let project_key = project_key(project)?;
    let updated_at = now_millis();
    if let Some(record) = store
        .projects
        .iter_mut()
        .find(|record| record.project_path == project_key)
    {
        record.milestones = milestones.clone();
        record.updated_at = updated_at;
    } else {
        if store.projects.len() >= MAX_PROJECT_RECORDS {
            return Err(format!(
                "本地项目进度最多保存 {MAX_PROJECT_RECORDS} 个项目；请先清理旧数据。"
            ));
        }
        store.projects.push(StoredProjectProgress {
            project_path: project_key,
            milestones: milestones.clone(),
            updated_at,
        });
    }
    atomic_write_store(store_path, &store)?;
    Ok(build_snapshot(project, milestones, updated_at))
}

fn build_snapshot(
    project: &Path,
    milestones: Vec<MilestoneInput>,
    updated_at: u64,
) -> ProjectProgressSnapshot {
    let completion_calculation = calculate_completion(&milestones);
    let completion = completion_metric(completion_calculation, updated_at);
    let health = health_metric(completion_calculation, updated_at);
    let confidence = if milestones.is_empty() {
        "unknown"
    } else {
        // The arithmetic is deterministic, but health and acceptance evidence
        // are intentionally absent. `medium` avoids presenting the snapshot
        // as stronger than the user-provided milestone data warrants.
        "medium"
    };
    ProjectProgressSnapshot {
        schema_version: SCHEMA_VERSION,
        source: STATUS_SOURCE.to_string(),
        project_path: project.to_string_lossy().into_owned(),
        updated_at,
        confidence: confidence.to_string(),
        milestones,
        completion,
        health,
    }
}

/// Pure weighted calculation. It has no clock, filesystem, process, or UI
/// dependency, which keeps the formula replayable and straightforward to
/// test. A missing/zero total weight is represented as `None`, never 0%.
fn calculate_completion(milestones: &[MilestoneInput]) -> CompletionCalculation {
    let mut total_weight = 0_u64;
    let mut weighted_points = 0_u64;
    let mut done_count = 0_u64;
    let mut blocked_count = 0_u64;
    let mut unfinished_count = 0_u64;
    for milestone in milestones {
        let weight = u64::from(milestone.weight);
        let progress = u64::from(milestone.progress_percent);
        total_weight = total_weight.saturating_add(weight);
        weighted_points = weighted_points.saturating_add(weight.saturating_mul(progress));
        if milestone.status == MilestoneStatus::Done {
            done_count = done_count.saturating_add(1);
        }
        if milestone.status == MilestoneStatus::Blocked {
            blocked_count = blocked_count.saturating_add(1);
        }
        if milestone.progress_percent < 100 {
            unfinished_count = unfinished_count.saturating_add(1);
        }
    }
    let percent = (total_weight > 0).then(|| {
        // Round to the nearest whole percentage point. The UI should not
        // imply precision that the user-entered milestones do not provide.
        ((weighted_points + total_weight / 2) / total_weight).min(100) as u8
    });
    CompletionCalculation {
        percent,
        total_weight,
        weighted_points,
        done_count,
        blocked_count,
        unfinished_count,
    }
}

fn completion_metric(calculation: CompletionCalculation, updated_at: u64) -> CompletionMetric {
    let Some(percent) = calculation.percent else {
        return CompletionMetric {
            state: "unknown".to_string(),
            percent: None,
            source: STATUS_SOURCE.to_string(),
            updated_at,
            confidence: "unknown".to_string(),
            evidence: vec![ProgressEvidence {
                kind: "scope".to_string(),
                detail: "尚未定义带正权重的用户里程碑；不会把缺少数据当作 0%。".to_string(),
            }],
        };
    };
    CompletionMetric {
        state: "derived".to_string(),
        percent: Some(percent),
        source: STATUS_SOURCE.to_string(),
        updated_at,
        confidence: "high".to_string(),
        evidence: vec![
            ProgressEvidence {
                kind: "formula".to_string(),
                detail: format!(
                    "完成度 = Σ(weight × progressPercent) / Σ(weight)，当前 Σ(weight)={}，Σ(weight × progressPercent)={}，结果按整数百分比四舍五入。",
                    calculation.total_weight, calculation.weighted_points
                ),
            },
            ProgressEvidence {
                kind: "source_boundary".to_string(),
                detail: format!(
                    "仅使用用户定义的 {} 个里程碑（{} 个已标记 done）；不使用 token、代码行、提交数或对话轮数。即使结果为 100%，也不代表外部验收或发布完成。",
                    calculation.done_count + calculation.unfinished_count,
                    calculation.done_count
                ),
            },
        ],
    }
}

fn health_metric(calculation: CompletionCalculation, updated_at: u64) -> HealthMetric {
    let status = if calculation.total_weight == 0 {
        "unknown"
    } else if calculation.blocked_count > 0 {
        "blocked"
    } else if calculation.unfinished_count == 0 {
        "healthy"
    } else {
        "attention"
    };
    let mut signals = Vec::new();
    if calculation.blocked_count > 0 {
        signals.push(HealthSignal {
            kind: "blockedMilestones".to_string(),
            value: calculation.blocked_count,
            source: "user.milestones".to_string(),
            updated_at,
            confidence: "high".to_string(),
            evidence: vec![ProgressEvidence {
                kind: "count".to_string(),
                detail: "该信号只统计用户将状态标记为 blocked 的里程碑，不判断阻塞原因或严重程度。"
                    .to_string(),
            }],
        });
    }
    if calculation.unfinished_count > 0 {
        signals.push(HealthSignal {
            kind: "unfinishedMilestones".to_string(),
            value: calculation.unfinished_count,
            source: "user.milestones".to_string(),
            updated_at,
            confidence: "high".to_string(),
            evidence: vec![ProgressEvidence {
                kind: "count".to_string(),
                detail: "该信号只统计 progressPercent 小于 100 的用户里程碑，不等同于项目不健康。"
                    .to_string(),
            }],
        });
    }
    HealthMetric {
        status: status.to_string(),
        source: STATUS_SOURCE.to_string(),
        updated_at,
        confidence: if status == "unknown" {
            "unknown".to_string()
        } else {
            "medium".to_string()
        },
        signals,
        evidence: vec![ProgressEvidence {
            kind: if status == "unknown" {
                "missing_input".to_string()
            } else {
                "derived_rule".to_string()
            },
            detail: if status == "unknown" {
                "尚未定义用户里程碑；本模块不会把缺少数据当作健康或不健康。".to_string()
            } else {
                format!(
                    "健康状态 `{status}` 仅由用户里程碑的 status/progressPercent 推导；未使用 Git、测试、构建或验收输入，`healthy` 不等于外部验收或发布完成。"
                )
            },
        }],
    }
}

fn validate_milestones(milestones: Vec<MilestoneInput>) -> Result<Vec<MilestoneInput>, String> {
    if milestones.len() > MAX_MILESTONES {
        return Err(format!("里程碑数量不能超过 {MAX_MILESTONES} 个。"));
    }
    let mut ids = HashSet::with_capacity(milestones.len());
    let mut normalized = Vec::with_capacity(milestones.len());
    for (index, milestone) in milestones.into_iter().enumerate() {
        let id = milestone.id.trim();
        if id.is_empty() {
            return Err(format!("第 {} 个里程碑的 id 不能为空。", index + 1));
        }
        if id.chars().count() > MAX_ID_CHARS {
            return Err(format!(
                "里程碑 id 不能超过 {MAX_ID_CHARS} 个字符（第 {} 个）。",
                index + 1
            ));
        }
        if id.chars().any(|character| character.is_control()) {
            return Err(format!(
                "里程碑 id 不能包含控制字符（第 {} 个）。",
                index + 1
            ));
        }
        if !ids.insert(id.to_string()) {
            return Err(format!("里程碑 id `{id}` 重复。"));
        }

        let title = milestone.title.trim();
        if title.is_empty() {
            return Err(format!("第 {} 个里程碑的标题不能为空。", index + 1));
        }
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err(format!(
                "里程碑标题不能超过 {MAX_TITLE_CHARS} 个字符（第 {} 个）。",
                index + 1
            ));
        }
        if title.chars().any(|character| character.is_control()) {
            return Err(format!(
                "里程碑标题不能包含控制字符（第 {} 个）。",
                index + 1
            ));
        }
        if !(1..=MAX_WEIGHT).contains(&milestone.weight) {
            return Err(format!(
                "里程碑权重必须在 1 到 {MAX_WEIGHT} 之间（第 {} 个）。",
                index + 1
            ));
        }
        if !milestone
            .status
            .accepts_progress(milestone.progress_percent)
        {
            return Err(format!(
                "里程碑 `{id}` 的状态 `{}` 与 progressPercent={} 不一致。",
                milestone.status.as_str(),
                milestone.progress_percent
            ));
        }
        normalized.push(MilestoneInput {
            id: id.to_string(),
            title: title.to_string(),
            ..milestone
        });
    }
    Ok(normalized)
}

fn canonical_project(input: &str) -> Result<PathBuf, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("项目目录不能为空。".to_string());
    }
    if trimmed.chars().count() > MAX_PROJECT_PATH_CHARS {
        return Err(format!(
            "项目路径不能超过 {MAX_PROJECT_PATH_CHARS} 个字符。"
        ));
    }
    let path =
        fs::canonicalize(trimmed).map_err(|error| format!("项目目录不存在或不可访问：{error}"))?;
    if !path.is_dir() {
        return Err("项目路径不是目录。".to_string());
    }
    Ok(path)
}

fn project_key(project: &Path) -> Result<String, String> {
    let key = project.to_string_lossy().into_owned();
    if key.is_empty() || key.chars().count() > MAX_PROJECT_PATH_CHARS {
        return Err("规范化后的项目路径不可保存。".to_string());
    }
    Ok(key)
}

fn progress_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    Ok(app_data_dir.join(STORE_FILE_NAME))
}

fn store_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "项目进度存储锁已损坏。".to_string())
}

fn load_store(path: &Path) -> Result<ProgressStore, String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(empty_store());
        }
        Err(error) => return Err(format!("无法打开项目进度文件：{error}")),
    };
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取项目进度文件信息：{error}"))?;
    if metadata.len() > MAX_STORE_BYTES as u64 {
        return Err(format!(
            "项目进度文件超过 {} 字节安全上限。",
            MAX_STORE_BYTES
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取项目进度文件：{error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err(format!(
            "项目进度文件超过 {} 字节安全上限。",
            MAX_STORE_BYTES
        ));
    }
    let store: ProgressStore = serde_json::from_slice(&bytes)
        .map_err(|error| format!("项目进度文件不是有效 JSON：{error}"))?;
    validate_store(&store)?;
    Ok(store)
}

fn empty_store() -> ProgressStore {
    ProgressStore {
        schema_version: SCHEMA_VERSION,
        projects: Vec::new(),
    }
}

fn validate_store(store: &ProgressStore) -> Result<(), String> {
    if store.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "不支持的项目进度数据版本 {}（当前版本为 {}）。",
            store.schema_version, SCHEMA_VERSION
        ));
    }
    if store.projects.len() > MAX_PROJECT_RECORDS {
        return Err(format!(
            "项目进度文件包含超过 {MAX_PROJECT_RECORDS} 个项目。"
        ));
    }
    let mut paths = HashSet::with_capacity(store.projects.len());
    for record in &store.projects {
        if record.project_path.is_empty()
            || record.project_path.chars().count() > MAX_PROJECT_PATH_CHARS
            || !paths.insert(record.project_path.clone())
        {
            return Err("项目进度文件包含重复或无效的项目路径。".to_string());
        }
        validate_milestones(record.milestones.clone())?;
    }
    Ok(())
}

fn atomic_write_store(path: &Path, store: &ProgressStore) -> Result<(), String> {
    validate_store(store)?;
    let bytes =
        serde_json::to_vec_pretty(store).map_err(|error| format!("无法编码项目进度：{error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err(format!(
            "项目进度数据超过 {} 字节安全上限。",
            MAX_STORE_BYTES
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "项目进度文件路径缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建应用数据目录：{error}"))?;

    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "项目进度文件名无效。".to_string())?;
    let temp_path = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        counter
    ));
    let write_result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Milestone titles can reveal private project planning; keep the
            // local document owner-readable/writable when the platform allows
            // explicit mode bits. Windows relies on the app-data ACL.
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&bytes)?;
        file.sync_all()?;
        replace_file(&temp_path, path)?;
        #[cfg(unix)]
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("无法原子保存项目进度：{error}"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    // `rename` within one directory is atomic on the Unix-like platforms
    // supported by this app and never exposes a partially-written JSON file.
    fs::rename(from, to)
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    #[link(name = "kernel32")]
    extern "system" {
        #[allow(non_snake_case)]
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let existing: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let replacement: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both vectors are NUL-terminated UTF-16 buffers that remain alive
    // for the duration of the call; Windows only reads them.
    let result = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            replacement.as_ptr(),
            MOVEFILE_REPLACE_EXISTING,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn milestone(
        id: &str,
        title: &str,
        weight: u16,
        progress_percent: u8,
        status: MilestoneStatus,
    ) -> MilestoneInput {
        MilestoneInput {
            id: id.to_string(),
            title: title.to_string(),
            weight,
            progress_percent,
            status,
        }
    }

    #[test]
    fn weighted_completion_uses_only_user_milestones() {
        let milestones = vec![
            milestone("a", "基础", 1, 100, MilestoneStatus::Done),
            milestone("b", "验证", 3, 0, MilestoneStatus::Planned),
        ];
        let result = calculate_completion(&milestones);
        assert_eq!(result.total_weight, 4);
        assert_eq!(result.weighted_points, 100);
        assert_eq!(result.percent, Some(25));
    }

    #[test]
    fn empty_milestones_are_unknown_not_zero() {
        let result = calculate_completion(&[]);
        assert_eq!(result.percent, None);
        let metric = completion_metric(result, 123);
        assert_eq!(metric.state, "unknown");
        assert_eq!(metric.percent, None);
    }

    #[test]
    fn validation_normalizes_and_rejects_inconsistent_input() {
        let valid = validate_milestones(vec![milestone(
            "  m1 ",
            "  完成设计  ",
            2,
            50,
            MilestoneStatus::InProgress,
        )])
        .expect("valid milestone");
        assert_eq!(valid[0].id, "m1");
        assert_eq!(valid[0].title, "完成设计");

        let invalid = validate_milestones(vec![milestone(
            "m2",
            "已完成但百分比错误",
            1,
            99,
            MilestoneStatus::Done,
        )]);
        assert!(invalid.is_err());
    }

    #[test]
    fn validation_rejects_duplicate_ids_and_excessive_titles() {
        let duplicate = validate_milestones(vec![
            milestone("same", "一", 1, 0, MilestoneStatus::Planned),
            milestone("same", "二", 1, 0, MilestoneStatus::Planned),
        ]);
        assert!(duplicate.is_err());

        let long_title = "x".repeat(MAX_TITLE_CHARS + 1);
        let too_long = validate_milestones(vec![milestone(
            "long",
            &long_title,
            1,
            0,
            MilestoneStatus::Planned,
        )]);
        assert!(too_long.is_err());
    }

    #[test]
    fn health_derives_blocked_state_but_keeps_acceptance_boundary() {
        let milestones = vec![milestone(
            "blocked",
            "等待外部依赖",
            1,
            20,
            MilestoneStatus::Blocked,
        )];
        let health = health_metric(calculate_completion(&milestones), 456);
        assert_eq!(health.status, "blocked");
        assert_eq!(health.confidence, "medium");
        assert_eq!(health.signals[0].kind, "blockedMilestones");
        assert_eq!(health.signals[0].value, 1);
        assert!(health.evidence[0].detail.contains("不等于外部验收"));
    }

    #[test]
    fn health_is_healthy_only_for_all_done_user_milestones() {
        let milestones = vec![milestone("done", "交付", 1, 100, MilestoneStatus::Done)];
        let health = health_metric(calculate_completion(&milestones), 789);
        assert_eq!(health.status, "healthy");
        assert_eq!(health.confidence, "medium");
        assert!(health.evidence[0].detail.contains("不等于外部验收"));

        let empty = health_metric(calculate_completion(&[]), 790);
        assert_eq!(empty.status, "unknown");
        assert_eq!(empty.confidence, "unknown");
    }

    #[test]
    fn snapshot_serializes_the_frontend_camel_case_contract() {
        let milestones = vec![milestone("m1", "实现", 1, 50, MilestoneStatus::InProgress)];
        let snapshot = build_snapshot(Path::new("/tmp/example"), milestones, 123);
        let value = serde_json::to_value(snapshot).expect("serialize snapshot");
        assert_eq!(value["updatedAt"], 123);
        assert_eq!(value["milestones"][0]["progressPercent"], 50);
        assert_eq!(value["milestones"][0]["status"], "inProgress");
        assert_eq!(value["completion"]["state"], "derived");
        assert_eq!(value["health"]["status"], "attention");
        assert!(value["completion"]["evidence"].is_array());
    }

    #[test]
    fn store_round_trip_uses_version_and_atomic_file() {
        let root = unique_temp_dir("codex-progress");
        fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join(STORE_FILE_NAME);
        let store = ProgressStore {
            schema_version: SCHEMA_VERSION,
            projects: vec![StoredProjectProgress {
                project_path: "/tmp/example".to_string(),
                milestones: validate_milestones(vec![milestone(
                    "m",
                    "测试",
                    1,
                    100,
                    MilestoneStatus::Done,
                )])
                .expect("milestone"),
                updated_at: 42,
            }],
        };
        atomic_write_store(&path, &store).expect("write store");
        let loaded = load_store(&path).expect("load store");
        assert_eq!(loaded.schema_version, SCHEMA_VERSION);
        assert_eq!(loaded.projects.len(), 1);
        assert!(!path
            .with_file_name(format!(".{STORE_FILE_NAME}.tmp"))
            .exists());
        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[test]
    fn malformed_store_is_rejected_without_replacement() {
        let root = unique_temp_dir("codex-progress-invalid");
        fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join(STORE_FILE_NAME);
        fs::write(&path, b"not-json").expect("write invalid store");
        assert!(load_store(&path).is_err());
        assert_eq!(fs::read(&path).expect("read invalid store"), b"not-json");
        fs::remove_dir_all(root).expect("remove temp dir");
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{nonce}", std::process::id()))
    }
}
