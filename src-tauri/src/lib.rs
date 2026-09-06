mod account;
mod advanced;
mod codex;
mod events;
mod macos_window;
mod progress;
mod project_status;
mod system_metrics;
mod widget;
mod widget_data;

use codex::TaskManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(TaskManager::default())
        .manage(system_metrics::SystemMetricsState::default())
        .manage(widget::WidgetWindowState::default())
        .invoke_handler(tauri::generate_handler![
            codex::get_environment,
            codex::start_task,
            codex::stop_task,
            advanced::get_advanced_capabilities,
            account::get_account_usage,
            account::get_project_usage,
            advanced::list_workspaces,
            advanced::save_workspace,
            advanced::delete_workspace,
            progress::get_project_progress,
            progress::list_project_progress,
            progress::save_project_progress,
            project_status::get_project_status,
            system_metrics::get_system_metrics,
            widget_data::get_widget_snapshot,
            widget_data::get_widget_preferences,
            widget_data::save_widget_preferences,
            widget::show_widget,
            widget::set_widget_project,
            widget::hide_widget,
            widget::toggle_widget,
            widget::set_widget_always_on_top,
            widget::minimize_main_window,
            widget::show_main_window,
            widget::get_widget_state,
            macos_window::get_macos_notch_geometry,
            macos_window::get_macos_pointer_proximity,
            macos_window::sync_macos_widget_window
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Codex Local Observer");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app_handle.state::<TaskManager>().shutdown();
        }
    });
}
