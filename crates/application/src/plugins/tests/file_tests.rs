use super::*;
#[path = "../../../../sftp/tests/support/mod.rs"]
#[allow(dead_code)] // Reuse the full SFTP protocol fixture without its desktop-only tests.
mod support;

async fn approved_primitive(app: &Application, id: &str, owner: &str, op: Primitive) -> Value {
    let response = call(app, id, owner, op.clone()).await;
    assert_eq!(
        response.error.as_ref().unwrap().code,
        "PLUGIN_CONFIRMATION_REQUIRED",
        "{response:?}"
    );
    if matches!(
        op,
        Primitive::TransferPrepare { .. }
            | Primitive::TransferDownloadPrepare { .. }
            | Primitive::TransferStart { .. }
    ) {
        let description = response.result["confirmationRequired"]["description"]
            .as_str()
            .unwrap();
        assert!(!description.contains(r"\\?\"), "{description}");
    }
    app.plugin_approve(
        response.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        true,
    )
    .unwrap();
    let response = call(app, id, owner, op).await;
    assert!(response.error.is_none(), "{response:?}");
    response.result
}

async fn bound(
    app: &Application,
    call: &state::Call,
    op: Primitive,
    bindings: Vec<String>,
) -> serverdeck_plugin_sdk::Response {
    app.plugin_dispatch(
        call,
        request(Capability::Platform {
            request: op,
            bindings,
        }),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn assist_mode_auto_reads_only_with_independent_grant_and_never_auto_saves() {
    use serverdeck_plugin_sdk::platform::ApprovalMode;
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.approval-read").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let server = server(app, Duration::ZERO).await;
    std::fs::write(server.root.path().join("etc/fixture/x.yaml"), "x: old\n").unwrap();
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
    let call = app.plugin_host.start_scoped(id, "page").unwrap();
    let read = Primitive::ReadFile {
        host_id: server.host.id.clone(),
        path: "/etc/fixture/x.yaml".into(),
    };
    let manual = bound(app, &call, read.clone(), vec![]).await;
    assert_eq!(manual.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    let automatic = bound(app, &call, read, vec![binding.clone()]).await;
    assert!(automatic.error.is_none(), "{automatic:?}");
    let save = bound(
        app,
        &call,
        Primitive::SaveFile {
            document_id: automatic.result["id"].as_str().unwrap().into(),
            content: "x: new\n".into(),
        },
        vec![binding.clone()],
    )
    .await;
    assert_eq!(save.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    assert_eq!(
        std::fs::read_to_string(server.root.path().join("etc/fixture/x.yaml")).unwrap(),
        "x: old\n"
    );
    drop(call);
    let other = app.plugin_host.start_scoped(id, "other").unwrap();
    let forged = bound(
        app,
        &other,
        Primitive::ReadFile {
            host_id: server.host.id.clone(),
            path: "/etc/fixture/x.yaml".into(),
        },
        vec![binding.clone()],
    )
    .await;
    assert!(forged.error.is_some());
    drop(other);
    // A remembered mode cannot grant a permission that the current installation lacks.
    let read = Capability::Platform {
        request: Primitive::ReadFile {
            host_id: server.host.id.clone(),
            path: "/etc/fixture/x.yaml".into(),
        },
        bindings: vec![binding],
    };
    let mut grant = app.plugins.grant(id).unwrap().unwrap();
    grant
        .permissions
        .retain(|p| *p != Permission::OperationsReadPreapproved);
    grant
        .operations
        .retain(|op| op != "operations.read.preapproved");
    let call = app.plugin_host.start_scoped(id, "page").unwrap();
    assert!(
        !app.plugin_mode_preapproves(&call, &plugin, &grant, &read)
            .unwrap()
    );
    drop(call);
    app.shutdown().await;
}

#[tokio::test]
async fn full_mode_reads_and_saves_without_repeated_approval_but_cannot_escape_file_roots() {
    use serverdeck_plugin_sdk::platform::ApprovalMode;
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture
        .install_with_commands(
            "dev.full-files",
            &[Permission::OperationsFullPreapproved],
            vec![],
        )
        .await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let server = server(app, Duration::ZERO).await;
    let path = server.root.path().join("etc/fixture/x.yaml");
    std::fs::write(&path, "x: old\n").unwrap();
    let mode = Primitive::ApprovalMode {
        mode: ApprovalMode::Full,
    };
    let pending = call(app, id, "page", mode.clone()).await;
    assert_eq!(pending.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    app.plugin_approve(
        pending.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        true,
    )
    .unwrap();
    let policy = call(app, id, "page", mode).await;
    let binding = policy.result["binding"].as_str().unwrap().to_owned();
    let scoped = app.plugin_host.start_scoped(id, "page").unwrap();
    let read = bound(
        app,
        &scoped,
        Primitive::ReadFile {
            host_id: server.host.id.clone(),
            path: "/etc/fixture/x.yaml".into(),
        },
        vec![binding.clone()],
    )
    .await;
    assert!(read.error.is_none(), "{read:?}");
    let saved = bound(
        app,
        &scoped,
        Primitive::SaveFile {
            document_id: read.result["id"].as_str().unwrap().into(),
            content: "x: new\n".into(),
        },
        vec![binding.clone()],
    )
    .await;
    assert!(saved.error.is_none(), "{saved:?}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "x: new\n");
    let escaped = bound(
        app,
        &scoped,
        Primitive::ReadFile {
            host_id: server.host.id.clone(),
            path: "/outside/secret".into(),
        },
        vec![binding],
    )
    .await;
    assert_eq!(escaped.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    drop(scoped);
    app.shutdown().await;
}

#[tokio::test]
async fn one_plan_confirmation_freezes_file_bytes_and_is_consumed_once() {
    use serverdeck_plugin_sdk::platform::ApprovalOperation;
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.approval-save").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let server = server(app, Duration::ZERO).await;
    let file = server.root.path().join("etc/fixture/x.yaml");
    std::fs::write(&file, "x: old\n").unwrap();
    let doc = approved_primitive(
        app,
        id,
        "page",
        Primitive::ReadFile {
            host_id: server.host.id.clone(),
            path: "/etc/fixture/x.yaml".into(),
        },
    )
    .await;
    let save = Primitive::SaveFile {
        document_id: doc["id"].as_str().unwrap().into(),
        content: "x: new\n".into(),
    };
    let plan = Primitive::ConfirmOperations {
        operations: vec![ApprovalOperation {
            request: Box::new(save.clone()),
            count: 1,
        }],
    };
    let call = app.plugin_host.start_scoped(id, "page").unwrap();
    let preview = bound(app, &call, plan.clone(), vec![]).await;
    assert_eq!(preview.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    assert!(
        preview.result["confirmationRequired"]["description"]
            .as_str()
            .unwrap()
            .contains("-x: old")
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "x: old\n");
    app.plugin_approve(
        preview.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        false,
    )
    .unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "x: old\n");
    let preview = bound(app, &call, plan.clone(), vec![]).await;
    app.plugin_approve(
        preview.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        true,
    )
    .unwrap();
    let consent = bound(app, &call, plan, vec![]).await;
    assert!(consent.error.is_none(), "{consent:?}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "x: old\n");
    let saved = bound(app, &call, save.clone(), vec![]).await;
    assert!(saved.error.is_none(), "{saved:?}");
    assert_eq!(saved.result["saved"], true);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "x: new\n");
    let replay = bound(app, &call, save.clone(), vec![]).await;
    assert_eq!(replay.error.unwrap().code, "PLUGIN_PLAN_CHANGED");
    drop(call);
    let next = app.plugin_host.start_scoped(id, "page").unwrap();
    let again = bound(app, &next, save, vec![]).await;
    assert_eq!(again.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    drop(next);
    app.shutdown().await;
}
async fn server(app: &Application, delay: Duration) -> support::Server {
    let mut server = support::Server::start_shared(
        true,
        delay,
        Some((app.database.clone(), app.terminals.clone())),
    )
    .await;
    let credential = app
        .credential_save(
            None,
            None,
            serverdeck_core::hosts::CredentialInput {
                name: "SFTP fixture".into(),
                kind: serverdeck_core::hosts::AuthType::Password,
                key_path: None,
                key_data: None,
                secret: Some(Zeroizing::new(server.password.clone())),
                clear_secret: false,
            },
        )
        .await
        .unwrap()
        .value;
    let mut config = server.host.config.clone();
    config.credential_id = Some(credential.id);
    server.host = app.database.host_update(&server.host.id, config).unwrap();
    std::fs::create_dir_all(server.root.path().join("etc/fixture")).unwrap();
    server.open().await;
    server
}

#[tokio::test]
async fn virtual_file_size_is_reported_without_creating_an_editable_document() {
    use serverdeck_plugin_sdk::platform::ApprovalMode;
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.virtual-file").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let server = server(app, Duration::ZERO).await;
    let path = "/etc/fixture/cpuinfo";
    std::fs::write(
        server.root.path().join("etc/fixture/cpuinfo"),
        "model name : fixture CPU\n",
    )
    .unwrap();
    server
        .faults
        .reported_sizes
        .lock()
        .unwrap()
        .insert(path.into(), 0);
    let policy = call(
        app,
        id,
        "page",
        Primitive::ApprovalMode {
            mode: ApprovalMode::Assist,
        },
    )
    .await;
    let scoped = app.plugin_host.start_scoped(id, "page").unwrap();
    let response = bound(
        app,
        &scoped,
        Primitive::ReadFile {
            host_id: server.host.id.clone(),
            path: path.into(),
        },
        vec![policy.result["binding"].as_str().unwrap().into()],
    )
    .await;
    assert_eq!(response.error.unwrap().code, "TEXT_SIZE_MISMATCH");
    assert!(app.plugin_host.lock().unwrap().documents.is_empty());
    assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
    // A genuine empty regular file remains readable, with the usual edit binding.
    server.faults.reported_sizes.lock().unwrap().clear();
    std::fs::write(server.root.path().join("etc/fixture/cpuinfo"), "").unwrap();
    let response = bound(
        app,
        &scoped,
        Primitive::ReadFile {
            host_id: server.host.id.clone(),
            path: path.into(),
        },
        vec![policy.result["binding"].as_str().unwrap().into()],
    )
    .await;
    assert!(response.error.is_none(), "{response:?}");
    assert_eq!(response.result["content"], "");
    assert!(response.result["id"].is_string());
    drop(scoped);
    app.shutdown().await;
}

#[tokio::test]
async fn read_preview_save_require_native_approval_owner_and_original_version() {
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.files").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let server = server(app, Duration::ZERO).await;
    let file = server.root.path().join("etc/fixture/x.yaml");
    std::fs::write(&file, "x: old\n").unwrap();
    let outside = call(
        app,
        id,
        "page",
        Primitive::ReadFile {
            host_id: server.host.id.clone(),
            path: "/secret".into(),
        },
    )
    .await;
    assert_eq!(outside.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    let doc = approved_primitive(
        app,
        id,
        "page",
        Primitive::ReadFile {
            host_id: server.host.id.clone(),
            path: "/etc/fixture/x.yaml".into(),
        },
    )
    .await;
    assert_eq!(doc["content"], "x: old\n");
    let token = doc["id"].as_str().unwrap();
    let denied = call(
        app,
        id,
        "other",
        Primitive::SaveFile {
            document_id: token.into(),
            content: "x: hacked\n".into(),
        },
    )
    .await;
    assert_eq!(denied.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "x: old\n");
    let saved = approved_primitive(
        app,
        id,
        "page",
        Primitive::SaveFile {
            document_id: token.into(),
            content: "x: new\n".into(),
        },
    )
    .await;
    assert_eq!(saved["saved"], true);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "x: new\n");
    std::fs::write(&file, "external writer\n").unwrap();
    let op = Primitive::SaveFile {
        document_id: token.into(),
        content: "x: should not save\n".into(),
    };
    let response = call(app, id, "page", op.clone()).await;
    app.plugin_approve(
        response.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        true,
    )
    .unwrap();
    let conflict = call(app, id, "page", op).await;
    assert!(conflict.error.is_some());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "external writer\n");
    app.plugin_close_scope(id, "page").await.unwrap();
    app.shutdown().await;
}

#[tokio::test]
async fn transfer_preparation_start_and_out_of_band_cancel_use_native_authority() {
    use serverdeck_plugin_sdk::platform::{RemotePath, TransferSource};
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.copy").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let server = server(app, Duration::from_millis(40)).await;
    let input = fixture.dir.path().join("archive.tar.gz");
    std::fs::write(&input, vec![b'x'; 1024 * 1024]).unwrap();
    let input = input.canonicalize().unwrap();
    let prepare = Primitive::TransferPrepare {
        source: TransferSource::Local {
            path: input.to_str().unwrap().into(),
        },
        destination: RemotePath {
            host_id: server.host.id.clone(),
            path: "/etc/fixture".into(),
        },
        overwrite: false,
    };
    let preview = approved_primitive(app, id, "page", prepare).await;
    let key = preview["id"].as_str().unwrap();
    assert_eq!(preview["bytes"], 1024 * 1024);
    assert!(
        !server
            .root
            .path()
            .join("etc/fixture/archive.tar.gz")
            .exists()
    );
    let denied = call(
        app,
        id,
        "other",
        Primitive::TransferStart { id: key.into() },
    )
    .await;
    assert_eq!(denied.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    approved_primitive(app, id, "page", Primitive::TransferStart { id: key.into() }).await;
    let busy = app.plugin_host.start_scoped(id, "model-page").unwrap();
    let denied = call(
        app,
        id,
        "other",
        Primitive::TransferCancel { id: key.into() },
    )
    .await;
    assert_eq!(denied.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    let cancelled = call(
        app,
        id,
        "page",
        Primitive::TransferCancel { id: key.into() },
    )
    .await;
    assert!(cancelled.error.is_none(), "{cancelled:?}");
    assert!(
        matches!(
            app.plugin_host.start_scoped(id, "another"),
            Err(Error::Busy)
        ),
        "cancellation must not release another guest action"
    );
    drop(busy);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let response = call(
                app,
                id,
                "page",
                Primitive::TransferStatus { id: key.into() },
            )
            .await;
            assert!(response.error.is_none(), "{response:?}");
            if response.result["state"] == "cancelled" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        !server
            .root
            .path()
            .join("etc/fixture/archive.tar.gz")
            .exists()
    );
    let replay = call(app, id, "page", Primitive::TransferStart { id: key.into() }).await;
    assert_eq!(replay.error.unwrap().code, "TRANSFER_CONSUMED");
    app.plugin_close_scope(id, "page").await.unwrap();
    assert!(app.plugin_host.lock().unwrap().copies.is_empty());
    app.shutdown().await;
}

#[tokio::test]
async fn revoking_plugin_authority_drains_owned_copy_without_committing_target() {
    use serverdeck_plugin_sdk::platform::{RemotePath, TransferSource};
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.revoke-copy").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let server = server(app, Duration::from_millis(40)).await;
    let input = fixture.dir.path().join("revoke.tar.gz");
    std::fs::write(&input, vec![b'x'; 1024 * 1024]).unwrap();
    let preview = approved_primitive(
        app,
        id,
        "page",
        Primitive::TransferPrepare {
            source: TransferSource::Local {
                path: input.canonicalize().unwrap().to_str().unwrap().into(),
            },
            destination: RemotePath {
                host_id: server.host.id.clone(),
                path: "/etc/fixture".into(),
            },
            overwrite: false,
        },
    )
    .await;
    let key = preview["id"].as_str().unwrap();
    approved_primitive(app, id, "page", Primitive::TransferStart { id: key.into() }).await;
    let job = app.plugin_host.lock().unwrap().copies[key]
        .job
        .clone()
        .unwrap();
    app.plugin_revoke(id.clone()).await.unwrap();
    assert!(!job.info().unwrap().unfinished());
    assert_ne!(job.info().unwrap().state, "completed");
    assert!(
        !server
            .root
            .path()
            .join("etc/fixture/revoke.tar.gz")
            .exists()
    );
    assert!(app.plugin_host.lock().unwrap().copies.is_empty());
    app.shutdown().await;
}

#[tokio::test]
async fn plugin_download_verifies_bytes_refuses_conflicts_and_binds_owner() {
    use serverdeck_plugin_sdk::platform::RemotePath;
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.download").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let server = server(app, Duration::ZERO).await;
    let bytes = vec![b'd'; 128 * 1024];
    let remote = server.root.path().join("etc/fixture/image.tar");
    std::fs::write(&remote, &bytes).unwrap();
    let destination = fixture
        .dir
        .path()
        .canonicalize()
        .unwrap()
        .join("downloaded image.tar");
    let prepare = Primitive::TransferDownloadPrepare {
        source: RemotePath {
            host_id: server.host.id.clone(),
            path: "/etc/fixture/image.tar".into(),
        },
        destination: destination.to_str().unwrap().into(),
    };
    let preview = approved_primitive(app, id, "page", prepare.clone()).await;
    assert_eq!(
        preview["destination"]["localPath"],
        destination.to_str().unwrap()
    );
    assert_eq!(preview["bytes"], bytes.len());
    assert!(!destination.exists());
    let key = preview["id"].as_str().unwrap();
    let denied = call(
        app,
        id,
        "other",
        Primitive::TransferStart { id: key.into() },
    )
    .await;
    assert_eq!(denied.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    approved_primitive(app, id, "page", Primitive::TransferStart { id: key.into() }).await;
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let response = call(
                app,
                id,
                "page",
                Primitive::TransferStatus { id: key.into() },
            )
            .await;
            assert!(response.error.is_none(), "{response:?}");
            if !["queued", "scanning", "running", "verifying"]
                .contains(&response.result["state"].as_str().unwrap())
            {
                break response.result;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(result["state"], "completed", "{result}");
    assert_eq!(result["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(std::fs::read(&destination).unwrap(), bytes);
    assert_eq!(std::fs::read(&remote).unwrap(), bytes);
    let conflict = call(app, id, "page", prepare.clone()).await;
    assert_eq!(conflict.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    app.plugin_approve(
        conflict.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        true,
    )
    .unwrap();
    let conflict = call(app, id, "page", prepare).await;
    assert_eq!(conflict.error.unwrap().code, "FILE_CONFLICT");
    assert_eq!(std::fs::read(&destination).unwrap(), bytes);
    app.plugin_close_scope(id, "page").await.unwrap();
    app.shutdown().await;
}

#[tokio::test]
async fn plugin_download_revocation_cancels_before_local_commit() {
    use serverdeck_plugin_sdk::platform::RemotePath;
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.download-revoke").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let server = server(app, Duration::from_millis(40)).await;
    std::fs::write(
        server.root.path().join("etc/fixture/image.tar"),
        vec![b'x'; 1024 * 1024],
    )
    .unwrap();
    let destination = fixture
        .dir
        .path()
        .canonicalize()
        .unwrap()
        .join("cancelled.tar");
    let preview = approved_primitive(
        app,
        id,
        "page",
        Primitive::TransferDownloadPrepare {
            source: RemotePath {
                host_id: server.host.id.clone(),
                path: "/etc/fixture/image.tar".into(),
            },
            destination: destination.to_str().unwrap().into(),
        },
    )
    .await;
    let key = preview["id"].as_str().unwrap();
    approved_primitive(app, id, "page", Primitive::TransferStart { id: key.into() }).await;
    let job = app.plugin_host.lock().unwrap().copies[key]
        .job
        .clone()
        .unwrap();
    app.plugin_revoke(id.clone()).await.unwrap();
    assert!(!job.info().unwrap().unfinished());
    assert_ne!(job.info().unwrap().state, "completed");
    assert!(!destination.exists());
    assert!(app.plugin_host.lock().unwrap().copies.is_empty());
    app.shutdown().await;
}

#[tokio::test]
async fn transfer_preapproval_skips_prompts_for_upload_and_download_but_preserves_roots_and_content()
 {
    use serverdeck_plugin_sdk::platform::{RemotePath, TransferSource};
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture
        .install_with_commands(
            "dev.direct-transfer",
            &[Permission::SftpTransferPreapproved],
            vec![],
        )
        .await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let server = server(app, Duration::ZERO).await;
    let local_dir = fixture.dir.path().canonicalize().unwrap();
    let bytes = vec![b'm'; 128 * 1024];
    let local_source = local_dir.join("image.tar");
    std::fs::write(&local_source, &bytes).unwrap();
    for download in [false, true] {
        let request = if download {
            Primitive::TransferDownloadPrepare {
                source: RemotePath {
                    host_id: server.host.id.clone(),
                    path: "/etc/fixture/image.tar".into(),
                },
                destination: local_dir.join("download.tar").to_str().unwrap().into(),
            }
        } else {
            Primitive::TransferPrepare {
                source: TransferSource::Local {
                    path: local_source.to_str().unwrap().into(),
                },
                destination: RemotePath {
                    host_id: server.host.id.clone(),
                    path: "/etc/fixture".into(),
                },
                overwrite: false,
            }
        };
        let preview = call(app, id, "page", request).await;
        assert!(preview.error.is_none(), "{preview:?}");
        assert!(preview.result.get("confirmationRequired").is_none());
        let key = preview.result["id"].as_str().unwrap();
        let started = call(app, id, "page", Primitive::TransferStart { id: key.into() }).await;
        assert!(started.error.is_none(), "{started:?}");
        let job = app.plugin_host.lock().unwrap().copies[key]
            .job
            .clone()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while job.info().unwrap().unfinished() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(job.info().unwrap().state, "completed");
        assert!(app.plugin_host.lock().unwrap().approvals.is_empty());
    }
    assert_eq!(
        std::fs::read(local_dir.join("download.tar")).unwrap(),
        bytes
    );
    assert_eq!(
        std::fs::read(server.root.path().join("etc/fixture/image.tar")).unwrap(),
        bytes
    );
    let denied = call(
        app,
        id,
        "page",
        Primitive::TransferDownloadPrepare {
            source: RemotePath {
                host_id: server.host.id.clone(),
                path: "/outside/image.tar".into(),
            },
            destination: local_dir.join("denied.tar").to_str().unwrap().into(),
        },
    )
    .await;
    assert_eq!(denied.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    assert!(!local_dir.join("denied.tar").exists());
    let conflict = call(
        app,
        id,
        "page",
        Primitive::TransferDownloadPrepare {
            source: RemotePath {
                host_id: server.host.id.clone(),
                path: "/etc/fixture/image.tar".into(),
            },
            destination: local_dir.join("download.tar").to_str().unwrap().into(),
        },
    )
    .await;
    assert_eq!(conflict.error.unwrap().code, "FILE_CONFLICT");
    app.plugin_close_scope(id, "page").await.unwrap();
    app.shutdown().await;
}
