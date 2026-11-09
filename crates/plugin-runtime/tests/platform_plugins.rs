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
