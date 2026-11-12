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

#[tokio::test]
async fn assist_streams_require_the_exact_export_template_and_owner_grant() {
    use serverdeck_plugin_sdk::platform::ApprovalMode;
    let fixture = Fixture::new();
    let app = &fixture.app;
    let manifest: Manifest = serde_json::from_str(include_str!(
        "../../../../../plugins/system/assistant/manifest.json"
    ))
    .unwrap();
    let template = manifest
        .preapproved_commands
        .into_iter()
        .find(|c| {
            c.args
                .get(2)
                .is_some_and(|a| a == "serverdeck-image-export")
        })
        .unwrap();
    assert!(template.validate_argument_template().unwrap());
    let mut command = template.clone();
    command.args[3..].clone_from_slice(&[
        "01234567-89ab-cdef-0123-456789abcdef".into(),
        "a".repeat(64),
        "b".repeat(64),
        "image.tar".into(),
    ]);
    let plugin = fixture
        .install_with_commands(
            "dev.stream-template",
            &[Permission::OperationsReadArgumentsPreapproved],
            vec![template],
        )
        .await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let ssh = ssh(app).await;
    let operation = Primitive::StreamOpen {
        host_id: ssh.host.id.clone(),
        command: command.clone(),
    };
    let ordinary = call(app, id, "page", operation.clone()).await;
    assert_eq!(ordinary.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    app.plugin_approve(
        ordinary.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        false,
    )
    .unwrap();
    let policy = call(
        app,
        id,
        "page",
        Primitive::ApprovalMode {
            mode: ApprovalMode::Assist,
        },
    )
    .await;
    let binding = policy.result["binding"].as_str().unwrap().to_owned();
    let opened = app
        .plugin_capability_scoped(
            id,
            "page",
            request(Capability::Platform {
                request: operation.clone(),
                bindings: vec![binding.clone()],
            }),
        )
        .await
        .unwrap();
    assert!(opened.error.is_none(), "{opened:?}");
    let stream = opened.result["id"].as_str().unwrap().to_owned();
    for _ in 0..25 {
        if !ssh.calls.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(ssh.calls.lock().unwrap().len(), 1);
    let stopped = call(app, id, "page", Primitive::StreamStop { stream_id: stream }).await;
    assert!(stopped.error.is_none(), "{stopped:?}");
    let mut changed_script = command.clone();
    changed_script.args[1].push_str("\nreboot");
    let mut changed_path = command.clone();
    changed_path.args[6] = "/etc/outside.tar".into();
    let mut changed_hash = command.clone();
    changed_hash.args[5] = "hash;reboot".into();
    for changed in [
        changed_script,
        changed_path,
        changed_hash,
        Command::script("docker image load --input /tmp/archive.tar"),
    ] {
        let denied = app
            .plugin_capability_scoped(
                id,
                "page",
                request(Capability::Platform {
                    request: Primitive::StreamOpen {
                        host_id: ssh.host.id.clone(),
                        command: changed,
                    },
                    bindings: vec![binding.clone()],
                }),
            )
            .await
            .unwrap();
        assert_eq!(denied.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
        app.plugin_approve(
            denied.result["confirmationRequired"]["id"]
                .as_str()
                .unwrap(),
            false,
        )
        .unwrap();
    }
    assert_eq!(ssh.calls.lock().unwrap().len(), 1);
    for owner in ["page", "other-page"] {
        let scoped = app.plugin_host.start_scoped(id, owner).unwrap();
        let grant = app.plugins.grant(id).unwrap().unwrap();
        let op = Capability::Platform {
            request: operation.clone(),
            bindings: vec![binding.clone()],
        };
        assert_eq!(
            app.plugin_mode_preapproves(&scoped, &plugin, &grant, &op)
                .unwrap(),
            owner == "page"
        );
        let mut revoked = grant.clone();
        revoked
            .permissions
            .retain(|p| *p != Permission::OperationsReadArgumentsPreapproved);
        assert!(
            !app.plugin_mode_preapproves(&scoped, &plugin, &revoked, &op)
                .unwrap()
        );
        let terminal = Capability::Platform {
            request: Primitive::Terminal {
                host_id: ssh.host.id.clone(),
                command: command.clone(),
            },
            bindings: vec![binding.clone()],
        };
        assert!(
            !app.plugin_mode_preapproves(&scoped, &plugin, &grant, &terminal)
                .unwrap()
        );
    }
    app.shutdown().await;
}

#[tokio::test]
async fn assist_parameterized_reads_skip_prompts_but_script_and_argument_changes_do_not() {
    use serverdeck_plugin_sdk::platform::ApprovalMode;
    let fixture = Fixture::new();
    let app = &fixture.app;
    let template = Command::script("printf '%s' \"$1\"")
        .arg("fixture-read")
        .arg("{{sd:uint:2:2147483647}}");
    let plugin = fixture
        .install_with_commands(
            "dev.argument-read",
            &[Permission::OperationsReadArgumentsPreapproved],
            vec![template.clone()],
        )
        .await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let ssh = ssh(app).await;
    let make = |value: &str| {
        Command::script("printf '%s' \"$1\"")
            .arg("fixture-read")
            .arg(value)
    };
    let ordinary = call(
        app,
        id,
        "page",
        Primitive::Execute {
            host_id: ssh.host.id.clone(),
            command: make("835251"),
        },
    )
    .await;
    assert_eq!(ordinary.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    app.plugin_approve(
        ordinary.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        false,
    )
    .unwrap();
    let policy = call(
        app,
        id,
        "page",
        Primitive::ApprovalMode {
            mode: ApprovalMode::Assist,
        },
    )
    .await;
    let binding = policy.result["binding"].as_str().unwrap().to_owned();
    for value in ["835251", "42"] {
        let reply = app
            .plugin_capability_scoped(
                id,
                "page",
                request(Capability::Platform {
                    request: Primitive::Execute {
                        host_id: ssh.host.id.clone(),
                        command: make(value),
                    },
                    bindings: vec![binding.clone()],
                }),
            )
            .await
            .unwrap();
        assert!(reply.error.is_none(), "{reply:?}");
    }
    assert_eq!(ssh.calls.lock().unwrap().len(), 2);
    for command in [
        make("1"),
        make("42;reboot"),
        Command::script("reboot").arg("fixture-read").arg("42"),
    ] {
        let reply = app
            .plugin_capability_scoped(
                id,
                "page",
                request(Capability::Platform {
                    request: Primitive::Execute {
                        host_id: ssh.host.id.clone(),
                        command,
                    },
                    bindings: vec![binding.clone()],
                }),
            )
            .await
            .unwrap();
        assert_eq!(reply.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
        app.plugin_approve(
            reply.result["confirmationRequired"]["id"].as_str().unwrap(),
            false,
        )
        .unwrap();
    }
    assert_eq!(ssh.calls.lock().unwrap().len(), 2);
    let scoped = app.plugin_host.start_scoped(id, "page").unwrap();
    let mut grant = app.plugins.grant(id).unwrap().unwrap();
    grant
        .permissions
        .retain(|p| *p != Permission::OperationsReadArgumentsPreapproved);
    let op = Capability::Platform {
        request: Primitive::Execute {
            host_id: ssh.host.id.clone(),
            command: make("42"),
        },
        bindings: vec![binding],
    };
    assert!(
        !app.plugin_mode_preapproves(&scoped, &plugin, &grant, &op)
            .unwrap()
    );
    drop(scoped);
    app.shutdown().await;
}

#[tokio::test]
async fn full_access_requires_native_consent_then_reuses_owner_bound_authority_and_exact_plans() {
    use serverdeck_plugin_sdk::platform::{ApprovalMode, ApprovalOperation};
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture
        .install_with_commands(
            "dev.full-mode",
            &[Permission::OperationsFullPreapproved],
            vec![],
        )
        .await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let ssh = ssh(app).await;
    let mode = Primitive::ApprovalMode {
        mode: ApprovalMode::Full,
    };
    let first = call(app, id, "page", mode.clone()).await;
    assert_eq!(first.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    assert!(
        first.result["confirmationRequired"]["description"]
            .as_str()
            .unwrap()
            .contains("完全访问")
    );
    app.plugin_approve(
        first.result["confirmationRequired"]["id"].as_str().unwrap(),
        false,
    )
    .unwrap();
    assert!(app.plugin_host.lock().unwrap().bindings.is_empty());
    let pending = call(app, id, "page", mode.clone()).await;
    app.plugin_approve(
        pending.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        true,
    )
    .unwrap();
    let allowed = call(app, id, "page", mode.clone()).await;
    assert!(allowed.error.is_none(), "{allowed:?}");
    let binding = allowed.result["binding"].as_str().unwrap().to_owned();
    assert_eq!(
        call(app, id, "page", mode.clone()).await.result["binding"],
        binding
    );
    assert!(ssh.calls.lock().unwrap().is_empty());
    let scoped = app.plugin_host.start_scoped(id, "page").unwrap();
    let execute = Primitive::Execute {
        host_id: ssh.host.id.clone(),
        command: Command::new("fixture-change"),
    };
    let run = |operation| {
        app.plugin_dispatch(
            &scoped,
            request(Capability::Platform {
                request: operation,
                bindings: vec![binding.clone()],
            }),
        )
    };
    let plan = run(Primitive::ConfirmOperations {
        operations: vec![ApprovalOperation {
            request: Box::new(execute.clone()),
            count: 2,
        }],
    })
    .await
    .unwrap();
    assert!(plan.error.is_none(), "{plan:?}");
    assert!(plan.result.is_null());
    for _ in 0..2 {
        assert!(run(execute.clone()).await.unwrap().error.is_none());
    }
    assert_eq!(
        run(execute.clone()).await.unwrap().error.unwrap().code,
        "PLUGIN_PLAN_CHANGED"
    );
    assert_eq!(ssh.calls.lock().unwrap().len(), 2);
    drop(scoped);
    let stolen = app
        .plugin_capability_scoped(
            id,
            "other-page",
            request(Capability::Platform {
                request: execute.clone(),
                bindings: vec![binding.clone()],
            }),
        )
        .await
        .unwrap();
    assert!(stolen.error.is_some());
    assert_eq!(ssh.calls.lock().unwrap().len(), 2);
    app.plugin_host
        .lock()
        .unwrap()
        .bindings
        .get_mut(&binding)
        .unwrap()
        .at = Instant::now() - Duration::from_secs(7 * 24 * 60 * 60);
    // Refreshing host/model bindings prunes expired revisions, but must preserve Full.
    let refreshed = call(
        app,
        id,
        "page",
        Primitive::Host {
            host_id: ssh.host.id.clone(),
        },
    )
    .await;
    assert!(refreshed.error.is_none(), "{refreshed:?}");
    app.plugin_scope_visibility(id, "page", false)
        .await
        .unwrap();
    app.plugin_scope_visibility(id, "page", true).await.unwrap();
    let persistent = app
        .plugin_capability_scoped(
            id,
            "page",
            request(Capability::Platform {
                request: execute.clone(),
                bindings: vec![binding.clone()],
            }),
        )
        .await
        .unwrap();
    assert!(persistent.error.is_none(), "{persistent:?}");
    assert_eq!(ssh.calls.lock().unwrap().len(), 3);
    assert_eq!(
        call(app, id, "page", mode.clone()).await.result["binding"],
        binding
    );
    let host_binding = refreshed.result["binding"].as_str().unwrap();
    app.plugin_host
        .lock()
        .unwrap()
        .bindings
        .get_mut(host_binding)
        .unwrap()
        .at = Instant::now() - Duration::from_secs(601);
    let scoped = app.plugin_host.start_scoped(id, "page").unwrap();
    assert!(
        app.plugin_binding_targets(&scoped, &[host_binding.to_owned()])
            .is_err()
    );
    let session = app
        .plugin_host
        .lock()
        .unwrap()
        .full_access_sessions
        .get(&(id.clone(), "page".into()))
        .unwrap()
        .clone();
    // Reducing authority remains possible while a Guest action owns the busy slot.
    let reduced = call(
        app,
        id,
        "page",
        Primitive::ApprovalMode {
            mode: ApprovalMode::Request,
        },
    )
    .await;
    assert!(reduced.error.is_none(), "{reduced:?}");
    assert!(
        app.plugin_binding_targets(&scoped, std::slice::from_ref(&binding))
            .is_err()
    );
    assert!(
        app.plugin_revision_binding_for_session(
            &scoped,
            state::RevisionTarget::ApprovalMode(ApprovalMode::Full),
            Some(&session),
        )
        .is_err(),
        "a late consent cannot restore a revoked session"
    );
    drop(scoped);
    let revoked = app
        .plugin_capability_scoped(
            id,
            "page",
            request(Capability::Platform {
                request: execute,
                bindings: vec![binding.clone()],
            }),
        )
        .await
        .unwrap();
    assert!(revoked.error.is_some());
    assert_eq!(ssh.calls.lock().unwrap().len(), 3);
    let renew = call(app, id, "page", mode.clone()).await;
    assert_eq!(renew.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    let pending = renew.result["confirmationRequired"]["id"].as_str().unwrap();
    let reduced = call(
        app,
        id,
        "page",
        Primitive::ApprovalMode {
            mode: ApprovalMode::Assist,
        },
    )
    .await;
    assert!(reduced.error.is_none());
    assert!(
        app.plugin_approve(pending, true).is_err(),
        "switching also revokes pending consent"
    );
    let renew = call(app, id, "page", mode).await;
    app.plugin_approve(
        renew.result["confirmationRequired"]["id"].as_str().unwrap(),
        true,
    )
    .unwrap();
    let allowed = call(
        app,
        id,
        "page",
        Primitive::ApprovalMode {
            mode: ApprovalMode::Full,
        },
    )
    .await;
    let closing_binding = allowed.result["binding"].as_str().unwrap().to_owned();
    app.plugin_close_scope(id, "page").await.unwrap();
    assert!(
        !app.plugin_host
            .lock()
            .unwrap()
            .bindings
            .contains_key(&closing_binding)
    );
    assert!(
        !app.plugin_host
            .lock()
            .unwrap()
            .full_access_sessions
            .contains_key(&(id.clone(), "page".into()))
    );
    app.shutdown().await;
}

#[tokio::test]
async fn a_confirmed_command_batch_cannot_expand_or_replay_and_assist_cannot_run_arbitrary_commands()
 {
    use serverdeck_plugin_sdk::platform::{ApprovalMode, ApprovalOperation};
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.batch").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let ssh = ssh(app).await;
    let policy = call(
        app,
        id,
        "page",
        Primitive::ApprovalMode {
            mode: ApprovalMode::Assist,
        },
    )
    .await;
    let bindings = vec![policy.result["binding"].as_str().unwrap().to_owned()];
    let call = app.plugin_host.start_scoped(id, "page").unwrap();
    let op = Primitive::Execute {
        host_id: ssh.host.id.clone(),
        command: Command::new("fixture-read"),
    };
    let run = |op| {
        app.plugin_dispatch(
            &call,
            request(Capability::Platform {
                request: op,
                bindings: bindings.clone(),
            }),
        )
    };
    let arbitrary = run(op.clone()).await.unwrap();
    assert_eq!(
        arbitrary.error.unwrap().code,
        "PLUGIN_CONFIRMATION_REQUIRED"
    );
    assert!(ssh.calls.lock().unwrap().is_empty());
    let plan = Primitive::ConfirmOperations {
        operations: vec![ApprovalOperation {
            request: Box::new(op.clone()),
            count: 2,
        }],
    };
    let preview = run(plan.clone()).await.unwrap();
    assert_eq!(preview.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    assert!(ssh.calls.lock().unwrap().is_empty());
    app.plugin_approve(
        preview.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        true,
    )
    .unwrap();
    assert!(run(plan).await.unwrap().error.is_none());
    for _ in 0..2 {
        let executed = run(op.clone()).await.unwrap();
        assert!(executed.error.is_none(), "{executed:?}");
        assert_eq!(executed.result["state"], "completed");
    }
    assert_eq!(ssh.calls.lock().unwrap().len(), 2);
    let expanded = run(Primitive::Execute {
        host_id: ssh.host.id.clone(),
        command: Command::new("different-command"),
    })
    .await
    .unwrap();
    assert_eq!(expanded.error.unwrap().code, "PLUGIN_PLAN_CHANGED");
    let replay = run(op).await.unwrap();
    assert_eq!(replay.error.unwrap().code, "PLUGIN_PLAN_CHANGED");
    assert_eq!(ssh.calls.lock().unwrap().len(), 2);
    drop(call);
    app.shutdown().await;
}
#[tokio::test]
async fn one_native_confirmation_resumes_original_wasm_batch_and_decline_executes_nothing() {
    let fixture = Fixture::new();
    let app = &fixture.app;
    let id = fixture.wasm().await;
    let ssh = ssh(app).await;
    let input = json!({"operations":[{"request":{"kind":"execute","hostId":ssh.host.id,"command":{"program":"fixture-read","args":[],"timeoutSecs":30}},"count":2}]});
    let first = app
        .plugin_call_scoped(&id, "page", json!({"action":"batch","input":input}))
        .await
        .unwrap();
    assert_eq!(first.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    assert!(ssh.calls.lock().unwrap().is_empty());
    app.plugin_approve(first.result["id"].as_str().unwrap(), false)
        .unwrap();
    let cancelled = app
        .plugin_continue(
            &id,
            "page",
            first.result["continuation"].as_str().unwrap(),
            true,
        )
        .await
        .unwrap();
    assert_eq!(cancelled.error.unwrap().code, "USER_CANCELLED");
    assert!(ssh.calls.lock().unwrap().is_empty());
    let pending = app
        .plugin_call_scoped(&id, "page", json!({"action":"batch","input":input}))
        .await
        .unwrap();
    assert_eq!(pending.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    app.plugin_approve(pending.result["id"].as_str().unwrap(), true)
        .unwrap();
    let finished = app
        .plugin_continue(
            &id,
            "page",
            pending.result["continuation"].as_str().unwrap(),
            false,
        )
        .await
        .unwrap();
    assert!(finished.error.is_none(), "{finished:?}");
    assert_eq!(finished.result["results"].as_array().unwrap().len(), 2);
    assert_eq!(ssh.calls.lock().unwrap().len(), 2);
    app.plugin_close_scope(&id, "page").await.unwrap();
    app.shutdown().await;
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
            let version = json!({"Server":{"Version":"fixture-version"}});
            let output = if command.contains("dockerOperatingSystem") {
                json!({"dockerVersion":version,"dockerOperatingSystem":"Fixture Linux"})
            } else {
                version
            };
            s.data(id, output.to_string().into_bytes())?;
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
                "capabilities" => {
                    assert_eq!(reply.result["detail"]["dockerState"], "running");
                    assert_eq!(
                        reply.result["detail"]["dockerVersion"]["Server"]["Version"],
                        "fixture-version"
                    );
                    assert_eq!(
                        reply.result["detail"]["dockerOperatingSystem"],
                        "Fixture Linux"
                    );
                }
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
async fn assistant_packaged_sends_repeated_questions_over_native_stream_and_ssh() {
    use serverdeck_plugin_sdk::streaming::Request as Stream;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fixture = Fixture::new();
    let app = &fixture.app;
    app.provision_bundled_plugins().unwrap();
    let ssh = ssh(app).await;
    let id = "cn.hiboot.plugins.assistant";
    app.plugin_activate(id).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = std::str::from_utf8(&bytes[..at]).unwrap();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .unwrap()
                        .parse()
                        .unwrap();
                    if bytes.len() >= at + 4 + length {
                        let body: Value =
                            serde_json::from_slice(&bytes[at + 4..at + 4 + length]).unwrap();
                        assert_eq!(body["stream"], true);
                        break;
                    }
                }
            }
            let delta = json!({"choices":[{"index":0,"delta":{"content":json!({"kind":"answer","outcome":"completed","text":"fixture answer"}).to_string()},"finish_reason":null}]});
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {delta}\n\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n"
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    app.secrets
        .write("assistant-stream-key", b"fixture-key")
        .unwrap();
    let revision = uuid::Uuid::new_v4().to_string();
    app.database
        .ai_model_save(
            serverdeck_storage::ai::ModelRecord {
                id: "assistant-stream-model".into(),
                name: "fixture".into(),
                config: serverdeck_core::ai::Config {
                    base_url: format!("http://{address}/v1"),
                    model: "fixture".into(),
                    allow_insecure_http: true,
                    ..Default::default()
                },
                secret_ref: Some("assistant-stream-key".into()),
                revision: revision.clone(),
            },
            None,
        )
        .unwrap();
    for _ in 0..2 {
        let progress = call(
            app,
            id,
            "page",
            Primitive::Streaming {
                request: Stream::ProgressOpen,
            },
        )
        .await;
        assert!(progress.error.is_none(), "{progress:?}");
        let prepared = app.plugin_call_scoped(id, "page", json!({"action":"prepare","input":{
            "progressId":progress.result["id"],"approvalMode":"assist",
            "modelId":"assistant-stream-model","expectedModelRevision":revision,
            "sessionId":ssh.host.id,"question":"输出一下硬件信息","autoHosts":true,
            "selection":{"server":true,"metrics":true,"processes":false,"docker":false,"log":null,"logLines":100},
            "maskAddresses":false,"redactValues":[]
        }})).await.unwrap();
        assert!(prepared.error.is_none(), "prepare: {prepared:?}");
        let reply = app
            .plugin_call_scoped(
                id,
                "page",
                json!({"action":"send","input":{
                    "id":prepared.result["id"],"confirmed":true
                }}),
            )
            .await
            .unwrap();
        assert!(
            reply.error.is_none(),
            "send: {reply:?}; events: {:?}",
            app.plugin_events().unwrap()
        );
        assert_eq!(reply.result["text"], "fixture answer");
        assert_eq!(reply.result["task"]["status"], "succeeded");
        let close = call(
            app,
            id,
            "page",
            Primitive::Streaming {
                request: Stream::ProgressClose {
                    id: progress.result["id"].as_str().unwrap().into(),
                },
            },
        )
        .await;
        assert!(close.error.is_none(), "{close:?}");
    }
    assert!(!ssh.calls.lock().unwrap().is_empty());
    server.await.unwrap();
    app.shutdown().await;
}
#[tokio::test]
async fn docker_interactive_sessions_skip_approval_but_mutations_require_one_decision() {
    let f = Fixture::new();
    let app = &f.app;
    app.provision_bundled_plugins().unwrap();
    let ssh = ssh(app).await;
    let id = "cn.hiboot.plugins.docker";
    let owner = "docker-interactive";
    let target = "a".repeat(64);
    app.plugin_activate(id).await.unwrap();
    let logs = app.plugin_call_scoped(id, owner, json!({
        "action":"logs", "input":{"hostId":ssh.host.id,"source":{"kind":"container","id":target},"lines":200,"follow":true}
    })).await.unwrap();
    assert!(logs.error.is_none(), "{logs:?}");
    let stream = logs.result["id"].as_str().unwrap().to_owned();
    let mut output = String::new();
    for _ in 0..20 {
        let polled = call(
            app,
            id,
            owner,
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
    let shell = app
        .plugin_call_scoped(
            id,
            owner,
            json!({
                "action":"shell", "input":{"hostId":ssh.host.id,"id":target,"bash":false}
            }),
        )
        .await
        .unwrap();
    assert!(shell.error.is_none(), "{shell:?}");
    let ticket = shell.result["ticket"].as_str().unwrap().to_owned();
    assert_eq!(shell.result["hostId"], ssh.host.id);
    assert!(app.plugin_host.lock().unwrap().approvals.is_empty());
    assert_eq!(ssh.calls.lock().unwrap().len(), 1);
    for request in [
        json!({"kind":"container_action","id":target,"action":"stop","confirmed":true}),
        json!({"kind":"container_action","id":target,"action":"remove","confirmed":true}),
        json!({"kind":"image_remove","id":target,"confirmed":true}),
    ] {
        for accepted in [false, true] {
            let before = ssh.calls.lock().unwrap().len();
            let pending = app
                .plugin_call_scoped(
                    id,
                    owner,
                    json!({
                        "action":"query", "input":{"hostId":ssh.host.id,"request":request}
                    }),
                )
                .await
                .unwrap();
            assert_eq!(
                pending.error.as_ref().unwrap().code,
                "PLUGIN_CONFIRMATION_REQUIRED"
            );
            assert!(
                pending.result["description"]
                    .as_str()
                    .unwrap()
                    .contains(&target)
            );
            assert_eq!(ssh.calls.lock().unwrap().len(), before);
            app.plugin_approve(pending.result["id"].as_str().unwrap(), accepted)
                .unwrap();
            let result = app
                .plugin_continue(
                    id,
                    owner,
                    pending.result["continuation"].as_str().unwrap(),
                    !accepted,
                )
                .await
                .unwrap();
            if accepted {
                assert!(result.error.is_none(), "{result:?}");
                assert_eq!(result.result["success"], true);
            } else {
                assert_eq!(result.error.unwrap().code, "USER_CANCELLED");
            }
            assert_eq!(
                ssh.calls.lock().unwrap().len(),
                before + usize::from(accepted)
            );
        }
    }
    app.plugin_scope_visibility(id, owner, false).await.unwrap();
    assert!(!app.plugin_host.lock().unwrap().logs.contains_key(&stream));
    let hidden_ticket = app
        .plugin_platform_terminal_open(
            id,
            owner,
            &ticket,
            &ssh.host.id,
            serverdeck_core::terminal::TerminalSize { cols: 80, rows: 24 },
            Arc::new(|_| true),
        )
        .await
        .unwrap_err();
    assert_eq!(
        serverdeck_core::IpcError::from(hidden_ticket).code,
        "PLUGIN_UI_HIDDEN"
    );
    assert!(
        !app.plugin_host
            .lock()
            .unwrap()
            .platform_terminals
            .contains_key(&ticket)
    );
    let hidden = app
        .plugin_call_scoped(
            id,
            owner,
            json!({
                "action":"shell", "input":{"hostId":ssh.host.id,"id":target}
            }),
        )
        .await
        .unwrap();
    assert!(hidden.error.is_some());
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
    let interactive = [
        Primitive::StreamOpen {
            host_id: ssh.host.id.clone(),
            command: Command::new("fixture-echo"),
        },
        Primitive::Terminal {
            host_id: ssh.host.id.clone(),
            command: Command::new("fixture-echo"),
        },
    ];
    for operation in &interactive {
        let pending = call(app, id, "upload-page", operation.clone()).await;
        assert_eq!(pending.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    }
    assert!(ssh.calls.lock().unwrap().is_empty());
    f.grant(&plugin).await;
    let result = call(app, id, "upload-page", operation.clone()).await;
    assert!(result.error.is_none(), "{result:?}");
    assert_eq!(result.result["exitCode"], 0);
    assert_eq!(ssh.calls.lock().unwrap().len(), 1);
    for operation in interactive {
        let opened = call(app, id, "upload-page", operation).await;
        assert!(opened.error.is_none(), "{opened:?}");
        assert!(opened.result["id"].is_string() || opened.result["ticket"].is_string());
    }
    for _ in 0..20 {
        if ssh.calls.lock().unwrap().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(ssh.calls.lock().unwrap().len(), 2);
    app.plugin_revoke(id.clone()).await.unwrap();
    assert!(app.plugin_host.lock().unwrap().logs.is_empty());
    assert!(
        app.plugin_host
            .lock()
            .unwrap()
            .platform_terminals
            .is_empty()
    );
    assert_eq!(
        serverdeck_core::IpcError::from(
            app.plugin_capability_scoped(id, "upload-page", request(cap(operation)))
                .await
                .unwrap_err()
        )
        .code,
        "PLUGIN_CANCELLED"
    );
    assert_eq!(ssh.calls.lock().unwrap().len(), 2);
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
