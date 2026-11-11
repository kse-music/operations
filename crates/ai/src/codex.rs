use crate::local_cli;
pub use crate::local_cli::Snapshot;
use crate::{check_request_budget, failure, provider::Completion};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use serverdeck_core::{
    Error,
    ai::{Config, Provider, Usage},
};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};
use zeroize::Zeroizing;

// This contains paths and a digest only. Authentication stays inside the Codex process.
#[derive(Serialize, Deserialize)]
struct Runtime {
    executable: PathBuf,
    home: PathBuf,
    revision: String,
    mcp_servers: Vec<String>,
}

fn io_error(error: std::io::Error) -> Error {
    Error::Connection {
        code: "AI_CODEX_IO",
        message: "本地 Codex 启动或通信失败，请检查安装与文件访问权限",
        source: Some(Box::new(error)),
    }
}

pub fn executable(directory: Option<&std::path::Path>) -> Result<Option<PathBuf>, Error> {
    local_cli::find_executable(executable_candidates)
        .and_then(|found| crate::local_tools::with_managed(found, directory, Provider::LocalCodex))
}
fn required_executable(directory: Option<&std::path::Path>) -> Result<PathBuf, Error> {
    executable(directory)?.ok_or_else(|| {
        failure(
            "AI_CODEX_MISSING",
            "未找到本地 Codex CLI，请安装并将 codex 加入 PATH，然后重启 ServerDeck",
        )
    })
}

fn executable_candidates(directory: &std::path::Path) -> Vec<PathBuf> {
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let mut paths = vec![directory.join(name)];
    if cfg!(windows) {
        let (platform, triple) = if cfg!(target_arch = "aarch64") {
            ("win32-arm64", "aarch64-pc-windows-msvc")
        } else {
            ("win32-x64", "x86_64-pc-windows-msvc")
        };
        let package = directory.join("node_modules/@openai/codex");
        let vendor = format!("vendor/{triple}/codex/codex.exe");
        paths.push(package.join(&vendor));
        paths.push(
            package
                .join(format!("node_modules/@openai/codex-{platform}"))
                .join(&vendor),
        );
        paths.push(
            directory
                .join(format!("node_modules/@openai/codex-{platform}"))
                .join(vendor),
        );
    }
    paths
}

fn home() -> Result<PathBuf, Error> {
    let path = if let Some(value) = std::env::var_os("CODEX_HOME") {
        PathBuf::from(value)
    } else {
        PathBuf::from(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .ok_or_else(|| failure("AI_CODEX_HOME", "无法定位本地 Codex 用户目录"))?,
        )
        .join(".codex")
    };
    if !path.is_absolute() {
        return Err(failure("AI_CODEX_HOME", "CODEX_HOME 必须为绝对路径"));
    }
    Ok(path)
}

async fn revision(runtime: &Runtime, account: &Value) -> Result<String, Error> {
    let mut hash = Sha256::new();
    hash.update(runtime.executable.as_os_str().as_encoded_bytes());
    hash.update(runtime.home.as_os_str().as_encoded_bytes());
    hash.update(account.to_string());
    // A ChatGPT refresh changes tokens without changing the signed-in identity.
    let files = if account["type"] == "chatgpt" {
        vec!["config.toml"]
    } else {
        vec!["config.toml", "auth.json"]
    };
    for name in files {
        let path = runtime.home.join(name);
        match tokio::fs::File::open(path).await {
            Ok(file) => {
                use tokio::io::AsyncReadExt;
                let mut bytes = Zeroizing::new(Vec::new());
                file.take(1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(io_error)?;
                if bytes.len() > 1024 * 1024 {
                    return Err(failure("AI_CODEX_CONFIG", "本地 Codex 配置文件超过 1 MiB"));
                }
                hash.update(name);
                hash.update(&*bytes);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => hash.update(name),
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

struct Client {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    _directory: tempfile::TempDir,
    sequence: u64,
    received: usize,
    stderr: Option<tokio::task::JoinHandle<Zeroizing<Vec<u8>>>>,
}

impl Drop for Client {
    fn drop(&mut self) {
        if let Some(stderr) = &self.stderr {
            stderr.abort();
        }
    }
}

impl Client {
    async fn start(runtime: &Runtime) -> Result<Self, Error> {
        let directory = tempfile::Builder::new()
            .prefix("serverdeck-codex-")
            .tempdir()
            .map_err(io_error)?;
        let mut command = Command::new(&runtime.executable);
        command
            .args(["app-server", "--listen", "stdio://"])
            .env("CODEX_HOME", &runtime.home)
            .current_dir(directory.path());
        // Per-process overrides preserve the user's provider and credentials while
        // keeping all operational tools and approvals in ServerDeck.
        for value in [
            "features.shell_tool=false",
            "features.hooks=false",
            "features.apps=false",
            "features.plugins=false",
            "features.multi_agent=false",
            "features.code_mode=false",
            "features.code_mode_host=false",
            "features.computer_use=false",
            "features.browser_use=false",
            "features.in_app_browser=false",
            "features.view_image=false",
            "features.skill_mcp_dependency_install=false",
            "features.skill_search=false",
            "web_search=\"disabled\"",
            "notify=[]",
        ] {
            command.args(["-c", value]);
        }
        for name in &runtime.mcp_servers {
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            {
                return Err(failure(
                    "AI_CODEX_CONFIG",
                    "本地 MCP 名称无法通过当前 Codex CLI 安全隔离，请使用字母、数字、下划线或短横线命名",
                ));
            }
            command.args(["-c", &format!("mcp_servers.{name}.enabled=false")]);
        }
        Self::connect(command, directory).await
    }
    async fn connect(mut command: Command, directory: tempfile::TempDir) -> Result<Self, Error> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(io_error)?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| failure("AI_CODEX_IO", "Codex 诊断管道不可用"))?;
        let stderr = local_cli::drain_stderr(stderr);
        let input = child
            .stdin
            .take()
            .ok_or_else(|| failure("AI_CODEX_IO", "Codex 输入管道不可用"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| failure("AI_CODEX_IO", "Codex 输出管道不可用"))?;
        let mut client = Self {
            child,
            input,
            output: BufReader::new(output),
            _directory: directory,
            sequence: 0,
            received: 0,
            stderr: Some(stderr),
        };
        client.rpc("initialize", json!({"clientInfo":{"name":"serverdeck","title":"ServerDeck","version":env!("CARGO_PKG_VERSION")}})).await?;
        client.write(json!({"method":"initialized"})).await?;
        Ok(client)
    }
    async fn write(&mut self, value: Value) -> Result<(), Error> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| Error::Worker(Box::new(e)))?;
        bytes.push(b'\n');
        self.input.write_all(&bytes).await.map_err(io_error)?;
        self.input.flush().await.map_err(io_error)
    }
    async fn read(&mut self) -> Result<Value, Error> {
        let bytes = match local_cli::read_line(&mut self.output, &mut self.received).await? {
            Some(bytes) => bytes,
            None => {
                let status = self.child.wait().await.map_err(io_error)?;
                let diagnostic = match self.stderr.take() {
                    Some(reader) => reader
                        .await
                        .map_err(|error| Error::Worker(Box::new(error)))?,
                    None => Zeroizing::new(Vec::new()),
                };
                let message =
                    if String::from_utf8_lossy(&diagnostic).contains("sqlite state runtime") {
                        "Codex 无法初始化本地状态库，请检查 Codex 用户目录的访问权限"
                    } else {
                        "本地 Codex 已退出，请检查 CLI 安装、配置和登录状态"
                    };
                tracing::warn!(
                    operation = "ai_codex_exit",
                    exit_code = status.code(),
                    "Codex exited before completing its response; diagnostic payload omitted"
                );
                return Err(Error::Connection {
                    code: "AI_CODEX_EXIT",
                    message,
                    source: Some(Box::new(std::io::Error::other(format!(
                        "Codex exited with {status}"
                    )))),
                });
            }
        };
        serde_json::from_slice(&bytes)
            .map_err(|_| failure("AI_CODEX_PROTOCOL", "本地 Codex 返回了无效的 JSON-RPC 消息"))
    }
    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, Error> {
        self.sequence += 1;
        let id = self.sequence;
        self.write(json!({"id":id,"method":method,"params":params}))
            .await?;
        loop {
            let value = self.read().await?;
            if value["id"].as_u64() == Some(id) && value.get("method").is_none() {
                if value.get("error").is_some() {
                    return Err(rpc_error(&value["error"]));
                }
                return value
                    .get("result")
                    .cloned()
                    .ok_or_else(|| failure("AI_CODEX_PROTOCOL", "Codex RPC 响应缺少结果"));
            }
            self.reject_request(&value).await?;
        }
    }
    async fn reject_request(&mut self, value: &Value) -> Result<(), Error> {
        if value.get("id").is_some() && value.get("method").is_some() {
            self.write(json!({"id":value["id"],"error":{"code":-32601,"message":"ServerDeck handles operations and approvals"}})).await?;
            return Err(failure(
                "AI_CODEX_TOOL",
                "本地 Codex 请求了助手范围外的工具或权限，已停止",
            ));
        }
        Ok(())
    }
    async fn inspect(&mut self, runtime: &Runtime) -> Result<(Config, String, Vec<String>), Error> {
        let account = self
            .rpc("account/read", json!({"refreshToken":false}))
            .await?;
        if account["account"].is_null() && account["requiresOpenaiAuth"].as_bool() != Some(false) {
            return Err(failure(
                "AI_CODEX_AUTH",
                "本地 Codex 尚未登录，请在终端运行 codex login 后刷新",
            ));
        }
        let effective = self
            .rpc("config/read", json!({"includeLayers":false}))
            .await?;
        let enabled_servers = effective["config"]["mcp_servers"]
            .as_object()
            .map(|servers| {
                servers
                    .iter()
                    .filter(|(_, config)| config["enabled"] != false)
                    .map(|(name, _)| name.clone())
                    .collect()
            })
            .unwrap_or_default();
        let mut config = Config {
            provider: Provider::LocalCodex,
            base_url: "codex://local".into(),
            model: effective["config"]["model"]
                .as_str()
                .unwrap_or("default")
                .to_owned(),
            ..Config::default()
        };
        config.max_output_tokens = 8192;
        let identity = json!({"account":account["account"],"provider":effective["config"]["model_provider"],"model":config.model});
        let digest = revision(runtime, &identity["account"]).await?;
        let revision = format!("{digest}:{:x}", Sha256::digest(identity.to_string()));
        Ok((config, revision, enabled_servers))
    }
}

fn rpc_error(error: &Value) -> Error {
    tracing::warn!(
        operation = "ai_codex_rpc",
        code = error["code"].as_i64(),
        "Codex request rejected; payload omitted"
    );
    failure(
        "AI_CODEX_RPC",
        "本地 Codex 拒绝请求，请检查 CLI 版本、配置、登录状态或额度",
    )
}

pub async fn snapshot() -> Result<Snapshot, Error> {
    snapshot_with_directory(None).await
}
pub async fn snapshot_with_directory(
    directory: Option<&std::path::Path>,
) -> Result<Snapshot, Error> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut runtime = Runtime {
            executable: required_executable(directory)?,
            home: home()?,
            revision: String::new(),
            mcp_servers: vec![],
        };
        let mut client = Client::start(&runtime).await?;
        let (config, revision, servers) = client.inspect(&runtime).await?;
        runtime.revision = revision.clone();
        runtime.mcp_servers = servers;
        Ok(Snapshot {
            config,
            revision,
            runtime: Zeroizing::new(
                serde_json::to_vec(&runtime).map_err(|e| Error::Worker(Box::new(e)))?,
            ),
        })
    })
    .await
    .map_err(|_| failure("AI_CODEX_TIMEOUT", "读取本地 Codex 状态超时，请检查 CLI"))?
}

pub async fn complete(config: &Config, runtime: &[u8], body: &Value) -> Result<Completion, Error> {
    complete_with_sink(config, runtime, body, None).await
}
pub async fn complete_with_sink(
    config: &Config,
    runtime: &[u8],
    body: &Value,
    sink: Option<crate::streaming::TextSink>,
) -> Result<Completion, Error> {
    let runtime: Runtime = serde_json::from_slice(runtime)
        .map_err(|_| failure("AI_CODEX_CONFIG", "本地 Codex 运行配置无效，请重新授权"))?;
    check_request_budget(
        config,
        serde_json::to_vec(body)
            .map_err(|e| Error::Worker(Box::new(e)))?
            .len(),
        u64::from(config.max_output_tokens),
    )?;
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut client = Client::start(&runtime).await?;
        let (_, revision, servers) = client.inspect(&runtime).await?;
        if servers
            .iter()
            .any(|name| !runtime.mcp_servers.contains(name))
        {
            return Err(failure(
                "AI_CODEX_CONFIG",
                "Codex MCP 配置已变化或无法隔离，请刷新本地状态后重试",
            ));
        }
        if revision != runtime.revision {
            return Err(Error::Conflict);
        }
        client.completion_with_sink(config, body, sink).await
    })
    .await
    .map_err(|_| failure("AI_CODEX_TIMEOUT", "本地 Codex 回答超时，已停止本次进程"))?
}

impl Client {
    #[cfg(test)]
    async fn completion(&mut self, config: &Config, body: &Value) -> Result<Completion, Error> {
        self.completion_with_sink(config, body, None).await
    }
    async fn completion_with_sink(
        &mut self,
        config: &Config,
        body: &Value,
        sink: Option<crate::streaming::TextSink>,
    ) -> Result<Completion, Error> {
        let model = if config.model == "default" {
            None
        } else {
            Some(&config.model)
        };
        let thread = self.rpc("thread/start", json!({
            "ephemeral": true,
            "sandbox": "read-only",
            "approvalPolicy": "never",
            "baseInstructions": body["messages"][0]["content"],
            "developerInstructions": "只根据消息中提供的证据返回要求的 JSON。所有工具查询与执行由 ServerDeck 完成。",
            "model": model,
        })).await?;
        let id = thread["thread"]["id"]
            .as_str()
            .ok_or_else(|| failure("AI_CODEX_PROTOCOL", "Codex 未返回会话 ID"))?;
        let tools = self
            .rpc("mcpServerStatus/list", json!({"threadId":id}))
            .await?;
        let isolated = tools["data"].as_array().is_some_and(|servers| {
            servers.iter().all(|server| {
                server["runtimeStatus"] == "disabled"
                    && server["tools"]
                        .as_object()
                        .is_some_and(|tools| tools.is_empty())
            })
        });
        if !isolated || !tools["nextCursor"].is_null() {
            return Err(failure(
                "AI_CODEX_CONFIG",
                "本地 Codex 仍加载了额外 MCP 工具，已停止发送",
            ));
        }
        let messages = body["messages"]
            .as_array()
            .filter(|messages| messages.len() >= 2)
            .ok_or_else(|| failure("AI_CODEX_PROTOCOL", "模型消息无效"))?;
        let context =
            serde_json::to_string(&messages[1..]).map_err(|e| Error::Worker(Box::new(e)))?;
        self.rpc(
            "turn/start",
            json!({"threadId":id,"input":[{"type":"text","text":context}]}),
        )
        .await?;
        let mut text = String::new();
        let mut streamed = String::new();
        let mut item_id = String::new();
        let mut usage = None;
        loop {
            let event = self.read().await?;
            self.reject_request(&event).await?;
            match event["method"].as_str() {
                Some("item/agentMessage/delta") => {
                    let delta = event["params"]["delta"]
                        .as_str()
                        .ok_or_else(|| failure("AI_CODEX_PROTOCOL", "Codex文本增量无效"))?;
                    let id = event["params"]["itemId"]
                        .as_str()
                        .ok_or_else(|| failure("AI_CODEX_PROTOCOL", "Codex文本项无效"))?;
                    let reset = item_id != id;
                    if reset {
                        streamed.clear();
                        item_id = id.into();
                    }
                    if streamed.len() + delta.len() > 256 * 1024 {
                        return Err(failure("AI_OUTPUT_LIMIT", "Codex回答超过256 KiB"));
                    }
                    streamed.push_str(delta);
                    crate::streaming::emit(sink.as_ref(), delta, reset).await?;
                }
                Some("item/completed") if event["params"]["item"]["type"] == "agentMessage" => {
                    if let Some(value) = event["params"]["item"]["text"].as_str() {
                        text = value.to_owned();
                    }
                    if text.len() > 256 * 1024 {
                        return Err(failure("AI_OUTPUT_LIMIT", "Codex 回答超过 256 KiB"));
                    }
                    let same_item =
                        event["params"]["item"]["id"].as_str() == Some(item_id.as_str());
                    if same_item && text.starts_with(&streamed) {
                        crate::streaming::emit(sink.as_ref(), &text[streamed.len()..], false)
                            .await?;
                    } else {
                        crate::streaming::emit(sink.as_ref(), &text, true).await?;
                    }
                    streamed.clone_from(&text);
                }
                Some("thread/tokenUsage/updated") => {
                    let tokens = &event["params"]["tokenUsage"]["last"];
                    usage = tokens["inputTokens"]
                        .as_u64()
                        .zip(tokens["outputTokens"].as_u64())
                        .map(|(input_tokens, output_tokens)| Usage {
                            input_tokens,
                            output_tokens,
                        });
                }
                Some("turn/completed") => {
                    let turn = &event["params"]["turn"];
                    if turn["status"] != "completed" {
                        return Err(rpc_error(&turn["error"]));
                    }
                    if text.trim().is_empty() {
                        return Err(failure("AI_CODEX_PROTOCOL", "Codex 未返回完整文本回答"));
                    }
                    return Ok(Completion {
                        text,
                        usage,
                        incomplete: false,
                    });
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture(scenario: &str) -> Client {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/codex/app-server.mjs");
        let mut command = Command::new("node");
        command.arg(path).arg(scenario);
        Client::connect(command, tempfile::tempdir().unwrap())
            .await
            .unwrap()
    }

    fn request() -> (Config, Value) {
        let config = Config {
            model: "fixture".into(),
            provider: Provider::LocalCodex,
            ..Config::default()
        };
        let body = crate::tests::messages(&config, "test", json!({}));
        (config, body)
    }

    #[tokio::test]
    async fn native_text_deltas_arrive_before_the_completed_turn() {
        let mut client = fixture("stream").await;
        let config = Config {
            provider: Provider::LocalCodex,
            ..Default::default()
        };
        let body = crate::tests::messages(&config, "test", json!({}));
        let (sink, mut receiver) = tokio::sync::mpsc::channel(16);
        let result = tokio::spawn(async move {
            client
                .completion_with_sink(&config, &body, Some(sink))
                .await
        });
        let first = receiver.recv().await.unwrap();
        assert_eq!(first.text, "{\"answer\":\"");
        assert!(!result.is_finished());
        assert_eq!(
            result.await.unwrap().unwrap().text,
            "{\"answer\":\"OK\",\"commands\":[]}"
        );
    }
    #[tokio::test]
    async fn subprocess_requires_completed_turn_and_preserves_usage() {
        let (config, body) = request();
        let mut client = fixture("success").await;
        let result = client.completion(&config, &body).await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&result.text).unwrap()["answer"],
            "OK"
        );
        assert_eq!(result.usage.unwrap().input_tokens, 10);
        for (scenario, expected) in [
            ("failed", "AI_CODEX_RPC"),
            ("crash", "AI_CODEX_EXIT"),
            ("tool", "AI_CODEX_TOOL"),
            ("mcp", "AI_CODEX_CONFIG"),
            ("oversize", "AI_OUTPUT_LIMIT"),
        ] {
            let mut client = fixture(scenario).await;
            let error =
                tokio::time::timeout(Duration::from_secs(5), client.completion(&config, &body))
                    .await
                    .unwrap()
                    .err()
                    .unwrap();
            assert_eq!(
                serverdeck_core::IpcError::from(error).code,
                expected,
                "{scenario}"
            );
        }
    }

    #[tokio::test]
    async fn missing_login_is_rejected_before_model_request() {
        let mut client = fixture("success").await;
        let runtime = Runtime {
            executable: PathBuf::new(),
            home: PathBuf::new(),
            revision: String::new(),
            mcp_servers: vec![],
        };
        let error = client.inspect(&runtime).await.err().unwrap();
        assert_eq!(serverdeck_core::IpcError::from(error).code, "AI_CODEX_AUTH");
    }

    #[tokio::test]
    async fn cancelled_completion_kills_its_own_process() {
        let (config, body) = request();
        let mut client = fixture("hang").await;
        let pid = client.child.id().unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(150),
                client.completion(&config, &body)
            )
            .await
            .is_err()
        );
        drop(client);
        tokio::time::sleep(Duration::from_millis(150)).await;
        let status = Command::new("node").args(["-e", "try { process.kill(Number(process.argv[1]), 0); process.exit(1); } catch { process.exit(0); }", &pid.to_string()]).status().await.unwrap();
        assert!(
            status.success(),
            "the cancelled request left its Codex child running"
        );
    }

    #[tokio::test]
    async fn configuration_and_account_changes_invalidate_snapshot_but_token_refresh_does_not() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = Runtime {
            executable: PathBuf::from("fixture"),
            home: directory.path().to_owned(),
            revision: String::new(),
            mcp_servers: vec![],
        };
        let account = json!({"type":"chatgpt","email":"fixture@example.test"});
        let original = revision(&runtime, &account).await.unwrap();
        tokio::fs::write(directory.path().join("auth.json"), "rotated-token")
            .await
            .unwrap();
        assert_eq!(original, revision(&runtime, &account).await.unwrap());
        tokio::fs::write(directory.path().join("config.toml"), "model = 'changed'")
            .await
            .unwrap();
        assert_ne!(original, revision(&runtime, &account).await.unwrap());
        assert_ne!(
            revision(&runtime, &account).await.unwrap(),
            revision(
                &runtime,
                &json!({"type":"chatgpt","email":"other@example.test"})
            )
            .await
            .unwrap()
        );
    }

    #[tokio::test]
    #[ignore = "uses the user's installed Codex and may consume a small amount of account usage"]
    async fn local_codex_live_completion() {
        let snapshot = snapshot().await.unwrap();
        let body = crate::tests::messages(
            &snapshot.config,
            "Reply using the required JSON with answer set to OK and commands set to an empty array.",
            json!({}),
        );
        let completion = complete(&snapshot.config, &snapshot.runtime, &body)
            .await
            .unwrap();
        let answer: Value = serde_json::from_str(&completion.text).unwrap();
        assert_eq!(answer["answer"], "OK");
        assert_eq!(answer["commands"], json!([]));
        assert!(!completion.incomplete);
    }
}
