use crate::events::{
    monitor_event, read_bounded_line, redact_and_truncate, AdapterEvent, BoundedRead,
    CodexJsonlParser, TaskEvent, TerminalCandidate, UsageSnapshot, MAX_JSONL_LINE_BYTES,
    MAX_STDERR_LINE_BYTES,
};
use crate::widget_data;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const TASK_EVENT_NAME: &str = "codex-task-event";
const MAX_PROMPT_CHARS: usize = 32_000;
const MAX_STDERR_EVENTS: u64 = 40;
const CANCEL_GRACE_PERIOD: Duration = Duration::from_secs(2);

#[derive(Clone, Default)]
pub struct TaskManager {
    active: Arc<Mutex<Option<ActiveTask>>>,
}

impl TaskManager {
    pub fn shutdown(&self) {
        let active = lock(&self.active).take();
        let Some(active) = active else {
            return;
        };
        active.cancel_requested.store(true, Ordering::SeqCst);
        let _ = request_termination(active.pid, &active.child);
        for _ in 0..10 {
            let exited = lock(&active.child)
                .try_wait()
                .map(|status| status.is_some())
                .unwrap_or(false);
            if exited {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        force_termination(active.pid, &active.child);
    }
}

#[derive(Clone)]
struct ActiveTask {
    id: String,
    pid: u32,
    child: Arc<Mutex<Child>>,
    cancel_requested: Arc<AtomicBool>,
    sequence: Arc<AtomicU64>,
}

#[derive(Default)]
struct ExecutionState {
    terminal: Option<TerminalCandidate>,
    warning_count: u64,
    event_count: u64,
    last_stderr: Option<String>,
    usage: Option<UsageSnapshot>,
}

impl ExecutionState {
    fn record_adapter(&mut self, event: &AdapterEvent) {
        self.event_count += 1;
        if event.public.severity == "warning" {
            self.warning_count += 1;
        }
        if let Some(usage) = &event.public.usage {
            self.usage = Some(usage.clone());
        }
        match event.terminal {
            Some(TerminalCandidate::Failed) => {
                self.terminal = Some(TerminalCandidate::Failed);
            }
            Some(TerminalCandidate::Completed) if self.terminal.is_none() => {
                self.terminal = Some(TerminalCandidate::Completed);
            }
            _ => {}
        }
    }

    fn record_monitor_event(&mut self, severity: &str) {
        self.event_count += 1;
        if severity == "warning" {
            self.warning_count += 1;
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTaskRequest {
    project_path: String,
    prompt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTaskResponse {
    task_id: String,
    project_path: String,
    codex_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    backend_ready: bool,
    project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    codex_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    codex_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[tauri::command]
pub fn get_environment() -> EnvironmentInfo {
    let project_path = default_project_path().to_string_lossy().into_owned();
    match locate_codex() {
        Ok(path) => EnvironmentInfo {
            backend_ready: true,
            project_path,
            codex_version: codex_version(&path),
            codex_path: Some(path.to_string_lossy().into_owned()),
            message: None,
        },
        Err(error) => EnvironmentInfo {
            backend_ready: true,
            project_path,
            codex_path: None,
            codex_version: None,
            message: Some(error),
        },
    }
}

#[tauri::command]
pub fn start_task(
    app: AppHandle,
    manager: State<'_, TaskManager>,
    request: StartTaskRequest,
) -> Result<StartTaskResponse, String> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("任务说明不能为空。".to_string());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("任务说明不能超过 {MAX_PROMPT_CHARS} 个字符。"));
    }

    let project = validate_project(&request.project_path)?;
    let codex_path = locate_codex()?;
    let task_id = Uuid::new_v4().to_string();
    let sequence = Arc::new(AtomicU64::new(0));
    let cancel_requested = Arc::new(AtomicBool::new(false));

    let mut active_guard = lock(&manager.active);
    if active_guard.is_some() {
        return Err("已有任务正在运行；请先等待它结束或停止它。".to_string());
    }

    let mut command = Command::new(&codex_path);
    command
        .arg("exec")
        .arg("--json")
        .arg("--color")
        .arg("never")
        .arg("--ephemeral")
        .arg("--sandbox")
        .arg("read-only")
        .arg("--cd")
        .arg(&project)
        .arg("-")
        .current_dir(&project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "无法启动 Codex CLI（{}）：{error}",
            codex_path.to_string_lossy()
        )
    })?;

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            return Err("无法读取 Codex stdout。".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            return Err("无法读取 Codex stderr。".to_string());
        }
    };
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        return Err("无法写入 Codex stdin。".to_string());
    };
    if let Err(error) = stdin
        .write_all(prompt.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
    {
        let _ = child.kill();
        return Err(format!("无法把任务说明写入 Codex stdin：{error}"));
    }

    let pid = child.id();
    let child = Arc::new(Mutex::new(child));
    let active_task = ActiveTask {
        id: task_id.clone(),
        pid,
        child: child.clone(),
        cancel_requested: cancel_requested.clone(),
        sequence: sequence.clone(),
    };
    *active_guard = Some(active_task);
    drop(active_guard);

    // The widget history stores only task metadata and structured usage; it
    // never receives the prompt.  A history write failure must not prevent a
    // valid Codex task from starting.
    widget_data::record_task_started(&app, &task_id, &project);

    let spawned = monitor_event(
        &task_id,
        &sequence,
        "process.spawned",
        Some("starting"),
        "info",
        "Codex 子进程已启动",
        Some("Prompt 已通过 stdin 写入并关闭；正在等待第一个 JSONL 事件。".to_string()),
        None,
        None,
    );
    emit(&app, &spawned);

    let execution = Arc::new(Mutex::new(ExecutionState::default()));
    spawn_task_threads(
        app.clone(),
        manager.inner().clone(),
        task_id.clone(),
        sequence,
        cancel_requested,
        child,
        stdout,
        stderr,
        execution,
    );

    Ok(StartTaskResponse {
        task_id,
        project_path: project.to_string_lossy().into_owned(),
        codex_path: codex_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn stop_task(
    app: AppHandle,
    manager: State<'_, TaskManager>,
    task_id: String,
) -> Result<(), String> {
    let active = {
        let guard = lock(&manager.active);
        let active = guard
            .as_ref()
            .ok_or_else(|| "当前没有运行中的任务。".to_string())?;
        if active.id != task_id {
            return Err("任务已切换；拒绝停止一个过期任务。".to_string());
        }
        active.clone()
    };

    if active.cancel_requested.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let stopping = monitor_event(
        &active.id,
        &active.sequence,
        "task.stopping",
        Some("stopping"),
        "info",
        "正在停止任务",
        Some("先请求进程正常终止；2 秒后仍未退出会强制结束。".to_string()),
        None,
        None,
    );
    emit(&app, &stopping);

    request_termination(active.pid, &active.child)?;
    let child = active.child.clone();
    let pid = active.pid;
    thread::spawn(move || {
        thread::sleep(CANCEL_GRACE_PERIOD);
        let still_running = lock(&child)
            .try_wait()
            .map(|status| status.is_none())
            .unwrap_or(true);
        if still_running {
            force_termination(pid, &child);
        }
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn spawn_task_threads(
    app: AppHandle,
    manager: TaskManager,
    task_id: String,
    sequence: Arc<AtomicU64>,
    cancel_requested: Arc<AtomicBool>,
    child: Arc<Mutex<Child>>,
    stdout: ChildStdout,
    stderr: ChildStderr,
    execution: Arc<Mutex<ExecutionState>>,
) {
    let stdout_app = app.clone();
    let stdout_task_id = task_id.clone();
    let stdout_sequence = sequence.clone();
    let stdout_execution = execution.clone();
    let stdout_thread = thread::spawn(move || {
        consume_stdout(
            stdout_app,
            stdout_task_id,
            stdout_sequence,
            stdout,
            stdout_execution,
        )
    });

    let stderr_app = app.clone();
    let stderr_task_id = task_id.clone();
    let stderr_sequence = sequence.clone();
    let stderr_execution = execution.clone();
    let stderr_thread = thread::spawn(move || {
        consume_stderr(
            stderr_app,
            stderr_task_id,
            stderr_sequence,
            stderr,
            stderr_execution,
        )
    });

    thread::spawn(move || {
        let mut monitor_error = None;
        let exit_status = loop {
            match lock(&child).try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => thread::sleep(Duration::from_millis(60)),
                Err(error) => {
                    monitor_error = Some(format!("无法读取 Codex 退出状态：{error}"));
                    let _ = lock(&child).kill();
                    break lock(&child).wait().ok();
                }
            }
        };

        if stdout_thread.join().is_err() {
            let mut state = lock(&execution);
            state.warning_count += 1;
            monitor_error.get_or_insert_with(|| "stdout 读取线程异常结束。".to_string());
        }
        if stderr_thread.join().is_err() {
            let mut state = lock(&execution);
            state.warning_count += 1;
            monitor_error.get_or_insert_with(|| "stderr 读取线程异常结束。".to_string());
        }

        let state = lock(&execution);
        let exit_code = exit_status.as_ref().and_then(|status| status.code());
        let exit_success = exit_status.as_ref().map(|status| status.success());
        let outcome = resolve_final_outcome(
            state.terminal,
            exit_success,
            exit_code,
            cancel_requested.load(Ordering::SeqCst),
            monitor_error.as_deref(),
            state.last_stderr.as_deref(),
            state.warning_count,
        );
        let mut finished = monitor_event(
            &task_id,
            &sequence,
            outcome.kind,
            Some(outcome.task_state),
            outcome.severity,
            outcome.label,
            outcome.detail,
            exit_code,
            Some(state.warning_count),
        );
        finished.usage = state.usage.clone();
        drop(state);
        emit(&app, &finished);

        let mut active = lock(&manager.active);
        if active.as_ref().is_some_and(|task| task.id == task_id) {
            *active = None;
        }
    });
}

fn consume_stdout(
    app: AppHandle,
    task_id: String,
    sequence: Arc<AtomicU64>,
    stdout: ChildStdout,
    execution: Arc<Mutex<ExecutionState>>,
) {
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::with_capacity(8 * 1024);
    let mut parser = CodexJsonlParser::new(task_id.clone(), sequence.clone());

    loop {
        match read_bounded_line(&mut reader, &mut buffer, MAX_JSONL_LINE_BYTES) {
            Ok(BoundedRead::Eof) => break,
            Ok(BoundedRead::Line {
                oversized: true,
                observed_at_least,
            }) => {
                let event = parser.oversized_line(observed_at_least);
                lock(&execution).record_adapter(&event);
                emit(&app, &event.public);
            }
            Ok(BoundedRead::Line {
                oversized: false, ..
            }) => {
                if let Some(event) = parser.parse_line(&buffer) {
                    lock(&execution).record_adapter(&event);
                    emit(&app, &event.public);
                }
            }
            Err(error) => {
                let event = monitor_event(
                    &task_id,
                    &sequence,
                    "stream.stdout_error",
                    None,
                    "warning",
                    "读取 Codex JSONL 时发生错误",
                    Some(error.to_string()),
                    None,
                    None,
                );
                lock(&execution).record_monitor_event("warning");
                emit(&app, &event);
                break;
            }
        }
    }
}

fn consume_stderr(
    app: AppHandle,
    task_id: String,
    sequence: Arc<AtomicU64>,
    stderr: ChildStderr,
    execution: Arc<Mutex<ExecutionState>>,
) {
    let mut reader = BufReader::new(stderr);
    let mut buffer = Vec::with_capacity(1024);
    let mut emitted = 0u64;
    let mut suppression_emitted = false;

    loop {
        match read_bounded_line(&mut reader, &mut buffer, MAX_STDERR_LINE_BYTES) {
            Ok(BoundedRead::Eof) => break,
            Ok(BoundedRead::Line {
                oversized,
                observed_at_least,
            }) => {
                let text = if oversized {
                    format!("stderr 行至少 {observed_at_least} 字节，已按安全上限截断。")
                } else {
                    String::from_utf8_lossy(&buffer).trim().to_string()
                };
                if text.is_empty() {
                    continue;
                }
                let text = redact_and_truncate(&text);
                {
                    let mut state = lock(&execution);
                    state.last_stderr = Some(text.clone());
                }
                if emitted < MAX_STDERR_EVENTS {
                    let event = monitor_event(
                        &task_id,
                        &sequence,
                        "process.stderr",
                        None,
                        "warning",
                        "Codex 诊断信息",
                        Some(text),
                        None,
                        None,
                    );
                    lock(&execution).record_monitor_event("warning");
                    emit(&app, &event);
                    emitted += 1;
                } else if !suppression_emitted {
                    let event = monitor_event(
                        &task_id,
                        &sequence,
                        "process.stderr_suppressed",
                        None,
                        "warning",
                        "更多 stderr 已折叠",
                        Some(format!(
                            "界面最多展示 {MAX_STDERR_EVENTS} 条诊断，读取仍在继续。"
                        )),
                        None,
                        None,
                    );
                    lock(&execution).record_monitor_event("warning");
                    emit(&app, &event);
                    suppression_emitted = true;
                }
            }
            Err(error) => {
                let event = monitor_event(
                    &task_id,
                    &sequence,
                    "stream.stderr_error",
                    None,
                    "warning",
                    "读取 Codex stderr 时发生错误",
                    Some(error.to_string()),
                    None,
                    None,
                );
                lock(&execution).record_monitor_event("warning");
                emit(&app, &event);
                break;
            }
        }
    }
}

struct FinalOutcome {
    kind: &'static str,
    task_state: &'static str,
    severity: &'static str,
    label: &'static str,
    detail: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn resolve_final_outcome(
    terminal: Option<TerminalCandidate>,
    exit_success: Option<bool>,
    exit_code: Option<i32>,
    cancelled: bool,
    monitor_error: Option<&str>,
    last_stderr: Option<&str>,
    warnings: u64,
) -> FinalOutcome {
    if cancelled {
        return FinalOutcome {
            kind: "task.cancelled",
            task_state: "cancelled",
            severity: "warning",
            label: "任务已取消",
            detail: Some("Codex 子进程已结束。".to_string()),
        };
    }
    if let Some(error) = monitor_error {
        return failed_outcome("本地进程监控失败", Some(error.to_string()));
    }
    if terminal == Some(TerminalCandidate::Failed) {
        return failed_outcome("Codex 报告任务失败", last_stderr.map(redact_and_truncate));
    }
    match (terminal, exit_success) {
        (Some(TerminalCandidate::Completed), Some(true)) => FinalOutcome {
            kind: "task.completed",
            task_state: "completed",
            severity: "success",
            label: "任务已确认完成",
            detail: (warnings > 0)
                .then(|| format!("Codex 正常退出；另记录 {warnings} 条兼容性或诊断警告。")),
        },
        (Some(TerminalCandidate::Completed), _) => failed_outcome(
            "完成事件与进程退出结果冲突",
            Some(format!(
                "收到了 turn.completed，但进程退出码为 {}；为避免误报，按失败处理。",
                exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "未知".to_string())
            )),
        ),
        (None, Some(true)) => failed_outcome(
            "进程结束，但未确认任务完成",
            Some("退出码为 0，但没有收到 turn.completed；可能是事件流截断或协议变化。".to_string()),
        ),
        _ => failed_outcome(
            "Codex 进程异常退出",
            last_stderr
                .map(redact_and_truncate)
                .or_else(|| Some("没有收到可用的完成事件或诊断详情。".to_string())),
        ),
    }
}

fn failed_outcome(label: &'static str, detail: Option<String>) -> FinalOutcome {
    FinalOutcome {
        kind: "task.failed",
        task_state: "failed",
        severity: "error",
        label,
        detail,
    }
}

fn emit(app: &AppHandle, event: &TaskEvent) {
    widget_data::record_task_event(app, event);
    let _ = app.emit(TASK_EVENT_NAME, event.clone());
}

fn validate_project(input: &str) -> Result<PathBuf, String> {
    if input.trim().is_empty() {
        return Err("项目目录不能为空。".to_string());
    }
    let path = fs::canonicalize(input.trim())
        .map_err(|error| format!("项目目录不存在或不可访问：{error}"))?;
    if !path.is_dir() {
        return Err("项目路径不是目录。".to_string());
    }

    let git_check = Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["rev-parse", "--is-inside-work-tree"])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法运行 git 来验证项目目录：{error}"))?;
    if !git_check.status.success() || String::from_utf8_lossy(&git_check.stdout).trim() != "true" {
        return Err("该目录不在 Git 仓库中。请先选择一个 Git 项目目录。".to_string());
    }
    Ok(path)
}

pub(crate) fn locate_codex() -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("CODEX_MONITOR_CODEX_BIN") {
        let path = PathBuf::from(configured);
        if executable_file(&path) {
            return Ok(path);
        }
        return Err("CODEX_MONITOR_CODEX_BIN 指向的文件不存在或不可执行。".to_string());
    }

    let executable_name = if cfg!(windows) { "codex.exe" } else { "codex" };
    if let Some(path) = env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|directory| directory.join(executable_name))
            .find(|candidate| executable_file(candidate))
    }) {
        return Ok(path);
    }

    #[cfg(target_os = "macos")]
    let fixed_candidates = [
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ];
    #[cfg(not(target_os = "macos"))]
    let fixed_candidates: [PathBuf; 0] = [];

    fixed_candidates
        .into_iter()
        .find(|candidate| executable_file(candidate))
        .ok_or_else(|| {
            "没有找到 Codex CLI。请先安装 Codex，或设置 CODEX_MONITOR_CODEX_BIN。".to_string()
        })
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn codex_version(path: &Path) -> Option<String> {
    let output = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

fn default_project_path() -> PathBuf {
    if let Some(path) = env::var_os("CODEX_MONITOR_PROJECT_DIR") {
        return PathBuf::from(path);
    }
    let current = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let current = if current.file_name().is_some_and(|name| name == "src-tauri") {
        current.parent().unwrap_or(&current).to_path_buf()
    } else {
        current
    };
    if is_git_project(&current) {
        return current;
    }

    // Finder-launched macOS apps commonly receive `/` as their working
    // directory.  A debug build can use the manifest directory as a helpful
    // developer default, but a packaged release must not probe the directory
    // where it was compiled (it may be a private Desktop path).  Probing that
    // path before the first window paints triggers a macOS Files & Folders
    // permission prompt and makes the UI look frozen.  In a release build the
    // user therefore chooses the project explicitly in the UI.
    #[cfg(debug_assertions)]
    {
        let compiled_project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf);
        if let Some(compiled_project) = compiled_project {
            if is_git_project(&compiled_project) {
                return compiled_project;
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        current
    }
    #[cfg(not(debug_assertions))]
    {
        // Keep a packaged app's first screen unambiguous: an empty path asks
        // the user to choose a directory instead of displaying Finder's `/`.
        PathBuf::new()
    }
}

fn is_git_project(path: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--is-inside-work-tree"])
        .stdin(Stdio::null())
        .output()
        .map(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true"
        })
        .unwrap_or(false)
}

fn request_termination(pid: u32, child: &Arc<Mutex<Child>>) -> Result<(), String> {
    #[cfg(unix)]
    {
        signal_process_group(pid, libc::SIGTERM).or_else(|_| {
            lock(child)
                .kill()
                .map_err(|error| format!("无法停止 Codex 子进程：{error}"))
        })
    }
    #[cfg(not(unix))]
    {
        lock(child)
            .kill()
            .map_err(|error| format!("无法停止 Codex 子进程：{error}"))
    }
}

fn force_termination(pid: u32, child: &Arc<Mutex<Child>>) {
    #[cfg(unix)]
    {
        let _ = signal_process_group(pid, libc::SIGKILL);
    }
    let _ = lock(child).kill();
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: i32) -> Result<(), String> {
    let pid = i32::try_from(pid).map_err(|_| "子进程 PID 超出可用范围。".to_string())?;
    // SAFETY: the child was created in its own process group and `kill` is called
    // with a valid negative group id plus a platform-provided signal constant.
    let result = unsafe { libc::kill(-pid, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
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
    fn success_requires_terminal_completed_and_clean_exit() {
        let outcome = resolve_final_outcome(
            Some(TerminalCandidate::Completed),
            Some(true),
            Some(0),
            false,
            None,
            None,
            0,
        );
        assert_eq!(outcome.task_state, "completed");
    }

    #[test]
    fn exit_zero_without_terminal_is_not_false_success() {
        let outcome = resolve_final_outcome(None, Some(true), Some(0), false, None, None, 0);
        assert_eq!(outcome.task_state, "failed");
        assert!(outcome.detail.unwrap().contains("turn.completed"));
    }

    #[test]
    fn nonzero_exit_overrides_completed_candidate() {
        let outcome = resolve_final_outcome(
            Some(TerminalCandidate::Completed),
            Some(false),
            Some(1),
            false,
            None,
            None,
            0,
        );
        assert_eq!(outcome.task_state, "failed");
        assert!(outcome.label.contains("冲突"));
    }

    #[test]
    fn user_cancellation_has_an_explicit_terminal_state() {
        let outcome = resolve_final_outcome(None, Some(false), None, true, None, None, 0);
        assert_eq!(outcome.task_state, "cancelled");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn development_default_prefers_a_git_project_over_finder_root() {
        let project = default_project_path();
        assert!(is_git_project(&project), "default path was {:?}", project);
        assert_ne!(project, PathBuf::from("/"));
    }
}
