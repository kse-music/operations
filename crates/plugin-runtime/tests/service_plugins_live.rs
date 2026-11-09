//! Opt-in real services in task-owned, network-none WSL Docker fixtures.
//! Commands come from the actual package Wasm. This tests service behavior; Native
//! permission/approval/SSH protocol coverage lives in serverdeck-application tests.
#![cfg(windows)]
use serde_json::{Value, json};
use serverdeck_plugin_core::{InstallInput, Repository};
use serverdeck_plugin_runtime::{Runtime, protocol::Reply};
use std::{
    path::PathBuf,
    process::{Command, Output},
};
fn wsl(args: &[&str]) -> Output {
    Command::new("wsl.exe")
        .args(["--distribution", "Ubuntu", "--user", "root", "--exec"])
        .args(args)
        .output()
        .unwrap()
}
fn owned(id: &str) {
    assert!(id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()));
    let output = wsl(&[
        "docker",
        "inspect",
        "--format",
        "{{index .Config.Labels \"cn.hiboot.qa\"}}",
        id,
    ]);
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "nginx-mysql-plugins"
    );
}
fn http(id: &str) -> String {
    owned(id);
    let reply = wsl(&[
        "docker",
        "exec",
        id,
        "bash",
        "-c",
        "exec 3<>/dev/tcp/127.0.0.1/8080; printf 'GET / HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3; cat <&3",
    ]);
    assert!(reply.status.success());
    String::from_utf8(reply.stdout).unwrap()
}
fn install(path: PathBuf) -> (tempfile::TempDir, Runtime, String) {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let p = repo
        .install(InstallInput {
            path,
            development_confirmed: true,
            expected_version: None,
            expected_digest: None,
        })
        .unwrap();
    assert!(!p.enabled);
    assert!(repo.grant(&p.manifest.id).unwrap().is_none());
    repo.set_enabled(&p.manifest.id, true).unwrap();
    (dir, Runtime::new(repo), p.manifest.id)
}
async fn run(
    runtime: &Runtime,
    id: &str,
    action: &str,
    input: Value,
    service: &str,
    container: bool,
) -> Reply {
    owned(service);
    let mut reply = runtime
        .call(id, json!({"action":action,"input":input}))
        .await
        .unwrap();
    for _ in 0..8 {
        if reply.error.is_some() || reply.result["kind"] == "done" {
            return reply;
        }
        let operation = &reply.result["request"]["operation"];
        assert_eq!(operation["kind"], "platform");
        let primitive = &operation["request"];
        assert_eq!(primitive["kind"], "execute");
        assert_eq!(primitive["hostId"], "task-owned-host");
        let command = &primitive["command"];
        assert_eq!(command["program"], "sh");
        assert_eq!(command["args"][0], "-c");
        let script = command["args"][1].as_str().unwrap().to_owned();
        let service = service.to_owned();
        let output = tokio::task::spawn_blocking(move || {
            if container {
                wsl(&["sh", "-c", &script])
            } else {
                wsl(&["docker", "exec", &service, "sh", "-c", &script])
            }
        })
        .await
        .unwrap();
        assert!(output.stdout.len() < 256 * 1024 && output.stderr.len() < 256 * 1024);
        let value = json!({"state":"completed","exitCode":output.status.code(),"stdout":String::from_utf8(output.stdout).unwrap(),"stderr":String::from_utf8(output.stderr).unwrap(),"truncated":false,"message":null});
        tokio::time::sleep(std::time::Duration::from_millis(70)).await;
        reply=runtime.resume(id,json!({"hostResponse":{"requestId":reply.result["request"]["requestId"],"result":value,"error":null}})).await.unwrap();
    }
    panic!("Service action did not terminate")
}
#[tokio::test]
#[ignore = "requires task-owned network-none Nginx/MySQL fixtures and an externally built SDK5 package"]
async fn actual_nginx_and_external_mysql_packages_work_for_host_and_container_modes() {
    let nginx = std::env::var("SERVERDECK_NGINX_QA_ID").unwrap();
    let mysql = std::env::var("SERVERDECK_MYSQL_QA_ID").unwrap();
    owned(&nginx);
    owned(&mysql);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let (_n, nginx_vm, nginx_plugin) = install(
        root.join("plugins/system/packages/nginx.sdplugin")
            .canonicalize()
            .unwrap(),
    );
    let (_m, mysql_vm, mysql_plugin) = install(PathBuf::from(
        std::env::var("SERVERDECK_MYSQL_PACKAGE").unwrap(),
    ));
    nginx_vm.activate(&nginx_plugin).await.unwrap();
    mysql_vm.activate(&mysql_plugin).await.unwrap();
    for container in [false, true] {
        let target = if container {
            json!({"kind":"container","id":nginx})
        } else {
            json!({"kind":"host"})
        };
        for action in ["info", "test", "reload"] {
            let reply=run(&nginx_vm,&nginx_plugin,"nginx",json!({"hostId":"task-owned-host","target":target,"configPath":"/etc/nginx/nginx.conf","action":action}),&nginx,container).await;
            assert!(reply.error.is_none(), "Nginx {action}: {reply:?}");
            assert_eq!(reply.result["value"]["success"], true);
        }
        let marker = if container {
            "sdk5-container-reloaded"
        } else {
            "sdk5-host-reloaded"
        };
        owned(&nginx);
        let config = format!(
            "events {{}}\nhttp {{ server {{ listen 8080; location / {{ return 200 '{marker}'; }} }} }}\n"
        );
        let saved = wsl(&[
            "docker",
            "exec",
            &nginx,
            "sh",
            "-c",
            "printf '%s' \"$1\" > /etc/nginx/nginx.conf",
            "fixture-config",
            &config,
        ]);
        assert!(saved.status.success());
        let reloaded=run(&nginx_vm,&nginx_plugin,"nginx",json!({"hostId":"task-owned-host","target":target,"configPath":"/etc/nginx/nginx.conf","action":"reload"}),&nginx,container).await;
        assert!(reloaded.error.is_none());
        let mut effective = false;
        for _ in 0..10 {
            if http(&nginx).contains(marker) {
                effective = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(effective, "Reload must change the actual HTTP response");
        let reply=run(&nginx_vm,&nginx_plugin,"nginx",json!({"hostId":"task-owned-host","target":target,"configPath":"/tmp/invalid-nginx.conf","action":"reload"}),&nginx,container).await;
        assert_eq!(reply.error.unwrap().code, "REMOTE_COMMAND");
        assert!(
            http(&nginx).contains(marker),
            "An invalid configuration must not change the serving worker"
        );
        let target = if container {
            json!({"kind":"container","id":mysql})
        } else {
            json!({"kind":"host"})
        };
        for section in [
            "summary",
            "connections",
            "slow_queries",
            "locks",
            "transactions",
            "replication",
            "databases",
        ] {
            let reply=run(&mysql_vm,&mysql_plugin,"inspect",json!({"hostId":"task-owned-host","target":target,"auth":{"kind":"option_file","path":"/tmp/serverdeck-client.cnf"},"section":section}),&mysql,container).await;
            assert!(reply.error.is_none(), "MySQL {section}: {reply:?}");
            let value = &reply.result["value"];
            assert_eq!(value["success"], true);
            let rows = value["records"].as_array().unwrap();
            if section != "replication" {
                assert!(
                    !rows.is_empty(),
                    "Real {section} fixture must contain observations"
                );
            }
            if section == "summary" {
                assert!(
                    rows.iter()
                        .any(|row| row["metric"] == "session_read_only" && row["value"] == "1")
                );
            }
        }
        let defaults=run(&mysql_vm,&mysql_plugin,"inspect",json!({"hostId":"task-owned-host","target":target,"auth":{"kind":"defaults"},"section":"summary"}),&mysql,container).await;
        assert!(defaults.error.is_none());
        let bad=run(&mysql_vm,&mysql_plugin,"inspect",json!({"hostId":"task-owned-host","target":target,"auth":{"kind":"option_file","path":"/tmp/missing-client.cnf"},"section":"summary"}),&mysql,container).await;
        assert_eq!(bad.error.unwrap().code, "REMOTE_COMMAND");
    }
    nginx_vm.shutdown().await.unwrap();
    mysql_vm.shutdown().await.unwrap();
}
