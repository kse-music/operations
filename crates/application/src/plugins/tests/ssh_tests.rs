//! A real loopback SSH protocol fixture; no user hosts or remote processes.
use super::*;
use russh::{
    Channel, ChannelId,
    keys::{Algorithm, HashAlg, PrivateKey},
    server::{self, Auth, Session},
};
use serverdeck_core::{
    hosts::{AuthType, Host, HostInput},
    terminal::TerminalSession,
};
use serverdeck_ssh::{Authentication, ConnectionPlan, Hop};
struct Handler {
    calls: Arc<Mutex<Vec<String>>>,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
}
impl server::Handler for Handler {
    type Error = russh::Error;
    async fn auth_password(&mut self, _: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == "fixture-password" {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        c: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(c.id(), c);
        reply.accept().await;
        Ok(())
    }
    async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.channels.remove(&id);
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        s: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(command).to_string();
        self.calls.lock().unwrap().push(command.clone());
        s.channel_success(id)?;
        if command.contains("fixture-failure") {
            s.extended_data(id, 1, b"fixture permission denied".to_vec())?;
            s.exit_status_request(id, 7)?;
        } else if command.contains("d version --format") {
            s.data(id, br#"{"Server":{"Version":"fixture-version"}}"#.to_vec())?;
            s.exit_status_request(id, 0)?;
        } else if command.contains("d container ls --all --no-trunc") {
            s.data(
                id,
                br#"{"ID":"fixture-container","Names":"fixture","State":"running"}"#.to_vec(),
            )?;
            s.exit_status_request(id, 0)?;
        } else if command.contains("d image ls --all --no-trunc") {
            s.data(
                id,
                br#"{"ID":"sha256:fixture-image","Repository":"fixture"}"#.to_vec(),
            )?;
            s.exit_status_request(id, 0)?;
        } else if command.contains("d container inspect --format") {
            let mut output = String::new();
            for id in ["b".repeat(64), "a".repeat(64)] {
                let row = if command.contains(".Config.Env") {
                    json!({"Id":id,"Config":{"Env":["KEY=fixture-value"]}})
                } else {
                    json!({"Id":id,"Name":"/fixture","Config":{"Image":"fixture-image"}})
                };
                output.push_str(&row.to_string());
                output.push('\n');
            }
            s.data(id, output.into_bytes())?;
            s.exit_status_request(id, 0)?;
        } else if command.contains("d stats --all --no-stream --no-trunc") {
            s.data(
                id,
                format!(
                    "{}\n{}\n",
                    json!({"ID":"b".repeat(64),"CPUPerc":"99%"}),
                    json!({"ID":"a".repeat(64),"CPUPerc":"12.34%"})
                )
                .into_bytes(),
            )?;
            s.exit_status_request(id, 0)?;
        } else {
            let value = if command.contains("fixture-large") {
                vec![b'x'; 280000]
            } else {
                b"literal fixture output\n".to_vec()
            };
            for part in value.chunks(16384) {
                s.data(id, part.to_vec())?;
            }
            s.exit_status_request(id, 0)?;
        }
        s.eof(id)?;
        s.close(id)
    }
}
struct Ssh {
    session: TerminalSession,
    host: Host,
    calls: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Ssh {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn ssh(app: &Application) -> Ssh {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    app.database
        .trust_key(
            "127.0.0.1",
            port,
            &key.public_key().to_openssh().unwrap(),
            &key.public_key().fingerprint(HashAlg::Sha256).to_string(),
        )
        .unwrap();
    let credential = app
        .credential_save(
            None,
            None,
            serverdeck_core::hosts::CredentialInput {
                name: "SSH fixture".into(),
                kind: AuthType::Password,
                key_path: None,
                key_data: None,
                secret: Some(Zeroizing::new("fixture-password".into())),
                clear_secret: false,
            },
        )
        .await
        .unwrap()
        .value;
    let host = app
        .database
        .host_create(HostInput {
            name: "SSH protocol fixture".into(),
            hostname: "127.0.0.1".into(),
            port,
            username: "ops".into(),
            auth_type: AuthType::Password,
            credential_id: Some(credential.id),
            group_id: None,
            description: String::new(),
            favorite: false,
            connect_timeout_secs: 3,
            ssh: Default::default(),
        })
        .unwrap();
    let config = Arc::new(server::Config {
        keys: vec![key],
        ..Default::default()
    });
    let calls = Arc::new(Mutex::new(vec![]));
    let record = calls.clone();
    let task = tokio::spawn(async move {
        let mut children = tokio::task::JoinSet::new();
        loop {
            tokio::select! {r=listener.accept()=>{let(stream,_)=r.unwrap();let config=config.clone();let h=Handler{calls:record.clone(),channels:HashMap::new()};children.spawn(async move{let handle=server::run_stream(config,stream,h).await.unwrap();let _=handle.await;});},_=children.join_next(),if !children.is_empty()=>()}
        }
    });
    let plan = ConnectionPlan {
        hops: vec![Hop {
            host: host.clone(),
            revision: credential.revision,
            auth: Authentication::Password(Zeroizing::new("fixture-password".into())),
        }],
        proxy: None,
    };
    let session = app
        .terminals
        .open_ops_plan(host.clone(), plan, Arc::new(|_| true))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !app.terminals.ops_ready(&session.id).unwrap() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    Ssh {
        session,
        host,
        calls,
        task,
    }
}
async fn approved(
    app: &Application,
    id: &str,
    input: Value,
) -> serverdeck_plugin_runtime::protocol::Reply {
    let reply = app
        .plugin_call_scoped(id, "page", json!({"action":"command","input":input}))
        .await
        .unwrap();
    assert_eq!(
        reply.error.as_ref().unwrap().code,
        "PLUGIN_CONFIRMATION_REQUIRED"
    );
    app.plugin_approve(reply.result["id"].as_str().unwrap(), true)
        .unwrap();
    app.plugin_continue(
        id,
        "page",
        reply.result["continuation"].as_str().unwrap(),
        false,
    )
    .await
    .unwrap()
}
#[tokio::test]
async fn docker_page_queries_repeat_without_confirmation_over_real_ssh() {
    let f = Fixture::new();
    let app = &f.app;
    app.provision_bundled_plugins().unwrap();
    let ssh = ssh(app).await;
    let id = "cn.hiboot.plugins.docker";
    app.plugin_activate(id).await.unwrap();
    for _ in 0..2 {
        for request in [
            json!({"kind":"capabilities"}),
            json!({"kind":"containers"}),
            json!({"kind":"images"}),
            json!({"kind":"container_details","id":"a".repeat(64),"revealEnv":false}),
            json!({"kind":"container_details","id":"a".repeat(64),"revealEnv":true}),
            json!({"kind":"container_stats","id":"a".repeat(64)}),
        ] {
            let kind = request["kind"].as_str().unwrap();
            let reply = app
                .plugin_call_scoped(
                    id,
                    "docker-page",
                    json!({"action":"query","input":{"hostId":ssh.host.id,"request":request}}),
                )
                .await
                .unwrap();
            assert!(reply.error.is_none(), "{kind}: {reply:?}");
            assert_eq!(reply.result["success"], true);
            match kind {
                "capabilities" => assert_eq!(reply.result["detail"]["dockerState"], "running"),
                "containers" => assert_eq!(reply.result["records"][0]["ID"], "fixture-container"),
                "images" => assert_eq!(reply.result["records"][0]["ID"], "sha256:fixture-image"),
                "container_details" => {
                    assert_eq!(reply.result["detail"]["id"], "a".repeat(64));
                    assert_eq!(reply.result["records"], json!([]));
                    if request["revealEnv"] == true {
                        assert_eq!(
                            reply.result["detail"]["environment"],
                            json!(["KEY=fixture-value"])
                        );
                    } else {
                        assert_eq!(reply.result["detail"]["environment"], json!([]));
                    }
                }
                "container_stats" => {
                    assert_eq!(reply.result["records"].as_array().unwrap().len(), 1);
                    assert_eq!(reply.result["records"][0]["ID"], "a".repeat(64));
                    assert_eq!(reply.result["records"][0]["CPUPerc"], "12.34%");
                }
                _ => unreachable!(),
            }
        }
    }
    assert_eq!(ssh.calls.lock().unwrap().len(), 12);
    assert!(app.plugin_host.lock().unwrap().approvals.is_empty());
    let target = "a".repeat(64);
    for request in [
        json!({"kind":"container_action","id":target,"action":"stop","confirmed":true}),
        json!({"kind":"image_remove","id":target,"confirmed":true}),
    ] {
        let pending = app
            .plugin_call_scoped(
                id,
                "docker-page",
                json!({"action":"query","input":{"hostId":ssh.host.id,"request":request}}),
            )
            .await
            .unwrap();
        assert_eq!(
            pending.error.as_ref().unwrap().code,
            "PLUGIN_CONFIRMATION_REQUIRED"
        );
        assert_eq!(ssh.calls.lock().unwrap().len(), 12);
        app.plugin_approve(pending.result["id"].as_str().unwrap(), false)
            .unwrap();
        let cancelled = app
            .plugin_continue(
                id,
                "docker-page",
                pending.result["continuation"].as_str().unwrap(),
                true,
            )
            .await
            .unwrap();
        assert_eq!(cancelled.error.unwrap().code, "USER_CANCELLED");
        assert_eq!(ssh.calls.lock().unwrap().len(), 12);
    }
    let command = app
        .plugin_detail(id.into())
        .await
        .unwrap()
        .manifest
        .preapproved_commands[0]
        .clone();
    let altered = call(
        app,
        id,
        "docker-page",
        Primitive::Execute {
            host_id: ssh.host.id.clone(),
            command: command.clone().arg("; reboot"),
        },
    )
    .await;
    assert_eq!(altered.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    assert_eq!(ssh.calls.lock().unwrap().len(), 12);
    let mut changed = ssh.host.config.clone();
    changed.username = "changed-target".into();
    app.database.host_update(&ssh.host.id, changed).unwrap();
    let changed = call(
        app,
        id,
        "docker-page",
        Primitive::Execute {
            host_id: ssh.host.id.clone(),
            command: command.clone(),
        },
    )
    .await;
    assert!(changed.error.is_some());
    assert_eq!(ssh.calls.lock().unwrap().len(), 12);
    app.plugin_close_scope(id, "docker-page").await.unwrap();
    assert!(
        app.plugin_capability_scoped(
            id,
            "docker-page",
            request(cap(Primitive::Execute {
                host_id: ssh.host.id.clone(),
                command
            }))
        )
        .await
        .is_err()
    );
    app.shutdown().await;
}
#[tokio::test]
async fn uploaded_presets_need_explicit_grant_and_stop_after_revocation() {
    let f = Fixture::new();
    let app = &f.app;
    let ssh = ssh(app).await;
    let plugin = app
        .plugin_install(InstallInput {
            path: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../plugins/system/packages/docker.sdplugin"),
            development_confirmed: true,
            expected_version: None,
            expected_digest: None,
        })
        .await
        .unwrap();
    assert_eq!(
        plugin.source,
        serverdeck_plugin_core::repository::PluginSource::User
    );
    assert!(
        app.plugin_permissions(plugin.manifest.id.clone())
            .await
            .unwrap()
            .is_none()
    );
    let id = &plugin.manifest.id;
    let operation = Primitive::Execute {
        host_id: ssh.host.id.clone(),
        command: plugin.manifest.preapproved_commands[0].clone(),
    };
    app.plugin_set_enabled(id.clone(), true).await.unwrap();
    assert_eq!(
        call(app, id, "upload-page", operation.clone())
            .await
            .error
            .unwrap()
            .code,
        "PLUGIN_PERMISSION_DENIED"
    );
    app.plugin_grant(
        id.clone(),
        GrantInput {
            expected_revision: plugin.revision.clone(),
            permissions: vec![Permission::SshExecute],
            operations: vec!["ssh.execute".into()],
            read_roots: vec![],
            write_roots: vec![],
            confirmed: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        call(app, id, "upload-page", operation.clone())
            .await
            .error
            .unwrap()
            .code,
        "PLUGIN_CONFIRMATION_REQUIRED"
    );
    assert!(ssh.calls.lock().unwrap().is_empty());
    f.grant(&plugin).await;
    let result = call(app, id, "upload-page", operation.clone()).await;
    assert!(result.error.is_none(), "{result:?}");
    assert_eq!(result.result["exitCode"], 0);
    assert_eq!(ssh.calls.lock().unwrap().len(), 1);
    app.plugin_revoke(id.clone()).await.unwrap();
    assert_eq!(
        serverdeck_core::IpcError::from(
            app.plugin_capability_scoped(id, "upload-page", request(cap(operation)))
                .await
                .unwrap_err()
        )
        .code,
        "PLUGIN_CANCELLED"
    );
    assert_eq!(ssh.calls.lock().unwrap().len(), 1);
    app.shutdown().await;
}
#[tokio::test]
async fn wasm_exec_uses_real_ssh_frozen_endpoint_literal_arguments_and_rejects_changed_target() {
    let f = Fixture::new();
    let id = f.wasm().await;
    let app = &f.app;
    let ssh = ssh(app).await;
    let command = Command::new("fixture-echo").arg("x'$(bad); y");
    let input = json!({"hostId":ssh.host.id,"command":command});
    let review = app
        .plugin_call_scoped(&id, "page", json!({"action":"command","input":input}))
        .await
        .unwrap();
    assert!(
        review.result["description"]
            .as_str()
            .unwrap()
            .contains(&format!("ops@127.0.0.1:{}", ssh.host.config.port))
    );
    assert!(ssh.calls.lock().unwrap().is_empty());
    app.plugin_approve(review.result["id"].as_str().unwrap(), true)
        .unwrap();
    let result = app
        .plugin_continue(
            &id,
            "page",
            review.result["continuation"].as_str().unwrap(),
            false,
        )
        .await
        .unwrap();
    assert!(result.error.is_none(), "{result:?}");
    assert_eq!(result.result["output"], "literal fixture output\n");
    assert_eq!(
        ssh.calls.lock().unwrap().as_slice(),
        [format!(
            "export LC_ALL=C; export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; {}",
            command.shell().unwrap()
        )]
    );
    let pending = app
        .plugin_call_scoped(&id, "page", json!({"action":"command","input":input}))
        .await
        .unwrap();
    let mut changed = ssh.host.config.clone();
    changed.username = "another-user".into();
    app.database.host_update(&ssh.host.id, changed).unwrap();
    app.plugin_approve(pending.result["id"].as_str().unwrap(), true)
        .unwrap();
    let result = app
        .plugin_continue(
            &id,
            "page",
            pending.result["continuation"].as_str().unwrap(),
            false,
        )
        .await
        .unwrap();
    assert!(result.error.is_some());
    assert_eq!(ssh.calls.lock().unwrap().len(), 1);
    app.shutdown().await;
}
#[tokio::test]
async fn real_ssh_failure_and_oversize_output_never_become_success() {
    let f = Fixture::new();
    let id = f.wasm().await;
    let app = &f.app;
    let ssh = ssh(app).await;
    for program in ["fixture-failure", "fixture-large"] {
        let reply = approved(
            app,
            &id,
            json!({"hostId":ssh.host.id,"command":Command::new(program)}),
        )
        .await;
        assert!(reply.error.is_some(), "{program}: {reply:?}");
    }
    assert_eq!(ssh.calls.lock().unwrap().len(), 2);
    app.shutdown().await;
}
#[tokio::test]
async fn streams_and_terminal_tickets_are_owned_and_hidden_scope_cleanup_is_independent() {
    let f = Fixture::new();
    let p = f.install("dev.ssh-resources").await;
    f.grant(&p).await;
    let id = &p.manifest.id;
    let app = &f.app;
    let ssh = ssh(app).await;
    let primitive = Primitive::StreamOpen {
        host_id: ssh.host.id.clone(),
        command: Command::new("fixture-echo"),
    };
    let pending = call(app, id, "a", primitive.clone()).await;
    app.plugin_approve(
        pending.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        true,
    )
    .unwrap();
    let opened = call(app, id, "a", primitive).await;
    assert!(opened.error.is_none(), "{opened:?}");
    let stream = opened.result["id"].as_str().unwrap().to_owned();
    assert!(
        call(
            app,
            id,
            "b",
            Primitive::StreamPoll {
                stream_id: stream.clone()
            }
        )
        .await
        .error
        .is_some()
    );
    let mut output = String::new();
    for _ in 0..10 {
        let polled = call(
            app,
            id,
            "a",
            Primitive::StreamPoll {
                stream_id: stream.clone(),
            },
        )
        .await;
        for event in polled.result["events"].as_array().unwrap() {
            if let Some(data) = event["dataBase64"].as_str() {
                output.push_str(&String::from_utf8(STANDARD.decode(data).unwrap()).unwrap());
            }
        }
        if output.contains("literal fixture output") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(70)).await;
    }
    assert!(output.contains("literal fixture output"));
    let primitive = Primitive::Terminal {
        host_id: ssh.host.id.clone(),
        command: Command::new("fixture-echo"),
    };
    let pending = call(app, id, "b", primitive.clone()).await;
    app.plugin_approve(
        pending.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        true,
    )
    .unwrap();
    let ticket = call(app, id, "b", primitive).await;
    assert!(ticket.error.is_none());
    let token = ticket.result["ticket"].as_str().unwrap().to_owned();
    app.plugin_scope_visibility(id, "a", false).await.unwrap();
    assert!(!app.plugin_host.lock().unwrap().logs.contains_key(&stream));
    assert!(
        app.plugin_host
            .lock()
            .unwrap()
            .platform_terminals
            .contains_key(&token)
    );
    app.plugin_close_scope(id, "b").await.unwrap();
    assert!(
        !app.plugin_host
            .lock()
            .unwrap()
            .platform_terminals
            .contains_key(&token)
    );
    assert!(app.terminals.ops_ready(&ssh.session.id).unwrap());
    app.shutdown().await;
}
