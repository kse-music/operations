use super::*;
use serverdeck_plugin_sdk::streaming::Request as Stream;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn primitive(request: Stream) -> Primitive {
    Primitive::Streaming { request }
}

#[tokio::test]
async fn progress_is_owned_bounded_revisioned_and_readable_while_the_guest_is_busy() {
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.progress").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let opened = call(app, id, "page", primitive(Stream::ProgressOpen)).await;
    let progress = opened.result["id"].as_str().unwrap().to_owned();
    let scoped = app.plugin_host.start_scoped(id, "page").unwrap();
    let publish = |text: String, reset| {
        app.plugin_dispatch(
            &scoped,
            request(cap(primitive(Stream::ProgressPublish {
                id: progress.clone(),
                text,
                reset,
            }))),
        )
    };
    assert!(
        publish("你".repeat(6000), true)
            .await
            .unwrap()
            .error
            .is_some()
    ); // single part >16 KiB
    assert!(
        publish("你".repeat(5000), true)
            .await
            .unwrap()
            .error
            .is_none()
    );
    assert!(
        publish("好".repeat(5000), false)
            .await
            .unwrap()
            .error
            .is_none()
    );
    let first = call(
        app,
        id,
        "page",
        primitive(Stream::ProgressRead {
            id: progress.clone(),
            revision: 0,
            offset: 0,
        }),
    )
    .await;
    assert!(first.error.is_none(), "{first:?}");
    assert!(first.result["text"].as_str().unwrap().len() <= 16 * 1024);
    let revision = first.result["revision"].as_u64().unwrap();
    let offset = first.result["offset"].as_u64().unwrap() as usize;
    let mut offset = offset;
    let mut collected = first.result["text"].as_str().unwrap().to_owned();
    while offset < 30000 {
        let next = call(
            app,
            id,
            "page",
            primitive(Stream::ProgressRead {
                id: progress.clone(),
                revision,
                offset,
            }),
        )
        .await;
        assert!(next.error.is_none(), "{next:?}");
        collected.push_str(next.result["text"].as_str().unwrap());
        offset = next.result["offset"].as_u64().unwrap() as usize;
    }
    assert_eq!(
        collected,
        format!("{}{}", "你".repeat(5000), "好".repeat(5000))
    );
    let stolen = call(
        app,
        id,
        "other",
        primitive(Stream::ProgressRead {
            id: progress.clone(),
            revision: 0,
            offset: 0,
        }),
    )
    .await;
    assert_eq!(stolen.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    assert!(
        publish("重新开始".into(), true)
            .await
            .unwrap()
            .error
            .is_none()
    );
    let reset = call(
        app,
        id,
        "page",
        primitive(Stream::ProgressRead {
            id: progress.clone(),
            revision,
            offset,
        }),
    )
    .await;
    assert_eq!(reset.result["text"], "重新开始");
    assert_ne!(reset.result["revision"], revision);
    app.plugin_cancel_scope(id, "page").unwrap();
    let closed = app
        .plugin_dispatch(
            &scoped,
            request(cap(primitive(Stream::ProgressClose {
                id: progress.clone(),
            }))),
        )
        .await
        .unwrap();
    assert!(closed.error.is_none());
    assert!(
        !app.plugin_host
            .lock()
            .unwrap()
            .progress
            .contains_key(&progress)
    );
    drop(scoped);
    let reopened = call(app, id, "page", primitive(Stream::ProgressOpen)).await;
    let progress = reopened.result["id"].as_str().unwrap();
    app.plugin_close_scope(id, "page").await.unwrap();
    assert!(
        !app.plugin_host
            .lock()
            .unwrap()
            .progress
            .contains_key(progress)
    );
    app.shutdown().await;
}

#[tokio::test]
async fn native_model_stream_yields_before_http_completion_and_cancellation_drains_its_resources() {
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.model-stream").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 4096];
        let header_end = loop {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                break at + 4;
            }
        };
        let headers = std::str::from_utf8(&bytes[..header_end]).unwrap();
        let len: usize = headers
            .lines()
            .find_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("content-length: ")
                    .map(str::to_owned)
            })
            .unwrap()
            .parse()
            .unwrap();
        while bytes.len() < header_end + len {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
        }
        let body: Value = serde_json::from_slice(&bytes[header_end..header_end + len]).unwrap();
        assert_eq!(body["stream"], true);
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"first \"},\"finish_reason\":null}]}\n\n").await.unwrap();
        let mut byte = [0];
        tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
            .await
            .unwrap()
            .unwrap()
    });
    app.secrets.write("model-stream-key", b"test-key").unwrap();
    let record = serverdeck_storage::ai::ModelRecord {
        id: "stream-model".into(),
        name: "stream fixture".into(),
        config: serverdeck_core::ai::Config {
            base_url: format!("http://{address}/v1"),
            model: "fixture".into(),
            allow_insecure_http: true,
            ..Default::default()
        },
        secret_ref: Some("model-stream-key".into()),
        revision: "revision".into(),
    };
    app.database.ai_model_save(record, None).unwrap();
    let scoped = app.plugin_host.start_scoped(id, "page").unwrap();
    let opened = app
        .plugin_dispatch(
            &scoped,
            request(cap(primitive(Stream::ModelStart {
                model_id: "stream-model".into(),
                expected_revision: Some("revision".into()),
                messages: vec![serverdeck_plugin_sdk::platform::Message {
                    role: serverdeck_plugin_sdk::platform::Role::User,
                    content: "test".into(),
                }],
            }))),
        )
        .await
        .unwrap();
    assert!(opened.error.is_none(), "{opened:?}");
    let stream = opened.result["id"].as_str().unwrap().to_owned();
    let part = app
        .plugin_dispatch(
            &scoped,
            request(cap(primitive(Stream::ModelPoll { id: stream.clone() }))),
        )
        .await
        .unwrap();
    assert!(part.error.is_none(), "{part:?}");
    assert_eq!(part.result["deltas"][0]["text"], "first ");
    assert!(part.result["completion"].is_null());
    assert!(!server.is_finished());
    let stolen = call(
        app,
        id,
        "other",
        primitive(Stream::ModelClose { id: stream.clone() }),
    )
    .await;
    assert_eq!(stolen.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    app.plugin_cancel_scope(id, "page").unwrap();
    let closed = app
        .plugin_dispatch(
            &scoped,
            request(cap(primitive(Stream::ModelClose { id: stream.clone() }))),
        )
        .await
        .unwrap();
    assert!(closed.error.is_none(), "{closed:?}");
    assert!(
        !app.plugin_host
            .lock()
            .unwrap()
            .model_streams
            .contains_key(&stream)
    );
    assert_eq!(server.await.unwrap(), 0);
    drop(scoped);
    app.shutdown().await;
}

#[tokio::test]
async fn model_stream_completes_with_unchanged_model_and_host_bindings() {
    use serverdeck_core::hosts::{AuthType, HostInput};
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.bound-model-stream").await;
    fixture.grant(&plugin).await;
    let id = &plugin.manifest.id;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
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
                    break;
                }
            }
        }
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"fixture answer\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n").await.unwrap();
    });
    app.secrets
        .write("bound-stream-key", b"fixture-key")
        .unwrap();
    let revision = uuid::Uuid::new_v4().to_string();
    app.database
        .ai_model_save(
            serverdeck_storage::ai::ModelRecord {
                id: "bound-stream-model".into(),
                name: "fixture".into(),
                config: serverdeck_core::ai::Config {
                    base_url: format!("http://{address}/v1"),
                    model: "fixture".into(),
                    allow_insecure_http: true,
                    ..Default::default()
                },
                secret_ref: Some("bound-stream-key".into()),
                revision: revision.clone(),
            },
            None,
        )
        .unwrap();
    let host = app
        .database
        .host_create(HostInput {
            name: "fixture".into(),
            hostname: "127.0.0.1".into(),
            port: 22,
            username: "test".into(),
            auth_type: AuthType::Agent,
            credential_id: None,
            group_id: None,
            description: String::new(),
            favorite: false,
            connect_timeout_secs: 15,
            ssh: Default::default(),
        })
        .unwrap();
    let model = call(
        app,
        id,
        "page",
        Primitive::Model {
            model_id: "bound-stream-model".into(),
        },
    )
    .await;
    let host = call(app, id, "page", Primitive::Host { host_id: host.id }).await;
    let bindings = vec![
        model.result["binding"].as_str().unwrap().to_owned(),
        host.result["binding"].as_str().unwrap().to_owned(),
    ];
    let scoped = app.plugin_host.start_scoped(id, "page").unwrap();
    let dispatch = |request_value| {
        app.plugin_dispatch(
            &scoped,
            request(Capability::Platform {
                request: primitive(request_value),
                bindings: bindings.clone(),
            }),
        )
    };
    let opened = dispatch(Stream::ModelStart {
        model_id: "bound-stream-model".into(),
        expected_revision: Some(revision),
        messages: vec![serverdeck_plugin_sdk::platform::Message {
            role: serverdeck_plugin_sdk::platform::Role::User,
            content: "fixture question".into(),
        }],
    })
    .await
    .unwrap();
    assert!(opened.error.is_none(), "{opened:?}");
    let stream = opened.result["id"].as_str().unwrap().to_owned();
    let completion = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let part = dispatch(Stream::ModelPoll { id: stream.clone() })
                .await
                .unwrap();
            assert!(part.error.is_none(), "{part:?}");
            if !part.result["completion"].is_null() {
                break part.result["completion"].clone();
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(completion["text"], "fixture answer");
    assert!(completion["binding"].is_string());
    assert_eq!(completion["incomplete"], false);
    assert!(
        dispatch(Stream::ModelClose { id: stream })
            .await
            .unwrap()
            .error
            .is_none()
    );
    server.await.unwrap();
    drop(scoped);
    app.shutdown().await;
}

#[tokio::test]
async fn streaming_io_can_exceed_96_reads_without_expanding_the_ordinary_action_budget() {
    let fixture = Fixture::new();
    let app = &fixture.app;
    let id = fixture.wasm().await;
    let opened = call(app, &id, "page", primitive(Stream::ProgressOpen)).await;
    let progress = opened.result["id"].as_str().unwrap();
    let streamed=app.plugin_call_scoped(&id,"page",json!({"action":"repeat","input":{"count":100,"request":{"kind":"streaming","request":{"kind":"progress_publish","id":progress,"text":"","reset":false}}}})).await.unwrap();
    assert!(streamed.error.is_none(), "{streamed:?}");
    assert_eq!(streamed.result["count"], 100);
    let ordinary = app
        .plugin_call_scoped(
            &id,
            "page",
            json!({"action":"repeat","input":{"count":100,"request":{"kind":"info"}}}),
        )
        .await;
    assert_eq!(
        serverdeck_core::IpcError::from(ordinary.err().unwrap()).code,
        "PLUGIN_CHAIN_LIMIT"
    );
    app.plugin_close_scope(&id, "page").await.unwrap();
    app.shutdown().await;
}
