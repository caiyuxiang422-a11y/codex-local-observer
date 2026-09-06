//! Read-only account and rate-limit snapshot through the documented Codex
//! App Server JSON-RPC surface.
//!
//! This adapter never opens or parses auth files. The Codex process owns its
//! existing authentication lifecycle; this process only sends account/read,
//! account/rateLimits/read, and account/usage/read requests and keeps the
//! bounded response in memory.

use crate::codex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: u8 = 1;
const RPC_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_JSON_LINE_BYTES: usize = 512 * 1024;
const MAX_DIAGNOSTIC_CHARS: usize = 240;
const MAX_BUCKETS: usize = 16;
const PROJECT_USAGE_SOURCE: &str = "codex.app_server.project_usage";
const PROJECT_THREAD_LIMIT: u64 = 200;
const MAX_PROJECT_THREADS: usize = 200;
const PROJECT_RPC_TIMEOUT: Duration = Duration::from_secs(20);
const PROJECT_USAGE_ID_BASE: i64 = 10_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageSnapshot {
    pub schema_version: u8,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    pub rate_limits: Vec<RateLimitBucket>,
    pub token_activity: TokenActivity,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitBucket {
    pub limit_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_duration_mins: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits_balance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_credits: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenActivity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifetime_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_daily_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_daily_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_daily_date: Option<String>,
}

/// A bounded, read-only usage snapshot for one project directory.  The
/// App Server only returns per-thread estimates when its billing route is
/// available; missing estimates therefore remain explicitly unavailable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsageSnapshot {
    pub schema_version: u8,
    pub source: String,
    pub project_path: String,
    pub updated_at: u64,
    pub confidence: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    pub thread_count: u64,
    pub measured_thread_count: u64,
    pub active_thread_count: u64,
    pub system_error_thread_count: u64,
    pub truncated: bool,
    pub evidence: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsageRequest {
    pub project_path: String,
}

#[derive(Debug)]
struct RpcLine {
    line: String,
}

#[derive(Debug, Default)]
struct RpcResponses {
    account: Option<Value>,
    rate_limits: Option<Value>,
    usage: Option<Value>,
    account_received: bool,
    rate_limits_received: bool,
    usage_received: bool,
    errors: Vec<String>,
    malformed_lines: u64,
}

/// Responses for a bounded batch whose request IDs are allocated at runtime.
/// An error response counts as received so one failed thread cannot hold the
/// whole project snapshot open until timeout.
#[derive(Debug, Default)]
struct DynamicRpcResponses {
    values: HashMap<i64, Value>,
    errors: HashMap<i64, String>,
    malformed_lines: u64,
    timed_out: bool,
    disconnected: bool,
}

type AppServerSpawn = (
    Child,
    ChildStdin,
    Receiver<RpcLine>,
    thread::JoinHandle<Option<String>>,
);

#[tauri::command]
pub async fn get_account_usage() -> Result<AccountUsageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(read_account_usage)
        .await
        .map_err(|error| format!("账户额度读取线程异常结束：{error}"))?
}

/// Read official per-thread usage estimates for one project.  This is kept as
/// a separate command from the account snapshot because the two endpoints
/// have different scopes and different failure semantics.
#[tauri::command]
pub async fn get_project_usage(
    request: ProjectUsageRequest,
) -> Result<ProjectUsageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || read_project_usage(&request.project_path))
        .await
        .map_err(|error| format!("项目 Token 读取线程异常结束：{error}"))?
}

fn read_project_usage(requested_path: &str) -> Result<ProjectUsageSnapshot, String> {
    let project = canonical_usage_project(requested_path)?;
    let project_path = project.to_string_lossy().into_owned();
    let now = now_millis();
    let (mut child, mut stdin, line_rx, stderr_tail) = spawn_app_server()?;
    let mut stderr_tail = Some(stderr_tail);

    // Complete the documented initialization handshake before asking for
    // project data.  The notification has no response ID and is intentionally
    // not added to the expected set below.
    if let Err(error) = send_json_request(
        &mut stdin,
        json!({
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {
                    "name": "codex_local_observer",
                    "title": "Codex Local Observer",
                    "version": "0.1.0"
                }
            }
        }),
    ) {
        terminate_child(&mut child);
        let _ = join_stderr(&mut stderr_tail);
        return Err(error);
    }
    let initialize = collect_dynamic_responses(&line_rx, &[0]);
    if let Some(error) = initialize.errors.get(&0) {
        terminate_child(&mut child);
        let stderr_detail = join_stderr(&mut stderr_tail);
        return Ok(unavailable_project_usage(
            project_path,
            now,
            format!("App Server 初始化失败：{}", redact(error)),
            initialize,
            stderr_detail,
        ));
    }
    if !initialize.values.contains_key(&0) {
        terminate_child(&mut child);
        let stderr_detail = join_stderr(&mut stderr_tail);
        return Ok(unavailable_project_usage(
            project_path,
            now,
            "App Server 初始化没有返回结果。".to_string(),
            initialize,
            stderr_detail,
        ));
    }

    if let Err(error) =
        send_json_request(&mut stdin, json!({"method": "initialized", "params": {}}))
    {
        terminate_child(&mut child);
        let _ = join_stderr(&mut stderr_tail);
        return Err(error);
    }
    // The current App Server loads the authenticated billing route after
    // account/read.  Waiting for this response avoids a false `null` usage
    // result on clients that otherwise answer before account state is ready.
    if let Err(error) = send_json_request(
        &mut stdin,
        json!({
            "method": "account/read",
            "id": 2,
            "params": {"refreshToken": false}
        }),
    ) {
        terminate_child(&mut child);
        let _ = join_stderr(&mut stderr_tail);
        return Err(error);
    }
    let account_probe = collect_dynamic_responses(&line_rx, &[2]);
    if let Err(error) = send_json_request(
        &mut stdin,
        json!({
            "method": "thread/list",
            "id": 1,
            "params": {
                "cwd": project_path.clone(),
                "limit": PROJECT_THREAD_LIMIT,
                "sourceKinds": [
                    "cli",
                    "vscode",
                    "exec",
                    "appServer",
                    "subAgent",
                    "subAgentReview",
                    "subAgentCompact",
                    "subAgentThreadSpawn",
                    "subAgentOther",
                    "unknown"
                ]
            }
        }),
    ) {
        terminate_child(&mut child);
        let _ = join_stderr(&mut stderr_tail);
        return Err(error);
    }
    let listed = collect_dynamic_responses(&line_rx, &[1]);
    let Some(list_response) = listed.values.get(&1) else {
        terminate_child(&mut child);
        let stderr_detail = join_stderr(&mut stderr_tail);
        let detail = listed
            .errors
            .get(&1)
            .map(|error| format!("thread/list 失败：{}", redact(error)))
            .unwrap_or_else(|| "thread/list 没有返回结果。".to_string());
        return Ok(unavailable_project_usage(
            project_path,
            now,
            detail,
            listed,
            stderr_detail,
        ));
    };
    let thread_list = parse_thread_list(list_response);
    let mut evidence = thread_list.evidence;
    if account_probe.values.is_empty() {
        evidence
            .push("account/read 未返回完整账户状态；项目 threadUsage 可能因此不可用。".to_string());
    }
    if let Some(error) = account_probe.errors.get(&2) {
        evidence.push(format!("account/read 失败：{}", redact(error)));
    }
    if account_probe.timed_out {
        evidence
            .push("account/read 超时；继续读取项目元数据，但不把缺失 usage 当作 0。".to_string());
    }
    let thread_ids = thread_list.thread_ids;
    let thread_count = thread_ids.len() as u64;
    let active_thread_count = thread_list.active_thread_count;
    let system_error_thread_count = thread_list.system_error_thread_count;
    if thread_list.truncated {
        evidence.push(format!(
            "thread/list 返回了 nextCursor；本次最多读取 {} 个线程，结果可能不完整。",
            MAX_PROJECT_THREADS
        ));
    }

    // Request each bounded thread estimate in one batch.  Missing/null
    // threadUsage is recorded as unavailable, never as a zero-token result.
    let mut usage_ids = Vec::with_capacity(thread_ids.len());
    for (index, thread_id) in thread_ids.iter().enumerate() {
        let id = PROJECT_USAGE_ID_BASE + index as i64;
        usage_ids.push((id, thread_id.clone()));
        if let Err(error) = send_json_request(
            &mut stdin,
            json!({
                "method": "account/usage/read",
                "id": id,
                "params": {"threadId": thread_id}
            }),
        ) {
            terminate_child(&mut child);
            let _ = join_stderr(&mut stderr_tail);
            return Err(error);
        }
    }
    let expected_ids = usage_ids.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    let usage_responses = if expected_ids.is_empty() {
        DynamicRpcResponses::default()
    } else {
        collect_dynamic_responses(&line_rx, &expected_ids)
    };
    terminate_child(&mut child);
    let stderr_detail = join_stderr(&mut stderr_tail);

    let mut totals = ProjectTokenTotals::default();
    let mut measured_thread_count = 0_u64;
    let mut missing_usage_count = 0_u64;
    let mut failed_usage_count = 0_u64;
    for (id, thread_id) in &usage_ids {
        if let Some(error) = usage_responses.errors.get(id) {
            failed_usage_count = failed_usage_count.saturating_add(1);
            evidence.push(format!(
                "线程 {} 的 usage 请求失败：{}",
                short_id(thread_id),
                redact(error)
            ));
            continue;
        }
        let Some(response) = usage_responses.values.get(id) else {
            missing_usage_count = missing_usage_count.saturating_add(1);
            continue;
        };
        match parse_thread_usage(response, thread_id, &mut totals) {
            ThreadUsageParse::Measured => {
                measured_thread_count = measured_thread_count.saturating_add(1)
            }
            ThreadUsageParse::Missing => {
                missing_usage_count = missing_usage_count.saturating_add(1)
            }
            ThreadUsageParse::Malformed => {
                missing_usage_count = missing_usage_count.saturating_add(1);
                evidence.push(format!(
                    "线程 {} 的 usage 响应缺少可汇总的 groups。",
                    short_id(thread_id)
                ));
            }
        }
    }
    if missing_usage_count > 0 {
        evidence.push(format!(
            "{} 个线程没有返回可用的 threadUsage；未知值没有按 0 计算。",
            missing_usage_count
        ));
    }
    if failed_usage_count > 0 {
        evidence.push(format!(
            "{} 个线程的 usage 请求失败；项目结果为部分数据。",
            failed_usage_count
        ));
    }
    if usage_responses.timed_out {
        evidence.push("读取项目线程 usage 超时；未收到的线程保持未知。".to_string());
    }
    if usage_responses.disconnected {
        evidence.push("App Server 在返回全部项目线程 usage 前退出。".to_string());
    }
    if usage_responses.malformed_lines > 0 {
        evidence.push(format!(
            "忽略了 {} 条格式异常或超长的 App Server 输出。",
            usage_responses.malformed_lines
        ));
    }
    if let Some(stderr) = stderr_detail {
        evidence.push(format!(
            "App Server 诊断：{}",
            truncate(&stderr, MAX_DIAGNOSTIC_CHARS)
        ));
    }
    evidence.push(format!(
        "官方 App Server 精确匹配 cwd：{}；线程总数 {}，已测量 {}。",
        project_path, thread_count, measured_thread_count
    ));

    let has_measurement = measured_thread_count > 0 && totals.groups > 0;
    let complete_thread_set = thread_count > 0
        && measured_thread_count == thread_count
        && missing_usage_count == 0
        && failed_usage_count == 0
        && !thread_list.truncated
        && !usage_responses.timed_out
        && !usage_responses.disconnected;
    let state = if has_measurement && complete_thread_set && totals.total.is_complete() {
        "known"
    } else if has_measurement {
        "partial"
    } else {
        // The project query itself succeeded, but this account did not expose
        // historical per-thread billing.  Keep that distinct from a transport
        // or protocol failure so the UI can explain the exact limitation.
        "unknown"
    };
    let confidence = if state == "known" { "medium" } else { "low" };
    Ok(ProjectUsageSnapshot {
        schema_version: SCHEMA_VERSION,
        source: PROJECT_USAGE_SOURCE.to_string(),
        project_path,
        updated_at: now,
        confidence: confidence.to_string(),
        state: state.to_string(),
        total_tokens: totals.total.value(),
        input_tokens: totals.input.value(),
        cached_input_tokens: totals.cached_input.value(),
        output_tokens: totals.output.value(),
        thread_count,
        measured_thread_count,
        active_thread_count,
        system_error_thread_count,
        truncated: thread_list.truncated,
        evidence,
    })
}

#[derive(Debug, Default)]
struct ThreadListParse {
    thread_ids: Vec<String>,
    active_thread_count: u64,
    system_error_thread_count: u64,
    truncated: bool,
    evidence: Vec<String>,
}

fn parse_thread_list(response: &Value) -> ThreadListParse {
    let mut parsed = ThreadListParse {
        evidence: vec![
            "只读取官方 App Server 的 thread/list 元数据；不读取本地会话文件或完整消息内容。"
                .to_string(),
        ],
        ..ThreadListParse::default()
    };
    let Some(data) = response.get("data").and_then(Value::as_array) else {
        parsed
            .evidence
            .push("thread/list 响应缺少 data 数组。".to_string());
        return parsed;
    };
    let mut seen_ids = HashSet::new();
    for thread in data.iter().take(MAX_PROJECT_THREADS) {
        let Some(id) = thread.get("id").and_then(Value::as_str) else {
            parsed
                .evidence
                .push("忽略了一个缺少字符串 id 的线程记录。".to_string());
            continue;
        };
        if !seen_ids.insert(id.to_string()) {
            continue;
        }
        parsed.thread_ids.push(id.to_string());
        match thread
            .get("status")
            .and_then(|status| status.get("type"))
            .and_then(Value::as_str)
        {
            Some("active") => {
                parsed.active_thread_count = parsed.active_thread_count.saturating_add(1)
            }
            Some("systemError") => {
                parsed.system_error_thread_count =
                    parsed.system_error_thread_count.saturating_add(1)
            }
            _ => {}
        }
    }
    parsed.truncated = response.get("nextCursor").is_some_and(|cursor| {
        !cursor.is_null() && cursor.as_str().is_some_and(|value| !value.is_empty())
    });
    parsed
}

#[derive(Debug, Default)]
struct OptionalTokenSum {
    value: u64,
    samples: u64,
    missing: u64,
}

impl OptionalTokenSum {
    fn add(&mut self, value: Option<&Value>) {
        match value.and_then(token_number) {
            Some(value) => {
                self.value = self.value.saturating_add(value);
                self.samples = self.samples.saturating_add(1);
            }
            None => self.missing = self.missing.saturating_add(1),
        }
    }

    fn is_complete(&self) -> bool {
        self.samples > 0 && self.missing == 0
    }

    fn value(&self) -> Option<u64> {
        self.is_complete().then_some(self.value)
    }
}

fn token_number(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
}

#[derive(Debug, Default)]
struct ProjectTokenTotals {
    groups: u64,
    total: OptionalTokenSum,
    input: OptionalTokenSum,
    cached_input: OptionalTokenSum,
    output: OptionalTokenSum,
}

#[derive(Debug, Eq, PartialEq)]
enum ThreadUsageParse {
    Measured,
    Missing,
    Malformed,
}

fn parse_thread_usage(
    response: &Value,
    expected_thread_id: &str,
    totals: &mut ProjectTokenTotals,
) -> ThreadUsageParse {
    let Some(thread_usage) = response.get("threadUsage") else {
        return ThreadUsageParse::Missing;
    };
    if thread_usage.is_null() {
        return ThreadUsageParse::Missing;
    }
    let Some(object) = thread_usage.as_object() else {
        return ThreadUsageParse::Malformed;
    };
    if let Some(thread_id) = object.get("threadId").and_then(Value::as_str) {
        if thread_id != expected_thread_id {
            return ThreadUsageParse::Malformed;
        }
    }
    let Some(groups) = object.get("groups").and_then(Value::as_array) else {
        return ThreadUsageParse::Malformed;
    };
    if groups.is_empty() {
        return ThreadUsageParse::Missing;
    }
    for group in groups {
        let Some(group) = group.as_object() else {
            return ThreadUsageParse::Malformed;
        };
        totals.groups = totals.groups.saturating_add(1);
        totals.total.add(group.get("totalTokens"));
        totals.input.add(group.get("inputTokens"));
        totals.cached_input.add(group.get("cachedInputTokens"));
        totals.output.add(group.get("outputTokens"));
    }
    ThreadUsageParse::Measured
}

fn canonical_usage_project(requested_path: &str) -> Result<PathBuf, String> {
    let trimmed = requested_path.trim();
    if trimmed.is_empty() {
        return Err("项目目录不能为空。".to_string());
    }
    let path =
        fs::canonicalize(trimmed).map_err(|error| format!("项目目录不存在或不可访问：{error}"))?;
    if !path.is_dir() {
        return Err("项目路径不是目录。".to_string());
    }
    Ok(path)
}

fn short_id(value: &str) -> String {
    value.chars().take(12).collect()
}

fn spawn_app_server() -> Result<AppServerSpawn, String> {
    let codex_path = codex::locate_codex()?;
    let mut command = Command::new(codex_path);
    command
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Codex App Server：{error}"))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child(&mut child);
            return Err("无法读取 App Server stdout。".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_child(&mut child);
            return Err("无法读取 App Server stderr。".to_string());
        }
    };
    let Some(stdin) = child.stdin.take() else {
        terminate_child(&mut child);
        return Err("无法写入 App Server stdin。".to_string());
    };
    let (line_tx, line_rx) = mpsc::channel::<RpcLine>();
    spawn_stdout_reader(stdout, line_tx);
    let stderr_tail = spawn_stderr_reader(stderr);
    Ok((child, stdin, line_rx, stderr_tail))
}

fn join_stderr(handle: &mut Option<thread::JoinHandle<Option<String>>>) -> Option<String> {
    handle
        .take()
        .and_then(|thread| thread.join().ok().flatten())
}

fn send_json_request(stdin: &mut impl Write, request: Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    line.push(b'\n');
    stdin
        .write_all(&line)
        .map_err(|error| format!("无法发送 App Server 请求：{error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("无法刷新 App Server 请求：{error}"))
}

fn collect_dynamic_responses(rx: &Receiver<RpcLine>, expected_ids: &[i64]) -> DynamicRpcResponses {
    let expected = expected_ids.iter().copied().collect::<HashSet<_>>();
    let mut received = HashSet::new();
    let mut output = DynamicRpcResponses::default();
    let deadline = Instant::now() + PROJECT_RPC_TIMEOUT;
    while !expected.is_subset(&received) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            output.timed_out = true;
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok(message) if message.line == "__oversized__" => {
                output.malformed_lines = output.malformed_lines.saturating_add(1);
            }
            Ok(message) => match serde_json::from_str::<Value>(&message.line) {
                Ok(value) => {
                    let Some(id) = value.get("id").and_then(Value::as_i64) else {
                        continue;
                    };
                    if !expected.contains(&id) {
                        continue;
                    }
                    if let Some(error) = value.get("error") {
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("App Server 返回未知错误");
                        output.errors.insert(id, redact(message));
                        received.insert(id);
                    } else {
                        output
                            .values
                            .insert(id, value.get("result").cloned().unwrap_or(Value::Null));
                        received.insert(id);
                    }
                }
                Err(_) => output.malformed_lines = output.malformed_lines.saturating_add(1),
            },
            Err(RecvTimeoutError::Timeout) => {
                output.timed_out = true;
                break;
            }
            Err(RecvTimeoutError::Disconnected) => {
                output.disconnected = true;
                break;
            }
        }
    }
    output
}

fn unavailable_project_usage(
    project_path: String,
    now: u64,
    detail: String,
    rpc: DynamicRpcResponses,
    stderr_detail: Option<String>,
) -> ProjectUsageSnapshot {
    let mut evidence = vec![
        "只读 Codex App Server 项目接口；不读取 auth.json、Cookie 或本地会话文件。".to_string(),
        detail,
    ];
    if rpc.timed_out {
        evidence.push("App Server 项目请求超时。".to_string());
    }
    if rpc.disconnected {
        evidence.push("App Server 在返回项目数据前退出。".to_string());
    }
    if rpc.malformed_lines > 0 {
        evidence.push(format!(
            "忽略了 {} 条格式异常或超长的 App Server 输出。",
            rpc.malformed_lines
        ));
    }
    for (id, error) in rpc.errors {
        evidence.push(format!("请求 {id} 失败：{}", redact(&error)));
    }
    if let Some(stderr) = stderr_detail {
        evidence.push(format!(
            "App Server 诊断：{}",
            truncate(&stderr, MAX_DIAGNOSTIC_CHARS)
        ));
    }
    ProjectUsageSnapshot {
        schema_version: SCHEMA_VERSION,
        source: PROJECT_USAGE_SOURCE.to_string(),
        project_path,
        updated_at: now,
        confidence: "none".to_string(),
        state: "unavailable".to_string(),
        total_tokens: None,
        input_tokens: None,
        cached_input_tokens: None,
        output_tokens: None,
        thread_count: 0,
        measured_thread_count: 0,
        active_thread_count: 0,
        system_error_thread_count: 0,
        truncated: false,
        evidence,
    }
}

fn read_account_usage() -> Result<AccountUsageSnapshot, String> {
    let now = now_millis();
    let codex_path = codex::locate_codex()?;
    let mut command = Command::new(codex_path);
    command
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Codex App Server：{error}"))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child(&mut child);
            return Err("无法读取 App Server stdout。".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_child(&mut child);
            return Err("无法读取 App Server stderr。".to_string());
        }
    };
    let Some(mut stdin) = child.stdin.take() else {
        terminate_child(&mut child);
        return Err("无法写入 App Server stdin。".to_string());
    };

    let (line_tx, line_rx) = mpsc::channel::<RpcLine>();
    spawn_stdout_reader(stdout, line_tx);
    let stderr_tail = spawn_stderr_reader(stderr);
    // Keep stdin alive while the App Server produces all three responses.
    // Passing ChildStdin by value here would drop it at the end of
    // send_requests, close the pipe, and make the server exit before the
    // account snapshot arrives.
    if let Err(error) = send_requests(&mut stdin) {
        terminate_child(&mut child);
        let _ = stderr_tail.join();
        return Err(error);
    }

    let responses = collect_responses(&line_rx);
    terminate_child(&mut child);
    let stderr_detail = stderr_tail.join().ok().flatten();

    build_snapshot(now, responses, stderr_detail)
}

fn send_requests(stdin: &mut impl Write) -> Result<(), String> {
    let requests = [
        json!({
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {
                    "name": "codex_local_observer",
                    "title": "Codex Local Observer",
                    "version": "0.1.0"
                }
            }
        }),
        json!({"method": "initialized", "params": {}}),
        json!({
            "method": "account/read",
            "id": 1,
            "params": {"refreshToken": false}
        }),
        json!({"method": "account/rateLimits/read", "id": 2}),
        json!({"method": "account/usage/read", "id": 3}),
    ];
    for request in requests {
        let mut line = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
        line.push(b'\n');
        stdin
            .write_all(&line)
            .map_err(|error| format!("无法发送 App Server 请求：{error}"))?;
    }
    stdin
        .flush()
        .map_err(|error| format!("无法刷新 App Server 请求：{error}"))
}

fn spawn_stdout_reader(stdout: ChildStdout, tx: Sender<RpcLine>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if line.len() <= MAX_JSON_LINE_BYTES {
                        let text = String::from_utf8_lossy(&line).trim().to_string();
                        if !text.is_empty() && tx.send(RpcLine { line: text }).is_err() {
                            break;
                        }
                    } else if tx
                        .send(RpcLine {
                            line: "__oversized__".to_string(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
}

fn spawn_stderr_reader(stderr: ChildStderr) -> thread::JoinHandle<Option<String>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.by_ref().take(16 * 1024).read_to_end(&mut bytes);
        let text = String::from_utf8_lossy(&bytes).trim().to_string();
        (!text.is_empty()).then(|| redact(&text))
    })
}

fn collect_responses(rx: &Receiver<RpcLine>) -> RpcResponses {
    let deadline = Instant::now() + RPC_TIMEOUT;
    let mut output = RpcResponses::default();
    while !output.account_received || !output.rate_limits_received || !output.usage_received {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            output.errors.push("App Server 账户请求超时。".to_string());
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok(message) if message.line == "__oversized__" => {
                output.malformed_lines = output.malformed_lines.saturating_add(1);
            }
            Ok(message) => match serde_json::from_str::<Value>(&message.line) {
                Ok(value) => record_response(&mut output, value),
                Err(_) => output.malformed_lines = output.malformed_lines.saturating_add(1),
            },
            Err(RecvTimeoutError::Timeout) => {
                output.errors.push("App Server 账户请求超时。".to_string());
                break;
            }
            Err(RecvTimeoutError::Disconnected) => {
                output
                    .errors
                    .push("App Server 在返回完整账户快照前退出。".to_string());
                break;
            }
        }
    }
    output
}

fn record_response(output: &mut RpcResponses, value: Value) {
    let Some(id) = value.get("id").and_then(Value::as_i64) else {
        return;
    };
    let response_id = id;
    if let Some(error) = value.get("error") {
        mark_received(output, response_id);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("App Server 返回未知错误");
        output
            .errors
            .push(format!("请求 {id}：{}", redact(message)));
        return;
    }
    let result = value.get("result").cloned().unwrap_or(Value::Null);
    match id {
        1 => {
            output.account_received = true;
            output.account = Some(result);
        }
        2 => {
            output.rate_limits_received = true;
            output.rate_limits = Some(result);
        }
        3 => {
            output.usage_received = true;
            output.usage = Some(result);
        }
        _ => {}
    }
}

fn mark_received(output: &mut RpcResponses, id: i64) {
    match id {
        1 => output.account_received = true,
        2 => output.rate_limits_received = true,
        3 => output.usage_received = true,
        _ => {}
    }
}

fn build_snapshot(
    now: u64,
    responses: RpcResponses,
    stderr_detail: Option<String>,
) -> Result<AccountUsageSnapshot, String> {
    let account = responses
        .account
        .as_ref()
        .and_then(|value| value.get("account"));
    let account_type = account
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let rate_limits = parse_rate_limits(responses.rate_limits.as_ref());
    let plan_type = account
        .and_then(|value| value.get("planType"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            responses
                .rate_limits
                .as_ref()
                .and_then(|value| value.get("rateLimits"))
                .and_then(|value| value.get("planType"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let plan_type = plan_type.or_else(|| {
        rate_limits
            .iter()
            .find_map(|bucket| bucket.plan_type.clone())
    });
    let token_activity = parse_token_activity(responses.usage.as_ref());
    let mut evidence = vec![
        "只读 Codex App Server 账户接口；快照不写入本地历史，也不读取 auth.json。".to_string(),
    ];
    if responses.malformed_lines > 0 {
        evidence.push(format!(
            "忽略了 {} 条格式异常或超长的 App Server 输出。",
            responses.malformed_lines
        ));
    }
    evidence.extend(responses.errors);
    if let Some(stderr) = stderr_detail {
        evidence.push(format!(
            "App Server 诊断：{}",
            truncate(&stderr, MAX_DIAGNOSTIC_CHARS)
        ));
    }
    let has_data = account_type.is_some()
        || !rate_limits.is_empty()
        || token_activity.lifetime_tokens.is_some()
        || token_activity.latest_daily_tokens.is_some();
    let state = if has_data && evidence.len() == 1 {
        "known"
    } else if has_data {
        "partial"
    } else {
        "unknown"
    };
    Ok(AccountUsageSnapshot {
        schema_version: SCHEMA_VERSION,
        source: "codex.app_server.account".to_string(),
        updated_at: now,
        confidence: if state == "known" { "medium" } else { "low" }.to_string(),
        state: state.to_string(),
        account_type,
        plan_type,
        rate_limits,
        token_activity,
        evidence,
    })
}

fn parse_rate_limits(response: Option<&Value>) -> Vec<RateLimitBucket> {
    let Some(response) = response else {
        return Vec::new();
    };
    let mut buckets = Vec::new();
    if let Some(primary) = response.get("rateLimits").filter(|value| value.is_object()) {
        buckets.push(parse_bucket("codex", primary));
    }
    if let Some(map) = response
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
    {
        for (id, value) in map.iter().take(MAX_BUCKETS) {
            let bucket = parse_bucket(id, value);
            if !buckets
                .iter()
                .any(|existing| existing.limit_id == bucket.limit_id)
            {
                buckets.push(bucket);
            }
        }
    }
    buckets.sort_by(|left, right| left.limit_id.cmp(&right.limit_id));
    buckets
}

fn parse_bucket(fallback_id: &str, value: &Value) -> RateLimitBucket {
    let id = value
        .get("limitId")
        .and_then(Value::as_str)
        .unwrap_or(fallback_id)
        .to_string();
    let primary = value.get("primary").unwrap_or(&Value::Null);
    let used_percent = bounded_percent(primary.get("usedPercent"));
    let credits = value.get("credits").and_then(Value::as_object);
    RateLimitBucket {
        limit_id: id,
        limit_name: value
            .get("limitName")
            .and_then(Value::as_str)
            .map(str::to_string),
        remaining_percent: used_percent.map(|used| 100 - used),
        used_percent,
        window_duration_mins: primary.get("windowDurationMins").and_then(Value::as_u64),
        resets_at: primary.get("resetsAt").and_then(Value::as_u64),
        credits_balance: credits.and_then(|map| scalar_string(map.get("balance"))),
        has_credits: credits.and_then(|map| map.get("hasCredits").and_then(Value::as_bool)),
        plan_type: value
            .get("planType")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn parse_token_activity(response: Option<&Value>) -> TokenActivity {
    let Some(response) = response else {
        return TokenActivity::default();
    };
    let summary = response.get("summary");
    let mut activity = TokenActivity {
        lifetime_tokens: summary
            .and_then(|value| value.get("lifetimeTokens"))
            .and_then(Value::as_u64),
        peak_daily_tokens: summary
            .and_then(|value| value.get("peakDailyTokens"))
            .and_then(Value::as_u64),
        ..TokenActivity::default()
    };
    if let Some(buckets) = response.get("dailyUsageBuckets").and_then(Value::as_array) {
        if let Some(latest) = buckets
            .iter()
            .filter_map(|bucket| {
                Some((
                    bucket.get("startDate")?.as_str()?.to_string(),
                    token_number(bucket.get("tokens")?)?,
                ))
            })
            .max_by(|left, right| left.0.cmp(&right.0))
        {
            activity.latest_daily_date = Some(latest.0);
            activity.latest_daily_tokens = Some(latest.1);
        }
    }
    activity
}

fn bounded_percent(value: Option<&Value>) -> Option<u8> {
    let number = value?.as_u64()?;
    (number <= 100).then_some(number as u8)
}

fn scalar_string(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(text) => Some(truncate(text, 64)),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn terminate_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            // The App Server is started in its own process group so a timeout
            // cannot leave a descendant holding the stdio pipes open.
            unsafe {
                let _ = libc::kill(-pid, libc::SIGTERM);
            }
        }
        thread::sleep(Duration::from_millis(40));
    }
    if child.try_wait().ok().flatten().is_none() {
        #[cfg(unix)]
        {
            if let Ok(pid) = i32::try_from(child.id()) {
                unsafe {
                    let _ = libc::kill(-pid, libc::SIGKILL);
                }
            }
        }
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn redact(value: &str) -> String {
    let mut output = value.to_string();
    for marker in ["Bearer ", "sk-", "api-key="] {
        if let Some(index) = output.find(marker) {
            let end = output[index..]
                .find(char::is_whitespace)
                .map(|offset| index + offset)
                .unwrap_or(output.len());
            output.replace_range(index..end, "[REDACTED]");
        }
    }
    truncate(&output, MAX_DIAGNOSTIC_CHARS)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remaining_percent_without_inventing_token_quota() {
        let response = json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": {"usedPercent": 23, "windowDurationMins": 10080, "resetsAt": 42},
                "credits": {"hasCredits": false, "balance": "0"},
                "planType": "pro"
            }
        });
        let buckets = parse_rate_limits(Some(&response));
        assert_eq!(buckets[0].remaining_percent, Some(77));
        assert_eq!(buckets[0].credits_balance.as_deref(), Some("0"));
        assert_eq!(buckets[0].resets_at, Some(42));
    }

    #[test]
    fn token_activity_keeps_latest_bucket_and_lifetime() {
        let response = json!({
            "summary": {"lifetimeTokens": 123, "peakDailyTokens": 20},
            "dailyUsageBuckets": [
                {"startDate": "2026-08-24", "tokens": 4},
                {"startDate": "2026-08-25", "tokens": 9}
            ]
        });
        let activity = parse_token_activity(Some(&response));
        assert_eq!(activity.lifetime_tokens, Some(123));
        assert_eq!(activity.latest_daily_date.as_deref(), Some("2026-08-25"));
        assert_eq!(activity.latest_daily_tokens, Some(9));
    }

    #[test]
    fn malformed_percent_is_unknown() {
        let response = json!({"rateLimits": {"primary": {"usedPercent": 101}}});
        let buckets = parse_rate_limits(Some(&response));
        assert_eq!(buckets[0].used_percent, None);
        assert_eq!(buckets[0].remaining_percent, None);
    }

    #[test]
    fn bucket_plan_is_available_when_account_plan_is_absent() {
        let response = json!({
            "rateLimits": {
                "planType": "plus",
                "primary": {"usedPercent": 10}
            }
        });
        let buckets = parse_rate_limits(Some(&response));
        assert_eq!(buckets[0].plan_type.as_deref(), Some("plus"));
    }

    #[test]
    fn parses_project_thread_list_result_without_rpc_envelope() {
        let response = json!({
            "data": [
                {"id": "thread-a", "status": {"type": "active"}},
                {"id": "thread-a", "status": {"type": "active"}},
                {"id": "thread-b", "status": {"type": "systemError"}}
            ],
            "nextCursor": "next"
        });
        let parsed = parse_thread_list(&response);
        assert_eq!(parsed.thread_ids, vec!["thread-a", "thread-b"]);
        assert_eq!(parsed.active_thread_count, 1);
        assert_eq!(parsed.system_error_thread_count, 1);
        assert!(parsed.truncated);
    }

    #[test]
    fn aggregates_official_thread_usage_groups_and_accepts_string_numbers() {
        let response = json!({
            "threadUsage": {
                "threadId": "thread-a",
                "groups": [
                    {"totalTokens": "12", "inputTokens": 10, "cachedInputTokens": 2, "outputTokens": 2},
                    {"totalTokens": 8, "inputTokens": 6, "cachedInputTokens": 1, "outputTokens": 2}
                ]
            }
        });
        let mut totals = ProjectTokenTotals::default();
        assert_eq!(
            parse_thread_usage(&response, "thread-a", &mut totals),
            ThreadUsageParse::Measured
        );
        assert_eq!(totals.total.value(), Some(20));
        assert_eq!(totals.input.value(), Some(16));
        assert_eq!(totals.cached_input.value(), Some(3));
        assert_eq!(totals.output.value(), Some(4));
    }

    #[test]
    fn null_thread_usage_stays_missing_not_zero() {
        let response = json!({"threadUsage": null});
        let mut totals = ProjectTokenTotals::default();
        assert_eq!(
            parse_thread_usage(&response, "thread-a", &mut totals),
            ThreadUsageParse::Missing
        );
        assert_eq!(totals.total.value(), None);
    }
}
