use super::*;
use serverdeck_plugin_core::permissions::GrantInput;
fn app() -> (tempfile::TempDir, Application) {
    let dir = tempfile::tempdir().unwrap();
    let app = Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    app.provision_bundled_plugins().unwrap();
    (dir, app)
}
#[tokio::test]
async fn image_removal_review_uses_the_frozen_native_target_and_remains_single_use() {
    let (_dir, app) = app();
    let id = "cn.hiboot.plugins.docker";
    app.plugin_host
        .resume(
            id,
            Some((
                ContextInput {
                    host_id: "review-host".into(),
                    ops_session: None,
                    file_session: None,
                },
                "profile".into(),
            )),
        )
        .unwrap();
    let plugin = app.plugins.detail(id).unwrap();
    let call = app.plugin_host.start(id).unwrap();
    let target = format!("sha256:{}", "a".repeat(64));
    let operation = Capability::SystemQuery {
        request: serverdeck_plugin_sdk::server::Query::ImageRemove { id: target.clone() },
    };
    let review = app
        .plugin_confirmation(&call, &plugin, &operation)
        .unwrap()
        .unwrap();
    assert_eq!(review.image_id.as_deref(), Some(target.as_str()));
    assert_eq!(review.host_id, "review-host");
    assert_eq!(serde_json::to_value(&review).unwrap()["imageId"], target);
    app.plugin_approve(&review.id, true).unwrap();
    let other = Capability::SystemQuery {
        request: serverdeck_plugin_sdk::server::Query::ImageRemove { id: "b".repeat(64) },
    };
    let different = app
        .plugin_confirmation(&call, &plugin, &other)
        .unwrap()
        .unwrap();
    assert_ne!(different.id, review.id);
    assert!(
        app.plugin_confirmation(&call, &plugin, &operation)
            .unwrap()
            .is_none()
    );
    assert!(
        app.plugin_confirmation(&call, &plugin, &operation)
            .unwrap()
            .is_some()
    );
    app.plugin_approve(&different.id, false).unwrap();
    let after_cancel = app
        .plugin_confirmation(&call, &plugin, &other)
        .unwrap()
        .unwrap();
    assert_ne!(after_cancel.id, different.id);
    let non_image = Capability::Execute {
        command: "printf review_only".into(),
        timeout_secs: 5,
    };
    let generic = app
        .plugin_confirmation(&call, &plugin, &non_image)
        .unwrap()
        .unwrap();
    assert!(generic.image_id.is_none());
    assert!(
        serde_json::to_value(&generic)
            .unwrap()
            .get("imageId")
            .is_none()
    );
    drop(call);
    app.shutdown().await;
}
#[tokio::test]
async fn chunk_resources_are_bounded_owned_expiring_and_released_on_stop() {
    let (_dir, app) = app();
    let id = "cn.hiboot.plugins.docker";
    let plugin = app.plugins.detail(id).unwrap();
    let grant = Grant::new(
        &plugin,
        GrantInput {
            expected_revision: plugin.revision.clone(),
            permissions: vec![Permission::UiContribute],
            operations: vec!["ui.contribute".into()],
            read_roots: vec![],
            write_roots: vec![],
            confirmed: true,
        },
    )
    .unwrap();
    let call = app.plugin_host.start(id).unwrap();
    let value = json!({"text":"测试".repeat(20_000)});
    let descriptor = app.plugin_result(&call, value.clone()).unwrap();
    let result_id = descriptor["__pluginResult"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let mut bytes = vec![];
    for chunk in 0..descriptor["__pluginResult"]["chunks"].as_u64().unwrap() {
        let part = app
            .plugin_server_capability(
                &call,
                Capability::ResultRead {
                    result_id: result_id.clone(),
                    chunk: chunk as u32,
                },
                &plugin,
                &grant,
            )
            .await
            .unwrap();
        bytes.extend(
            base64::engine::general_purpose::STANDARD
                .decode(part["dataBase64"].as_str().unwrap())
                .unwrap(),
        );
    }
    assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), value);
    assert!(
        app.plugin_server_capability(
            &call,
            Capability::ResultRead {
                result_id: result_id.clone(),
                chunk: u32::MAX
            },
            &plugin,
            &grant
        )
        .await
        .is_err()
    );
    let other = app.plugin_host.start("other").unwrap();
    assert!(
        app.plugin_server_capability(
            &other,
            Capability::ResultRead {
                result_id: result_id.clone(),
                chunk: 0
            },
            &plugin,
            &grant
        )
        .await
        .is_err()
    );
    app.plugin_result(&call, value.clone()).unwrap();
    assert!(matches!(app.plugin_result(&call, value), Err(Error::Busy)));
    assert!(
        app.plugin_result(&call, json!("x".repeat(4 * 1024 * 1024)))
            .is_err()
    );
    app.plugin_host
        .lock()
        .unwrap()
        .results
        .get_mut(&result_id)
        .unwrap()
        .at = Instant::now() - Duration::from_secs(61);
    assert!(
        app.plugin_server_capability(
            &call,
            Capability::ResultRead {
                result_id: result_id.clone(),
                chunk: 0
            },
            &plugin,
            &grant
        )
        .await
        .is_err()
    );
    drop(call);
    app.plugin_host.resume(id, None).unwrap();
    let next = app.plugin_host.start(id).unwrap();
    assert!(
        app.plugin_server_capability(
            &next,
            Capability::ResultClose { result_id },
            &plugin,
            &grant
        )
        .await
        .is_err()
    );
    drop(next);
    drop(other);
    app.plugin_stop_resources(id).await.unwrap();
    assert!(app.plugin_host.lock().unwrap().results.is_empty());
    app.shutdown().await;
}
#[tokio::test]
async fn shell_ticket_binds_plugin_context_revision_host_target_and_is_single_use() {
    let (_dir, app) = app();
    let id = "cn.hiboot.plugins.docker";
    let context = || ContextInput {
        host_id: "host".into(),
        ops_session: None,
        file_session: None,
    };
    app.plugin_host
        .resume(id, Some((context(), "profile".into())))
        .unwrap();
    let call = app.plugin_host.start(id).unwrap();
    let expected = ops::ContainerShell {
        id: "abc123".into(),
        bash: false,
        confirmed: true,
    };
    let seed = || state::ShellTicket {
        plugin: id.into(),
        generation: call.generation.clone(),
        revision: "r1".into(),
        host: "host".into(),
        container: "abc123".into(),
        bash: false,
        at: Instant::now(),
    };
    app.plugin_host
        .lock()
        .unwrap()
        .shells
        .insert("ticket".into(), seed());
    for (revision, target, container, bash) in [
        ("r2", "host", "abc123", false),
        ("r1", "different", "abc123", false),
        ("r1", "host", "abc124", false),
        ("r1", "host", "abc123", true),
    ] {
        assert!(
            app.plugin_claim_shell(
                &call,
                revision,
                "ticket",
                target,
                &ops::ContainerShell {
                    id: container.into(),
                    bash,
                    confirmed: true
                }
            )
            .is_err()
        );
    }
    let other = app.plugin_host.start("other").unwrap();
    assert!(
        app.plugin_claim_shell(&other, "r1", "ticket", "host", &expected)
            .is_err()
    );
    drop(other);
    app.plugin_host
        .lock()
        .unwrap()
        .shells
        .get_mut("ticket")
        .unwrap()
        .at = Instant::now() - Duration::from_secs(61);
    assert!(
        app.plugin_claim_shell(&call, "r1", "ticket", "host", &expected)
            .is_err()
    );
    app.plugin_host
        .lock()
        .unwrap()
        .shells
        .insert("ticket".into(), seed());
    assert_eq!(
        app.plugin_claim_shell(&call, "r1", "ticket", "host", &expected)
            .unwrap(),
        "host"
    );
    assert!(
        app.plugin_claim_shell(&call, "r1", "ticket", "host", &expected)
            .is_err()
    );
    app.plugin_host
        .lock()
        .unwrap()
        .shells
        .insert("ticket".into(), seed());
    drop(call);
    app.plugin_host
        .resume(id, Some((context(), "profile".into())))
        .unwrap();
    let changed = app.plugin_host.start(id).unwrap();
    assert!(
        app.plugin_claim_shell(&changed, "r1", "ticket", "host", &expected)
            .is_err()
    );
    drop(changed);
    app.plugin_stop_resources(id).await.unwrap();
    assert!(app.plugin_host.lock().unwrap().shells.is_empty());
    app.shutdown().await;
}
