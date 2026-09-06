//! Local project status inspection.
//!
//! This module deliberately exposes a small, structured surface to the UI:
//! Git metadata plus the optional `test` and `build` scripts declared by a
//! project's `package.json`.  The UI never supplies an executable or a shell
//! command.  Commands are selected from a fixed package-manager allowlist and
//! passed as individual argv values.

use crate::events::redact_and_truncate;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: u8 = 1;
const DEFAULT_CHECK_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_TIMEOUT: Duration = Duration::from_secs(15);
const TERMINATION_GRACE: Duration = Duration::from_millis(500);
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_GIT_STATUS_BYTES: usize = 16 * 1024 * 1024;
const MAX_CHECK_OUTPUT_BYTES: usize = 64 * 1024;
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_millis(250);
const STATUS_SOURCE: &str = "local.project_status";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusRequest {
    pub project_path: String,
    /// The caller must choose an explicit, fixed check set. There is no
    /// implicit `all` default: an omitted field must not accidentally run a
    /// test or build command.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusSnapshot {
    pub schema_version: u8,
    pub source: String,
    pub project_path: String,
    pub collected_at: u64,
    pub confidence: String,
    pub git: GitStatus,
    pub checks: ProjectChecks,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// `available`, `notRepository`, or `error`.
    pub status: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    pub detached: bool,
    pub dirty: bool,
    pub uncommitted_files: u64,
    pub staged_files: u64,
    pub unstaged_files: u64,
    pub untracked_files: u64,
    pub counts_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChecks {
    pub test: CheckResult,
    pub build: CheckResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// `passed`, `failed`, `timedOut`, `notConfigured`, `notRequested`,
    /// `notFound`, or `error`.
    pub status: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub configured: bool,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestedKind {
    All,
    Git,
    Test,
    Build,
}

impl RequestedKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "all" => Ok(Self::All),
            "git" => Ok(Self::Git),
            "test" => Ok(Self::Test),
            "build" => Ok(Self::Build),
            other => Err(format!(
                "未知的项目检查类型 `{other}`；可用值为 all、git、test、build。"
            )),
        }
    }

    fn includes_git(self) -> bool {
        matches!(self, Self::All | Self::Git)
    }

    fn includes_test(self) -> bool {
        matches!(self, Self::All | Self::Test)
    }

    fn includes_build(self) -> bool {
        matches!(self, Self::All | Self::Build)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl PackageManager {
    fn executable(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
            Self::Yarn => "yarn",
            Self::Bun => "bun",
        }
    }

    fn display(self) -> &'static str {
        self.executable()
    }
}

#[derive(Debug, Default)]
struct ManifestScripts {
    // Keep only presence. Script bodies can contain credentials or other
    // sensitive command text; they are never needed to invoke the fixed
    // `run test` / `run build` allowlist.
    test: bool,
    build: bool,
}

#[derive(Debug, Default)]
struct GitCounts {
    branch: Option<String>,
    detached: bool,
    dirty: u64,
    staged: u64,
    unstaged: u64,
    untracked: u64,
    truncated: bool,
}

#[derive(Clone, Copy, Debug)]
enum BufferMode {
    Head,
    Tail,
}

#[derive(Debug)]
struct BoundedBuffer {
    bytes: Vec<u8>,
    limit: usize,
    mode: BufferMode,
}

impl BoundedBuffer {
    fn new(limit: usize, mode: BufferMode) -> Self {
        Self {
            bytes: Vec::with_capacity(limit.min(8 * 1024)),
            limit,
            mode,
        }
    }

    fn push(&mut self, data: &[u8]) {
        if self.limit == 0 || data.is_empty() {
            return;
        }
        match self.mode {
            BufferMode::Head => {
                let remaining = self.limit.saturating_sub(self.bytes.len());
                self.bytes
                    .extend_from_slice(&data[..data.len().min(remaining)]);
            }
            BufferMode::Tail => {
                self.bytes.extend_from_slice(data);
                if self.bytes.len() > self.limit {
                    let keep_from = self.bytes.len() - self.limit;
                    self.bytes.drain(..keep_from);
                }
            }
        }
    }

    fn snapshot(&self) -> Vec<u8> {
        self.bytes.clone()
    }
}

#[derive(Debug)]
struct CapturedProcess {
    status: Option<ExitStatus>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
    spawn_error: Option<String>,
    duration_ms: u64,
}

#[derive(Debug)]
struct ProcessOutput {
    stdout: Arc<Mutex<BoundedBuffer>>,
    stderr: Arc<Mutex<BoundedBuffer>>,
    stdout_done: Arc<AtomicBool>,
    stderr_done: Arc<AtomicBool>,
}

#[tauri::command]
pub async fn get_project_status(
    request: ProjectStatusRequest,
) -> Result<ProjectStatusSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || get_project_status_sync(request))
        .await
        .map_err(|error| format!("项目状态检查线程异常结束：{error}"))?
}

fn get_project_status_sync(request: ProjectStatusRequest) -> Result<ProjectStatusSnapshot, String> {
    let kind = RequestedKind::parse(&request.kind)?;
    let project = canonical_project(&request.project_path)?;

    let git = if kind.includes_git() {
        collect_git_status(&project)
    } else {
        GitStatus::not_requested()
    };

    let manifest = if kind.includes_test() || kind.includes_build() {
        read_manifest_scripts(&project)
    } else {
        Ok(None)
    };

    let (test, build) = match manifest {
        Ok(Some(scripts)) => {
            let manager = detect_package_manager(&project);
            let test = if kind.includes_test() {
                check_script(&project, manager, "test", scripts.test)
            } else {
                CheckResult::not_requested()
            };
            let build = if kind.includes_build() {
                check_script(&project, manager, "build", scripts.build)
            } else {
                CheckResult::not_requested()
            };
            (test, build)
        }
        Ok(None) => {
            let test = if kind.includes_test() {
                CheckResult::not_configured(
                    "项目没有 package.json scripts.test；未猜测或替换项目命令。",
                )
            } else {
                CheckResult::not_requested()
            };
            let build = if kind.includes_build() {
                CheckResult::not_configured(
                    "项目没有 package.json scripts.build；未猜测或替换项目命令。",
                )
            } else {
                CheckResult::not_requested()
            };
            (test, build)
        }
        Err(error) => {
            let test = if kind.includes_test() {
                CheckResult::error(error.clone())
            } else {
                CheckResult::not_requested()
            };
            let build = if kind.includes_build() {
                CheckResult::error(error)
            } else {
                CheckResult::not_requested()
            };
            (test, build)
        }
    };

    let collected_at = now_millis();
    let confidence = snapshot_confidence(&git, &test, &build);
    Ok(ProjectStatusSnapshot {
        schema_version: SCHEMA_VERSION,
        source: STATUS_SOURCE.to_string(),
        project_path: project.to_string_lossy().into_owned(),
        collected_at,
        confidence: confidence.to_string(),
        git,
        checks: ProjectChecks { test, build },
    })
}

impl GitStatus {
    fn not_requested() -> Self {
        Self {
            status: "notRequested".to_string(),
            source: STATUS_SOURCE.to_string(),
            updated_at: now_millis(),
            confidence: "none".to_string(),
            branch: None,
            head_sha: None,
            detached: false,
            dirty: false,
            uncommitted_files: 0,
            staged_files: 0,
            unstaged_files: 0,
            untracked_files: 0,
            counts_truncated: false,
            detail: Some("本次刷新未请求 Git 检查。".to_string()),
        }
    }

    fn error(detail: impl Into<String>) -> Self {
        Self {
            status: "error".to_string(),
            source: STATUS_SOURCE.to_string(),
            updated_at: now_millis(),
            confidence: "low".to_string(),
            branch: None,
            head_sha: None,
            detached: false,
            dirty: false,
            uncommitted_files: 0,
            staged_files: 0,
            unstaged_files: 0,
            untracked_files: 0,
            counts_truncated: false,
            detail: Some(redact_and_truncate(&detail.into())),
        }
    }
}

impl CheckResult {
    fn not_requested() -> Self {
        Self {
            status: "notRequested".to_string(),
            source: STATUS_SOURCE.to_string(),
            updated_at: now_millis(),
            confidence: "none".to_string(),
            configured: false,
            duration_ms: 0,
            exit_code: None,
            output_tail: None,
            detail: Some("本次刷新未请求此项检查。".to_string()),
        }
    }

    fn not_configured(detail: impl Into<String>) -> Self {
        Self {
            status: "notConfigured".to_string(),
            source: STATUS_SOURCE.to_string(),
            updated_at: now_millis(),
            confidence: "high".to_string(),
            configured: false,
            duration_ms: 0,
            exit_code: None,
            output_tail: None,
            detail: Some(detail.into()),
        }
    }

    fn error(detail: impl Into<String>) -> Self {
        Self {
            status: "error".to_string(),
            source: STATUS_SOURCE.to_string(),
            updated_at: now_millis(),
            confidence: "low".to_string(),
            configured: false,
            duration_ms: 0,
            exit_code: None,
            output_tail: None,
            detail: Some(redact_and_truncate(&detail.into())),
        }
    }
}

fn snapshot_confidence(git: &GitStatus, test: &CheckResult, build: &CheckResult) -> &'static str {
    if git.counts_truncated
        || matches!(git.status.as_str(), "error")
        || matches!(test.status.as_str(), "error" | "timedOut")
        || matches!(build.status.as_str(), "error" | "timedOut")
    {
        "medium"
    } else {
        "high"
    }
}

fn canonical_project(input: &str) -> Result<PathBuf, String> {
    if input.trim().is_empty() {
        return Err("项目目录不能为空。".to_string());
    }
    let path = fs::canonicalize(input.trim())
        .map_err(|error| format!("项目目录不存在或不可访问：{error}"))?;
    if !path.is_dir() {
        return Err("项目路径不是目录。".to_string());
    }
    Ok(path)
}

fn collect_git_status(project: &Path) -> GitStatus {
    let git = resolve_program("git");
    let preflight = run_program(
        &git,
        &[
            "-C".to_string(),
            project.to_string_lossy().into_owned(),
            "--no-optional-locks".to_string(),
            "rev-parse".to_string(),
            "--is-inside-work-tree".to_string(),
        ],
        project,
        GIT_TIMEOUT,
        MAX_CHECK_OUTPUT_BYTES,
        BufferMode::Head,
    );

    if let Some(error) = preflight.spawn_error {
        return GitStatus::error(format!("无法运行 git：{error}"));
    }
    if preflight.timed_out {
        return GitStatus::error("git 仓库检查超时；未读取完整状态。".to_string());
    }
    if !preflight
        .status
        .as_ref()
        .is_some_and(|status| status.success())
    {
        let stderr_detail = output_detail(&preflight.stderr);
        let not_repository = looks_like_not_repository(stderr_detail.as_deref())
            || preflight.status.as_ref().and_then(ExitStatus::code) == Some(128);
        let detail =
            stderr_detail.or_else(|| not_repository.then(|| "该目录不在 Git 仓库中。".to_string()));
        return GitStatus {
            status: if not_repository {
                "notRepository".to_string()
            } else {
                "error".to_string()
            },
            source: STATUS_SOURCE.to_string(),
            updated_at: now_millis(),
            confidence: if not_repository {
                "high".to_string()
            } else {
                "low".to_string()
            },
            branch: None,
            head_sha: None,
            detached: false,
            dirty: false,
            uncommitted_files: 0,
            staged_files: 0,
            unstaged_files: 0,
            untracked_files: 0,
            counts_truncated: false,
            detail,
        };
    }

    let status_output = run_program(
        &git,
        &[
            "-C".to_string(),
            project.to_string_lossy().into_owned(),
            "--no-optional-locks".to_string(),
            "status".to_string(),
            "--porcelain=v1".to_string(),
            "-z".to_string(),
            "--branch".to_string(),
            "--untracked-files=all".to_string(),
        ],
        project,
        GIT_TIMEOUT,
        MAX_GIT_STATUS_BYTES,
        BufferMode::Head,
    );

    if let Some(error) = status_output.spawn_error {
        return GitStatus::error(format!("无法读取 Git 状态：{error}"));
    }
    if status_output.timed_out {
        return GitStatus::error("读取 Git 状态超时；未返回部分计数。".to_string());
    }
    if !status_output
        .status
        .as_ref()
        .is_some_and(|status| status.success())
    {
        return GitStatus::error(
            output_detail(&status_output.stderr)
                .unwrap_or_else(|| "Git 状态命令失败。".to_string()),
        );
    }

    let counts = parse_git_status(
        &status_output.stdout,
        status_output.stdout.len() >= MAX_GIT_STATUS_BYTES,
    );
    let head_sha = git_head_sha(project);
    GitStatus {
        status: "available".to_string(),
        source: STATUS_SOURCE.to_string(),
        updated_at: now_millis(),
        confidence: if counts.truncated {
            "medium".to_string()
        } else {
            "high".to_string()
        },
        branch: counts.branch,
        head_sha,
        detached: counts.detached,
        dirty: counts.dirty > 0,
        uncommitted_files: counts.dirty,
        staged_files: counts.staged,
        unstaged_files: counts.unstaged,
        untracked_files: counts.untracked,
        counts_truncated: counts.truncated,
        detail: counts
            .truncated
            .then(|| "Git 状态输出超过安全上限，文件计数可能不完整。".to_string()),
    }
}

fn git_head_sha(project: &Path) -> Option<String> {
    let output = run_program(
        &resolve_program("git"),
        &[
            "-C".to_string(),
            project.to_string_lossy().into_owned(),
            "--no-optional-locks".to_string(),
            "rev-parse".to_string(),
            "--short".to_string(),
            "HEAD".to_string(),
        ],
        project,
        GIT_TIMEOUT,
        MAX_CHECK_OUTPUT_BYTES,
        BufferMode::Head,
    );
    if output.timed_out
        || output.spawn_error.is_some()
        || !output
            .status
            .as_ref()
            .is_some_and(|status| status.success())
    {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let sha = text.lines().next().unwrap_or_default().trim();
    (!sha.is_empty()).then(|| sha.to_string())
}

fn parse_git_status(bytes: &[u8], output_truncated: bool) -> GitCounts {
    let mut counts = GitCounts {
        truncated: output_truncated,
        ..GitCounts::default()
    };
    let mut records = bytes.split(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.starts_with(b"## ") {
            parse_branch_header(record, &mut counts);
            continue;
        }
        if record.len() < 3 || record[2] != b' ' {
            counts.truncated = true;
            continue;
        }
        let x = record[0];
        let y = record[1];
        if x == b'?' && y == b'?' {
            counts.untracked = counts.untracked.saturating_add(1);
        } else {
            if x != b' ' {
                counts.staged = counts.staged.saturating_add(1);
            }
            if y != b' ' {
                counts.unstaged = counts.unstaged.saturating_add(1);
            }
        }
        counts.dirty = counts.dirty.saturating_add(1);
        // `-z` emits the old path as a second NUL record for renames/copies.
        // It is one logical change, so consume that path without counting it.
        if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            let _ = records.next();
        }
    }
    counts
}

fn parse_branch_header(record: &[u8], counts: &mut GitCounts) {
    let text = String::from_utf8_lossy(record);
    let header = text.trim_start_matches("## ").trim();
    if header.starts_with("HEAD (no branch)") || header == "HEAD" {
        counts.detached = true;
        return;
    }
    if let Some(branch) = header.strip_prefix("No commits yet on ") {
        if !branch.trim().is_empty() {
            counts.branch = Some(branch.trim().to_string());
        }
        return;
    }
    let branch = header.split("...").next().unwrap_or(header).trim();
    if !branch.is_empty() {
        counts.branch = Some(branch.to_string());
    }
}

fn read_manifest_scripts(project: &Path) -> Result<Option<ManifestScripts>, String> {
    let path = project.join("package.json");
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取 package.json：{error}")),
    };
    if !metadata.is_file() {
        return Err("package.json 不是普通文件。".to_string());
    }
    if metadata.len() > MAX_MANIFEST_BYTES as u64 {
        return Err(format!(
            "package.json 超过 {} 字节安全上限。",
            MAX_MANIFEST_BYTES
        ));
    }
    let mut file = File::open(&path).map_err(|error| format!("无法打开 package.json：{error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 package.json：{error}"))?;
    // The file can grow between metadata() and read_to_end(); enforce the
    // bound again after reading so a concurrent writer cannot bypass it.
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(format!(
            "package.json 超过 {} 字节安全上限。",
            MAX_MANIFEST_BYTES
        ));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("package.json 不是有效 JSON：{error}"))?;
    let Some(scripts) = value.get("scripts").and_then(Value::as_object) else {
        return Ok(None);
    };
    Ok(Some(ManifestScripts {
        test: script_value(scripts.get("test"), "test")?,
        build: script_value(scripts.get("build"), "build")?,
    }))
}

fn script_value(value: Option<&Value>, name: &str) -> Result<bool, String> {
    let Some(value) = value else {
        return Ok(false);
    };
    let Some(script) = value.as_str() else {
        return Err(format!("package.json 的 scripts.{name} 必须是字符串。"));
    };
    if script.trim().is_empty() {
        return Err(format!("package.json 的 scripts.{name} 不能为空。"));
    }
    // The actual script body is intentionally never retained, sent to the
    // renderer, or interpolated into a shell command. It is only a presence
    // check; the package manager receives the fixed script name.
    Ok(true)
}

fn detect_package_manager(project: &Path) -> PackageManager {
    if project.join("bun.lockb").is_file() || project.join("bun.lock").is_file() {
        PackageManager::Bun
    } else if project.join("pnpm-lock.yaml").is_file() {
        PackageManager::Pnpm
    } else if project.join("yarn.lock").is_file() {
        PackageManager::Yarn
    } else {
        PackageManager::Npm
    }
}

fn check_script(
    project: &Path,
    manager: PackageManager,
    name: &str,
    configured: bool,
) -> CheckResult {
    if !configured {
        return CheckResult::not_configured(format!(
            "package.json 没有 scripts.{name}；未猜测或替换项目命令。"
        ));
    }
    let executable = resolve_program(manager.executable());
    let args = vec!["run".to_string(), name.to_string()];
    let captured = run_program(
        &executable,
        &args,
        project,
        DEFAULT_CHECK_TIMEOUT,
        MAX_CHECK_OUTPUT_BYTES,
        BufferMode::Tail,
    );
    let output_tail = combined_output(&captured.stdout, &captured.stderr);
    let duration_ms = captured.duration_ms;
    let configured_detail = configured_detail(manager, name);

    if let Some(error) = captured.spawn_error {
        let not_found = error.contains("找不到")
            || error.contains("No such file")
            || error.contains("not found")
            || error.contains("系统找不到");
        return CheckResult {
            status: if not_found {
                "notFound".to_string()
            } else {
                "error".to_string()
            },
            source: STATUS_SOURCE.to_string(),
            updated_at: now_millis(),
            confidence: if not_found {
                "high".to_string()
            } else {
                "low".to_string()
            },
            configured: true,
            duration_ms,
            exit_code: None,
            output_tail,
            detail: Some(redact_and_truncate(&format!(
                "{} 无法启动：{error}",
                configured_detail
            ))),
        };
    }
    if captured.timed_out {
        return CheckResult {
            status: "timedOut".to_string(),
            source: STATUS_SOURCE.to_string(),
            updated_at: now_millis(),
            confidence: "medium".to_string(),
            configured: true,
            duration_ms,
            exit_code: captured.status.as_ref().and_then(ExitStatus::code),
            output_tail,
            detail: Some(format!(
                "{} 超过 {} 秒，已终止进程树。",
                configured_detail,
                DEFAULT_CHECK_TIMEOUT.as_secs()
            )),
        };
    }

    let exit_code = captured.status.as_ref().and_then(ExitStatus::code);
    let passed = captured
        .status
        .as_ref()
        .is_some_and(|status| status.success());
    CheckResult {
        status: if passed {
            "passed".to_string()
        } else {
            "failed".to_string()
        },
        source: STATUS_SOURCE.to_string(),
        updated_at: now_millis(),
        confidence: "high".to_string(),
        configured: true,
        duration_ms,
        exit_code,
        output_tail,
        detail: Some(redact_and_truncate(&format!(
            "{}；退出码 {}。",
            configured_detail,
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "未知".to_string())
        ))),
    }
}

fn configured_detail(manager: PackageManager, name: &str) -> String {
    format!(
        "由 {} 执行 scripts.{name}；项目脚本可能读写文件、访问网络或产生其他副作用。",
        manager.display()
    )
}

fn run_program(
    program: &Path,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
    output_limit: usize,
    stdout_mode: BufferMode,
) -> CapturedProcess {
    let started = Instant::now();
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return CapturedProcess {
                status: None,
                stdout: Vec::new(),
                stderr: Vec::new(),
                timed_out: false,
                spawn_error: Some(error.to_string()),
                duration_ms: elapsed_ms(started),
            };
        }
    };

    let output = ProcessOutput {
        stdout: Arc::new(Mutex::new(BoundedBuffer::new(output_limit, stdout_mode))),
        stderr: Arc::new(Mutex::new(BoundedBuffer::new(
            output_limit,
            BufferMode::Tail,
        ))),
        // A missing pipe is already drained. These flags are replaced by the
        // reader's completion signal when a pipe is present.
        stdout_done: Arc::new(AtomicBool::new(true)),
        stderr_done: Arc::new(AtomicBool::new(true)),
    };
    if let Some(stdout) = child.stdout.take() {
        output.stdout_done.store(false, Ordering::Release);
        spawn_output_reader(stdout, output.stdout.clone(), output.stdout_done.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        output.stderr_done.store(false, Ordering::Release);
        spawn_output_reader(stderr, output.stderr.clone(), output.stderr_done.clone());
    }

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                terminate_process(&mut child, false);
                let grace_deadline = Instant::now() + TERMINATION_GRACE;
                let grace_status = loop {
                    match child.try_wait() {
                        Ok(Some(status)) => break Some(status),
                        Ok(None) if Instant::now() >= grace_deadline => {
                            terminate_process(&mut child, true);
                            break child.wait().ok();
                        }
                        Ok(None) => thread::sleep(Duration::from_millis(20)),
                        Err(_) => break child.wait().ok(),
                    }
                };
                break grace_status;
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(_) => {
                terminate_process(&mut child, true);
                break child.wait().ok();
            }
        }
    };

    // Give readers a bounded drain window so normal output is not lost just
    // because the child exited a few milliseconds before the pipe reader. The
    // threads remain detached after the deadline: a grandchild may hold a pipe
    // open forever, and joining it would make a refresh hang.
    wait_for_output_drain(&output.stdout_done, &output.stderr_done);
    let stdout = lock(&output.stdout).snapshot();
    let stderr = lock(&output.stderr).snapshot();
    CapturedProcess {
        status,
        stdout,
        stderr,
        timed_out,
        spawn_error: None,
        duration_ms: elapsed_ms(started),
    }
}

fn spawn_output_reader<R: Read + Send + 'static>(
    mut reader: R,
    target: Arc<Mutex<BoundedBuffer>>,
    done: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => lock(&target).push(&buffer[..size]),
            }
        }
        done.store(true, Ordering::Release);
    });
}

fn wait_for_output_drain(stdout_done: &AtomicBool, stderr_done: &AtomicBool) {
    let deadline = Instant::now() + OUTPUT_DRAIN_GRACE;
    while !(stdout_done.load(Ordering::Acquire) && stderr_done.load(Ordering::Acquire))
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(5));
    }
}

fn terminate_process(child: &mut Child, force: bool) {
    let pid = child.id();
    #[cfg(unix)]
    {
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        if let Ok(pid) = i32::try_from(pid) {
            // SAFETY: this process was started in its own process group above;
            // a negative PID addresses that group, not an arbitrary process.
            unsafe {
                let _ = libc::kill(-pid, signal);
            }
        }
    }
    #[cfg(windows)]
    if force {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    if force {
        let _ = child.kill();
    }
}

fn resolve_program(program: &str) -> PathBuf {
    let path = Path::new(program);
    if path.components().count() > 1 {
        return path.to_path_buf();
    }
    if let Some(path_var) = env::var_os("PATH") {
        if let Some(found) = env::split_paths(&path_var)
            .map(|directory| directory.join(program))
            .find(|candidate| candidate.is_file())
        {
            return found;
        }
    }
    #[cfg(target_os = "macos")]
    {
        for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            let candidate = Path::new(directory).join(program);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from(program)
}

fn output_detail(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes).trim().to_string();
    (!text.is_empty()).then(|| redact_and_truncate(&text))
}

fn combined_output(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let mut output = String::new();
    if !stdout.is_empty() {
        output.push_str("stdout: ");
        output.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !output.is_empty() {
            output.push_str(" | ");
        }
        output.push_str("stderr: ");
        output.push_str(&stderr);
    }
    (!output.is_empty()).then(|| redact_and_truncate(&output))
}

fn looks_like_not_repository(detail: Option<&str>) -> bool {
    detail
        .map(|detail| {
            let detail = detail.to_ascii_lowercase();
            detail.contains("not a git repository") || detail.contains("不是 git 仓库")
        })
        .unwrap_or(false)
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_git_status_counts_and_rename_records() {
        let bytes = b"## main...origin/main [ahead 1]\0 M src/a\0A  src/b\0?? new.txt\0R  new.txt\0old.txt\0";
        let counts = parse_git_status(bytes, false);
        assert_eq!(counts.branch.as_deref(), Some("main"));
        assert!(!counts.detached);
        assert_eq!(counts.dirty, 4);
        assert_eq!(counts.staged, 2);
        assert_eq!(counts.unstaged, 1);
        assert_eq!(counts.untracked, 1);
    }

    #[test]
    fn parses_detached_git_status_header() {
        let counts = parse_git_status(b"## HEAD (no branch)\0", false);
        assert!(counts.detached);
        assert!(counts.branch.is_none());
    }

    #[test]
    fn detects_package_manager_by_lockfile() {
        let root = unique_temp_dir("codex-status-manager");
        fs::create_dir_all(&root).expect("create temp dir");
        fs::write(root.join("pnpm-lock.yaml"), "lockfileVersion: 9").expect("write lock");
        assert_eq!(detect_package_manager(&root), PackageManager::Pnpm);
        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[test]
    fn reads_only_test_and_build_script_presence() {
        let root = unique_temp_dir("codex-status-manifest");
        fs::create_dir_all(&root).expect("create temp dir");
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"test":"vitest run","build":"vite build","dev":"vite"},"secret":"do-not-return"}"#,
        )
        .expect("write manifest");
        let scripts = read_manifest_scripts(&root)
            .expect("parse manifest")
            .expect("manifest scripts");
        assert!(scripts.test);
        assert!(scripts.build);
        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[test]
    fn missing_script_is_not_configured() {
        let result = CheckResult::not_configured("no script");
        assert_eq!(result.status, "notConfigured");
        assert!(!result.configured);
    }

    #[test]
    fn reports_a_directory_outside_git_without_fabricating_counts() {
        let root = unique_temp_dir("codex-status-non-git");
        fs::create_dir_all(&root).expect("create temp dir");
        let status = collect_git_status(&root);
        assert_eq!(status.status, "notRepository");
        assert_eq!(status.uncommitted_files, 0);
        assert!(!status.dirty);
        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[test]
    fn reads_real_git_staged_unstaged_and_untracked_counts() {
        let root = unique_temp_dir("codex-status-git-fixture;safe");
        fs::create_dir_all(&root).expect("create temp dir");
        let git = resolve_program("git");
        let root_text = root.to_string_lossy().into_owned();
        let init = Command::new(&git)
            .args(["-C", &root_text, "init", "-q"])
            .output()
            .expect("git init");
        assert!(init.status.success(), "git init failed: {:?}", init);
        fs::write(root.join("staged.txt"), "one").expect("write staged file");
        let add = Command::new(&git)
            .args(["-C", &root_text, "add", "staged.txt"])
            .output()
            .expect("git add");
        assert!(add.status.success(), "git add failed: {:?}", add);
        fs::write(root.join("staged.txt"), "two").expect("modify staged file");
        fs::write(root.join("untracked;file.txt"), "three").expect("write untracked file");

        let status = collect_git_status(&root);
        assert_eq!(status.status, "available");
        assert!(status.dirty);
        assert!(status.staged_files >= 1);
        assert!(status.unstaged_files >= 1);
        assert!(status.untracked_files >= 1);
        // The staged file modified after `git add` is one logical status
        // record with both staged and unstaged columns, plus one untracked
        // record.
        assert!(status.uncommitted_files >= 2);
        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[test]
    fn configured_check_explains_script_side_effects() {
        let detail = configured_detail(PackageManager::Npm, "test");
        assert!(detail.contains("scripts.test"));
        assert!(detail.contains("副作用"));
    }

    #[test]
    fn output_is_redacted_and_bounded() {
        let output = combined_output(
            b"Authorization: Bearer very-secret-token",
            b"api_key=secret sk-1234567890abcdef",
        )
        .expect("output");
        assert!(!output.contains("very-secret-token"));
        assert!(!output.contains("secret"));
        assert!(!output.contains("sk-"));
        // `redact_and_truncate` keeps at most 420 Unicode scalar values plus
        // one optional ellipsis.  Assert in characters rather than bytes so
        // this remains correct for non-ASCII output.
        assert!(output.chars().count() <= 421);
    }

    #[test]
    fn requested_kind_rejects_unknown_values() {
        let error = RequestedKind::parse("shell").expect_err("invalid kind");
        assert!(error.contains("all"));
    }

    #[test]
    fn requested_kind_must_be_explicit() {
        assert!(RequestedKind::parse("").is_err());
    }

    #[test]
    fn bounded_buffers_keep_the_declared_limit() {
        let mut head = BoundedBuffer::new(4, BufferMode::Head);
        head.push(b"abcdef");
        assert_eq!(head.snapshot(), b"abcd".to_vec());

        let mut tail = BoundedBuffer::new(4, BufferMode::Tail);
        tail.push(b"abcdef");
        assert_eq!(tail.snapshot(), b"cdef".to_vec());
    }

    #[cfg(unix)]
    #[test]
    fn drains_process_output_after_a_clean_exit() {
        let shell = resolve_program("sh");
        let captured = run_program(
            &shell,
            &[
                "-c".to_string(),
                "printf 'project-check-marker'".to_string(),
            ],
            &env::temp_dir(),
            Duration::from_secs(2),
            1024,
            BufferMode::Tail,
        );
        assert!(captured.status.as_ref().is_some_and(ExitStatus::success));
        assert!(!captured.timed_out);
        assert!(combined_output(&captured.stdout, &captured.stderr)
            .expect("captured output")
            .contains("project-check-marker"));
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        env::temp_dir().join(format!("{prefix}-{}-{nonce}", std::process::id()))
    }
}
