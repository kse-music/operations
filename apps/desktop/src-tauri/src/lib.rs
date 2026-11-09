mod ai_commands;
pub mod commands;
pub mod file_commands;
mod monitor_commands;
mod ops_commands;
mod plugin_commands;
mod plugin_ui_protocol;
mod product_commands;
pub mod storage_commands;
mod terminal_upload_commands;
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
    let application = plugin_ui_protocol::register(tauri::Builder::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main")
                && let Err(error) = window.unminimize().and_then(|()| window.show()).and_then(|()| window.set_focus()) {
                tracing::warn!(operation = "focus_existing_window", error = %error, "could not focus existing window");
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let initialized = (|| -> Result<(), Box<dyn std::error::Error>> {
                app.manage(file_commands::ExitApproval(AtomicBool::new(false)));
                let data = app.path().app_data_dir()?;
                let logs = app.path().app_log_dir()?;
                let profile = serverdeck_application::storage_location::Profile::open(
                    app.path().app_config_dir()?.join(serverdeck_application::storage_location::LOCATOR),
                    serverdeck_application::storage_location::Locations { data, logs, webview: app.path().app_local_data_dir()? },
                )?;
                let locations = profile.locations().clone();
                // Record upgrade failures before loading configuration. Apply the
                // persisted log level only after its safe upgrade has completed.
                let guard = logging::initialize(&locations.logs, serverdeck_core::LogLevel::Info)?;
                app.manage(guard);
                let application = Application::initialize(locations.data, locations.logs.clone())?;
                profile.record_initialized()?;
                let config = tauri::async_runtime::block_on(application.bootstrap())?.config;
                app.state::<logging::Logger>().set_level(config.log_level)?;
                application.provision_bundled_plugins()?;
                app.manage(storage_commands::StorageState::new(profile));
                app.manage(application);
                let window_config = app.config().app.windows.iter().find(|w| w.label == "main")
                    .ok_or("main window configuration missing")?;
                tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
                    .data_directory(locations.webview).build()?;
                window_state::initialize(app.handle(), &app.state::<Application>())?;
                tracing::info!(operation = "startup", "ServerDeck initialized");
                Ok(())
            })();
            if let Err(error) = &initialized {
                use tauri_plugin_dialog::DialogExt;
                app.dialog().message(format!("无法打开应用数据：{error}\n请检查已配置的目录、磁盘和权限。不会切换到替代空数据库。"))
                    .title("ServerDeck 启动失败").kind(tauri_plugin_dialog::MessageDialogKind::Error).blocking_show();
            }
            initialized
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
                    if handle
                        .state::<storage_commands::StorageState>()
                        .restart
                        .load(Ordering::Acquire)
                    {
                        handle.state::<logging::Logger>().flush();
                        handle.request_restart();
                    } else {
                        handle.exit(0);
                    }
                });
            }
        }
    });
}

pub fn command_handler<R: tauri::Runtime>()
-> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        storage_commands::app_storage_preview,
        storage_commands::app_storage_migrate,
        storage_commands::app_storage_ready,
        plugin_commands::plugin_preview,
        plugin_commands::plugin_preview_info,
        plugin_commands::plugin_ui,
        plugin_commands::plugin_pick,
        plugin_commands::plugin_save_development_kit,
        plugin_commands::plugin_statuses,
        plugin_commands::plugin_activate,
        plugin_commands::plugin_call,
        plugin_commands::plugin_continue,
        plugin_commands::plugin_close_scope,
        plugin_commands::plugin_cancel_scope,
        plugin_commands::plugin_scope_visibility,
        plugin_commands::plugin_platform_terminal_open,
        plugin_commands::plugin_health,
        plugin_commands::plugin_cancel,
        plugin_commands::plugin_grant,
        plugin_commands::plugin_permissions,
        plugin_commands::plugin_revoke,
        plugin_commands::plugin_reset,
        plugin_commands::plugin_approve,
        plugin_commands::plugin_events,
        plugin_commands::plugin_capability,
        plugin_commands::plugin_install,
        plugin_commands::plugin_list,
        plugin_commands::plugin_inventory,
        plugin_commands::plugin_reinstall_bundled,
        plugin_commands::plugin_detail,
        plugin_commands::plugin_set_enabled,
        plugin_commands::plugin_uninstall,
        ai_commands::ai_models,
        ai_commands::ai_local_codex_status,
        ai_commands::ai_local_tool_install,
        ai_commands::ai_local_tool_install_cancel,
        ai_commands::ai_local_codex_authorize,
        ai_commands::ai_local_claude_code_status,
        ai_commands::ai_local_claude_code_authorize,
        ai_commands::ai_model_save,
        ai_commands::ai_model_test,
        ai_commands::ai_model_delete,
        product_commands::background_tasks,
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
        file_commands::files_switch_user,
        file_commands::files_list,
        file_commands::files_local,
        file_commands::files_local_drives,
        file_commands::files_open_local,
        file_commands::external_prepare,
        file_commands::external_ready,
        file_commands::external_save,
        file_commands::external_cancel,
        file_commands::files_properties,
        file_commands::files_action,
        file_commands::files_close,
        file_commands::files_pick,
        file_commands::files_drag_download,
        file_commands::transfer_start,
        file_commands::transfer_list,
        file_commands::transfer_clear_host,
        file_commands::transfer_cancel,
        file_commands::transfer_retry,
        file_commands::text_read,
        file_commands::text_save,
        file_commands::text_dirty,
        file_commands::text_close,
        file_commands::file_terminal,
        file_commands::app_exit_confirm,
        commands::forward_start,
        commands::forward_list,
        commands::forward_stop,
        commands::terminal_open,
        terminal_upload_commands::terminal_upload_pick,
        terminal_upload_commands::terminal_upload_read,
        terminal_upload_commands::terminal_upload_release,
        commands::terminal_local_open,
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
        commands::host_test,
        commands::host_create_tested,
        commands::host_update_tested,
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
        commands::hosts_import
    ]
}
