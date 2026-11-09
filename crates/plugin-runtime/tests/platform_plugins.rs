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
    runtime.resume(id,json!({"hostResponse":{"requestId":reply.result["request"]["requestId"],"result":result,"error":null}})).await.unwrap()
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
#[tokio::test]
async fn nginx_owns_commands_and_parses_remote_failure_without_a_native_nginx_api() {
    let (_directory, runtime, id) = packaged("nginx");
    runtime.activate(&id).await.unwrap();
    let reply=runtime.call(&id,json!({"action":"nginx","input":{"hostId":"host","target":{"kind":"host"},"configPath":"/etc/nginx/nginx.conf","action":"reload"}})).await.unwrap();
    let request = operation(&reply);
    assert_eq!(request["kind"], "execute");
    let script = request["command"]["args"][1].as_str().unwrap();
    assert!(script.contains("nginx -t"));
    assert!(script.contains("&&"));
    let reply=resume(&runtime,&id,&reply,json!({"state":"completed","exitCode":1,"stdout":"","stderr":"invalid config","message":null,"truncated":false})).await;
    assert_eq!(reply.error.unwrap().code, "REMOTE_COMMAND");
    runtime.shutdown().await.unwrap();
}
