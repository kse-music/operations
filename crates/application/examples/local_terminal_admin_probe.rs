// Interactive Windows QA: run a copied EXE from .local/elevated-terminal-qa.
// Default: allow UAC; --cancel: cancel UAC. No hosts, secrets or user data are used.
#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    serverdeck_application::run_terminal_helper();
    if serverdeck_windows_terminal::is_elevated()? {
        return Err("Run the probe from a non-administrator process".into());
    }
    tokio::runtime::Runtime::new()?.block_on(probe())
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows interactive QA only");
}

#[cfg(windows)]
async fn probe() -> Result<(), Box<dyn std::error::Error>> {
    use serverdeck_application::Application;
    use serverdeck_core::terminal::{TerminalEvent, TerminalSize};
    use std::{sync::Arc, time::Duration};
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.local/elevated-terminal-qa");
    std::fs::create_dir_all(&root)?;
    let directory = tempfile::tempdir_in(root)?;
    let app =
        Application::initialize(directory.path().join("data"), directory.path().join("logs"))?;
    let (send, mut events) = tokio::sync::mpsc::channel(64);
    let sink: serverdeck_ssh::Sink = Arc::new(move |event| send.try_send(event).is_ok());
    let normal = app
        .terminal_local_open(TerminalSize { cols: 80, rows: 24 }, Arc::new(|_| true))
        .await?;
    assert!(
        !normal.elevated,
        "ordinary shell must retain the non-elevated host token"
    );
    println!("Host and ordinary shell are not elevated. Respond to the Windows UAC prompt.");
    let admin = app
        .terminal_local_open_elevated(TerminalSize { cols: 90, rows: 25 }, sink)
        .await;
    if std::env::args().any(|argument| argument == "--cancel") {
        let error = serverdeck_core::IpcError::from(
            admin.expect_err("Cancel the UAC prompt for this probe"),
        );
        assert_eq!(error.message, "已取消管理员终端授权");
        app.terminal_close(&normal.id).await?;
        println!("PASS UAC cancellation is explicit and the ordinary session remains independent");
        return Ok(());
    }
    let admin = admin?;
    assert!(admin.elevated);
    println!("Administrator helper authenticated and shell ready.");
    // The ordinary shell has a separate sink; closing it cannot consume admin output.
    app.terminal_close(&normal.id).await?;
    app.terminal_resize(
        &admin.id,
        TerminalSize {
            cols: 101,
            rows: 31,
        },
    )?;
    let command = "$a=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); [Console]::WriteLine(('SD_ADMIN_' + $a)); [Console]::WriteLine(('SD_MATH_' + (17*19))); [Console]::WriteLine(('SD_COLS_' + [Console]::WindowWidth));\r";
    let mut text = String::new();
    let mut queries_answered = 0;
    let mut sent = false;
    let outcome = loop {
        let event = match tokio::time::timeout(Duration::from_secs(15), events.recv()).await {
            Ok(Some(event)) => event,
            _ => {
                eprintln!("Probe output before timeout: {text:?}");
                break Err("Terminal output timed out");
            }
        };
        match event {
            TerminalEvent::Data { sequence, data } => {
                text.push_str(&String::from_utf8_lossy(&data));
                app.terminal_ack(&admin.id, sequence)?;
                // ConPTY requests the initial cursor position; xterm normally replies.
                let queries = text.matches("\x1b[6n").count();
                while queries_answered < queries {
                    app.terminal_input(&admin.id, b"\x1b[1;1R".to_vec())?;
                    queries_answered += 1;
                }
                if !sent && text.contains("PS ") {
                    app.terminal_input(&admin.id, command.as_bytes().to_vec())?;
                    sent = true;
                }
                if text.contains("SD_ADMIN_True")
                    && text.contains("SD_MATH_323")
                    && text.contains("SD_COLS_101")
                {
                    break Ok(());
                }
            }
            TerminalEvent::State {
                state: "failed",
                message,
                ..
            } => {
                eprintln!("Terminal failed: {message:?}");
                break Err("Terminal failed");
            }
            _ => (),
        }
    };
    app.terminal_close(&admin.id).await?;
    outcome?;
    assert!(
        !serverdeck_windows_terminal::is_elevated()?,
        "host must remain non-elevated"
    );
    println!(
        "PASS elevated PowerShell token, real command/input/output/ACK/resize, independent host token, helper shutdown"
    );
    Ok(())
}
