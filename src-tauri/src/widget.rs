//! Desktop floating-widget window controls.
//!
//! The widget is a second, deliberately small Tauri webview.  It hosts the
//! same frontend bundle as the main window; the frontend can inspect the
//! webview label (`widget`) and render its compact view.  This module only
//! manages native-window state.  It does not collect Codex data, read
//! credentials, or make the widget a background daemon.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow,
    WebviewWindowBuilder,
};

pub const WIDGET_LABEL: &str = "widget";
pub const WIDGET_CROWN_LABEL: &str = "widget-crown";
const WIDGET_PROJECT_EVENT: &str = "widget-project-changed";
const WIDGET_WINDOW_SHOWN_EVENT: &str = "widget-window-shown";
const WIDGET_WINDOW_HIDDEN_EVENT: &str = "widget-window-hidden";

// The compact native frame is deliberately small. The frontend can still
// call the public Tauri `setSize` API to grow it for the expanded view; these
// values only describe the initial/default window contract.
const WIDGET_DEFAULT_WIDTH: u32 = 220;
const WIDGET_DEFAULT_HEIGHT: u32 = 38;

/// Native settings that are safe to change from the UI.  The value is kept in
/// memory for this MVP; visual/data preferences are persisted by the local
/// widget-data adapter and are intentionally separate from native window state.
#[derive(Debug)]
pub struct WidgetWindowState {
    always_on_top: AtomicBool,
    selected_project_path: Mutex<Option<String>>,
}

impl WidgetWindowState {
    pub fn new() -> Self {
        Self {
            always_on_top: AtomicBool::new(true),
            selected_project_path: Mutex::new(None),
        }
    }

    fn always_on_top(&self) -> bool {
        self.always_on_top.load(Ordering::Relaxed)
    }

    fn set_always_on_top(&self, value: bool) {
        self.always_on_top.store(value, Ordering::Relaxed);
    }

    fn selected_project_path(&self) -> Option<String> {
        self.selected_project_path
            .lock()
            .ok()
            .and_then(|path| path.clone())
    }

    fn set_selected_project_path(&self, path: Option<String>) {
        if let Ok(mut current) = self.selected_project_path.lock() {
            *current = path;
        }
    }
}

impl Default for WidgetWindowState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WidgetWindowSnapshot {
    pub label: String,
    pub exists: bool,
    pub visible: bool,
    pub always_on_top: bool,
    pub selected_project_path: Option<String>,
}

static CREATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn create_lock() -> &'static Mutex<()> {
    CREATE_LOCK.get_or_init(|| Mutex::new(()))
}

/// Create the passive top-band companion used by a coverable camera-safe
/// summary. It stays hidden until the AppKit presentation synchronizer proves
/// that the main widget is a hardware-notch medium surface with pinning off.
/// Keeping creation here (outside an AppKit `with_webview` callback) avoids a
/// nested main-thread wait while another native window is being configured.
#[cfg(target_os = "macos")]
fn ensure_crown_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if app.get_webview_window(WIDGET_CROWN_LABEL).is_some() {
        return Ok(());
    }

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == WIDGET_CROWN_LABEL)
        .ok_or_else(|| "未找到 widget-crown 窗口配置".to_string())?;
    WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| format!("读取顶部状态伴随窗口配置失败：{error}"))?
        .always_on_top(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()
        .map_err(|error| format!("创建顶部状态伴随窗口失败：{error}"))?;
    Ok(())
}

fn hide_crown_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WIDGET_CROWN_LABEL) {
        window
            .hide()
            .map_err(|error| format!("隐藏顶部状态伴随窗口失败：{error}"))?;
    }
    Ok(())
}

fn clamp_i64_to_i32(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

/// Calculate a position whose top edge is flush with a monitor's top edge and
/// whose horizontal axis is centred on that monitor.
///
/// This intentionally uses the complete monitor frame rather than
/// `work_area()`: the latter excludes macOS's menu bar, while a notch-style
/// surface must be allowed to occupy the top edge. Tauri exposes monitor
/// positions in the same top-left desktop coordinate space expected by
/// `set_position`.
///
/// Keeping the calculation pure makes negative monitor origins, an over-sized
/// widget, and empty monitor descriptors testable without creating a native
/// window. All coordinates are physical pixels.
fn top_edge_center_position(
    monitor_position: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
    window_size: PhysicalSize<u32>,
) -> Option<PhysicalPosition<i32>> {
    let monitor_width = i64::from(monitor_size.width);
    let monitor_height = i64::from(monitor_size.height);
    let window_width = i64::from(window_size.width);
    let window_height = i64::from(window_size.height);
    if monitor_width <= 0 || monitor_height <= 0 || window_width <= 0 || window_height <= 0 {
        return None;
    }

    let monitor_left = i64::from(monitor_position.x);
    let horizontal_slack = (monitor_width - window_width).max(0);
    let centered_x = monitor_left + horizontal_slack / 2;
    let max_x = monitor_left + monitor_width - window_width;
    // An over-sized widget cannot be fully contained, but clamping keeps its
    // left edge at the monitor origin instead of producing a surprising drift.
    let x = centered_x.clamp(monitor_left, max_x.max(monitor_left));
    let y = i64::from(monitor_position.y);

    Some(PhysicalPosition::new(
        clamp_i64_to_i32(x),
        clamp_i64_to_i32(y),
    ))
}

/// Pick the monitor that should host a newly-created widget.  The current
/// monitor is preferred so a multi-monitor user gets the capsule near the
/// window they are working in; hidden windows may not have one yet, so the
/// primary monitor and then the first available monitor are safe fallbacks.
fn widget_monitor<R: Runtime>(window: &WebviewWindow<R>) -> Option<Monitor> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| {
            window
                .available_monitors()
                .ok()
                .and_then(|monitors| monitors.into_iter().next())
        })
}

fn widget_size<R: Runtime>(window: &WebviewWindow<R>) -> PhysicalSize<u32> {
    // Some runtimes cannot report outer_size until the native surface is
    // shown; inner_size and the compact config dimensions are fallbacks.
    window
        .outer_size()
        .ok()
        .filter(|size| size.width > 0 && size.height > 0)
        .or_else(|| {
            window
                .inner_size()
                .ok()
                .filter(|size| size.width > 0 && size.height > 0)
        })
        .unwrap_or_else(|| PhysicalSize::new(WIDGET_DEFAULT_WIDTH, WIDGET_DEFAULT_HEIGHT))
}

/// Use Tauri's desktop centre helper only where the desktop runtime exposes
/// it.  Keeping this tiny fallback behind `cfg(desktop)` lets the module stay
/// compilable for Tauri mobile targets too, even though this project ships a
/// desktop widget only.
fn center_widget_fallback<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(desktop)]
    {
        let _ = window.center();
    }

    #[cfg(not(desktop))]
    let _ = window;
}

/// Place a widget at the top centre of its complete monitor frame.
///
/// This is the portable fallback. On macOS, `sync_native_widget` runs after
/// this calculation and replaces the frame with AppKit logical-point geometry
/// derived from the actual `NSScreen` safe area. It never claims ownership of
/// or access to the system camera cut-out itself.
fn place_widget_top_edge<R: Runtime>(window: &WebviewWindow<R>) -> Result<bool, String> {
    let Some(monitor) = widget_monitor(window) else {
        return Ok(false);
    };
    let Some(position) =
        top_edge_center_position(*monitor.position(), *monitor.size(), widget_size(window))
    else {
        return Ok(false);
    };

    window
        .set_position(position)
        .map_err(|error| format!("设置浮动窗口屏幕顶边位置失败：{error}"))?;
    Ok(true)
}

fn snap_widget_to_top_edge<R: Runtime>(window: &WebviewWindow<R>) {
    match place_widget_top_edge(window) {
        Ok(true) => {}
        Ok(false) => {
            // A non-desktop/mock runtime may not expose monitor geometry. A
            // centre fallback keeps the command usable without weakening the
            // real desktop path above.
            center_widget_fallback(window);
        }
        Err(error) => {
            eprintln!("{error}; 回退到屏幕居中位置");
            center_widget_fallback(window);
        }
    }
}

/// Apply the macOS-only AppKit bridge when it is available. Tauri's monitor
/// API remains the cross-platform fallback; failures are logged with a
/// concrete reason so a degraded placement is diagnosable.
fn sync_native_widget<R: Runtime>(
    app: &AppHandle<R>,
    width: Option<f64>,
    height: Option<f64>,
    animate: bool,
    always_on_top: Option<bool>,
    interactive: Option<bool>,
) {
    #[cfg(target_os = "macos")]
    if let Err(error) = crate::macos_window::sync_widget_window_for_app(
        app,
        width,
        height,
        animate,
        always_on_top,
        interactive,
    ) {
        eprintln!("AppKit widget bridge unavailable: {error}");
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, width, height, animate, always_on_top, interactive);
}

/// Show the widget through AppKit on macOS so Tauri does not necessarily make
/// it the key window. Other targets retain the ordinary Tauri show path.
#[cfg(target_os = "macos")]
fn show_widget_window<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    always_on_top: bool,
    interactive: bool,
) -> Result<(), String> {
    let _ = window;
    crate::macos_window::show_widget_window_for_app(app, always_on_top, interactive)
        .map_err(|error| format!("通过 AppKit 显示浮动窗口失败：{error}"))
}

#[cfg(not(target_os = "macos"))]
fn show_widget_window<R: Runtime>(
    _app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    _always_on_top: bool,
    _interactive: bool,
) -> Result<(), String> {
    window
        .show()
        .map_err(|error| format!("显示浮动窗口失败：{error}"))
}

fn normalize_project_path(project_path: Option<String>) -> Option<String> {
    project_path
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
}

fn update_selected_project<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &WidgetWindowState,
    project_path: Option<String>,
) -> Option<String> {
    let path = normalize_project_path(project_path)?;
    state.set_selected_project_path(Some(path.clone()));
    if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
        // Notification is an optimization. The widget polls the native state
        // as a fallback, so a webview that is still starting or shutting down
        // must not make the durable in-memory project hand-off fail.
        let _ = window.emit(WIDGET_PROJECT_EVENT, path.clone());
    }
    Some(path)
}

fn state_snapshot<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &WidgetWindowState,
) -> Result<WidgetWindowSnapshot, String> {
    let window = app.get_webview_window(WIDGET_LABEL);
    let visible = match window.as_ref() {
        Some(window) => window
            .is_visible()
            .map_err(|error| format!("读取浮动窗口可见状态失败：{error}"))?,
        None => false,
    };
    Ok(WidgetWindowSnapshot {
        label: WIDGET_LABEL.to_string(),
        exists: window.is_some(),
        visible,
        always_on_top: state.always_on_top(),
        selected_project_path: state.selected_project_path(),
    })
}

fn configure_and_show<R: tauri::Runtime>(
    app: &AppHandle<R>,
    always_on_top: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = ensure_crown_window(app) {
            // The split-level crown is an optional enhancement. Keep the main
            // project overview usable and let its complete single-window UI
            // act as the fallback when this second WebView cannot be created.
            eprintln!("顶部状态伴随窗口创建失败，已降级为单窗口：{error}");
        }
        // A newly shown widget starts from the conservative compact bootstrap.
        // The explicit frontend presentation sync will reveal the companion only
        // for the one supported split-level medium configuration.
        if let Err(error) = hide_crown_window(app) {
            eprintln!("顶部状态伴随窗口预隐藏失败：{error}");
        }
    }
    if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
        // On macOS the AppKit bridge is the single owner of the native level.
        // tao schedules `set_always_on_top` asynchronously; calling it here
        // immediately before the synchronous AppKit write can race and put a
        // user-disabled shelf back at the floating level. Other targets keep
        // the ordinary Tauri setter.
        #[cfg(not(target_os = "macos"))]
        window
            .set_always_on_top(always_on_top)
            .map_err(|error| format!("设置浮动窗口层级失败：{error}"))?;
        // The notch presentation is a passive overlay and must not become key.
        // On macOS an existing floating host keeps the focusability configured
        // by the placement bridge; resetting it here would break its controls
        // after hide/show.
        #[cfg(not(target_os = "macos"))]
        window
            .set_focusable(false)
            .map_err(|error| format!("设置浮动窗口非聚焦模式失败：{error}"))?;
        // Re-anchor an existing (possibly hidden) widget as well. This keeps
        // repeated "show" actions aligned with the current display instead of
        // restoring a stale window-manager position.
        #[cfg(not(target_os = "macos"))]
        snap_widget_to_top_edge(&window);
        sync_native_widget(app, None, None, false, Some(always_on_top), Some(false));
        show_widget_window(app, &window, always_on_top, false)?;
        // Some window managers apply a hidden window's position lazily; a
        // second pass after show makes the top-edge contract deterministic.
        #[cfg(not(target_os = "macos"))]
        snap_widget_to_top_edge(&window);
        sync_native_widget(app, None, None, false, Some(always_on_top), Some(false));
        return Ok(());
    }

    // The command is async so creation runs through Tauri's command runtime;
    // this avoids the WebView2 synchronous-creation deadlock documented by
    // Tauri on Windows.
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == WIDGET_LABEL)
        .ok_or_else(|| "未找到 widget 窗口配置".to_string())?;
    let window = WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| format!("读取浮动窗口配置失败：{error}"))?
        .always_on_top(always_on_top)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()
        .map_err(|error| format!("创建浮动窗口失败：{error}"))?;

    // The initial Tauri frame is only a cross-platform bootstrap. On macOS the
    // AppKit bridge immediately re-anchors it to the real screen safe area;
    // other platforms retain the complete-monitor top-edge fallback. The
    // frontend may later call `setSize` to reveal its expanded content.
    snap_widget_to_top_edge(&window);
    sync_native_widget(app, None, None, false, Some(always_on_top), Some(false));

    show_widget_window(app, &window, always_on_top, false)?;
    sync_native_widget(app, None, None, false, Some(always_on_top), Some(false));
    Ok(())
}

/// Show (or recreate) the compact desktop widget.
#[tauri::command]
pub async fn show_widget(
    app: AppHandle,
    state: tauri::State<'_, WidgetWindowState>,
    project_path: Option<String>,
) -> Result<WidgetWindowSnapshot, String> {
    update_selected_project(&app, &state, project_path);
    let always_on_top = state.always_on_top();
    let _guard = create_lock()
        .lock()
        .map_err(|_| "浮动窗口创建锁已损坏".to_string())?;
    configure_and_show(&app, always_on_top)?;
    if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
        // Existing hidden WebViews do not reliably receive a document
        // visibilitychange when their native NSWindow returns. This explicit
        // lifecycle event lets the renderer immediately re-apply its saved
        // medium/compact presentation instead of waiting for the 5s poll.
        let _ = window.emit(WIDGET_WINDOW_SHOWN_EVENT, ());
    }
    state_snapshot(&app, &state)
}

/// Change the project observed by the sticky note without showing or focusing
/// it. The event makes an existing webview refresh immediately; a window that
/// is created later reads the same value through `get_widget_state`.
#[tauri::command]
pub fn set_widget_project(
    app: AppHandle,
    state: tauri::State<'_, WidgetWindowState>,
    project_path: String,
) -> Result<WidgetWindowSnapshot, String> {
    if update_selected_project(&app, &state, Some(project_path)).is_none() {
        return Err("项目概览路径不能为空。".to_string());
    }
    state_snapshot(&app, &state)
}

/// Hide the widget without destroying it.  A later `show_widget` call can
/// restore it with its current native settings.
#[tauri::command]
pub fn hide_widget(
    app: AppHandle,
    state: tauri::State<'_, WidgetWindowState>,
) -> Result<WidgetWindowSnapshot, String> {
    let main_result = if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
        // Invalidate the renderer's split-surface ownership before both
        // native windows disappear. The WebView stays alive while hidden, so
        // a later show starts with its complete main header instead of reusing
        // a painted acknowledgement from the previous visibility session.
        let _ = window.emit(WIDGET_WINDOW_HIDDEN_EVENT, ());
        window
            .hide()
            .map_err(|error| format!("隐藏浮动窗口失败：{error}"))
    } else {
        Ok(())
    };
    // Always attempt both hides. A failure in one native host must not leave
    // the other host visible solely because the function returned early.
    let crown_result = hide_crown_window(&app);
    main_result?;
    crown_result?;
    state_snapshot(&app, &state)
}

/// Toggle visibility of the widget.
#[tauri::command]
pub async fn toggle_widget(
    app: AppHandle,
    state: tauri::State<'_, WidgetWindowState>,
) -> Result<WidgetWindowSnapshot, String> {
    if app
        .get_webview_window(WIDGET_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
    {
        hide_widget(app, state)
    } else {
        show_widget(app, state, None).await
    }
}

/// Persist the requested stacking preference. The AppKit bridge decides which
/// presentation may honour it: floating surfaces and the camera-safe summary
/// do, while compact/expanded camera-safe surfaces keep their hardware anchor.
#[tauri::command]
pub fn set_widget_always_on_top(
    app: AppHandle,
    state: tauri::State<'_, WidgetWindowState>,
    enabled: bool,
) -> Result<WidgetWindowSnapshot, String> {
    state.set_always_on_top(enabled);
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
        window
            .set_always_on_top(enabled)
            .map_err(|error| format!("设置浮动窗口层级失败：{error}"))?;
    }
    #[cfg(target_os = "macos")]
    if app.get_webview_window(WIDGET_LABEL).is_some() {
        crate::macos_window::sync_widget_window_for_app(
            &app,
            None,
            None,
            false,
            Some(enabled),
            None,
        )
        .map_err(|error| format!("同步项目概览原生层级状态失败：{error}"))?;
    }
    state_snapshot(&app, &state)
}

/// The main window remains a normal native window.  This explicit command is
/// useful for a compact UI button and preserves the distinction between
/// minimizing the app and hiding the floating widget.
#[tauri::command]
pub fn minimize_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    window
        .minimize()
        .map_err(|error| format!("最小化主窗口失败：{error}"))
}

/// Restore the normal dashboard from the compact widget.
#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    window
        .show()
        .map_err(|error| format!("显示主窗口失败：{error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("恢复主窗口失败：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦主窗口失败：{error}"))
}

/// Return the current native state without creating a window.
#[tauri::command]
pub fn get_widget_state(
    app: AppHandle,
    state: tauri::State<'_, WidgetWindowState>,
) -> Result<WidgetWindowSnapshot, String> {
    state_snapshot(&app, &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_edge_center_position_uses_the_complete_monitor_frame() {
        let position = top_edge_center_position(
            PhysicalPosition::new(0, 23),
            PhysicalSize::new(1920, 1080),
            PhysicalSize::new(400, 46),
        )
        .expect("valid monitor should produce a position");

        assert_eq!(position, PhysicalPosition::new(760, 23));
    }

    #[test]
    fn top_edge_center_position_handles_negative_monitor_origins() {
        let position = top_edge_center_position(
            PhysicalPosition::new(-1280, 0),
            PhysicalSize::new(1280, 800),
            PhysicalSize::new(400, 46),
        )
        .expect("valid monitor should produce a position");

        assert_eq!(position, PhysicalPosition::new(-840, 0));
    }

    #[test]
    fn top_edge_center_position_clamps_an_oversized_widget() {
        let position = top_edge_center_position(
            PhysicalPosition::new(10, 20),
            PhysicalSize::new(300, 200),
            PhysicalSize::new(500, 260),
        )
        .expect("non-empty monitor should still produce a fallback position");

        assert_eq!(position, PhysicalPosition::new(10, 20));
    }

    #[test]
    fn top_edge_center_position_rejects_empty_monitor_frames() {
        assert_eq!(
            top_edge_center_position(
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(0, 800),
                PhysicalSize::new(400, 46),
            ),
            None
        );
        assert_eq!(
            top_edge_center_position(
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(1920, 0),
                PhysicalSize::new(400, 46),
            ),
            None
        );
        assert_eq!(
            top_edge_center_position(
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(1920, 1080),
                PhysicalSize::new(0, 46),
            ),
            None
        );
    }

    #[test]
    fn snapshot_contract_uses_camel_case_for_selected_project() {
        let snapshot = WidgetWindowSnapshot {
            label: WIDGET_LABEL.to_string(),
            exists: false,
            visible: false,
            always_on_top: true,
            selected_project_path: Some("/tmp/example".to_string()),
        };

        let value = serde_json::to_value(snapshot).expect("snapshot should serialize");
        assert_eq!(value["selectedProjectPath"], "/tmp/example");
        assert!(value.get("selected_project_path").is_none());
    }

    #[test]
    fn project_path_normalization_trims_and_rejects_empty_values() {
        assert_eq!(
            normalize_project_path(Some("  /tmp/example  ".to_string())),
            Some("/tmp/example".to_string())
        );
        assert_eq!(normalize_project_path(Some("  \n ".to_string())), None);
        assert_eq!(normalize_project_path(None), None);
    }
}
