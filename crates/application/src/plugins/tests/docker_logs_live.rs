//! Opt-in real OpenSSH + Docker check using only tools/docker-logs-fixture.py resources.
use super::*;
use serverdeck_core::hosts::{AuthType, CredentialInput, HostInput};
use std::path::{Path, PathBuf};

fn wsl_path(path: &Path) -> String {
    let path = path.to_str().unwrap().replace('\\', "/");
    assert_eq!(&path[1..3], ":/");
    format!("/mnt/{}/{}", path[..1].to_lowercase(), &path[3..])
}

async fn remote_processes(directory: &Path) -> Vec<u32> {
    let directory = wsl_path(directory);
    let tool =
        wsl_path(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/docker-logs-fixture.py"));
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("wsl")
            .args([
                "--user", "root", "--exec", "python3", &tool, "status", &directory,
            ])
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice::<Value>(&output.stdout).unwrap()["processes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pid| pid.as_u64().unwrap() as u32)
        .collect()
}

async fn platform_result(app: &Application, id: &str, owner: &str, operation: Primitive) -> Value {
    let response = call(app, id, owner, operation).await;
    assert!(response.error.is_none(), "{response:?}");
    let descriptor = &response.result["__pluginResult"];
    let Some(token) = descriptor["id"].as_str() else {
        return response.result;
    };
    let mut bytes = Vec::new();
    for chunk in 0..descriptor["chunks"].as_u64().unwrap() {
        let part = call(
            app,
            id,
            owner,
            Primitive::ResultRead {
                result_id: token.into(),
                chunk: chunk as u32,
            },
        )
        .await;
        assert!(part.error.is_none(), "{part:?}");
        bytes.extend(
            STANDARD
                .decode(part.result["dataBase64"].as_str().unwrap())
                .unwrap(),
        );
    }
    let closed = call(
        app,
        id,
        owner,
        Primitive::ResultClose {
            result_id: token.into(),
        },
    )
    .await;
    assert!(closed.error.is_none(), "{closed:?}");
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires explicit local WSL fixture setup and SERVERDECK_LOG_QA_DIR; no user hosts"]
async fn real_docker_logs_exit_on_dialog_hidden_scope_ssh_disconnect_and_app_shutdown() {
    let directory = PathBuf::from(std::env::var("SERVERDECK_LOG_QA_DIR").unwrap());
    let config: Value =
        serde_json::from_slice(&std::fs::read(directory.join("fixture.json")).unwrap()).unwrap();
    assert!(
        remote_processes(&directory).await.is_empty(),
        "fixture already has active log readers"
    );
    for source in ["container", "compose"] {
        for close in ["dialog", "hidden", "scope", "session", "host", "shutdown"] {
            let fixture = Fixture::new();
            let app = &fixture.app;
            app.provision_bundled_plugins().unwrap();
            let credential = app
                .credential_save(
                    None,
                    None,
                    CredentialInput {
                        name: "Ephemeral local Docker QA".into(),
                        kind: AuthType::PrivateKey,
                        key_path: None,
                        key_data: Some(Zeroizing::new(
                            std::fs::read_to_string(directory.join("client-key")).unwrap(),
                        )),
                        secret: None,
                        clear_secret: false,
                    },
                )
                .await
                .unwrap()
                .value;
            let port = config["port"].as_u64().unwrap() as u16;
            app.database
                .trust_key(
                    "127.0.0.1",
                    port,
                    config["publicKey"].as_str().unwrap(),
                    config["fingerprint"].as_str().unwrap(),
                )
                .unwrap();
            let host = app
                .database
                .host_create(HostInput {
                    name: "Local Docker QA".into(),
                    hostname: "127.0.0.1".into(),
                    port,
                    username: "root".into(),
                    auth_type: AuthType::PrivateKey,
                    credential_id: Some(credential.id),
                    group_id: None,
                    description: String::new(),
                    favorite: false,
                    connect_timeout_secs: 5,
                    ssh: Default::default(),
                })
                .unwrap();
            let (states, mut events) = tokio::sync::mpsc::channel(16);
            let session = app
                .ops_open(
                    host.id.clone(),
                    Arc::new(move |event| states.try_send(event).is_ok()),
                )
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                while let Some(event) = events.recv().await {
                    if let serverdeck_core::terminal::TerminalEvent::State {
                        state,
                        code,
                        message,
                    } = event
                    {
                        if state == "connected" {
                            return;
                        }
                        assert_ne!(state, "failed", "local SSH failed: {code:?} {message:?}");
                    }
                }
                panic!("local SSH event stream ended before ready");
            })
            .await
            .expect("local OpenSSH ready with pinned host key");
            let id = "cn.hiboot.plugins.docker";
            let owner = "real-docker-logs";
            app.plugin_activate(id).await.unwrap();
            let input_source = if source == "container" {
                json!({"kind":"container", "id":config["container"]})
            } else {
                json!({"kind":"compose", "project":config["project"]})
            };
            let opened = app
                .plugin_call_scoped(
                    id,
                    owner,
                    json!({"action":"logs", "input":{
                        "hostId":host.id, "source":input_source, "lines":20, "follow":true
                    }}),
                )
                .await
                .unwrap();
            assert!(opened.error.is_none(), "{opened:?}");
            let stream = opened.result["id"].as_str().unwrap().to_owned();
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let polled = platform_result(
                        app,
                        id,
                        owner,
                        Primitive::StreamPoll {
                            stream_id: stream.clone(),
                        },
                    )
                    .await;
                    let has_output = polled["events"].as_array().unwrap().iter().any(|event| {
                        event["dataBase64"].as_str().is_some_and(|data| {
                            String::from_utf8_lossy(&STANDARD.decode(data).unwrap())
                                .contains("SERVERDECK_LOG_QA")
                        })
                    });
                    if has_output {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .expect("real Docker log output");
            assert!(
                !remote_processes(&directory).await.is_empty(),
                "actual remote log CLI must exist before close"
            );
            // Exercise cleanup even while reading is paused.
            app.operations_host.log_pause(&stream, true).unwrap();
            match close {
                "dialog" => {
                    let stopped =
                        call(app, id, owner, Primitive::StreamStop { stream_id: stream }).await;
                    assert!(stopped.error.is_none(), "{stopped:?}");
                }
                "hidden" => app
                    .plugin_scope_visibility(id, owner, false, false)
                    .await
                    .unwrap(),
                "scope" => app.plugin_close_scope(id, owner).await.unwrap(),
                "session" => app.terminal_close(&session.id).await.unwrap(),
                "host" => app.terminal_close_host(&host.id).await.unwrap(),
                "shutdown" => app.shutdown().await,
                _ => unreachable!(),
            }
            assert!(
                remote_processes(&directory).await.is_empty(),
                "{source}/{close}: remote log CLI remains after close returned"
            );
            assert_eq!(app.operations_host.log_count().unwrap(), 0);
            if ["dialog", "hidden", "scope"].contains(&close) {
                assert!(
                    app.terminals.ops_ready(&session.id).unwrap(),
                    "log close must retain shared SSH transport"
                );
            }
            if close != "shutdown" {
                app.shutdown().await;
            }
            assert_eq!(app.terminals.counts().unwrap(), (0, 0));
            println!("Verified real Docker logs: {source}/{close}; remote CLI count = 0");
        }
    }
}
