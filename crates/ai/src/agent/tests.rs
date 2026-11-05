use super::*;
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Host(Response);
impl AgentHost for Host {
    async fn query(&self, request: Request) -> Result<Response, Error> {
        assert!(matches!(request, Request::Images));
        Ok(self.0.clone())
    }
}
fn row(id: char, tag: &str) -> Value {
    json!({"ID":format!("sha256:{}",id.to_string().repeat(64)),"Tag":tag,"Repository":"fixture"})
}
fn binding() -> Binding {
    Binding {
        session: serverdeck_core::terminal::TerminalSession {
            id: "session".into(),
            host_id: "host".into(),
            transport_id: "transport".into(),
            route_host_ids: vec![],
        },
        profile: "profile".into(),
        hostname: "fixture".into(),
        username: "ops".into(),
        port: 22,
    }
}
fn prepare(assistant: &Assistant, config: Config) -> Preview {
    assistant
        .prepare(PreparedContext {
            related_bindings: vec![],
            history: vec![],
            model_id: "model".into(),
            revision: "revision".into(),
            config,
            question: "删除 Docker 镜像中 tag 为 <none> 的镜像".into(),
            context: json!({}),
            binding: Some(binding()),
            redactor: Redactor::new(true, vec![]).unwrap(),
            warnings: vec![],
        })
        .unwrap()
}
async fn model(replies: Vec<Value>) -> (Config, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = Config {
        base_url: format!("http://{}/v1", listener.local_addr().unwrap()),
        allow_insecure_http: true,
        model: "fixture".into(),
        ..Default::default()
    };
    let task = tokio::spawn(async move {
        let mut requests = vec![];
        for reply in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = vec![];
            let end = loop {
                let mut buf = [0; 4096];
                let size = stream.read(&mut buf).await.unwrap();
                assert!(size > 0);
                bytes.extend_from_slice(&buf[..size]);
                if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let size: usize = std::str::from_utf8(&bytes[..end])
                .unwrap()
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .unwrap()
                .parse()
                .unwrap();
            while bytes.len() < end + size {
                let mut buf = [0; 4096];
                let size = stream.read(&mut buf).await.unwrap();
                assert!(size > 0);
                bytes.extend_from_slice(&buf[..size]);
            }
            requests.push(serde_json::from_slice(&bytes[end..end + size]).unwrap());
            let body=json!({"choices":[{"message":{"content":reply.to_string()},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20}}).to_string();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    (config, task)
}
#[tokio::test]
async fn query_plan_uses_complete_evidence_excludes_tagged_aliases_and_requires_single_use_confirmation()
 {
    let assistant = Assistant::default();
    let (config,http)=model(vec![json!({"kind":"query","requests":[{"kind":"images"}]}),json!({"kind":"plan","summary":"删除无标签镜像，不强制","actions":[{"kind":"remove_untagged_images"}]})]).await;
    let preview = prepare(&assistant, config);
    let mut rows = (0..21).map(|_| row('b', "latest")).collect::<Vec<_>>();
    rows.extend([row('a', "<none>"), row('c', "<none>"), row('c', "stable")]);
    let host = Host(Response::records(rows));
    let answer = assistant
        .send_agent(&preview.id, "revision", b"test-key", true, &host)
        .await
        .unwrap();
    let requests = http.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].to_string().contains("totalRecords"));
    assert_eq!(answer.usage.unwrap().input_tokens, 20);
    assert_eq!(answer.agent.as_ref().unwrap().steps.len(), 1);
    assert!(
        answer.agent.as_ref().unwrap().steps[0]
            .target
            .ends_with(&"a".repeat(64)),
        "target after omitted excerpt is still selected from full evidence"
    );
    let proposal = &answer.proposals[0];
    assert!(
        assistant
            .take_plan(ExecuteInput {
                proposal_id: proposal.id.clone(),
                confirmed: true,
                change_confirmation: Some("forged".into())
            })
            .is_err()
    );
    let review = assistant.review_command(&proposal.id).unwrap();
    assert_eq!(review["steps"].as_array().unwrap().len(), 1);
    let lease = assistant
        .take_plan(ExecuteInput {
            proposal_id: proposal.id.clone(),
            confirmed: true,
            change_confirmation: proposal.change_confirmation.clone(),
        })
        .unwrap();
    assert!(
        assistant
            .take_plan(ExecuteInput {
                proposal_id: proposal.id.clone(),
                confirmed: true,
                change_confirmation: proposal.change_confirmation.clone()
            })
            .is_err()
    );
    assistant.cancel(&preview.id).unwrap();
    assert!(lease.cancel.is_cancelled());
}
#[tokio::test]
async fn plan_without_successful_evidence_unknown_targets_and_oversized_plans_are_rejected() {
    let host = Host(Response::records(vec![]));
    assert!(
        build_plan(vec![Action::RemoveUntaggedImages], &[], &host)
            .await
            .is_err()
    );
    assert!(
        build_plan(
            vec![Action::Container {
                id: "a".repeat(64),
                action: ContainerAction::Stop
            }],
            &[(Request::Containers, Response::records(vec![]))],
            &host
        )
        .await
        .is_err()
    );
    let rows = (0..33)
        .map(|i| json!({"ID":format!("{i:064x}"),"Tag":"<none>"}))
        .collect();
    assert!(
        build_plan(
            vec![Action::RemoveUntaggedImages],
            &[(Request::Images, Response::records(rows))],
            &host
        )
        .await
        .is_err()
    );
    assert!(
        build_plan(
            vec![Action::RemoveUntaggedImages],
            &[(
                Request::Images,
                Response {
                    success: false,
                    ..Response::records(vec![row('a', "<none>")])
                }
            )],
            &host
        )
        .await
        .is_err()
    );
}
#[tokio::test]
async fn mutation_tool_requests_are_never_dispatched_and_repeated_queries_are_bounded() {
    for replies in [
        vec![
            json!({"kind":"query","requests":[{"kind":"image_remove","id":"a".repeat(64),"confirmed":true}]}),
        ],
        vec![json!({"kind":"query","requests":[{"kind":"images"}]}); 6],
    ] {
        let assistant = Assistant::default();
        let (config, http) = model(replies).await;
        let preview = prepare(&assistant, config);
        assert!(
            assistant
                .send_agent(
                    &preview.id,
                    "revision",
                    b"test-key",
                    true,
                    &Host(Response::records(vec![]))
                )
                .await
                .is_err()
        );
        http.await.unwrap();
        assert!(lock(&assistant.state).unwrap().plans.is_empty());
    }
}
#[tokio::test]
async fn stale_plan_expiry_model_revocation_and_retagging_prevent_execution() {
    let host = Host(Response::records(vec![row('a', "<none>")]));
    let steps = build_plan(
        vec![Action::RemoveUntaggedImages],
        &[(Request::Images, host.0.clone())],
        &host,
    )
    .await
    .unwrap();
    assert!(
        fingerprint(
            &steps[0].request,
            &Response::records(vec![row('a', "latest")])
        )
        .is_err()
    );
    assert!(!verified(&steps[0], &host.0));
    assert!(verified(&steps[0], &Response::records(vec![])));
    assert!(!verified(
        &steps[0],
        &Response {
            success: false,
            ..Response::records(vec![])
        }
    ));
    for expired in [false, true] {
        let assistant = Assistant::default();
        let (config, http) = model(vec![
            json!({"kind":"query","requests":[{"kind":"images"}]}),
            json!({"kind":"plan","summary":"clean","actions":[{"kind":"remove_untagged_images"}]}),
        ])
        .await;
        let preview = prepare(&assistant, config);
        let answer = assistant
            .send_agent(&preview.id, "revision", b"test-key", true, &host)
            .await
            .unwrap();
        http.await.unwrap();
        let id = &answer.proposals[0].id;
        if expired {
            lock(&assistant.state)
                .unwrap()
                .plans
                .get_mut(id)
                .unwrap()
                .at = Instant::now() - Duration::from_secs(601);
        } else {
            assistant.revoke_model("model").unwrap();
        }
        assert!(assistant.review_command(id).is_err());
    }
}

#[tokio::test]
async fn service_and_container_plans_require_observed_identity_and_verify_actual_postconditions() {
    struct Details;
    impl AgentHost for Details {
        async fn query(&self, request: Request) -> Result<Response, Error> {
            Ok(match request {
                Request::ContainerDetails {
                    id,
                    reveal_env: false,
                    ..
                } => Response::detail(
                    json!({"id":id,"state":{"Status":"running","Running":true,"StartedAt":"before"}}),
                ),
                Request::ServiceDetails { unit, .. } => Response::detail(
                    json!({"Id":unit,"LoadState":"loaded","ActiveState":"active","UnitFileState":"enabled","MainPID":"42","ActiveEnterTimestamp":"before"}),
                ),
                _ => panic!("unexpected query"),
            })
        }
    }
    let id = "a".repeat(64);
    let evidence = vec![
        (
            Request::Containers,
            Response::records(vec![json!({"ID":id})]),
        ),
        (
            Request::Services {
                scope: Scope::System,
            },
            Response::records(vec![json!({"unit":"nginx.service"})]),
        ),
    ];
    let steps = build_plan(
        vec![
            Action::Container {
                id: id.clone(),
                action: ContainerAction::Restart,
            },
            Action::Service {
                scope: Scope::System,
                unit: "nginx.service".into(),
                action: ServiceAction::Restart,
            },
        ],
        &evidence,
        &Details,
    )
    .await
    .unwrap();
    for step in &steps {
        let mut response = Details.query(step.read.clone()).await.unwrap();
        assert!(
            !verified(step, &response),
            "a successful command with unchanged restart evidence is not verified"
        );
        if matches!(step.request, Request::ContainerAction { .. }) {
            response.detail.as_mut().unwrap()["state"]["StartedAt"] = json!("after");
        } else {
            response.detail.as_mut().unwrap()["ActiveEnterTimestamp"] = json!("after");
        }
        assert!(verified(step, &response));
        assert_ne!(fingerprint(&step.request, &response).unwrap(), step.before);
    }
    assert!(
        build_plan(
            vec![Action::Service {
                scope: Scope::User,
                unit: "nginx.service".into(),
                action: ServiceAction::Stop
            }],
            &evidence,
            &Details
        )
        .await
        .is_err(),
        "system observation cannot authorize user-scope action"
    );
    assert!(
        build_plan(
            vec![
                Action::Container {
                    id: id.clone(),
                    action: ContainerAction::Stop
                },
                Action::Container {
                    id,
                    action: ContainerAction::Start
                }
            ],
            &evidence,
            &Details
        )
        .await
        .is_err(),
        "a stop/start sequence must not partially execute against a stale frozen precondition; use restart"
    );
}
