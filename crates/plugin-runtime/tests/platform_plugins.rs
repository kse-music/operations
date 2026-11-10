//! Runs packaged production Wasm with the regular VM limits. Platform responses here
//! are test fixtures; SSH, model transports and approval are tested at the host boundary.
use serde_json::{Value, json};
use serverdeck_plugin_core::{InstallInput, Repository};
use serverdeck_plugin_runtime::{Runtime, protocol::Reply};

fn packaged(name: &str) -> (tempfile::TempDir, Runtime, String) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::fs::create_dir_all(root.join(".local/qa/sdk-platform")).unwrap();
    let directory = tempfile::Builder::new()
        .prefix("wasm-")
        .tempdir_in(root.join(".local/qa/sdk-platform"))
        .unwrap();
    let repo = Repository::open(directory.path().join("plugins")).unwrap();
    let path = root
        .join(format!("plugins/system/packages/{name}.sdplugin"))
        .canonicalize()
        .unwrap();
    assert!(
        path.is_file(),
        "Build system packages before running this integration test: {}",
        path.display()
    );
    serverdeck_plugin_core::Package::read(&path, std::env::consts::OS)
        .expect("production package must validate");
    let plugin = repo
        .install(InstallInput {
            path,
            development_confirmed: true,
            expected_version: None,
            expected_digest: None,
        })
        .unwrap();
    let id = plugin.manifest.id;
    repo.set_enabled(&id, true).unwrap();
    (directory, Runtime::new(repo), id)
}
async fn resume(runtime: &Runtime, id: &str, reply: &Reply, result: Value) -> Reply {
    tokio::time::sleep(std::time::Duration::from_millis(70)).await;
    runtime.resume(id,json!({"hostResponse":{"requestId":reply.result["request"]["requestId"],"result":result,"error":null}})).await.unwrap_or_else(|error| panic!("resuming {} failed: {error:?}", operation(reply)["kind"]))
}

fn metadata(request: &Value) -> Value {
    match request["kind"].as_str().unwrap() {
        "info" => {
            json!({"scope":"fixture-owner","nonce":"fixture-id-000000000000000000000000","unixMs":100000})
        }
        "model" => {
            json!({"model":{"id":"model","revision":"revision","config":{"provider":"openai_compatible","baseUrl":"https://fixture.invalid/v1","model":"fixture","maxOutputTokens":2048,"contextWindowTokens":131072}},"binding":"model-binding"})
        }
        "hosts" => {
            json!({"hosts":[{"id":"host","name":"fixture","hostname":"192.168.1.2","username":"user","port":22}],"groups":[]})
        }
        "host" => {
            json!({"host":{"id":"host","name":"fixture","hostname":"192.168.1.2"},"binding":"host-binding"})
        }
        other => panic!("Unexpected primitive: {other}"),
    }
}

async fn invoke(
    runtime: &Runtime,
    id: &str,
    action: &str,
    input: Value,
    mut respond: impl FnMut(&Value) -> Value,
) -> Reply {
    let mut reply = runtime
        .call(id, json!({"action":action,"input":input}))
        .await
        .unwrap();
    for _ in 0..16 {
        if reply.error.is_some() || reply.result["kind"] == "done" {
            return reply;
        }
        let result = respond(operation(&reply));
        reply = resume(runtime, id, &reply, result).await;
    }
    panic!("Action {action} did not finish within its bounded platform sequence");
}

fn done(reply: &Reply) -> &Value {
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(reply.result["kind"], "done");
    &reply.result["value"]
}

fn prepare_input(mask: bool, linked: bool) -> Value {
    json!({"modelId":"model","sessionId":if linked {Some("host")} else {None},"sessionIds":[],"question":"说明 password=question-secret\n192.168.1.2\n中文秘密","selection":{"server":linked,"metrics":false,"processes":false,"docker":false,"log":null,"logLines":100},"maskAddresses":mask,"redactValues":["中文秘密"],"history":[{"role":"user","content":format!("{}\nBearer history-secret", "历史上下文 ".repeat(500))},{"role":"assistant","content":"上次回答 password=answer-secret"}],"autoHosts":true,"expectedModelRevision":"revision"})
}

#[tokio::test]
async fn assistant_routes_questions_inside_the_packaged_wasm() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    let mut completions = 0;
    let reply = invoke(&runtime, &id, "resolve_hosts", json!({"modelId":"model","question":"说明 password=routing-secret 的问题","requestId":"route","previousHostIds":[],"maskAddresses":true,"redactValues":[]}), |request| {
        if request["kind"] == "model_complete" {
            completions += 1;
            let body = request["messages"].to_string();
            assert!(!body.contains("routing-secret"));
            assert!(!body.contains("192.168.1.2"));
            assert!(body.contains("REDACTED"));
            json!({"text":"{\"hostIds\":[],\"message\":\"\"}","incomplete":false})
        } else {
            metadata(request)
        }
    }).await;
    assert_eq!(done(&reply)["hostIds"], json!([]));
    assert_eq!(completions, 1);
    runtime.health(&id).await.unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn assistant_prepares_and_answers_repeated_questions_without_crashing() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    for (mask, linked) in [(true, false), (false, true), (true, true)] {
        let prepared = invoke(
            &runtime,
            &id,
            "prepare",
            prepare_input(mask, linked),
            metadata,
        )
        .await;
        let preview = done(&prepared);
        let mut completions = 0;
        let reply = invoke(&runtime, &id, "send", json!({"id":preview["id"],"confirmed":true}), |request| {
            if request["kind"] != "model_complete" {
                return metadata(request);
            }
            completions += 1;
            let body = request["messages"].to_string();
            for secret in ["question-secret", "history-secret", "answer-secret", "中文秘密"] {
                assert!(!body.contains(secret), "{secret}");
            }
            assert_eq!(body.contains("192.168.1.2"), !mask);
            assert!(body.contains("历史上下文"));
            let text = if linked {
                json!({"kind":"answer","text":"完成诊断\npassword=model-secret"})
            } else {
                json!({"answer":"完成诊断\npassword=model-secret","commands":[]})
            };
            json!({"text":text.to_string(),"incomplete":false,"usage":{"inputTokens":100,"outputTokens":20}})
        }).await;
        assert_eq!(completions, 1);
        assert!(done(&reply)["text"].as_str().unwrap().contains("完成诊断"));
        assert!(!done(&reply).to_string().contains("model-secret"));
        assert_eq!(
            done(&reply)["usage"],
            json!({"inputTokens":100,"outputTokens":20})
        );
        runtime.health(&id).await.unwrap();
    }
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn assistant_rejects_invalid_input_and_budget_without_crashing_or_calling_a_model() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    for question in [String::new(), "问题".repeat(1365)] {
        let mut input = prepare_input(true, false);
        input["question"] = json!(question);
        let reply = invoke(&runtime, &id, "prepare", input, |request| {
            let mut value = metadata(request);
            if request["kind"] == "model" {
                value["model"]["config"]["contextWindowTokens"] = json!(2300);
            }
            value
        })
        .await;
        assert_eq!(reply.error.as_ref().unwrap().code, "AI_INPUT");
        runtime.health(&id).await.unwrap();
    }
    runtime.shutdown().await.unwrap();
}
fn operation(reply: &Reply) -> &Value {
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(reply.result["kind"], "host_call");
    assert_eq!(reply.result["request"]["operation"]["kind"], "platform");
    &reply.result["request"]["operation"]["request"]
}

#[tokio::test]
async fn docker_compose_prepares_project_commands_and_survives_denial() {
    let (_directory, runtime, id) = packaged("docker");
    runtime.activate(&id).await.unwrap();
    let snapshot = json!({"ID":"a".repeat(64),"Name":"/shop-web-1","Image":"nginx","State":"running","ExitCode":0,"Project":"shop","Service":"web","OneOff":"False","WorkingDir":"/srv/my shop","ConfigFiles":"/srv/my shop/compose.yaml"}).to_string();
    let completed = |stdout: &str| json!({"state":"completed","exitCode":0,"stdout":stdout,"stderr":"","truncated":false,"message":null});
    let projects = invoke(&runtime, &id, "query", json!({"hostId":"host","request":{"kind":"compose_projects"}}), |request| {
        assert!(request["command"]["args"][1].as_str().unwrap().ends_with("d compose ls --all --format json"));
        completed(r#"[{"Name":"shop","Status":"running(1)","ConfigFiles":"/srv/my shop/compose.yaml"}]"#)
    }).await;
    assert_eq!(done(&projects)["records"][0]["Name"], "shop");
    let services = invoke(
        &runtime,
        &id,
        "query",
        json!({"hostId":"host","request":{"kind":"compose_services","project":"shop"}}),
        |_| completed(&snapshot),
    )
    .await;
    assert_eq!(done(&services)["detail"]["services"][0]["Service"], "web");
    let mut reply = runtime.call(&id, json!({"action":"query","input":{"hostId":"host","request":{"kind":"compose_action","project":"shop","action":"stop","confirmed":true}}})).await.unwrap();
    assert_eq!(operation(&reply)["kind"], "host");
    reply = resume(&runtime, &id, &reply, metadata(operation(&reply))).await;
    assert_eq!(
        reply.result["request"]["operation"]["bindings"],
        json!(["host-binding"])
    );
    reply = resume(&runtime, &id, &reply, completed(&snapshot)).await;
    let script = operation(&reply)["command"]["args"][1].as_str().unwrap();
    assert!(script.contains("--project-name 'shop'"));
    assert!(script.contains("--file '/srv/my shop/compose.yaml' stop --timeout 5"));
    let manifest: Value =
        serde_json::from_str(include_str!("../../../plugins/system/docker/manifest.json")).unwrap();
    assert!(
        !manifest["preapprovedCommands"]
            .as_array()
            .unwrap()
            .contains(&operation(&reply)["command"])
    );
    let cancelled = runtime.resume(&id, json!({"hostResponse":{"requestId":reply.result["request"]["requestId"],"result":null,"error":{"code":"USER_CANCELLED","message":"取消"}}})).await.unwrap();
    assert_eq!(cancelled.error.as_ref().unwrap().code, "USER_CANCELLED");
    let mut opened = false;
    let logs = invoke(&runtime, &id, "logs", json!({"hostId":"host","source":{"kind":"compose","project":"shop"},"lines":200,"follow":true}), |request| {
        match request["kind"].as_str().unwrap() {
            "host" => metadata(request),
            "execute" => completed(&snapshot),
            "stream_open" => { opened = true; assert!(request["command"]["args"][1].as_str().unwrap().contains("logs --no-color --timestamps --tail 200 --follow")); json!({"id":"compose-stream"}) },
            other => panic!("unexpected {other}"),
        }
    }).await;
    assert!(opened);
    assert_eq!(done(&logs)["id"], "compose-stream");
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn docker_information_and_individual_restart_use_current_contract() {
    let (_directory, runtime, id) = packaged("docker");
    runtime.activate(&id).await.unwrap();
    let manifest: Value =
        serde_json::from_str(include_str!("../../../plugins/system/docker/manifest.json")).unwrap();
    let info = invoke(&runtime, &id, "query", json!({"hostId":"host","request":{"kind":"capabilities"}}), |request| {
        assert_eq!(request["command"], manifest["preapprovedCommands"][0]);
        assert!(request["command"]["args"][1].as_str().unwrap().contains("{{json .OperatingSystem}}"));
        json!({"state":"completed","exitCode":0,"stdout":"{\"dockerVersion\":{\"Server\":{\"Os\":\"linux\"}},\"dockerOperatingSystem\":\"Ubuntu 24.04.3 LTS\"}","stderr":"","truncated":false,"message":null})
    }).await;
    assert_eq!(
        done(&info)["detail"]["dockerOperatingSystem"],
        "Ubuntu 24.04.3 LTS"
    );
    let removed = invoke(&runtime, &id, "query", json!({"hostId":"host","request":{"kind":"container_maintenance","action":"restart_all","confirmed":true}}), |_| panic!("removed action reached host")).await;
    assert_eq!(removed.error.unwrap().code, "INPUT");
    let target = "a".repeat(64);
    let input = json!({"hostId":"host","request":{"kind":"container_action","id":target,"action":"restart","confirmed":true}});
    let pending = runtime
        .call(&id, json!({"action":"query","input":input}))
        .await
        .unwrap();
    let command = &operation(&pending)["command"];
    assert!(
        command["args"][1]
            .as_str()
            .unwrap()
            .ends_with(&format!("d container restart --time 10 '{target}'"))
    );
    assert!(
        !manifest["preapprovedCommands"]
            .as_array()
            .unwrap()
            .contains(command)
    );
    let cancelled = runtime.resume(&id, json!({"hostResponse":{"requestId":pending.result["request"]["requestId"],"result":null,"error":{"code":"USER_CANCELLED","message":"取消"}}})).await.unwrap();
    assert_eq!(cancelled.error.unwrap().code, "USER_CANCELLED");
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn docker_maintenance_requires_confirmation_and_reports_partial_failures() {
    let manifest: Value =
        serde_json::from_str(include_str!("../../../plugins/system/docker/manifest.json")).unwrap();
    for action in ["restart_exited", "clear_logs"] {
        let (_directory, runtime, id) = packaged("docker");
        runtime.activate(&id).await.unwrap();
        let input = json!({"hostId":"host","request":{"kind":"container_maintenance","action":action,"confirmed":false}});
        let unconfirmed = invoke(&runtime, &id, "query", input.clone(), |_| {
            panic!("unconfirmed action reached host")
        })
        .await;
        assert_eq!(unconfirmed.error.unwrap().code, "DOCKER_INPUT");
        let mut input = input;
        input["request"]["confirmed"] = json!(true);
        let pending = runtime
            .call(&id, json!({"action":"query","input":input}))
            .await
            .unwrap();
        let request = operation(&pending);
        assert_eq!(request["kind"], "execute");
        assert_eq!(request["hostId"], "host");
        assert!(
            !manifest["preapprovedCommands"]
                .as_array()
                .unwrap()
                .contains(&request["command"])
        );
        let script = request["command"]["args"][1].as_str().unwrap();
        assert_eq!(
            script.contains("--filter status=exited"),
            action == "restart_exited"
        );
        assert_eq!(
            script.contains("truncate --no-create"),
            action == "clear_logs"
        );
        let cancelled = runtime.resume(&id, json!({"hostResponse":{"requestId":pending.result["request"]["requestId"],"result":null,"error":{"code":"USER_CANCELLED","message":"取消"}}})).await.unwrap();
        assert_eq!(cancelled.error.unwrap().code, "USER_CANCELLED");
        let completed = invoke(&runtime, &id, "query", input.clone(), |_| json!({"state":"completed","exitCode":0,"stdout":"{\"matched\":2,\"succeeded\":2,\"failed\":0,\"skipped\":0}","stderr":"","truncated":false,"message":null})).await;
        assert_eq!(done(&completed)["success"], true);
        assert!(
            done(&completed)["message"]
                .as_str()
                .unwrap()
                .contains("成功 2 个")
        );
        let partial = invoke(&runtime, &id, "query", input.clone(), |_| json!({"state":"completed","exitCode":0,"stdout":"{\"matched\":2,\"succeeded\":1,\"failed\":1,\"skipped\":0}","stderr":"Permission denied","truncated":false,"message":null})).await;
        assert_eq!(done(&partial)["success"], false);
        assert_eq!(done(&partial)["code"], "DOCKER_PARTIAL_FAILURE");
        assert!(
            done(&partial)["message"]
                .as_str()
                .unwrap()
                .contains("失败 1 个")
        );
        assert!(
            done(&partial)["message"]
                .as_str()
                .unwrap()
                .contains("Permission denied")
        );
        let failed = invoke(&runtime, &id, "query", input, |_| json!({"state":"completed","exitCode":1,"stdout":"","stderr":"daemon unavailable","truncated":false,"message":null})).await;
        assert!(failed.error.is_some());
        runtime.shutdown().await.unwrap();
    }
}

// Opt-in only: the caller creates and owns this isolated, networkless QA project.
// Uses real Docker through WSL; does not claim to exercise the native SSH/UI bridge.
#[tokio::test]
#[ignore = "requires an explicitly created SERVERDECK_COMPOSE_QA_PROJECT in local WSL Docker"]
async fn docker_compose_live_project_lifecycle() {
    let project = std::env::var("SERVERDECK_COMPOSE_QA_PROJECT").unwrap();
    assert!(project.starts_with("sd-compose-qa-"));
    assert!(
        project
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    );
    let (_directory, runtime, id) = packaged("docker");
    runtime.activate(&id).await.unwrap();
    async fn run(runtime: &Runtime, id: &str, action: &str, input: Value, project: &str) -> Value {
        let mut reply = runtime
            .call(id, json!({"action":action,"input":input}))
            .await
            .unwrap();
        for _ in 0..10 {
            if reply.result["kind"] == "done" {
                return done(&reply).clone();
            }
            let request = operation(&reply).clone();
            let result = if request["kind"] == "host" {
                metadata(&request)
            } else {
                assert!(matches!(
                    request["kind"].as_str(),
                    Some("execute" | "stream_open")
                ));
                let command = &request["command"];
                let script = command["args"][1].as_str().unwrap();
                if script.contains("exec docker") {
                    assert!(script.contains(&format!("--project-name '{project}'")));
                    assert!(!script.contains("down"));
                    assert!(!script.contains("up -d"));
                }
                let program = command["program"].as_str().unwrap().to_string();
                let args = command["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a.as_str().unwrap().to_string())
                    .collect::<Vec<_>>();
                let output = tokio::task::spawn_blocking(move || {
                    std::process::Command::new("wsl")
                        .args(["--user", "root", "--exec", &program])
                        .args(args)
                        .output()
                        .unwrap()
                })
                .await
                .unwrap();
                let stdout = String::from_utf8(output.stdout).unwrap();
                let stderr = String::from_utf8(output.stderr).unwrap();
                if request["kind"] == "stream_open" {
                    assert!(output.status.success(), "{stderr}");
                    assert!(stdout.contains("COMPOSE_QA_WEB"));
                    assert!(stdout.contains("COMPOSE_QA_WORKER"));
                    json!({"id":"real-compose-logs"})
                } else {
                    json!({"state":"completed","exitCode":output.status.code(),"stdout":stdout,"stderr":stderr,"truncated":false,"message":null})
                }
            };
            reply = resume(runtime, id, &reply, result).await;
        }
        panic!("live Compose action exceeded request bound");
    }
    let projects = run(
        &runtime,
        &id,
        "query",
        json!({"hostId":"host","request":{"kind":"compose_projects"}}),
        &project,
    )
    .await;
    assert!(
        projects["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["Name"] == project)
    );
    for (action, expected) in [
        ("stop", "exited"),
        ("start", "running"),
        ("restart", "running"),
    ] {
        run(&runtime, &id, "query", json!({"hostId":"host","request":{"kind":"compose_action","project":project,"action":action,"confirmed":true}}), &project).await;
        let detail = run(
            &runtime,
            &id,
            "query",
            json!({"hostId":"host","request":{"kind":"compose_services","project":project}}),
            &project,
        )
        .await;
        let rows = detail["detail"]["services"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r["State"] == expected));
    }
    let logs = run(&runtime, &id, "logs", json!({"hostId":"host","source":{"kind":"compose","project":project},"lines":200,"follow":false}), &project).await;
    assert_eq!(logs["id"], "real-compose-logs");
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn assistant_owns_redaction_and_preview_inside_the_packaged_wasm() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    let mut reply=runtime.call(&id,json!({"action":"prepare","input":{"modelId":"model","sessionId":null,"sessionIds":[],"question":"说明 password=should-be-redacted 的问题","selection":{"server":false,"metrics":false,"processes":false,"docker":false,"log":null,"logLines":100},"maskAddresses":true,"redactValues":[],"history":[],"autoHosts":true,"expectedModelRevision":null}})).await.unwrap();
    for _ in 0..12 {
        if reply.result["kind"] == "done" {
            let text = reply.result["value"]["body"].as_str().unwrap();
            assert!(!text.contains("should-be-redacted"));
            assert!(text.contains("REDACTED"));
            runtime.shutdown().await.unwrap();
            return;
        }
        let result = match operation(&reply)["kind"].as_str().unwrap() {
            "info" => {
                json!({"scope":"fixture-owner","nonce":"fixture-id-000000000000000000000000","unixMs":100000})
            }
            "model" => {
                json!({"model":{"id":"model","revision":"revision","config":{"provider":"openai_compatible","baseUrl":"https://fixture.invalid/v1","model":"fixture","maxOutputTokens":2048,"contextWindowTokens":131072}},"binding":"model-binding"})
            }
            "hosts" => json!({"hosts":[],"groups":[]}),
            other => panic!("Unexpected primitive: {other}"),
        };
        reply = resume(&runtime, &id, &reply, result).await;
    }
    panic!("The preview did not finish within its bounded platform sequence");
}
