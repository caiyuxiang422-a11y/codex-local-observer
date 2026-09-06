//! Fourth-step foundations: capability discovery and an explicit workspace list.
//!
//! This module deliberately stops at observable, reversible operations. It does
//! not start a long-lived App Server, answer approval requests, read auth files,
//! call the Usage API, or execute plugins. Those features need a versioned
//! protocol and an explicit permission model first.

use crate::codex;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const SCHEMA_VERSION: u8 = 1;
const SOURCE: &str = "local.advanced_capabilities";
const WORKSPACE_SOURCE: &str = "local.workspace_registry";
const STORE_FILE_NAME: &str = "workspace-registry-v1.json";
const MAX_WORKSPACES: usize = 50;
const MAX_STORE_BYTES: usize = 512 * 1024;
const MAX_ID_CHARS: usize = 80;
const MAX_NAME_CHARS: usize = 160;
const MAX_PATH_CHARS: usize = 4096;
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PROBE_OUTPUT: usize = 32 * 1024;
static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedCapabilitiesSnapshot {
    pub schema_version: u8,
    pub source: String,
    pub collected_at: u64,
    pub confidence: String,
    pub capabilities: Vec<AdvancedCapability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedCapability {
    pub id: String,
    pub status: String,
    pub label: String,
    pub detail: String,
    pub evidence: Vec<CapabilityEvidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityEvidence {
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceRequest {
    pub workspace: WorkspaceInput,
    #[serde(default)]
    pub make_active: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorkspaceRequest {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInput {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub added_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub schema_version: u8,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_project_path: Option<String>,
    pub workspaces: Vec<Workspace>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceStore {
    schema_version: u8,
    active_project_path: Option<String>,
    workspaces: Vec<Workspace>,
}

#[derive(Debug)]
struct ProbeResult {
    success: bool,
    timed_out: bool,
    output: String,
}

/// Read-only feature probe. The command only asks the installed binary for
/// help/version text; it never starts app-server daemon or opens a socket.
#[tauri::command]
pub async fn get_advanced_capabilities() -> Result<AdvancedCapabilitiesSnapshot, String> {
    tauri::async_runtime::spawn_blocking(probe_capabilities)
        .await
        .map_err(|error| format!("高级能力探测线程异常结束：{error}"))?
}

fn probe_capabilities() -> Result<AdvancedCapabilitiesSnapshot, String> {
    let collected_at = now_ms();
    let codex_path = match codex::locate_codex() {
        Ok(path) => path,
        Err(error) => {
            return Ok(unavailable_capabilities(collected_at, error));
        }
    };
    let version = probe(&codex_path, &["--version"]);
    let app_server = probe(&codex_path, &["app-server", "--help"]);
    let resume = probe(&codex_path, &["exec", "resume", "--help"]);

    let version_detail = if version.output.is_empty() {
        "未读取到版本文本".to_string()
    } else {
        format!("检测到 {}", truncate(&version.output, 180))
    };
    let app_server_status = if app_server.success {
        "experimental"
    } else {
        "notVerified"
    };
    let app_server_detail = if app_server.timed_out {
        "app-server 帮助探测超时；没有启动服务。".to_string()
    } else if app_server.success {
        "CLI 暴露实验性 App Server 入口；本工具尚未绑定双向 JSON-RPC。".to_string()
    } else {
        "当前 CLI 未能通过帮助探测确认 App Server。".to_string()
    };
    let resume_detail = if resume.success {
        "CLI 暴露 exec resume，但本工具当前任务使用 --ephemeral，恢复尚未接入。".to_string()
    } else if resume.timed_out {
        "恢复入口探测超时；没有读取会话文件。".to_string()
    } else {
        "当前 CLI 未能通过帮助探测确认恢复入口。".to_string()
    };

    Ok(AdvancedCapabilitiesSnapshot {
        schema_version: SCHEMA_VERSION,
        source: SOURCE.to_string(),
        collected_at,
        confidence: if version.success {
            "high".to_string()
        } else {
            "medium".to_string()
        },
        capabilities: vec![
            capability(
                "appServer",
                app_server_status,
                "App Server",
                app_server_detail,
                vec![
                    evidence("binary", codex_path.to_string_lossy().into_owned()),
                    evidence("version", version_detail),
                    evidence("help", probe_evidence(&app_server)),
                ],
            ),
            capability(
                "sessionRecovery",
                "notVerified",
                "会话恢复",
                resume_detail,
                vec![evidence("help", probe_evidence(&resume))],
            ),
            capability(
                "approvals",
                "notVerified",
                "审批",
                "审批消息需要 App Server 协议和逐次权限确认；当前不会自动批准任何请求。"
                    .to_string(),
                vec![evidence(
                    "policy",
                    "默认只读沙箱；未接入审批响应。".to_string(),
                )],
            ),
            capability(
                "usageApi",
                "notConfigured",
                "Usage API",
                "需要用户明确配置组织级 API 凭据和统计周期；当前不读取密钥、不请求网络。"
                    .to_string(),
                vec![evidence(
                    "policy",
                    "不会把 API 用量解释为 ChatGPT/Codex 订阅额度。".to_string(),
                )],
            ),
            capability(
                "multiProject",
                "available",
                "多项目",
                "本地工作区注册表已启用；只保存用户主动添加的目录，不扫描磁盘。".to_string(),
                vec![evidence("adapter", "local.workspace_registry".to_string())],
            ),
            capability(
                "plugins",
                "disabled",
                "插件系统",
                "插件执行默认关闭；尚未定义 manifest 信任、权限隔离和卸载协议。".to_string(),
                vec![evidence("policy", "不会发现或执行第三方代码。".to_string())],
            ),
        ],
    })
}

fn unavailable_capabilities(collected_at: u64, error: String) -> AdvancedCapabilitiesSnapshot {
    let ids = [
        ("appServer", "App Server", "notVerified"),
        ("sessionRecovery", "会话恢复", "notVerified"),
        ("approvals", "审批", "notVerified"),
        ("usageApi", "Usage API", "notConfigured"),
        ("multiProject", "多项目", "available"),
        ("plugins", "插件系统", "disabled"),
    ];
    AdvancedCapabilitiesSnapshot {
        schema_version: SCHEMA_VERSION,
        source: SOURCE.to_string(),
        collected_at,
        confidence: "none".to_string(),
        capabilities: ids
            .into_iter()
            .map(|(id, label, status)| {
                capability(
                    id,
                    status,
                    label,
                    if id == "multiProject" {
                        "本地工作区注册表仍可使用；Codex CLI 缺失不影响目录登记。".to_string()
                    } else if id == "plugins" {
                        "插件执行默认关闭。".to_string()
                    } else if id == "usageApi" {
                        "尚未配置组织级 Usage API 凭据。".to_string()
                    } else {
                        "没有找到可探测的 Codex CLI；能力状态未验证。".to_string()
                    },
                    vec![evidence("error", error.clone())],
                )
            })
            .collect(),
    }
}

fn capability(
    id: &str,
    status: &str,
    label: &str,
    detail: String,
    evidence: Vec<CapabilityEvidence>,
) -> AdvancedCapability {
    AdvancedCapability {
        id: id.to_string(),
        status: status.to_string(),
        label: label.to_string(),
        detail,
        evidence,
    }
}

fn evidence(kind: &str, detail: String) -> CapabilityEvidence {
    CapabilityEvidence {
        kind: kind.to_string(),
        detail,
    }
}

fn probe_evidence(result: &ProbeResult) -> String {
    if result.timed_out {
        return "探测超时".to_string();
    }
    if result.success {
        return format!("命令成功；输出：{}", truncate(&result.output, 240));
    }
    if result.output.is_empty() {
        "命令失败且没有诊断输出".to_string()
    } else {
        format!("命令失败；输出：{}", truncate(&result.output, 240))
    }
}

fn probe(path: &Path, args: &[&str]) -> ProbeResult {
    let mut child = match Command::new(path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return ProbeResult {
                success: false,
                timed_out: false,
                output: error.to_string(),
            }
        }
    };
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map(|output| combine_output(&output.stdout, &output.stderr))
                    .unwrap_or_default();
                return ProbeResult {
                    success: status.success(),
                    timed_out: false,
                    output,
                };
            }
            Ok(None) if start.elapsed() < PROBE_TIMEOUT => {
                thread::sleep(Duration::from_millis(15));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let output = child
                    .wait_with_output()
                    .map(|output| combine_output(&output.stdout, &output.stderr))
                    .unwrap_or_default();
                return ProbeResult {
                    success: false,
                    timed_out: true,
                    output,
                };
            }
        }
    }
}

fn combine_output(stdout: &[u8], stderr: &[u8]) -> String {
    let mut text = String::from_utf8_lossy(stdout).to_string();
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push_str(" | ");
        }
        text.push_str(&String::from_utf8_lossy(stderr));
    }
    // Help output should be harmless, but failures can still echo a config
    // path or a token-shaped diagnostic. Reuse the shared redaction boundary.
    crate::events::redact_and_truncate(&truncate(&text, MAX_PROBE_OUTPUT))
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut result = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        result.push('…');
    }
    result
}

#[tauri::command]
pub async fn list_workspaces(app: AppHandle) -> Result<WorkspaceSnapshot, String> {
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_workspaces_sync(&path))
        .await
        .map_err(|error| format!("工作区读取线程异常结束：{error}"))?
}

#[tauri::command]
pub async fn save_workspace(
    app: AppHandle,
    request: SaveWorkspaceRequest,
) -> Result<WorkspaceSnapshot, String> {
    let workspace = validate_workspace(request.workspace)?;
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        save_workspace_sync(&path, workspace, request.make_active)
    })
    .await
    .map_err(|error| format!("工作区保存线程异常结束：{error}"))?
}

#[tauri::command]
pub async fn delete_workspace(
    app: AppHandle,
    request: DeleteWorkspaceRequest,
) -> Result<WorkspaceSnapshot, String> {
    let id = validate_id(&request.id)?;
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || delete_workspace_sync(&path, &id))
        .await
        .map_err(|error| format!("工作区删除线程异常结束：{error}"))?
}

fn list_workspaces_sync(path: &Path) -> Result<WorkspaceSnapshot, String> {
    let _guard = store_guard()?;
    let store = load_store(path)?;
    Ok(snapshot(store))
}

fn save_workspace_sync(
    path: &Path,
    mut workspace: Workspace,
    make_active: bool,
) -> Result<WorkspaceSnapshot, String> {
    let _guard = store_guard()?;
    let mut store = load_store(path)?;
    let now = now_ms();
    let existing = store
        .workspaces
        .iter_mut()
        .find(|item| item.id == workspace.id || item.path == workspace.path);
    if let Some(existing) = existing {
        workspace.added_at = existing.added_at;
        workspace.last_used_at = Some(now);
        *existing = workspace.clone();
    } else {
        if store.workspaces.len() >= MAX_WORKSPACES {
            return Err(format!("工作区数量不能超过 {MAX_WORKSPACES} 个。"));
        }
        workspace.added_at = now;
        workspace.last_used_at = Some(now);
        store.workspaces.push(workspace.clone());
    }
    if make_active {
        store.active_project_path = Some(workspace.path);
    }
    store.schema_version = SCHEMA_VERSION;
    write_store(path, &store)?;
    Ok(snapshot(store))
}

fn delete_workspace_sync(path: &Path, id: &str) -> Result<WorkspaceSnapshot, String> {
    let _guard = store_guard()?;
    let mut store = load_store(path)?;
    let before = store.workspaces.len();
    let removed_path = store
        .workspaces
        .iter()
        .find(|workspace| workspace.id == id)
        .map(|workspace| workspace.path.clone());
    store.workspaces.retain(|workspace| workspace.id != id);
    if before == store.workspaces.len() {
        return Err("找不到要删除的工作区。".to_string());
    }
    if removed_path.as_deref() == store.active_project_path.as_deref() {
        store.active_project_path = store.workspaces.first().map(|item| item.path.clone());
    }
    write_store(path, &store)?;
    Ok(snapshot(store))
}

fn validate_workspace(input: WorkspaceInput) -> Result<Workspace, String> {
    let id = if input.id.trim().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        validate_id(&input.id)?
    };
    let raw_path = input.path.trim();
    if raw_path.is_empty() || raw_path.chars().count() > MAX_PATH_CHARS {
        return Err("工作区路径不能为空且不能超过 4096 个字符。".to_string());
    }
    if raw_path.chars().any(|ch| ch.is_control()) {
        return Err("工作区路径不能包含控制字符。".to_string());
    }
    let path = fs::canonicalize(raw_path)
        .map_err(|error| format!("工作区目录不存在或不可访问：{error}"))?;
    if !path.is_dir() {
        return Err("工作区路径不是目录。".to_string());
    }
    let name = input.name.trim().to_string();
    let name = if name.is_empty() {
        path.file_name()
            .and_then(|part| part.to_str())
            .unwrap_or("未命名项目")
            .to_string()
    } else {
        name
    };
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("工作区名称不能超过 {MAX_NAME_CHARS} 个字符。"));
    }
    if name.chars().any(|ch| ch.is_control()) {
        return Err("工作区名称不能包含控制字符。".to_string());
    }
    Ok(Workspace {
        id,
        name,
        path: path.to_string_lossy().into_owned(),
        added_at: 0,
        last_used_at: None,
    })
}

fn validate_id(value: &str) -> Result<String, String> {
    let id = value.trim();
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
        return Err(format!(
            "工作区 ID 不能为空且不能超过 {MAX_ID_CHARS} 个字符。"
        ));
    }
    if id.chars().any(|ch| ch.is_control()) {
        return Err("工作区 ID 不能包含控制字符。".to_string());
    }
    Ok(id.to_string())
}

fn snapshot(store: WorkspaceStore) -> WorkspaceSnapshot {
    WorkspaceSnapshot {
        schema_version: SCHEMA_VERSION,
        source: WORKSPACE_SOURCE.to_string(),
        updated_at: now_ms(),
        confidence: "high".to_string(),
        active_project_path: store.active_project_path,
        workspaces: store.workspaces,
    }
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(STORE_FILE_NAME))
        .map_err(|error| format!("无法确定应用数据目录：{error}"))
}

fn load_store(path: &Path) -> Result<WorkspaceStore, String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkspaceStore {
                schema_version: SCHEMA_VERSION,
                active_project_path: None,
                workspaces: Vec::new(),
            });
        }
        Err(error) => return Err(format!("无法读取工作区注册表：{error}")),
    };
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取工作区注册表元数据：{error}"))?;
    if metadata.len() > MAX_STORE_BYTES as u64 {
        return Err("工作区注册表超过安全大小上限。".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取工作区注册表内容：{error}"))?;
    let store: WorkspaceStore =
        serde_json::from_slice(&bytes).map_err(|error| format!("工作区注册表格式损坏：{error}"))?;
    if store.schema_version != SCHEMA_VERSION || store.workspaces.len() > MAX_WORKSPACES {
        return Err("工作区注册表版本或数量不受支持。".to_string());
    }
    Ok(store)
}

fn write_store(path: &Path, store: &WorkspaceStore) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "工作区注册表路径没有父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".{STORE_FILE_NAME}.{counter}.tmp"));
    let data = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("无法编码工作区注册表：{error}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).truncate(true);
    let mut file = options
        .open(&temp)
        .map_err(|error| format!("无法创建工作区临时文件：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("无法限制工作区注册表权限：{error}"))?;
    }
    file.write_all(&data)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法写入工作区注册表：{error}"))?;
    drop(file);
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("无法原子替换工作区注册表：{error}")
    })
}

fn store_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "工作区注册表锁已损坏。".to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn truncate_is_bounded_and_marks_loss() {
        assert_eq!(truncate("abcdef", 3), "abc…");
        assert_eq!(truncate("abc", 3), "abc");
    }

    #[test]
    fn workspace_validation_canonicalizes_and_rejects_controls() {
        let directory = std::env::temp_dir().join(format!("codex-observer-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let result = validate_workspace(WorkspaceInput {
            id: "one".to_string(),
            name: " Demo ".to_string(),
            path: directory.to_string_lossy().into_owned(),
        })
        .unwrap();
        assert_eq!(result.name, "Demo");
        assert!(validate_id("bad\nvalue").is_err());
        assert!(validate_workspace(WorkspaceInput {
            id: "two".to_string(),
            name: "bad\nname".to_string(),
            path: directory.to_string_lossy().into_owned(),
        })
        .is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn store_round_trip_is_json_and_bounded() {
        let directory = std::env::temp_dir().join(format!("codex-observer-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(STORE_FILE_NAME);
        let store = WorkspaceStore {
            schema_version: SCHEMA_VERSION,
            active_project_path: None,
            workspaces: Vec::new(),
        };
        write_store(&path, &store).unwrap();
        let loaded = load_store(&path).unwrap();
        assert_eq!(loaded.schema_version, SCHEMA_VERSION);
        assert!(loaded.workspaces.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn capability_probe_has_all_declared_ids_when_cli_missing() {
        let snapshot = unavailable_capabilities(1, "missing".to_string());
        let ids: Vec<_> = snapshot
            .capabilities
            .iter()
            .map(|item| item.id.as_str())
            .collect();
        assert_eq!(ids.len(), 6);
        assert!(ids.contains(&"multiProject"));
    }

    #[cfg(unix)]
    #[test]
    fn probe_captures_a_successful_help_like_command() {
        let result = probe(Path::new("/bin/echo"), &["probe-ok"]);
        assert!(result.success);
        assert!(!result.timed_out);
        assert!(result.output.contains("probe-ok"));
    }
}
