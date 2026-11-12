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
        "confirm_operations" => Value::Null,
        "approval_mode" => json!({"binding":"policy-binding","mode":request["mode"]}),
        "info" => {
            static NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let nonce = NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            json!({"scope":"fixture-owner","nonce":format!("fixture-{nonce:032}"),"unixMs":100000})
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
    for _ in 0..32 {
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

#[tokio::test]
async fn docker_image_archive_uses_bound_long_streams_and_returns_native_transfer_paths() {
    let (_directory, runtime, id) = packaged("docker");
    runtime.activate(&id).await.unwrap();
    let nonce = "01234567-89ab-cdef-0123-456789abcdef";
    for request in [
        json!({"kind":"import","fileName":"image.tar","confirmed":true}),
        json!({"kind":"export","id":"a".repeat(64),"reference":"registry:5000/app:v1","fileName":"image.tar","confirmed":true}),
    ] {
        let mut reply = runtime
            .call(
                &id,
                json!({"action":"image_archive","input":{"hostId":"host","request":request}}),
            )
            .await
            .unwrap();
        assert_eq!(operation(&reply)["kind"], "info");
        reply = resume(&runtime, &id, &reply, json!({"nonce":nonce})).await;
        assert_eq!(operation(&reply)["kind"], "host");
        reply = resume(&runtime, &id, &reply, metadata(operation(&reply))).await;
        assert_eq!(operation(&reply)["kind"], "stream_open");
        assert_eq!(
            reply.result["request"]["operation"]["bindings"],
            json!(["host-binding"])
        );
        let script = operation(&reply)["command"]["args"][1].as_str().unwrap();
        assert!(script.contains(if request["kind"] == "import" {
            "image load --input"
        } else {
            "image save --output"
        }));
        assert!(script.contains(&format!("SD_ARCHIVE_READY:{nonce}")));
        reply = resume(&runtime, &id, &reply, json!({"id":"archive-stream"})).await;
        assert_eq!(done(&reply)["streamId"], "archive-stream");
        assert_eq!(
            done(&reply)["path"],
            format!("/tmp/serverdeck-image-{nonce}/image.tar")
        );
    }
    runtime.shutdown().await.unwrap();
}

fn prepare_input(mask: bool, linked: bool) -> Value {
    json!({"modelId":"model","sessionId":if linked {Some("host")} else {None},"sessionIds":[],"question":"说明 password=question-secret\n192.168.1.2\n中文秘密","selection":{"server":linked,"metrics":false,"processes":false,"docker":false,"log":null,"logLines":100},"maskAddresses":mask,"redactValues":["中文秘密"],"history":[{"role":"user","content":format!("{}\nBearer history-secret", "历史上下文 ".repeat(500))},{"role":"assistant","content":"上次回答 password=answer-secret"}],"autoHosts":true,"expectedModelRevision":"revision"})
}

#[tokio::test]
async fn assistant_hardware_questions_collect_cpu_and_memory_before_the_model_request() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    for question in ["输出一下硬件信息", "Show hardware information"] {
        let mut input = prepare_input(false, true);
        input["question"] = json!(question);
        input["history"] = json!([]);
        let mut samples = 0;
        let prepared = invoke(&runtime, &id, "prepare", input, |request| {
            if request["kind"] != "execute" { return metadata(request); }
            assert!(request["command"]["args"][1].as_str().unwrap().contains("SDMON1"));
            samples += 1;
            let mut output = "SDMON1\0".to_owned();
            for (key, value) in [
                ("stat", "cpu 100 0 50 800 50 0 0 0\ncpu0 100 0 50 800 50 0 0 0"),
                ("memory", "MemTotal: 1000 kB\nMemAvailable: 100 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n"),
                ("uptime", "100.0 90.0"), ("boot", "boot-a"),
                ("hostname", "fixture"), ("arch", "x86_64"), ("cpuinfo", "model name : fixture CPU"),
            ] { output.push_str(&format!("{key}\0{value}\0{key}_code\00\0")); }
            json!({"state":"completed","exitCode":0,"stdout":output,"stderr":"","message":null,"truncated":false})
        }).await;
        assert_eq!(samples, 2, "{question}");
        let messages: Value =
            serde_json::from_str(done(&prepared)["body"].as_str().unwrap()).unwrap();
        let value: Value = serde_json::from_str(
            messages.as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let host = &value["context"]["hosts"][0];
        assert_eq!(host["system"]["cpuModel"], "fixture CPU");
        assert_eq!(host["system"]["cores"], 1);
        assert_eq!(host["metrics"]["memory"]["total"], 1024000);
    }
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn assistant_reports_unstable_file_reads_but_still_stops_on_context_conflicts() {
    for code in ["TEXT_SIZE_MISMATCH", "CONFLICT"] {
        let (_directory, runtime, id) = packaged("assistant");
        runtime.activate(&id).await.unwrap();
        let prepared = invoke(
            &runtime,
            &id,
            "prepare",
            prepare_input(false, true),
            metadata,
        )
        .await;
        let mut reply = runtime
            .call(
                &id,
                json!({"action":"send","input":{"id":done(&prepared)["id"],"confirmed":true}}),
            )
            .await
            .unwrap();
        let mut models = 0;
        let mut reads = 0;
        for _ in 0..16 {
            if reply.error.is_some() || reply.result["kind"] == "done" {
                break;
            }
            let request = operation(&reply);
            if request["kind"] == "read_file" {
                reads += 1;
                tokio::time::sleep(std::time::Duration::from_millis(70)).await;
                reply = runtime.resume(&id, json!({"hostResponse":{
                    "requestId":reply.result["request"]["requestId"],"result":null,
                    "error":{"code":code,"message":"fixture file cannot be edited password=fixture-secret"}
                }})).await.unwrap();
                continue;
            }
            let result = if request["kind"] == "model_complete" {
                models += 1;
                let text = if models == 1 {
                    json!({"kind":"query","requests":[{"kind":"file_read","hostId":"host","path":"/proc/cpuinfo","startLine":1,"lines":100}]})
                } else {
                    let messages = request["messages"].to_string();
                    assert!(messages.contains("TEXT_SIZE_MISMATCH"));
                    assert!(messages.contains("failed"));
                    assert!(!messages.contains("fixture-secret"));
                    json!({"kind":"answer","text":"该文件不能作为可编辑文档读取；根据已有系统采样回答。"})
                };
                json!({"text":text.to_string(),"incomplete":false})
            } else {
                metadata(request)
            };
            reply = resume(&runtime, &id, &reply, result).await;
        }
        assert_eq!(reads, 1);
        if code == "CONFLICT" {
            assert_eq!(reply.error.unwrap().code, "CONFLICT");
            assert_eq!(models, 1);
        } else {
            assert_eq!(models, 2);
            let answer = done(&reply);
            assert_eq!(answer["agent"]["observations"][0]["status"], "failed");
            assert_eq!(answer["proposals"], json!([]));
            assert!(!answer.to_string().contains("fixture-secret"));
        }
        runtime.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn assistant_packaged_file_edits_preview_original_lines_and_only_save_frozen_content() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    let mut input = prepare_input(true, true);
    input["selection"]["server"] = json!(false);
    input["history"] = json!([]);
    let prepared = invoke(&runtime, &id, "prepare", input, metadata).await;
    let root = done(&prepared)["id"].clone();
    let content = format!(
        "password: hidden-secret\r\n{}",
        (2..=200)
            .map(|n| format!("line{n}: {}\r\n", "x".repeat(140)))
            .collect::<String>()
    );
    assert!(content.len() > 28000 && content.len() <= 32768);
    let mut rounds = 0;
    let reply=invoke(&runtime,&id,"send",json!({"id":root,"confirmed":true}),|request|match request["kind"].as_str().unwrap() {
        "model_complete"=>{
            rounds+=1;
            if rounds>1 {assert!(!request["messages"].to_string().contains("hidden-secret"));}
            let text=if rounds==1 {json!({"kind":"query","requests":[{"kind":"file_read","hostId":"host","path":"/work/x.yaml","startLine":1,"lines":30}]})} else {json!({"kind":"plan","summary":"删除第六行，在原文第20行后插入配置","actions":[{"kind":"file_edit","documentId":"doc","edits":[{"startLine":6,"deleteLines":1,"insertLines":[]},{"startLine":21,"deleteLines":0,"insertLines":["x: yy"]}]}]})};
            json!({"text":text.to_string(),"incomplete":false})
        }
        "read_file"=>json!({"id":"doc","path":"/work/x.yaml","content":content,"sha256":"a".repeat(64),"atomicSave":true,"permissions":384}),
        other=>{assert_ne!(other,"save_file","preview must not write");metadata(request)}
    }).await;
    let answer = done(&reply);
    let proposal = answer["proposals"][0].clone();
    assert!(
        answer["agent"]["steps"][0]["preview"]["diff"]
            .as_str()
            .unwrap()
            .contains("-line6:")
    );
    let mut saves = 0;
    let executed=invoke(&runtime,&id,"execute",json!({"proposalId":proposal["id"],"confirmed":true,"changeConfirmation":proposal["changeConfirmation"]}),|request|match request["kind"].as_str().unwrap(){
        "save_file"=>{saves+=1;assert_eq!(request["documentId"],"doc");let saved=request["content"].as_str().unwrap();assert!(saved.starts_with("password: hidden-secret\r\n"));assert!(!saved.contains("line6:"));assert!(saved.contains(&format!("line20: {}\r\nx: yy\r\nline21:","x".repeat(140))));assert!(!saved.contains("[REDACTED]"));json!({"saved":true,"document":null,"recoveryPath":null,"message":null})},
        "close_file"=>Value::Null,
        _=>metadata(request)
    }).await;
    assert_eq!(saves, 1);
    assert_eq!(done(&executed)["task"]["status"], "succeeded");
    let replay=invoke(&runtime,&id,"execute",json!({"proposalId":proposal["id"],"confirmed":true,"changeConfirmation":proposal["changeConfirmation"]}),metadata).await;
    assert!(replay.error.is_some());
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn assistant_packaged_relay_uses_native_job_progress_and_retains_final_result() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    let mut input = prepare_input(false, true);
    input["selection"]["server"] = json!(false);
    input["history"] = json!([]);
    input["sessionIds"] = json!(["second"]);
    let prepared = invoke(&runtime, &id, "prepare", input, metadata).await;
    let root = done(&prepared)["id"].clone();
    let preview = json!({"id":"native-copy","source":{"kind":"remote","hostId":"host","path":"/work/xx.tar.gz"},"destination":{"hostId":"second","path":"/work/xx.tar.gz"},"bytes":1234,"overwrite":false,"targetExists":false});
    let mut rounds = 0;
    let sent=invoke(&runtime,&id,"send",json!({"id":root,"confirmed":true}),|request|match request["kind"].as_str().unwrap(){
        "model_complete"=>{rounds+=1;let text=if rounds==1 {json!({"kind":"query","requests":[{"kind":"transfer_prepare","source":preview["source"],"destination":{"hostId":"second","path":"/work"},"overwrite":false}]})}else{json!({"kind":"plan","summary":"将已确认的归档中转到测试服务器","actions":[{"kind":"transfer","previewId":"native-copy"}]})};json!({"text":text.to_string(),"incomplete":false})},
        "transfer_prepare"=>preview.clone(),
        other=>{assert_ne!(other,"transfer_start");metadata(request)}
    }).await;
    let proposal = done(&sent)["proposals"][0].clone();
    let mut starts = 0;
    let state = |state: &str, sha: Option<String>| json!({"id":"native-copy","state":state,"totalBytes":1234,"transferredBytes":if state=="completed" {1234}else{100},"bytesPerSecond":100,"sha256":sha,"message":null,"recoveryPaths":[]});
    let executed=invoke(&runtime,&id,"execute",json!({"proposalId":proposal["id"],"confirmed":true,"changeConfirmation":proposal["changeConfirmation"]}),|request|match request["kind"].as_str().unwrap(){
        "transfer_start"=>{starts+=1;assert_eq!(request,&json!({"kind":"transfer_start","id":"native-copy"}));state("running",None)},
        "transfer_status"=>state("running",None),_=>metadata(request)
    }).await;
    assert_eq!(starts, 1);
    assert_eq!(done(&executed)["pending"], true);
    assert_eq!(done(&executed)["task"]["status"], "transferring");
    let finished = invoke(
        &runtime,
        &id,
        "poll",
        json!({"id":root}),
        |request| match request["kind"].as_str().unwrap() {
            "transfer_status" => state("completed", Some("a".repeat(64))),
            "transfer_close" => Value::Null,
            _ => metadata(request),
        },
    )
    .await;
    assert_eq!(done(&finished)["success"], true);
    assert_eq!(done(&finished)["task"]["status"], "succeeded");
    let again = invoke(&runtime, &id, "poll", json!({"id":root}), metadata).await;
    assert_eq!(done(&again), done(&finished));
    runtime.shutdown().await.unwrap();
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
async fn assistant_packaged_tools_tasks_and_frozen_execution_keep_platform_bindings() {
    fn completed(stdout: &str) -> Value {
        json!({"state":"completed","exitCode":0,"stdout":stdout,"stderr":"","message":null,"truncated":false})
    }
    for (mode, denied) in [
        ("request", false),
        ("request", true),
        ("assist", false),
        ("full", false),
    ] {
        let (_directory, runtime, id) = packaged("assistant");
        runtime.activate(&id).await.unwrap();
        let catalog = invoke(&runtime, &id, "tools", json!({}), metadata).await;
        assert_eq!(done(&catalog).as_array().unwrap().len(), 18);
        let mut input = prepare_input(true, true);
        input["approvalMode"] = json!(mode);
        let prepared = invoke(&runtime, &id, "prepare", input, metadata).await;
        let task_id = done(&prepared)["id"].clone();
        assert_eq!(done(&prepared)["task"]["status"], "prepared");
        let image = "a".repeat(64);
        let images = json!({"ID":image,"Tag":"<none>"}).to_string();
        let mut model_calls = 0;
        let sent = invoke(&runtime, &id, "send", json!({"id":task_id,"confirmed":true}), |request| {
            match request["kind"].as_str().unwrap() {
                "model_complete" => {
                    model_calls += 1;
                    assert!(request["messages"][0]["content"].as_str().unwrap().contains("inputSchema"));
                    let text = if model_calls == 1 { json!({"kind":"query","requests":[{"kind":"images"}]}) } else { json!({"kind":"plan","summary":"清理已查询镜像","actions":[{"kind":"remove_untagged_images"}]}) };
                    json!({"text":text.to_string(),"incomplete":false,"usage":{"inputTokens":10,"outputTokens":2}})
                }
                "execute" => {
                    assert!(!request["command"]["args"][1].as_str().unwrap().contains("d image rm"));
                    completed(&images)
                }
                _ => metadata(request),
            }
        }).await;
        let answer = done(&sent);
        assert_eq!(answer["task"]["status"], "awaiting_approval");
        assert_eq!(answer["agent"]["observations"][0]["tool"], "images");
        assert_eq!(answer["agent"]["observations"][0]["status"], "succeeded");
        let proposal = &answer["proposals"][0];
        let execute = json!({"proposalId":proposal["id"],"confirmed":true,"changeConfirmation":proposal["changeConfirmation"]});
        let mut reply = runtime
            .call(&id, json!({"action":"execute","input":execute}))
            .await
            .unwrap();
        let mut mutations = 0;
        for _ in 0..16 {
            if reply.error.is_some() || reply.result["kind"] == "done" {
                break;
            }
            let request = operation(&reply);
            if request["kind"] == "execute" {
                assert_eq!(
                    reply.result["request"]["operation"]["bindings"],
                    if mode == "request" {
                        json!(["model-binding", "host-binding"])
                    } else {
                        json!(["model-binding", "policy-binding", "host-binding"])
                    }
                );
                let script = request["command"]["args"][1].as_str().unwrap();
                if script.contains("d image rm") {
                    mutations += 1;
                    assert!(script.contains(&image));
                    assert!(script.contains("--no-prune"));
                    assert!(!script.contains("--force"));
                    if denied {
                        reply = runtime.resume(&id,json!({"hostResponse":{"requestId":reply.result["request"]["requestId"],"result":null,"error":{"code":"USER_CANCELLED","message":"宿主拒绝执行"}}})).await.unwrap();
                        continue;
                    }
                }
                reply = resume(
                    &runtime,
                    &id,
                    &reply,
                    completed(if mutations == 0 { &images } else { "" }),
                )
                .await;
            } else {
                let result = metadata(request);
                reply = resume(&runtime, &id, &reply, result).await;
            }
        }
        assert_eq!(mutations, 1, "mutation was replayed or never requested");
        assert_eq!(
            done(&reply)["task"]["status"],
            if denied { "unverified" } else { "succeeded" }
        );
        let snapshot = invoke(&runtime, &id, "task", json!({"id":task_id}), metadata).await;
        assert_eq!(done(&snapshot)["status"], done(&reply)["task"]["status"]);
        let replay = invoke(&runtime, &id, "execute", execute, metadata).await;
        assert_eq!(replay.error.unwrap().code, "NOT_FOUND");
        runtime.health(&id).await.unwrap();
        runtime.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn assistant_packaged_process_details_use_declared_argv_templates_in_all_modes() {
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../plugins/system/assistant/manifest.json"
    ))
    .unwrap();
    let templates = serde_json::from_value::<serverdeck_plugin_core::Manifest>(manifest)
        .unwrap()
        .preapproved_commands;
    for mode in ["request", "assist", "full"] {
        let (_directory, runtime, id) = packaged("assistant");
        runtime.activate(&id).await.unwrap();
        let mut input = prepare_input(true, true);
        input["approvalMode"] = json!(mode);
        input["history"] = json!([]);
        let prepared = invoke(&runtime, &id, "prepare", input, metadata).await;
        let mut rounds = 0;
        let mut pids = vec![];
        let answer = invoke(&runtime, &id, "send", json!({"id":done(&prepared)["id"],"confirmed":true}), |request| {
            match request["kind"].as_str().unwrap() {
                "model_complete" => {
                    rounds += 1;
                    let text = if rounds == 1 { json!({"kind":"query","requests":[{"kind":"process_details","pid":42},{"kind":"process_details","pid":73}]}) } else { json!({"kind":"answer","text":"已检查两个进程的详情。"}) };
                    json!({"text":text.to_string(),"incomplete":false})
                }
                "execute" => {
                    let command = serde_json::from_value(request["command"].clone()).unwrap();
                    assert!(templates.iter().any(|template| template.matches_argument_template(&command)));
                    assert_eq!(command.args.len(), 4);
                    let pid = command.args[3].parse::<u32>().unwrap();
                    pids.push(pid);
                    let stat = format!("{pid} (worker) S {}", vec!["1";21].join(" "));
                    let stdout = format!("SDPROC1\0boot-fixture\0{stat}\0Name:\tworker\nVmRSS:\t123 kB\0/usr/bin/worker");
                    json!({"state":"completed","exitCode":0,"stdout":stdout,"stderr":"","message":null,"truncated":false})
                }
                _ => metadata(request),
            }
        }).await;
        assert_eq!(pids, [42, 73]);
        assert_eq!(done(&answer)["task"]["status"], "succeeded");
        assert_eq!(
            done(&answer)["agent"]["observations"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        runtime.health(&id).await.unwrap();
        runtime.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn assistant_packaged_batches_keep_fuel_limits_and_reject_extra_fields_before_ssh() {
    for scenario in 0..3 {
        let (_directory, runtime, id) = packaged("assistant");
        runtime.activate(&id).await.unwrap();
        let prepared = invoke(
            &runtime,
            &id,
            "prepare",
            prepare_input(true, true),
            metadata,
        )
        .await;
        let task_id = done(&prepared)["id"].clone();
        let mut queries = 0;
        let sent = invoke(&runtime,&id,"send",json!({"id":task_id,"confirmed":true}),|request| {
            match request["kind"].as_str().unwrap() {
                "model_complete" => {
                    let decision = if scenario == 2 {
                        json!({"kind":"plan","summary":"缺少查询证据的最大计划","actions":(0..32).map(|n|json!({"kind":"container","id":format!("{n:064x}"),"action":"start"})).collect::<Vec<_>>()})
                    } else {
                        let requests = if scenario == 1 { json!([{"kind":"images"},{"kind":"images","confirmed":true}]) } else { json!([{"kind":"images"},{"kind":"images"},{"kind":"images"}]) };
                        json!({"kind":"query","requests":requests})
                    };
                    json!({"text":decision.to_string(),"incomplete":false,"usage":{"inputTokens":10,"outputTokens":2}})
                }
                "execute" => { queries += 1; json!({"state":"completed","exitCode":0,"stdout":"","stderr":"","message":null,"truncated":false}) }
                _ => metadata(request),
            }
        }).await;
        assert_eq!(sent.error.unwrap().code, "AI_INPUT");
        assert_eq!(queries, if scenario == 0 { 12 } else { 0 });
        let task = invoke(&runtime, &id, "task", json!({"id":task_id}), metadata).await;
        assert_eq!(done(&task)["status"], "failed");
        runtime.health(&id).await.unwrap();
        runtime.shutdown().await.unwrap();
    }
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

#[tokio::test]
async fn assistant_packaged_full_history_stays_within_fuel_limits() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    let mut input = prepare_input(true, true);
    input["history"] = json!(
        (0..12)
            .map(|index| json!({
                "role": if index % 2 == 0 { "user" } else { "assistant" },
                "content": format!("{}\npassword=history-secret", "历史内容abc ".repeat(250)),
            }))
            .collect::<Vec<_>>()
    );
    let prepared = invoke(&runtime, &id, "prepare", input, metadata).await;
    assert!(!done(&prepared).to_string().contains("history-secret"));
    runtime.health(&id).await.unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn assistant_packaged_cpu_memory_diagnosis_handles_many_mounts_and_processes() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    let mut input = prepare_input(true, true);
    input["question"] = json!("帮我排查当前主机 CPU 和内存使用异常的可能原因。");
    input["history"] = json!([]);
    let mounts = (0..256)
        .map(|i| {
            format!(
                "{} 0 8:{} / /mnt/disk{} rw - ext4 /dev/disk{} rw",
                i + 1,
                i,
                i,
                i
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let df = format!(
        "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n{}",
        (0..256)
            .map(|i| format!("/dev/disk{i} ext4 1000 900 100 90% /mnt/disk{i}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let processes = (1..=128)
        .map(|i| {
            format!(
                "{i} user {} 0.1 00:10 worker --token=process-secret",
                i % 30
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut samples = 0;
    let prepared = invoke(&runtime, &id, "prepare", input, |request| {
        if request["kind"] != "execute" { return metadata(request); }
        let command = request["command"]["args"][1].as_str().unwrap();
        let stdout = if command.contains("SDMON1") {
            samples += 1;
            let stat = if samples == 1 { "cpu 100 0 50 800 50 0 0 0\ncpu0 100 0 50 800 50 0 0 0" } else { "cpu 200 0 50 800 50 0 0 0\ncpu0 200 0 50 800 50 0 0 0" };
            let mut output = "SDMON1\0".to_owned();
            for (key, value) in [
                ("stat", stat), ("memory", "MemTotal: 1000 kB\nMemAvailable: 100 kB\nSwapTotal: 100 kB\nSwapFree: 60 kB\n"),
                ("uptime", if samples == 1 { "100.0 90.0" } else { "100.25 90.0" }), ("boot", "boot-a"),
                ("load", "1.0 2.0 3.0 1/200 20"), ("hostname", "fixture"), ("kernel", "6.8.0"), ("arch", "x86_64"),
                ("os", "PRETTY_NAME=Linux"), ("cpuinfo", "model name : fixture"), ("time", "2026-11-11T12:00:00+0800 CST"),
                ("net", "eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0"), ("addresses", "2: eth0 inet 192.0.2.1/24 scope global"),
                ("mounts", mounts.as_str()), ("df", df.as_str()),
            ] {
                output.push_str(&format!("{key}\0{value}\0{key}_code\0"));
                output.push_str("0\0");
            }
            output.push_str("indices\0eth0 2\0timezone\0Asia/Shanghai\0");
            output
        } else {
            assert!(command.contains("ps "));
            processes.clone()
        };
        json!({"state":"completed","exitCode":0,"stdout":stdout,"stderr":"","message":null,"truncated":false})
    }).await;
    assert_eq!(samples, 2);
    let messages: Value = serde_json::from_str(done(&prepared)["body"].as_str().unwrap()).unwrap();
    let context: Value = serde_json::from_str(
        messages.as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let host = &context["context"]["hosts"][0];
    assert_eq!(host["metrics"]["cpu"]["usage"], 100.0);
    assert_eq!(host["metrics"]["memory"]["usage"], 90.0);
    assert_eq!(host["metrics"]["diskTotal"], 256);
    assert_eq!(host["processes"]["summary"]["total"], 128);
    assert!(!done(&prepared).to_string().contains("process-secret"));
    let mut rounds = 0;
    let sent = invoke(&runtime, &id, "send", json!({"id":done(&prepared)["id"],"confirmed":true}), |request| {
        match request["kind"].as_str().unwrap() {
            "model_complete" => {
                rounds += 1;
                assert!(!request["messages"].to_string().contains("process-secret"));
                let text = if rounds == 1 { json!({"kind":"query","requests":[{"kind":"processes"}]}) } else { json!({"kind":"answer","text":"CPU 和内存使用较高，请结合进程证据进一步排查。"}) };
                json!({"text":text.to_string(),"incomplete":false})
            }
            "execute" => {
                assert!(request["command"]["args"][1].as_str().unwrap().contains("ps "));
                json!({"state":"completed","exitCode":0,"stdout":processes,"stderr":"","message":null,"truncated":false})
            }
            _ => metadata(request),
        }
    }).await;
    assert_eq!(rounds, 2);
    assert_eq!(done(&sent)["task"]["status"], "succeeded");
    assert_eq!(done(&sent)["agent"]["observations"][0]["records"], 128);
    runtime.health(&id).await.unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn assistant_packaged_container_query_redacts_bounded_detail_and_keeps_complete_counts() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    let mut input = prepare_input(true, true);
    input["history"] = json!([]);
    let prepared = invoke(&runtime, &id, "prepare", input, metadata).await;
    let mut rounds = 0;
    let rows = (0..128)
        .map(|index| {
            json!({
                "ID": format!("{index:064x}"), "Names": format!("worker-{index}"),
                "Image": "registry.example.com/team/worker:latest", "State": "running",
                "Status": "Up 2 hours", "Ports": "0.0.0.0:8080->80/tcp",
                "Labels": "password=remote-secret",
            })
            .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");
    let sent = invoke(&runtime, &id, "send", json!({"id":done(&prepared)["id"],"confirmed":true}), |request| {
        match request["kind"].as_str().unwrap() {
            "model_complete" => {
                rounds += 1;
                if rounds > 1 {
                    let messages = request["messages"].to_string();
                    assert!(!messages.contains("remote-secret"));
                    let results: Value = serde_json::from_str(request["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap()).unwrap();
                    assert_eq!(results["untrustedToolResults"][0]["result"]["totalRecords"], 128);
                    assert_eq!(results["untrustedToolResults"][0]["result"]["records"].as_array().unwrap().len(), 20);
                    assert_eq!(results["untrustedToolResults"][0]["result"]["omittedRecords"], 108);
                }
                let text = if rounds == 1 { json!({"kind":"query","requests":[{"kind":"containers"}]}) } else { json!({"kind":"plan","summary":"重启已查询的最后一个容器","actions":[{"kind":"container","id":format!("{:064x}",127),"action":"restart"}]}) };
                json!({"text":text.to_string(),"incomplete":false})
            }
            "execute" => {
                let command = request["command"]["args"][1].as_str().unwrap();
                let stdout = if command.contains("d container inspect") {
                    json!({"Id":format!("{:064x}",127),"State":{"Status":"running","StartedAt":"before","Pid":42}}).to_string()
                } else {
                    assert!(command.contains("d container ls"));
                    rows.clone()
                };
                json!({"state":"completed","exitCode":0,"stdout":stdout,"stderr":"","message":null,"truncated":false})
            }
            _ => metadata(request),
        }
    }).await;
    assert_eq!(done(&sent)["agent"]["observations"][0]["records"], 128);
    assert_eq!(done(&sent)["task"]["status"], "awaiting_approval");
    assert_eq!(
        done(&sent)["agent"]["steps"][0]["target"],
        format!("{:064x}", 127)
    );
    runtime.health(&id).await.unwrap();
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
async fn docker_startup_unifies_inspect_and_compose_without_leaking_other_containers() {
    let (_directory, runtime, id) = packaged("docker");
    runtime.activate(&id).await.unwrap();
    let manifest: Value =
        serde_json::from_str(include_str!("../../../plugins/system/docker/manifest.json")).unwrap();
    let completed = |stdout: String| json!({"state":"completed","exitCode":0,"stdout":stdout,"stderr":"","truncated":false,"message":null});
    for (compose, reveal, inspect_only) in [
        (false, false, false),
        (false, true, false),
        (true, false, false),
        (true, true, false),
        (true, false, true),
    ] {
        let snapshot = json!({"Id":"a".repeat(64),"Name":"/web","Config":{"Image":"nginx","Labels":if compose {json!({"com.docker.compose.project":"shop","com.docker.compose.service":"web","com.docker.compose.project.working_dir":"/srv/a b","com.docker.compose.project.config_files":"/srv/a b/compose.yaml,/srv/a b/override.yaml"})} else {json!({})}},"EnvironmentKeys":["TOKEN"],"HostConfig":{"NetworkMode":"bridge"},"Mounts":[]});
        let mut config_read = false;
        let reply = invoke(&runtime,&id,"query",json!({"hostId":"host","request":{"kind":"container_startup","id":"a".repeat(64),"revealEnv":reveal,"inspectOnly":inspect_only}}), |request| {
            match request["kind"].as_str().unwrap() {
                "host" => metadata(request),
                "execute" => {
                    let command = &request["command"];
                    let script = command["args"][1].as_str().unwrap();
                    if script.contains("config --format json") {
                        config_read = true;
                        assert!(manifest["preapprovedCommands"].as_array().unwrap().contains(command), "every startup read must be exactly preapproved");
                        assert!(script.contains("sd_reveal="));
                        assert!(!script.contains("/srv/a b"), "project paths must be read by the fixed script");
                        let model=json!({"services":{"web":{"image":"nginx","environment":{"TOKEN":"compose-secret"},"build":{"context":"/src"}},"other":{"environment":{"OTHER":"other-secret"}}}});
                        completed(json!({"Id":"a".repeat(64),"Members":["a".repeat(64)],"Project":"shop","WorkingDir":"/srv/a b","ConfigFiles":"/srv/a b/compose.yaml,/srv/a b/override.yaml","Model":model,"ExitCode":0,"EnvironmentFilesResolved":reveal}).to_string())
                    } else if script.contains("EnvironmentKeys") {
                        assert!(manifest["preapprovedCommands"].as_array().unwrap().contains(command));
                        completed(format!("{}\n{}",json!({"Id":"b".repeat(64),"Config":{"Env":["OTHER=other-secret"]}}),snapshot))
                    } else {
                        assert!(reveal);
                        assert!(manifest["preapprovedCommands"].as_array().unwrap().contains(command));
                        completed(json!({"Id":"a".repeat(64),"Config":{"Env":["TOKEN=container-secret"]}}).to_string())
                    }
                },
                other => panic!("unexpected primitive {other}"),
            }
        }).await;
        let detail = &done(&reply)["detail"];
        assert_eq!(config_read, compose && !inspect_only);
        assert_eq!(
            detail["source"],
            if config_read { "compose" } else { "inspect" }
        );
        assert_eq!(detail["environmentRevealed"], reveal);
        assert!(!detail.to_string().contains("other-secret"));
        assert_eq!(
            detail.to_string().contains("compose-secret"),
            config_read && reveal
        );
        assert_eq!(
            detail.to_string().contains("container-secret"),
            !config_read && reveal
        );
        if config_read {
            assert_eq!(
                detail["configuration"]["services"]["web"]["build"]["context"],
                "/src"
            );
        }
    }
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

#[tokio::test]
async fn assistant_packaged_streams_redacted_reply_before_the_model_completes() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    let mut input = prepare_input(true, false);
    input["progressId"] = json!("display-progress");
    let preview = invoke(&runtime, &id, "prepare", input, metadata).await;
    let raw = json!({"answer":"第一段内容 中文秘密 password=secret-value\n第二段内容边生成边显示。","commands":[]}).to_string();
    let split = raw.find("第二段").unwrap();
    let mut polls = 0;
    let mut published = String::new();
    let mut early = false;
    let mut closed = false;
    let answer = invoke(&runtime, &id, "send", json!({"id":done(&preview)["id"],"confirmed":true}), |request| {
        if request["kind"] != "streaming" { return metadata(request); }
        let io = &request["request"];
        match io["kind"].as_str().unwrap() {
            "progress_publish" => {
                if io["reset"] == true { published.clear(); }
                published.push_str(io["text"].as_str().unwrap());
                assert!(!published.contains("中文秘密")); assert!(!published.contains("secret-value"));
                if polls == 1 && published.contains("第一段内容") { early = true; }
                Value::Null
            }
            "model_start" => json!({"id":"model-stream"}),
            "model_poll" => {
                polls += 1;
                if polls == 1 { json!({"deltas":[{"text":&raw[..split],"reset":false}],"completion":null}) }
                else { json!({"deltas":[{"text":&raw[split..],"reset":false}],"completion":{"text":raw,"usage":null,"incomplete":false}}) }
            }
            "model_close" => { closed = true; Value::Null }
            other => panic!("Unexpected stream primitive {other}"),
        }
    }).await;
    assert!(
        early,
        "actual WASM must publish redacted text before the completion frame"
    );
    assert!(closed);
    assert_eq!(polls, 2);
    assert!(
        done(&answer)["text"]
            .as_str()
            .unwrap()
            .contains("第二段内容边生成边显示")
    );
    assert_eq!(done(&answer)["text"], published);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn assistant_packaged_large_stream_keeps_fuel_limits_redaction_and_complete_output() {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    let mut input = prepare_input(true, false);
    input["progressId"] = json!("large-display");
    let preview = invoke(&runtime, &id, "prepare", input, metadata).await;
    let text = format!(
        "开头中文秘密\n{}结束",
        "一段完整诊断内容 password=secret-value\n".repeat(500)
    );
    let raw = json!({"answer":text,"commands":[]}).to_string();
    assert!(raw.len() > 24000);
    let mut at = 0;
    let mut displayed = String::new();
    let mut early = false;
    let mut closed = false;
    let mut reply = runtime
        .call(
            &id,
            json!({"action":"send","input":{"id":done(&preview)["id"],"confirmed":true}}),
        )
        .await
        .unwrap();
    for _ in 0..128 {
        assert!(reply.error.is_none(), "{:?}", reply.error);
        if reply.result["kind"] == "done" {
            break;
        }
        let request = operation(&reply);
        let result = if request["kind"] != "streaming" {
            metadata(request)
        } else {
            let io = &request["request"];
            match io["kind"].as_str().unwrap() {
                "model_start" => json!({"id":"large-stream"}),
                "model_poll" => {
                    let start = at;
                    at = (at + 2048).min(raw.len());
                    while !raw.is_char_boundary(at) {
                        at -= 1;
                    }
                    json!({"deltas":[{"text":&raw[start..at],"reset":false}],"completion":if at==raw.len(){json!({"text":raw,"usage":null,"incomplete":false})}else{Value::Null}})
                }
                "progress_publish" => {
                    if io["reset"] == true {
                        displayed.clear();
                    }
                    displayed.push_str(io["text"].as_str().unwrap());
                    assert!(!displayed.contains("中文秘密"));
                    assert!(!displayed.contains("secret-value"));
                    if at < raw.len() && !displayed.is_empty() {
                        early = true;
                    }
                    Value::Null
                }
                "model_close" => {
                    closed = true;
                    Value::Null
                }
                other => panic!("Unexpected stream primitive {other}"),
            }
        };
        reply = resume(&runtime, &id, &reply, result).await;
    }
    assert!(early && closed);
    assert_eq!(done(&reply)["text"], displayed);
    assert!(displayed.ends_with("结束"));
    assert_eq!(displayed.matches("[REDACTED]").count(), 501);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn assistant_packaged_truncated_advice_fails_without_exposing_execution_and_closes_its_stream()
 {
    let (_directory, runtime, id) = packaged("assistant");
    runtime.activate(&id).await.unwrap();
    let mut input = prepare_input(true, false);
    input["progressId"] = json!("cut-display");
    let preview = invoke(&runtime, &id, "prepare", input, metadata).await;
    let raw = json!({"answer":"已生成部分诊断内容，尚未完成。","commands":[]}).to_string();
    let mut closed = false;
    let answer=invoke(&runtime,&id,"send",json!({"id":done(&preview)["id"],"confirmed":true}),|request|{
        if request["kind"]!="streaming" {return metadata(request);}
        match request["request"]["kind"].as_str().unwrap(){
            "progress_publish"=>Value::Null,
            "model_start"=>json!({"id":"cut-stream"}),
            "model_poll"=>json!({"deltas":[{"text":raw,"reset":false}],"completion":{"text":raw,"usage":null,"incomplete":true}}),
            "model_close"=>{closed=true;Value::Null},
            other=>panic!("Unexpected stream primitive {other}"),
        }
    }).await;
    assert!(closed);
    assert!(answer.error.as_ref().unwrap().message.contains("截断"));
    let task = invoke(
        &runtime,
        &id,
        "task",
        json!({"id":done(&preview)["id"]}),
        metadata,
    )
    .await;
    assert_eq!(done(&task)["status"], "failed");
    runtime.shutdown().await.unwrap();
}
