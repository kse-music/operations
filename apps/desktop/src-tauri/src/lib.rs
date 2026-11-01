mod automation_commands;
pub mod commands;
pub mod file_commands;
mod monitor_commands;
mod ops_commands;
mod product_commands;
mod task_commands;
mod window_state;

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use serverdeck_application::{Application, logging};
use tauri::{Emitter, Manager};

pub fn run() {
    let exiting = Arc::new(AtomicBool::new(false));
    let drained = Arc::new(AtomicBool::new(false));
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main")
                && let Err(error) = window.unminimize().and_then(|()| window.show()).and_then(|()| window.set_focus()) {
                tracing::warn!(operation = "focus_existing_window", error = %error, "could not focus existing window");
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(file_commands::ExitApproval(AtomicBool::new(false)));
            let data = app.path().app_data_dir()?;
            let logs = app.path().app_log_dir()?;
            let application = Application::initialize(data, logs.clone())?;
            let config = tauri::async_runtime::block_on(application.bootstrap())?.config;
            let guard = logging::initialize(&logs, config.log_level)?;
            app.manage(guard);
            let scheduler=application.clone();
            window_state::initialize(app.handle(), &application)?;
            app.manage(application);
            tauri::async_runtime::spawn(async move{if scheduler.start_automation_scheduler().is_err(){tracing::error!(operation="automation_scheduler_start","local scheduler could not start");}});
            tracing::info!(operation = "startup", "ServerDeck initialized");
            Ok(())
        })
        .invoke_handler(command_handler())
        .on_window_event(|window, event| {
            window_state::record(window,event);
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && !window.state::<file_commands::ExitApproval>().0.load(Ordering::Acquire)
            {
                api.prevent_close();
                if window.emit("app-exit-review", window.state::<Application>().exit_pending()).is_err() {
                    tracing::warn!(operation = "exit_review", "could not request window close review");
                }
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started
                && let Some(state) = webview.try_state::<Application>()
            {
                let application = state.inner().clone();
                tauri::async_runtime::spawn(async move {
                    if application.terminal_reset().await.is_err() {
                        tracing::warn!(operation = "webview_reset", "SSH cleanup after page navigation failed");
                    }
                });
            }
        })
        .build(tauri::generate_context!())
        .expect(
            "ServerDeck startup failed; check data directory permissions and configuration version",
        );

    application.run(move |app, event| {
        if let tauri::RunEvent::Exit = event {
            app.state::<logging::Logger>().flush();
        }
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if drained.load(Ordering::Acquire) {
                return;
            }
            api.prevent_exit();
            let pending = app.state::<Application>().exit_pending();
            if !app
                .state::<file_commands::ExitApproval>()
                .0
                .load(Ordering::Acquire)
            {
                if app.emit("app-exit-review", pending).is_err() {
                    tracing::warn!(
                        operation = "exit_review",
                        "could not request exit confirmation"
                    );
                }
                return;
            }
            if !exiting.swap(true, Ordering::AcqRel) {
                let handle = app.clone();
                let drained = drained.clone();
                let state = app.state::<Application>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    window_state::flush(&handle, &state).await;
                    state.shutdown().await;
                    drained.store(true, Ordering::Release);
                    handle.exit(0);
                });
            }
        }
    });
}

pub fn command_handler<R: tauri::Runtime>()
-> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        product_commands::backup_export,
        product_commands::backup_preview,
        product_commands::backup_restore,
        product_commands::background_tasks,
        automation_commands::automation_prepare,
        automation_commands::automation_catalog,
        automation_commands::automation_entry_save,
        automation_commands::automation_entry_delete,
        automation_commands::automation_group_save,
        automation_commands::automation_group_delete,
        automation_commands::automation_start,
        automation_commands::automation_run,
        automation_commands::automation_history,
        automation_commands::automation_cancel,
        automation_commands::automation_approve,
        automation_commands::automation_schedule_save,
        automation_commands::automation_schedule_disable,
        automation_commands::automation_schedule_delete,
        automation_commands::automation_status,
        automation_commands::automation_run_delete,
        task_commands::diagnostic_start,
        task_commands::diagnostic_list,
        task_commands::diagnostic_cancel,
        task_commands::batch_start,
        task_commands::batch_list,
        task_commands::batch_cancel,
        task_commands::batch_retry_file,
        ops_commands::ops_open,
        ops_commands::ops_connections,
        ops_commands::ops_query,
        ops_commands::ops_close,
        ops_commands::ops_feedback,
        ops_commands::ops_log_open,
        ops_commands::ops_log_pause,
        ops_commands::ops_log_ack,
        ops_commands::ops_log_close,
        ops_commands::ops_container_shell,
        monitor_commands::monitor_open,
        monitor_commands::monitor_snapshot,
        monitor_commands::monitor_visible,
        monitor_commands::monitor_stop,
        file_commands::files_connections,
        file_commands::files_open,
        file_commands::files_list,
        file_commands::files_local,
        file_commands::files_properties,
        file_commands::files_action,
        file_commands::files_close,
        file_commands::files_pick,
        file_commands::transfer_start,
        file_commands::transfer_list,
        file_commands::transfer_cancel,
        file_commands::transfer_retry,
        file_commands::text_read,
        file_commands::text_save,
        file_commands::text_dirty,
        file_commands::text_close,
        file_commands::file_terminal,
        file_commands::app_exit_confirm,
        commands::workspace_load,
        commands::workspace_save,
        commands::forward_start,
        commands::forward_list,
        commands::forward_stop,
        commands::terminal_open,
        commands::terminal_input,
        commands::terminal_resize,
        commands::terminal_ack,
        commands::terminal_trust,
        commands::terminal_close,
        commands::terminal_close_host,
        commands::app_bootstrap,
        commands::config_save,
        commands::host_list,
        commands::host_create,
        commands::host_update,
        commands::host_delete,
        commands::host_copy,
        commands::group_save,
        commands::group_delete,
        commands::credential_save,
        commands::credential_delete,
        commands::credential_cleanup,
        commands::credential_status,
        commands::hosts_import_preview,
        commands::hosts_import,
        commands::hosts_export
    ]
}
