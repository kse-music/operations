use serverdeck_application::Application;
use serverdeck_core::product::WindowGeometry;
use tauri::{Manager, Runtime};
pub struct WindowState(pub tokio::sync::watch::Sender<Option<WindowGeometry>>);
pub fn initialize<R: Runtime>(
    app: &tauri::AppHandle<R>,
    application: &Application,
) -> Result<(), Box<dyn std::error::Error>> {
    let saved = tauri::async_runtime::block_on(application.window_geometry())?;
    if let Some(g) = saved
        && let Some(window) = app.get_webview_window("main")
    {
        let mut width = g.width;
        let mut height = g.height;
        if let Some(m) = window.current_monitor()? {
            let size = m.size().to_logical::<f64>(m.scale_factor());
            width = width.min(size.width.max(900.0));
            height = height.min(size.height.max(600.0));
        }
        window.set_size(tauri::LogicalSize::new(width, height))?;
        if g.maximized {
            window.maximize()?;
        }
    }
    let (sender, mut receiver) = tokio::sync::watch::channel(saved);
    app.manage(WindowState(sender));
    let application = application.clone();
    tauri::async_runtime::spawn(async move {
        while receiver.changed().await.is_ok() {
            loop {
                let quiet = tokio::time::sleep(std::time::Duration::from_millis(500));
                tokio::pin!(quiet);
                tokio::select! {r=receiver.changed()=>{if r.is_err(){return;}},_=&mut quiet=>break}
            }
            let g = *receiver.borrow_and_update();
            if let Some(g) = g
                && application.save_window_geometry(g).await.is_err()
            {
                tracing::warn!(
                    operation = "window_geometry_save",
                    "could not persist window size"
                );
            }
        }
    });
    Ok(())
}
pub fn record<R: Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    if !matches!(
        event,
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
    ) {
        return;
    }
    let Some(state) = window.try_state::<WindowState>() else {
        return;
    };
    if window.is_minimized().unwrap_or(true) || window.is_fullscreen().unwrap_or(true) {
        return;
    }
    let (Ok(size), Ok(scale), Ok(maximized)) = (
        window.inner_size(),
        window.scale_factor(),
        window.is_maximized(),
    ) else {
        return;
    };
    let size = size.to_logical::<f64>(scale);
    let previous = *state.0.borrow();
    let normal = previous.unwrap_or(WindowGeometry {
        width: 1280.0,
        height: 820.0,
        maximized: false,
    });
    let g = if maximized {
        WindowGeometry {
            maximized: true,
            ..normal
        }
    } else {
        WindowGeometry {
            width: size.width,
            height: size.height,
            maximized: false,
        }
    };
    if g.validate().is_ok() {
        state.0.send_replace(Some(g));
    }
}
pub async fn flush<R: Runtime>(app: &tauri::AppHandle<R>, application: &Application) {
    let g = app.try_state::<WindowState>().and_then(|s| *s.0.borrow());
    if let Some(g) = g
        && application.save_window_geometry(g).await.is_err()
    {
        tracing::warn!(
            operation = "window_geometry_save",
            "could not persist final window size"
        );
    }
}
