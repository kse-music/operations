mod ai_commands;
pub mod browser_commands;
pub mod commands;
pub mod editor_commands;
pub mod file_commands;
mod monitor_commands;
mod ops_commands;
mod plugin_commands;
mod plugin_ui_protocol;
mod product_commands;
pub mod storage_commands;
mod terminal_upload_commands;
pub mod update_commands;
mod window_state;
mod zmodem_commands;

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use serverdeck_application::{Application, logging};
use tauri::{Emitter, Manager};

const PREVENT_NATIVE_CONTEXT_MENU: &str = include_str!("prevent-native-context-menu.js");

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let initialized = (|| -> Result<(), Box<dyn std::error::Error>> {
                app.manage(file_commands::ExitApproval(AtomicBool::new(false)));
                app.manage(update_commands::Updates::default());
                let data = app.path().app_data_dir()?;
                let logs = app.path().app_log_dir()?;
                let profile = serverdeck_application::storage_location::Profile::open(
                    app.path().app_config_dir()?.join(serverdeck_application::storage_location::LOCATOR),
                    serverdeck_application::storage_location::Locations { data, logs, webview: app.path().app_local_data_dir()? },
                )?;
                let locations = profile.locations().clone();
                app.manage(editor_commands::EditorWindows::new(locations.webview.clone()));
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
                    .initialization_script_for_all_frames(PREVENT_NATIVE_CONTEXT_MENU)
                    .on_navigation({
                        let handle = app.handle().clone();
                        move |_| !handle.state::<editor_commands::EditorWindows>().is_open()
                    })
                    .data_directory(locations.webview).build()?;
                window_state::initialize(app.handle(), &app.state::<Application>())?;
                tracing::info!(operation = "startup", "ServerDeck initialized");
                Ok(())
            })();
            if let Err(error) = &initialized {
                use tauri_plugin_dialog::DialogExt;
                // The saved language may be inaccessible when initialization fails.
                app.dialog().message(format!("无法打开应用数据 / Cannot open application data: {error}\n请检查已配置的目录、磁盘和权限。不会切换到替代空数据库。\nCheck the configured directory, disk and permissions. No empty replacement database will be used."))
                    .title("ServerDeck 启动失败 / Startup failed").kind(tauri_plugin_dialog::MessageDialogKind::Error).blocking_show();
            }
            initialized
        })
        .invoke_handler(command_handler())
        .on_window_event(|window, event| {
            if editor_commands::window_event(window, event) || window.label() != "main" {
                return;
            }
            window_state::record(window,event);
            terminal_upload_commands::drag_event(window, event);
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
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
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
                if app.emit_to("main", "app-exit-review", pending).is_err() {
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
                    handle.state::<update_commands::Updates>().shutdown().await;
                    state.shutdown().await;
                    drained.store(true, Ordering::Release);
                    if handle.state::<update_commands::Updates>().installing() {
                        let install_handle = handle.clone();
                        let installed = tauri::async_runtime::spawn_blocking(move || {
                            let (update, bytes) = install_handle.state::<update_commands::Updates>().take_installation()?;
                            update.install(bytes).map_err(|error| serverdeck_core::Error::Connection {
                                code: "UPDATE_INSTALL",
                                message: "更新安装器启动失败，应用将重新打开，请重试",
                                source: Some(Box::new(error)),
                            })
                        }).await;
                        if !matches!(installed, Ok(Ok(()))) {
                            use tauri_plugin_dialog::DialogExt;
                            tracing::error!(operation = "update_install", "update installer could not be launched after draining");
                            handle.dialog().message("更新安装器启动失败，应用将重新打开，请重试。 / Could not launch the update installer. The app will restart; please try again.")
                                .title("ServerDeck").kind(tauri_plugin_dialog::MessageDialogKind::Error).blocking_show();
                        }
                        handle.state::<logging::Logger>().flush();
                        handle.request_restart();
                        return;
                    }
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
        update_commands::app_update_status,
        update_commands::app_update_check,
        update_commands::app_update_auto_check,
        update_commands::app_update_download,
        update_commands::app_update_cancel,
        update_commands::app_update_install,
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
        editor_commands::editor_open,
        editor_commands::editor_status,
        editor_commands::editor_load,
        editor_commands::editor_dirty,
        editor_commands::editor_save,
        editor_commands::editor_reload,
        editor_commands::editor_close,
        file_commands::file_terminal,
        file_commands::app_exit_confirm,
        commands::forward_start,
        commands::forward_list,
        commands::forward_stop,
        commands::terminal_open,
        terminal_upload_commands::terminal_upload_pick,
        terminal_upload_commands::terminal_upload_claim_drop,
        terminal_upload_commands::terminal_upload_run_drop,
        terminal_upload_commands::terminal_upload_cancel_drop,
        terminal_upload_commands::terminal_upload_read,
        terminal_upload_commands::terminal_upload_release,
        zmodem_commands::terminal_zmodem_read,
        zmodem_commands::terminal_zmodem_write,
        commands::terminal_local_open,
        commands::terminal_local_saved_sessions,
        commands::terminal_local_save,
        commands::terminal_local_remove_saved,
        commands::terminal_local_open_saved,
        commands::terminal_local_open_elevated,
        browser_commands::terminal_open_link,
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
