//! Data contracts and bounded local aggregation for the desktop sticky widget.
//!
//! The widget is intentionally an observer of this application, not a scraper
//! of the ChatGPT desktop client.  Task records are created only when this
//! process starts `codex exec --json`; unknown account-wide values remain
//! unknown.  The small JSON stores are an MVP deviation from the project's
//! eventual SQLite architecture.  They are versioned, bounded, private, and
//! written atomically so that the change is reversible.

use crate::events::{TaskEvent, UsageSnapshot};
use crate::progress::{
    progress_store_path_for_widget, read_project_progress_snapshots_from_path,
    ProjectProgressSnapshot,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const SCHEMA_VERSION: u8 = 1;
const TASK_STORE_FILE: &str = "widget-task-history-v1.json";
const PREFERENCES_STORE_FILE: &str = "widget-preferences-v1.json";
const MAX_STORE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TASK_RECORDS: usize = 250;
const MAX_RECENT_CHANGES: usize = 12;
const MAX_VISIBLE_TASKS: usize = 12;
const MAX_METRICS: usize = 9;
const MAX_SUBSCRIPTION_CHARS: usize = 48;
const MAX_REFRESH_SECONDS: u16 = 60;
const MIN_REFRESH_SECONDS: u16 = 2;
const STAGNANT_AFTER_MS: u64 = 24 * 60 * 60 * 1_000;
const SOURCE_TASKS: &str = "local.codex_exec.jsonl";
const SOURCE_PROGRESS: &str = "local.project_progress";
/// Scope identifier for the selected project's own milestone completion.
/// Unlike the comparison cards below, this metric is keyed by the normalized
/// current project path and never means a cross-project winner.
const HIGHLIGHT_SCOPE_CURRENT_PROJECT: &str = "current_project";
/// Scope identifier for the two comparison cards in the widget.  They are
/// intentionally global comparisons over every project whose milestones this
/// app has saved, rather than claims about the currently selected project.
const HIGHLIGHT_SCOPE_ALL_PROJECTS: &str = "all_saved_projects";

static REGISTRY: OnceLock<Mutex<TaskRegistry>> = OnceLock::new();
static STORE_COUNTER: OnceLock<Mutex<u64>> = OnceLock::new();

#[derive(Default)]
struct TaskRegistry {
    loaded: bool,
    records: Vec<TaskRecord>,
    load_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskRecord {
    task_id: String,
    project_path: String,
    state: String,
    started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    warning_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<UsageSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_event_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_event_label: Option<String>,
    updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskStore {
    schema_version: u8,
    tasks: Vec<TaskRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetPreferences {
    pub schema_version: u8,
    pub visible_metrics: Vec<String>,
    /// Existing preference files predate placement selection and remain
    /// attached to the notch unless the user explicitly chooses floating.
    #[serde(default = "default_placement_mode")]
    pub placement_mode: String,
    /// Compact and medium are persistent sibling surfaces. Older v1 stores
    /// predate this choice and safely retain the compact default.
    #[serde(default = "default_resting_mode")]
    pub resting_mode: String,
    /// Compact chips were added after the first preference format.  Serde
    /// defaults keep existing v1 files readable; validation below still
    /// rejects unknown values before they are written back.
    #[serde(default = "default_compact_left_metric")]
    pub compact_left_metric: String,
    #[serde(default = "default_compact_right_metric")]
    pub compact_right_metric: String,
    /// The detached summary has three fixed slots. Older preference files
    /// receive the previous project/day/progress arrangement via Serde.
    #[serde(default = "default_floating_medium_metrics")]
    pub floating_medium_metrics: Vec<String>,
    pub pinned: bool,
    pub refresh_seconds: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_label: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWidgetPreferencesRequest {
    pub preferences: WidgetPreferences,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetPreferencesSnapshot {
    pub schema_version: u8,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub persistence: String,
    pub preferences: WidgetPreferences,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSnapshotRequest {
    #[serde(default)]
    pub project_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSnapshot {
    pub schema_version: u8,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub scope: String,
    pub current_project_path: Option<String>,
    pub current_project_progress: ProjectHighlightMetric,
    pub current_project_usage: TokenMetric,
    pub today_usage: TokenMetric,
    pub running_tasks: TaskListMetric,
    pub failed_tasks: TaskListMetric,
    pub pending_approvals: CountMetric,
    pub highest_completion: ProjectHighlightMetric,
    pub stagnant_project: ProjectHighlightMetric,
    pub recent_changes: RecentChangesMetric,
    pub subscription: SubscriptionMetric,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenMetric {
    pub state: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub period: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListMetric {
    pub state: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub scope: String,
    pub tasks: Vec<TaskSummary>,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub task_id: String,
    pub project_path: String,
    pub state: String,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountMetric {
    pub state: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHighlightMetric {
    pub state: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    /// Stable machine-readable scope for the comparison.  Keeping this next
    /// to the selected project path prevents a global winner from being read
    /// as the currently selected project's own completion.
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub age_hours: Option<u64>,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentChangesMetric {
    pub state: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub changes: Vec<RecentChange>,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentChange {
    pub at: u64,
    pub kind: String,
    pub project_path: String,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionMetric {
    pub state: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub evidence: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default)]
struct TokenTotals {
    input: u64,
    input_samples: u64,
    cached_input: u64,
    cached_input_samples: u64,
    cache_write: u64,
    cache_write_samples: u64,
    output: u64,
    output_samples: u64,
    reasoning_output: u64,
    reasoning_output_samples: u64,
    samples: u64,
}

impl TokenTotals {
    fn add_usage(&mut self, usage: Option<&UsageSnapshot>) {
        let Some(usage) = usage else { return };
        if let Some(value) = usage.input_tokens {
            self.input = self.input.saturating_add(value);
            self.input_samples = self.input_samples.saturating_add(1);
        }
        if let Some(value) = usage.cached_input_tokens {
            self.cached_input = self.cached_input.saturating_add(value);
            self.cached_input_samples = self.cached_input_samples.saturating_add(1);
        }
        if let Some(value) = usage.cache_write_input_tokens {
            self.cache_write = self.cache_write.saturating_add(value);
            self.cache_write_samples = self.cache_write_samples.saturating_add(1);
        }
        if let Some(value) = usage.output_tokens {
            self.output = self.output.saturating_add(value);
            self.output_samples = self.output_samples.saturating_add(1);
        }
        if let Some(value) = usage.reasoning_output_tokens {
            self.reasoning_output = self.reasoning_output.saturating_add(value);
            self.reasoning_output_samples = self.reasoning_output_samples.saturating_add(1);
        }
        self.samples = self.samples.saturating_add(1);
    }

    fn metric(self, now: u64, period: String, evidence: Vec<String>) -> TokenMetric {
        if self.samples == 0 {
            return TokenMetric {
                state: "unknown".to_string(),
                source: SOURCE_TASKS.to_string(),
                updated_at: now,
                confidence: "none".to_string(),
                period,
                input_tokens: None,
                cached_input_tokens: None,
                cache_write_input_tokens: None,
                output_tokens: None,
                reasoning_output_tokens: None,
                total_tokens: None,
                evidence,
            };
        }
        // Codex reports cached/cache-write fields as components of input in
        // the same usage snapshot.  They are shown separately but are not
        // added again to totalTokens.
        let complete_input = self.input_samples == self.samples;
        let complete_output = self.output_samples == self.samples;
        TokenMetric {
            state: "known".to_string(),
            source: SOURCE_TASKS.to_string(),
            updated_at: now,
            confidence: "medium".to_string(),
            period,
            input_tokens: complete_input.then_some(self.input),
            cached_input_tokens: (self.cached_input_samples == self.samples)
                .then_some(self.cached_input),
            cache_write_input_tokens: (self.cache_write_samples == self.samples)
                .then_some(self.cache_write),
            output_tokens: complete_output.then_some(self.output),
            reasoning_output_tokens: (self.reasoning_output_samples == self.samples)
                .then_some(self.reasoning_output),
            total_tokens: (complete_input && complete_output)
                .then_some(self.input.saturating_add(self.output)),
            evidence,
        }
    }
}

#[tauri::command]
pub async fn get_widget_preferences(app: AppHandle) -> Result<WidgetPreferencesSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || get_preferences_sync(&app))
        .await
        .map_err(|error| format!("项目概览偏好读取线程异常结束：{error}"))?
}

#[tauri::command]
pub async fn save_widget_preferences(
    app: AppHandle,
    request: SaveWidgetPreferencesRequest,
) -> Result<WidgetPreferencesSnapshot, String> {
    let preferences = validate_preferences(request.preferences)?;
    tauri::async_runtime::spawn_blocking(move || save_preferences_sync(&app, preferences))
        .await
        .map_err(|error| format!("项目概览偏好保存线程异常结束：{error}"))?
}

#[tauri::command]
pub async fn get_widget_snapshot(
    app: AppHandle,
    request: WidgetSnapshotRequest,
) -> Result<WidgetSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || build_widget_snapshot(&app, request.project_path))
        .await
        .map_err(|error| format!("项目概览数据读取线程异常结束：{error}"))?
}

/// Called by the Codex adapter at task start.  Persistence failures are
/// intentionally non-fatal to the actual task; the live event stream remains
/// the primary source while the history store is best effort.
pub(crate) fn record_task_started(app: &AppHandle, task_id: &str, project_path: &Path) {
    let now = now_millis();
    let mut registry = registry_lock();
    ensure_registry_loaded(&mut registry, app);
    registry.records.retain(|record| record.task_id != task_id);
    registry.records.push(TaskRecord {
        task_id: task_id.to_string(),
        project_path: project_path.to_string_lossy().into_owned(),
        state: "running".to_string(),
        started_at: now,
        ended_at: None,
        exit_code: None,
        warning_count: 0,
        usage: None,
        last_event_kind: Some("process.spawned".to_string()),
        last_event_label: Some("Codex 子进程已启动".to_string()),
        updated_at: now,
    });
    trim_records(&mut registry.records);
    // A metadata write failure must not abort Codex, but the widget must stop
    // claiming that its bounded history is complete.
    if let Err(error) = persist_registry(app, &registry.records) {
        registry.load_error = Some(error);
    }
}

/// Called for every normalized event.  Only bounded labels/types and the
/// structured usage counters are retained; prompt, source text and command
/// output are never written to the history file.
pub(crate) fn record_task_event(app: &AppHandle, event: &TaskEvent) {
    let mut registry = registry_lock();
    ensure_registry_loaded(&mut registry, app);
    let Some(record) = registry
        .records
        .iter_mut()
        .find(|record| record.task_id == event.task_id)
    else {
        return;
    };
    record.updated_at = event.received_at;
    record.last_event_kind = Some(truncate(&event.kind, 80));
    record.last_event_label = Some(truncate(&event.label, 160));
    if let Some(usage) = &event.usage {
        record.usage = Some(usage.clone());
    }
    if let Some(code) = event.exit_code {
        record.exit_code = Some(code);
    }
    if let Some(warnings) = event.warning_count {
        record.warning_count = warnings;
    } else if event.severity == "warning" {
        record.warning_count = record.warning_count.saturating_add(1);
    }
    let mut should_persist = false;
    if let Some(state) = &event.task_state {
        record.state = state.clone();
        if matches!(state.as_str(), "completed" | "failed" | "cancelled") {
            record.ended_at = Some(event.received_at);
            should_persist = true;
        }
    }
    if should_persist {
        if let Err(error) = persist_registry(app, &registry.records) {
            registry.load_error = Some(error);
        }
    }
}

fn build_widget_snapshot(
    app: &AppHandle,
    requested_project_path: Option<String>,
) -> Result<WidgetSnapshot, String> {
    let now = now_millis();
    let mut registry = registry_lock();
    ensure_registry_loaded(&mut registry, app);
    let records = registry.records.clone();
    let registry_error = registry.load_error.clone();
    drop(registry);

    let current_project_path = requested_project_path
        .and_then(|path| normalize_optional_path(&path))
        .or_else(|| {
            records
                .iter()
                .rev()
                .find(|record| record.state == "running")
                .map(|record| record.project_path.clone())
        });

    let current_usage = totals_for_project(&records, current_project_path.as_deref());
    let today_key = local_day_key(now);
    let today_usage = records
        .iter()
        .filter(|record| {
            record
                .ended_at
                .is_some_and(|ended| local_day_key(ended) == today_key)
        })
        .fold(TokenTotals::default(), |mut total, record| {
            total.add_usage(record.usage.as_ref());
            total
        });

    let running = records
        .iter()
        .filter(|record| belongs_to_project(record, current_project_path.as_deref()))
        .filter(|record| record.state == "running" || record.state == "starting")
        .rev()
        .take(MAX_VISIBLE_TASKS)
        .map(task_summary)
        .collect::<Vec<_>>();
    let failed = records
        .iter()
        .filter(|record| belongs_to_project(record, current_project_path.as_deref()))
        .filter(|record| record.state == "failed")
        .rev()
        .take(MAX_VISIBLE_TASKS)
        .map(task_summary)
        .collect::<Vec<_>>();

    let progress_result = progress_store_path_for_widget(app)
        .and_then(|path| read_project_progress_snapshots_from_path(&path));
    let (
        highest,
        stagnant,
        current_project_progress,
        has_progress,
        progress_changes,
        progress_error,
    ) = match progress_result {
        Ok(progress) => {
            let highest = highest_completion(&progress, now);
            let stagnant = stagnant_project(&progress, now);
            let current_project_progress =
                current_project_progress_metric(&progress, current_project_path.as_deref(), now);
            let has_progress = !progress.is_empty();
            (
                highest,
                stagnant,
                current_project_progress,
                has_progress,
                progress,
                None,
            )
        }
        Err(error) => {
            let detail = truncate(&format!("项目里程碑适配器暂不可用：{error}"), 240);
            (
                unknown_highlight(now, &detail),
                unknown_highlight(now, &detail),
                unknown_current_project_progress(now, &detail),
                false,
                Vec::new(),
                Some(detail),
            )
        }
    };
    let changes = recent_changes(
        &records,
        &progress_changes,
        current_project_path.as_deref(),
        registry_error.as_deref(),
        progress_error.as_deref(),
    );

    let subscription_label = load_preferences(app)
        .ok()
        .and_then(|preferences| preferences.subscription_label);
    let subscription = if let Some(label) = subscription_label {
        SubscriptionMetric {
            state: "manual".to_string(),
            source: "user.widget_preference".to_string(),
            updated_at: now,
            confidence: "low".to_string(),
            label: Some(label),
            evidence: vec!["由用户手动填写；未通过账号接口核验。".to_string()],
        }
    } else {
        SubscriptionMetric {
            state: "unknown".to_string(),
            source: "not_connected".to_string(),
            updated_at: now,
            confidence: "none".to_string(),
            label: None,
            evidence: vec![
                "当前版本不读取 auth.json、Cookie 或官方桌面 UI；请在设置中手动填写套餐。"
                    .to_string(),
            ],
        }
    };

    Ok(WidgetSnapshot {
        schema_version: SCHEMA_VERSION,
        source: "local.widget.aggregate".to_string(),
        updated_at: now,
        confidence: if records.is_empty() && !has_progress {
            "none".to_string()
        } else {
            "medium".to_string()
        },
        scope: if current_project_path.is_some() {
            "当前项目的本工具任务；今日 Token 仍是本机全部项目汇总。"
        } else {
            "仅本工具启动的 codex exec 任务；项目指标来自用户保存的里程碑。"
        }
        .to_string(),
        current_project_path,
        current_project_progress,
        current_project_usage: mark_token_partial(
            current_usage.metric(
                now,
                "当前项目的本地任务历史".to_string(),
                vec!["仅统计本工具已收到 usage 的任务；未收到 usage 不计为 0。".to_string()],
            ),
            registry_error.as_deref(),
        ),
        today_usage: mark_token_partial(
            today_usage.metric(
                now,
                "今天（本机时区）".to_string(),
                vec![
                    "只统计本工具已结束任务的 Codex JSONL usage；不代表账号账单或订阅额度。"
                        .to_string(),
                ],
            ),
            registry_error.as_deref(),
        ),
        running_tasks: task_list_metric(
            running,
            now,
            "当前本工具进程".to_string(),
            "运行中列表只包括本观察台启动且仍在本地记录中的任务。".to_string(),
            registry_error.as_deref(),
        ),
        failed_tasks: task_list_metric(
            failed,
            now,
            "本工具有限任务历史".to_string(),
            "失败列表最多保留本地历史中的最近任务；不会扫描其他 Codex 客户端。".to_string(),
            registry_error.as_deref(),
        ),
        pending_approvals: CountMetric {
            state: "unknown".to_string(),
            source: "not_connected".to_string(),
            updated_at: now,
            confidence: "none".to_string(),
            count: None,
            evidence: vec![
                "当前任务使用 exec 只读链路，尚未接入 App Server 审批事件；未知不等于 0。"
                    .to_string(),
            ],
        },
        highest_completion: highest,
        stagnant_project: stagnant,
        recent_changes: changes,
        subscription,
    })
}

fn mark_token_partial(mut metric: TokenMetric, adapter_error: Option<&str>) -> TokenMetric {
    if let Some(error) = adapter_error {
        if metric.state == "known" {
            metric.state = "partial".to_string();
            metric.confidence = "low".to_string();
        }
        metric.evidence.push(format!(
            "本地任务历史读取或写入不完整：{}",
            truncate(error, 180)
        ));
    }
    metric
}

fn totals_for_project(records: &[TaskRecord], project: Option<&str>) -> TokenTotals {
    let Some(project) = project else {
        return TokenTotals::default();
    };
    records
        .iter()
        .filter(|record| record.project_path == project)
        .fold(TokenTotals::default(), |mut total, record| {
            total.add_usage(record.usage.as_ref());
            total
        })
}

fn belongs_to_project(record: &TaskRecord, project: Option<&str>) -> bool {
    project.is_none_or(|path| record.project_path == path)
}

fn task_list_metric(
    tasks: Vec<TaskSummary>,
    now: u64,
    scope: String,
    evidence: String,
    adapter_error: Option<&str>,
) -> TaskListMetric {
    let mut evidence_items = vec![evidence];
    if let Some(error) = adapter_error {
        evidence_items.push(format!("历史读取不完整：{}", truncate(error, 180)));
    }
    TaskListMetric {
        state: if adapter_error.is_some() {
            "partial".to_string()
        } else {
            "known".to_string()
        },
        source: SOURCE_TASKS.to_string(),
        updated_at: now,
        confidence: if adapter_error.is_some() {
            "low".to_string()
        } else {
            "medium".to_string()
        },
        scope,
        tasks,
        evidence: evidence_items,
    }
}

fn task_summary(record: &TaskRecord) -> TaskSummary {
    TaskSummary {
        task_id: record.task_id.clone(),
        project_path: record.project_path.clone(),
        state: record.state.clone(),
        started_at: record.started_at,
        ended_at: record.ended_at,
        exit_code: record.exit_code,
        last_event: record.last_event_label.clone(),
        usage: record.usage.as_ref().map(usage_summary),
    }
}

fn usage_summary(usage: &UsageSnapshot) -> UsageSummary {
    UsageSummary {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: match (usage.input_tokens, usage.output_tokens) {
            (Some(input), Some(output)) => Some(input.saturating_add(output)),
            _ => None,
        },
    }
}

/// Resolve the selected project's own completion metric.
///
/// The selected path is normalized before it is compared with the paths in
/// the progress index.  Progress snapshots are written with the same
/// canonical-path rule by `progress`, so an exact string match keeps a
/// project switch from leaking another project's completion into this card.
/// This deliberately does not call `highest_completion`: that function has a
/// different, all-saved-projects scope.
fn current_project_progress_metric(
    projects: &[ProjectProgressSnapshot],
    current_project_path: Option<&str>,
    now: u64,
) -> ProjectHighlightMetric {
    let Some(normalized_path) = current_project_path.and_then(normalize_optional_path) else {
        return unknown_current_project_progress(
            now,
            "没有选中的当前项目路径，无法匹配已保存的里程碑记录；未知不等于 0%。",
        );
    };
    let Some(project) = projects
        .iter()
        .find(|project| project.project_path == normalized_path)
    else {
        return unknown_current_project_progress(
            now,
            &format!(
                "当前项目路径规范化为 `{}` 后，没有精确匹配的已保存项目进度记录；未知不等于 0%。",
                truncate(&normalized_path, 240)
            ),
        );
    };

    let mut evidence = vec![
        format!(
            "当前项目路径已规范化并与已保存记录精确匹配：`{}`。",
            project.project_path
        ),
        "当前项目进度只使用该匹配记录；没有把全项目最高完成度当作当前项目进度。".to_string(),
    ];
    evidence.extend(
        project
            .completion
            .evidence
            .iter()
            .map(|item| format!("{}：{}", item.kind, item.detail)),
    );
    if project.completion.percent.is_none() {
        evidence.push("该匹配记录没有可计算的里程碑完成度；未知不等于 0%。".to_string());
    }

    ProjectHighlightMetric {
        state: project.completion.state.clone(),
        source: SOURCE_PROGRESS.to_string(),
        updated_at: now,
        confidence: project.completion.confidence.clone(),
        scope: HIGHLIGHT_SCOPE_CURRENT_PROJECT.to_string(),
        project_path: Some(project.project_path.clone()),
        percent: project.completion.percent,
        last_updated_at: Some(project.updated_at),
        age_hours: Some(now.saturating_sub(project.updated_at) / 3_600_000),
        evidence,
    }
}

fn highest_completion(projects: &[ProjectProgressSnapshot], now: u64) -> ProjectHighlightMetric {
    let candidate = projects
        .iter()
        .filter_map(|project| project.completion.percent.map(|percent| (percent, project)))
        .max_by_key(|(percent, project)| (*percent, project.updated_at));
    match candidate {
        Some((percent, project)) => ProjectHighlightMetric {
            state: "derived".to_string(),
            source: SOURCE_PROGRESS.to_string(),
            updated_at: now,
            confidence: project.confidence.clone(),
            scope: HIGHLIGHT_SCOPE_ALL_PROJECTS.to_string(),
            project_path: Some(project.project_path.clone()),
            percent: Some(percent),
            last_updated_at: Some(project.updated_at),
            age_hours: Some(now.saturating_sub(project.updated_at) / 3_600_000),
            evidence: vec!["按用户保存的里程碑加权完成度排序；不等于验收或发布完成。".to_string()],
        },
        None => unknown_highlight(now, "没有带有效里程碑完成度的已保存项目。"),
    }
}

fn stagnant_project(projects: &[ProjectProgressSnapshot], now: u64) -> ProjectHighlightMetric {
    let candidate = projects
        .iter()
        .filter(|project| !project.milestones.is_empty())
        .filter(|project| now.saturating_sub(project.updated_at) >= STAGNANT_AFTER_MS)
        .min_by_key(|project| project.updated_at);
    match candidate {
        Some(project) => ProjectHighlightMetric {
            state: "derived".to_string(),
            source: SOURCE_PROGRESS.to_string(),
            updated_at: now,
            confidence: "low".to_string(),
            scope: HIGHLIGHT_SCOPE_ALL_PROJECTS.to_string(),
            project_path: Some(project.project_path.clone()),
            percent: project.completion.percent,
            last_updated_at: Some(project.updated_at),
            age_hours: Some(now.saturating_sub(project.updated_at) / 3_600_000),
            evidence: vec![
                "这里只表示里程碑记录超过 24 小时未更新，不证明代码或任务真的没有进展。"
                    .to_string(),
            ],
        },
        None => unknown_highlight(
            now,
            "没有足够证据判断项目长期停滞；阈值是里程碑记录超过 24 小时未更新。",
        ),
    }
}

fn unknown_highlight(now: u64, detail: &str) -> ProjectHighlightMetric {
    ProjectHighlightMetric {
        state: "unknown".to_string(),
        source: SOURCE_PROGRESS.to_string(),
        updated_at: now,
        confidence: "none".to_string(),
        scope: HIGHLIGHT_SCOPE_ALL_PROJECTS.to_string(),
        project_path: None,
        percent: None,
        last_updated_at: None,
        age_hours: None,
        evidence: vec![detail.to_string()],
    }
}

fn unknown_current_project_progress(now: u64, detail: &str) -> ProjectHighlightMetric {
    ProjectHighlightMetric {
        state: "unknown".to_string(),
        source: SOURCE_PROGRESS.to_string(),
        updated_at: now,
        confidence: "none".to_string(),
        scope: HIGHLIGHT_SCOPE_CURRENT_PROJECT.to_string(),
        project_path: None,
        percent: None,
        last_updated_at: None,
        age_hours: None,
        evidence: vec![detail.to_string()],
    }
}

fn recent_changes(
    records: &[TaskRecord],
    progress: &[ProjectProgressSnapshot],
    project: Option<&str>,
    task_adapter_error: Option<&str>,
    progress_adapter_error: Option<&str>,
) -> RecentChangesMetric {
    let mut changes = records
        .iter()
        .filter(|record| belongs_to_project(record, project))
        .map(|record| RecentChange {
            at: record.updated_at,
            kind: record
                .last_event_kind
                .clone()
                .unwrap_or_else(|| "task".to_string()),
            project_path: record.project_path.clone(),
            detail: record
                .last_event_label
                .clone()
                .unwrap_or_else(|| "本地任务状态更新".to_string()),
        })
        .chain(
            progress
                .iter()
                .filter(|item| project.is_none_or(|path| item.project_path == path))
                .map(|project| RecentChange {
                    at: project.updated_at,
                    kind: "milestones.saved".to_string(),
                    project_path: project.project_path.clone(),
                    detail: project
                        .completion
                        .percent
                        .map(|percent| format!("里程碑进度已保存：{percent}%"))
                        .unwrap_or_else(|| "里程碑记录已保存".to_string()),
                }),
        )
        .collect::<Vec<_>>();
    changes.sort_by_key(|change| std::cmp::Reverse(change.at));
    changes.truncate(MAX_RECENT_CHANGES);
    let has_adapter_error = task_adapter_error.is_some() || progress_adapter_error.is_some();
    let mut evidence = vec![
        "最近变化只来自本工具任务生命周期和用户保存的里程碑；未扫描项目文件或其他 Codex 客户端。"
            .to_string(),
    ];
    if let Some(error) = task_adapter_error {
        evidence.push(format!("任务历史不完整：{}", truncate(error, 180)));
    }
    if let Some(error) = progress_adapter_error {
        evidence.push(format!("里程碑历史不完整：{}", truncate(error, 180)));
    }
    RecentChangesMetric {
        state: if has_adapter_error {
            "partial"
        } else {
            "known"
        }
        .to_string(),
        source: "local.widget.aggregate".to_string(),
        updated_at: now_millis(),
        confidence: if has_adapter_error { "low" } else { "medium" }.to_string(),
        changes,
        evidence,
    }
}

fn registry_lock() -> std::sync::MutexGuard<'static, TaskRegistry> {
    REGISTRY
        .get_or_init(|| Mutex::new(TaskRegistry::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn ensure_registry_loaded(registry: &mut TaskRegistry, app: &AppHandle) {
    if registry.loaded {
        return;
    }
    registry.loaded = true;
    let path = match data_path(app, TASK_STORE_FILE) {
        Ok(path) => path,
        Err(error) => {
            registry.load_error = Some(error);
            return;
        }
    };
    let mut loaded = match load_task_store(&path) {
        Ok(loaded) => loaded,
        Err(error) => {
            registry.load_error = Some(error);
            return;
        }
    };
    // A previous process may have been killed while a task was running.  Do
    // not resurrect it as a live task after restart; expose it as unknown.
    for record in &mut loaded {
        if record.state == "running" || record.state == "starting" {
            record.state = "unknown".to_string();
            record.last_event_label = Some("上次应用退出时未确认任务终态".to_string());
        }
    }
    registry.records = loaded;
}

fn trim_records(records: &mut Vec<TaskRecord>) {
    records.sort_by_key(|record| record.updated_at);
    if records.len() > MAX_TASK_RECORDS {
        let remove = records.len() - MAX_TASK_RECORDS;
        records.drain(..remove);
    }
}

fn persist_registry(app: &AppHandle, records: &[TaskRecord]) -> Result<(), String> {
    let path = data_path(app, TASK_STORE_FILE)?;
    let store = TaskStore {
        schema_version: SCHEMA_VERSION,
        tasks: records.to_vec(),
    };
    atomic_write_json(&path, &store)
}

fn get_preferences_sync(app: &AppHandle) -> Result<WidgetPreferencesSnapshot, String> {
    let now = now_millis();
    let path = data_path(app, PREFERENCES_STORE_FILE)?;
    let preferences = load_preferences_from_path(&path)?.unwrap_or_else(default_preferences);
    Ok(WidgetPreferencesSnapshot {
        schema_version: SCHEMA_VERSION,
        source: if path.exists() {
            "local.widget_preferences".to_string()
        } else {
            "local.widget_preferences.default".to_string()
        },
        updated_at: now,
        confidence: "high".to_string(),
        persistence: if path.exists() {
            "persisted".to_string()
        } else {
            "default".to_string()
        },
        preferences,
    })
}

fn save_preferences_sync(
    app: &AppHandle,
    preferences: WidgetPreferences,
) -> Result<WidgetPreferencesSnapshot, String> {
    let path = data_path(app, PREFERENCES_STORE_FILE)?;
    atomic_write_json(&path, &preferences)?;
    Ok(WidgetPreferencesSnapshot {
        schema_version: SCHEMA_VERSION,
        source: "local.widget_preferences".to_string(),
        updated_at: now_millis(),
        confidence: "high".to_string(),
        persistence: "persisted".to_string(),
        preferences,
    })
}

fn load_preferences(app: &AppHandle) -> Result<WidgetPreferences, String> {
    let path = data_path(app, PREFERENCES_STORE_FILE)?;
    Ok(load_preferences_from_path(&path)?.unwrap_or_else(default_preferences))
}

fn load_preferences_from_path(path: &Path) -> Result<Option<WidgetPreferences>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = read_bounded(path)?;
    let preferences: WidgetPreferences = serde_json::from_slice(&bytes)
        .map_err(|error| format!("项目概览偏好文件格式无效：{error}"))?;
    Ok(Some(validate_preferences(preferences)?))
}

fn default_preferences() -> WidgetPreferences {
    WidgetPreferences {
        schema_version: SCHEMA_VERSION,
        visible_metrics: vec![
            "currentProjectUsage".to_string(),
            "runningTasks".to_string(),
            "failedTasks".to_string(),
            "highestCompletion".to_string(),
            "todayUsage".to_string(),
            "recentChanges".to_string(),
        ],
        placement_mode: default_placement_mode(),
        resting_mode: default_resting_mode(),
        compact_left_metric: default_compact_left_metric(),
        compact_right_metric: default_compact_right_metric(),
        floating_medium_metrics: default_floating_medium_metrics(),
        pinned: true,
        refresh_seconds: 5,
        subscription_label: None,
    }
}

fn default_placement_mode() -> String {
    "notch".to_string()
}

fn default_resting_mode() -> String {
    "compact".to_string()
}

fn default_compact_left_metric() -> String {
    "projectStatus".to_string()
}

fn default_compact_right_metric() -> String {
    "usageRemaining".to_string()
}

fn default_floating_medium_metrics() -> Vec<String> {
    ["projectUsage", "todayUsage", "projectProgress"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn validate_preferences(mut preferences: WidgetPreferences) -> Result<WidgetPreferences, String> {
    if preferences.schema_version != SCHEMA_VERSION {
        preferences.schema_version = SCHEMA_VERSION;
    }
    let allowed: HashSet<&str> = [
        "currentProjectUsage",
        "runningTasks",
        "failedTasks",
        "pendingApprovals",
        "highestCompletion",
        "stagnantProject",
        "todayUsage",
        "recentChanges",
        "subscription",
    ]
    .into_iter()
    .collect();
    let mut seen = HashSet::new();
    preferences
        .visible_metrics
        .retain(|metric| allowed.contains(metric.as_str()) && seen.insert(metric.clone()));
    if preferences.visible_metrics.len() > MAX_METRICS {
        preferences.visible_metrics.truncate(MAX_METRICS);
    }
    if !matches!(preferences.placement_mode.as_str(), "notch" | "floating") {
        preferences.placement_mode = default_placement_mode();
    }
    if !matches!(preferences.resting_mode.as_str(), "compact" | "medium") {
        preferences.resting_mode = default_resting_mode();
    }
    const COMPACT_METRICS: [&str; 10] = [
        "projectStatus",
        "projectUsage",
        "usageRemaining",
        "projectProgress",
        "todayUsage",
        "runningTasks",
        "failedTasks",
        "pendingApprovals",
        "subscription",
        "hidden",
    ];
    if !COMPACT_METRICS.contains(&preferences.compact_left_metric.as_str()) {
        preferences.compact_left_metric = default_compact_left_metric();
    }
    if !COMPACT_METRICS.contains(&preferences.compact_right_metric.as_str()) {
        preferences.compact_right_metric = default_compact_right_metric();
    }
    const MEDIUM_METRICS: [&str; 9] = [
        "projectStatus",
        "projectUsage",
        "usageRemaining",
        "projectProgress",
        "todayUsage",
        "runningTasks",
        "failedTasks",
        "pendingApprovals",
        "subscription",
    ];
    let medium_defaults = default_floating_medium_metrics();
    preferences.floating_medium_metrics = (0..medium_defaults.len())
        .map(|index| {
            preferences
                .floating_medium_metrics
                .get(index)
                .filter(|metric| MEDIUM_METRICS.contains(&metric.as_str()))
                .cloned()
                .unwrap_or_else(|| medium_defaults[index].clone())
        })
        .collect();
    preferences.refresh_seconds = preferences
        .refresh_seconds
        .clamp(MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS);
    if let Some(label) = preferences.subscription_label.as_mut() {
        *label = label.trim().chars().take(MAX_SUBSCRIPTION_CHARS).collect();
        if label.is_empty() {
            preferences.subscription_label = None;
        }
    }
    Ok(preferences)
}

fn load_task_store(path: &Path) -> Result<Vec<TaskRecord>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = read_bounded(path)?;
    let store: TaskStore = serde_json::from_slice(&bytes)
        .map_err(|error| format!("项目概览任务历史格式无效：{error}"))?;
    if store.schema_version != SCHEMA_VERSION {
        return Err("项目概览任务历史版本不受支持。".to_string());
    }
    let mut tasks = store.tasks;
    trim_records(&mut tasks);
    Ok(tasks)
}

fn data_path(app: &AppHandle, filename: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(filename))
        .map_err(|error| format!("无法定位应用数据目录：{error}"))
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("无法读取项目概览数据文件：{error}"))?;
    if metadata.len() as usize > MAX_STORE_BYTES {
        return Err("项目概览数据文件超过安全大小上限。".to_string());
    }
    let mut file =
        fs::File::open(path).map_err(|error| format!("无法打开项目概览数据文件：{error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取项目概览数据文件：{error}"))?;
    Ok(bytes)
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("项目概览数据编码失败：{error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err("项目概览数据超过安全大小上限。".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "项目概览数据路径缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    let counter = STORE_COUNTER.get_or_init(|| Mutex::new(0));
    let suffix = {
        let mut value = counter
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *value = value.saturating_add(1);
        *value
    };
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        suffix
    ));
    {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("无法写入项目概览临时文件：{error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法完成项目概览临时文件写入：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("无法限制项目概览文件权限：{error}"))?;
        }
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("无法原子替换项目概览数据文件：{error}")
    })
}

fn normalize_optional_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    fs::canonicalize(trimmed)
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
        .or_else(|| Some(trimmed.to_string()))
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn local_day_key(timestamp: u64) -> String {
    #[cfg(unix)]
    {
        let seconds = (timestamp / 1_000) as libc::time_t;
        let mut local = std::mem::MaybeUninit::<libc::tm>::uninit();
        // SAFETY: `localtime_r` writes a complete tm into the provided slot
        // when the pointer is valid; the timestamp is a plain integer.
        let result = unsafe { libc::localtime_r(&seconds, local.as_mut_ptr()) };
        if !result.is_null() {
            // SAFETY: the previous call returned the same initialized pointer.
            let local = unsafe { local.assume_init() };
            return format!("{:04}-{:03}", local.tm_year + 1900, local.tm_yday + 1);
        }
    }
    format!("utc-day-{}", timestamp / 86_400_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: u64, output: u64) -> UsageSnapshot {
        UsageSnapshot {
            input_tokens: Some(input),
            output_tokens: Some(output),
            ..UsageSnapshot::default()
        }
    }

    #[test]
    fn token_total_does_not_double_count_cached_input() {
        let mut totals = TokenTotals::default();
        totals.add_usage(Some(&UsageSnapshot {
            input_tokens: Some(100),
            cached_input_tokens: Some(40),
            cache_write_input_tokens: Some(5),
            output_tokens: Some(20),
            ..UsageSnapshot::default()
        }));
        let metric = totals.metric(1, "test".to_string(), Vec::new());
        assert_eq!(metric.total_tokens, Some(120));
        assert_eq!(metric.cached_input_tokens, Some(40));
    }

    #[test]
    fn empty_tokens_are_unknown_not_zero() {
        let metric = TokenTotals::default().metric(1, "test".to_string(), Vec::new());
        assert_eq!(metric.state, "unknown");
        assert_eq!(metric.total_tokens, None);
    }

    #[test]
    fn incomplete_usage_components_remain_unknown() {
        let mut totals = TokenTotals::default();
        totals.add_usage(Some(&UsageSnapshot {
            input_tokens: Some(10),
            output_tokens: Some(2),
            ..UsageSnapshot::default()
        }));
        totals.add_usage(Some(&UsageSnapshot {
            input_tokens: Some(5),
            ..UsageSnapshot::default()
        }));
        let metric = totals.metric(1, "test".to_string(), Vec::new());
        assert_eq!(metric.input_tokens, Some(15));
        assert_eq!(metric.output_tokens, None);
        assert_eq!(metric.total_tokens, None);
    }

    #[test]
    fn preferences_remove_unknown_metrics_and_bound_values() {
        let preferences = validate_preferences(WidgetPreferences {
            schema_version: 99,
            visible_metrics: vec![
                "runningTasks".to_string(),
                "x".to_string(),
                "runningTasks".to_string(),
            ],
            placement_mode: "invalid-placement".to_string(),
            resting_mode: "invalid-size".to_string(),
            compact_left_metric: "invalid-left".to_string(),
            compact_right_metric: "projectUsage".to_string(),
            floating_medium_metrics: vec![
                "runningTasks".to_string(),
                "hidden".to_string(),
                "invalid-medium".to_string(),
            ],
            pinned: true,
            refresh_seconds: 1,
            subscription_label: Some("  Plus  ".to_string()),
        })
        .expect("valid");
        assert_eq!(preferences.schema_version, 1);
        assert_eq!(preferences.visible_metrics, vec!["runningTasks"]);
        assert_eq!(preferences.placement_mode, "notch");
        assert_eq!(preferences.resting_mode, "compact");
        assert_eq!(preferences.compact_left_metric, "projectStatus");
        assert_eq!(preferences.compact_right_metric, "projectUsage");
        assert_eq!(
            preferences.floating_medium_metrics,
            vec!["runningTasks", "todayUsage", "projectProgress"]
        );
        assert_eq!(preferences.refresh_seconds, MIN_REFRESH_SECONDS);
        assert_eq!(preferences.subscription_label.as_deref(), Some("Plus"));
    }

    #[test]
    fn old_preference_json_gets_safe_compact_side_defaults() {
        let old_json = r#"{
            "schemaVersion": 1,
            "visibleMetrics": ["runningTasks"],
            "pinned": true,
            "refreshSeconds": 5
        }"#;
        let preferences: WidgetPreferences =
            serde_json::from_str(old_json).expect("legacy preferences should deserialize");
        let preferences = validate_preferences(preferences).expect("legacy preferences valid");
        assert_eq!(preferences.compact_left_metric, "projectStatus");
        assert_eq!(preferences.compact_right_metric, "usageRemaining");
        assert_eq!(
            preferences.floating_medium_metrics,
            vec!["projectUsage", "todayUsage", "projectProgress"]
        );
        assert_eq!(preferences.placement_mode, "notch");
        assert_eq!(preferences.resting_mode, "compact");
    }

    #[test]
    fn medium_resting_mode_round_trips_through_validation() {
        let mut preferences = default_preferences();
        preferences.resting_mode = "medium".to_string();
        let preferences = validate_preferences(preferences).expect("medium mode should be valid");
        assert_eq!(preferences.resting_mode, "medium");
    }

    #[test]
    fn floating_placement_mode_round_trips_through_json_and_validation() {
        let mut preferences = default_preferences();
        preferences.placement_mode = "floating".to_string();
        let json = serde_json::to_string(&preferences).expect("preferences should serialize");
        let preferences: WidgetPreferences =
            serde_json::from_str(&json).expect("preferences should deserialize");
        let preferences =
            validate_preferences(preferences).expect("floating placement should be valid");
        assert_eq!(preferences.placement_mode, "floating");
    }

    #[test]
    fn floating_medium_metrics_round_trip_in_slot_order() {
        let mut preferences = default_preferences();
        preferences.floating_medium_metrics = vec![
            "usageRemaining".to_string(),
            "failedTasks".to_string(),
            "subscription".to_string(),
        ];
        let json = serde_json::to_string(&preferences).expect("preferences should serialize");
        let preferences: WidgetPreferences =
            serde_json::from_str(&json).expect("preferences should deserialize");
        let preferences = validate_preferences(preferences).expect("summary metrics valid");
        assert_eq!(
            preferences.floating_medium_metrics,
            vec!["usageRemaining", "failedTasks", "subscription"]
        );
    }

    #[test]
    fn stagnant_requires_a_full_day_without_milestone_update() {
        let now = 10_000_000_000;
        let project = ProjectProgressSnapshot {
            schema_version: 1,
            source: SOURCE_PROGRESS.to_string(),
            project_path: "/tmp/example".to_string(),
            updated_at: now - STAGNANT_AFTER_MS - 1,
            confidence: "medium".to_string(),
            milestones: Vec::new(),
            completion: crate::progress::CompletionMetric {
                state: "unknown".to_string(),
                percent: None,
                source: SOURCE_PROGRESS.to_string(),
                updated_at: now,
                confidence: "unknown".to_string(),
                evidence: Vec::new(),
            },
            health: crate::progress::HealthMetric {
                status: "unknown".to_string(),
                source: SOURCE_PROGRESS.to_string(),
                updated_at: now,
                confidence: "unknown".to_string(),
                signals: Vec::new(),
                evidence: Vec::new(),
            },
        };
        let result = stagnant_project(&[project], now);
        assert_eq!(result.state, "unknown");
        assert_eq!(result.scope, HIGHLIGHT_SCOPE_ALL_PROJECTS);
    }

    #[test]
    fn comparison_highlights_are_global_even_when_a_project_is_selected() {
        let now = 10_000_000_000;
        let selected = progress_fixture("/tmp/selected", now - 1_000, 25);
        let other = progress_fixture("/tmp/other", now - STAGNANT_AFTER_MS - 1, 90);

        // The widget's selected project scopes task/token cards only. These
        // comparison cards intentionally retain their all-saved-projects
        // meaning, and expose that scope in the serialized field.
        let highest = highest_completion(&[selected.clone(), other.clone()], now);
        assert_eq!(highest.project_path.as_deref(), Some("/tmp/other"));
        assert_eq!(highest.scope, HIGHLIGHT_SCOPE_ALL_PROJECTS);

        let stagnant = stagnant_project(&[selected, other], now);
        assert_eq!(stagnant.project_path.as_deref(), Some("/tmp/other"));
        assert_eq!(stagnant.scope, HIGHLIGHT_SCOPE_ALL_PROJECTS);
    }

    #[test]
    fn current_project_progress_matches_selected_path_not_global_winner() {
        let now = 10_000_000_000;
        let selected_path = normalize_optional_path("/tmp/selected").expect("path");
        let other_path = normalize_optional_path("/tmp/other").expect("path");
        let selected = progress_fixture(&selected_path, now - 1_000, 25);
        let other = progress_fixture(&other_path, now - 2_000, 90);

        let metric = current_project_progress_metric(
            &[selected, other],
            Some(&format!("  {selected_path}  ")),
            now,
        );

        assert_eq!(metric.state, "derived");
        assert_eq!(metric.percent, Some(25));
        assert_eq!(metric.project_path.as_deref(), Some(selected_path.as_str()));
        assert_eq!(metric.scope, HIGHLIGHT_SCOPE_CURRENT_PROJECT);
        assert!(metric
            .evidence
            .iter()
            .any(|detail| detail.contains("精确匹配")));
        assert_ne!(metric.percent, Some(90));
    }

    #[test]
    fn current_project_progress_is_unknown_without_selection_or_record() {
        let now = 10_000_000_000;
        let project = progress_fixture("/tmp/selected", now - 1_000, 25);

        let no_selection =
            current_project_progress_metric(std::slice::from_ref(&project), None, now);
        assert_eq!(no_selection.state, "unknown");
        assert_eq!(no_selection.percent, None);
        assert_eq!(no_selection.scope, HIGHLIGHT_SCOPE_CURRENT_PROJECT);
        assert!(no_selection
            .evidence
            .iter()
            .any(|detail| detail.contains("没有选中的当前项目路径")));

        let no_record = current_project_progress_metric(&[project], Some("/tmp/not-saved"), now);
        assert_eq!(no_record.state, "unknown");
        assert_eq!(no_record.percent, None);
        assert_eq!(no_record.scope, HIGHLIGHT_SCOPE_CURRENT_PROJECT);
        assert!(no_record
            .evidence
            .iter()
            .any(|detail| detail.contains("没有精确匹配")));
    }

    fn progress_fixture(path: &str, updated_at: u64, percent: u8) -> ProjectProgressSnapshot {
        let status = if percent == 0 {
            crate::progress::MilestoneStatus::Planned
        } else if percent == 100 {
            crate::progress::MilestoneStatus::Done
        } else {
            crate::progress::MilestoneStatus::InProgress
        };
        ProjectProgressSnapshot {
            schema_version: 1,
            source: SOURCE_PROGRESS.to_string(),
            project_path: path.to_string(),
            updated_at,
            confidence: "medium".to_string(),
            milestones: vec![crate::progress::MilestoneInput {
                id: "milestone".to_string(),
                title: "目标".to_string(),
                weight: 1,
                progress_percent: percent,
                status,
            }],
            completion: crate::progress::CompletionMetric {
                state: "derived".to_string(),
                percent: Some(percent),
                source: SOURCE_PROGRESS.to_string(),
                updated_at,
                confidence: "medium".to_string(),
                evidence: Vec::new(),
            },
            health: crate::progress::HealthMetric {
                status: "unknown".to_string(),
                source: SOURCE_PROGRESS.to_string(),
                updated_at,
                confidence: "unknown".to_string(),
                signals: Vec::new(),
                evidence: Vec::new(),
            },
        }
    }

    #[test]
    fn usage_summary_is_optional_when_components_are_missing() {
        let summary = usage_summary(&usage(4, 0));
        assert_eq!(summary.total_tokens, Some(4));
        let summary = usage_summary(&UsageSnapshot::default());
        assert_eq!(summary.total_tokens, None);
    }

    #[test]
    fn selected_project_scope_does_not_include_other_tasks() {
        let record = TaskRecord {
            task_id: "task-1".to_string(),
            project_path: "/tmp/selected".to_string(),
            state: "running".to_string(),
            started_at: 1,
            ended_at: None,
            exit_code: None,
            warning_count: 0,
            usage: None,
            last_event_kind: None,
            last_event_label: None,
            updated_at: 1,
        };
        assert!(belongs_to_project(&record, Some("/tmp/selected")));
        assert!(!belongs_to_project(&record, Some("/tmp/other")));
        assert!(belongs_to_project(&record, None));
    }
}
