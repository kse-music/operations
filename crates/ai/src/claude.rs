pub use crate::local_cli::Snapshot;
use crate::{check_request_budget, failure, local_cli, provider::Completion};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use serverdeck_core::{
    Error,
    ai::{Config, Provider, Usage},
};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdout, Command},
};
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
struct Runtime {
    executable: PathBuf,
    home: PathBuf,
    revision: String,
}

fn executable_candidates(directory: &Path) -> Vec<PathBuf> {
    let name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let mut paths = vec![directory.join(name)];
    let package = directory.join("node_modules/@anthropic-ai/claude-code");
    paths.push(package.join("bin").join(name));
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "aarch64") => "win32-arm64",
        ("windows", _) => "win32-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", _) => "darwin-x64",
        ("linux", "aarch64") => "linux-arm64",
        _ => "linux-x64",
    };
    paths.push(
        package
            .join(format!("node_modules/@anthropic-ai/claude-code-{platform}"))
            .join(name),
    );
    paths
}

fn home() -> Result<PathBuf, Error> {
    let path = if let Some(value) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        PathBuf::from(value)
    } else {
        PathBuf::from(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .ok_or_else(|| failure("AI_CLAUDE_HOME", "无法定位 Claude Code 用户目录"))?,
        )
        .join(".claude")
    };
    if !path.is_absolute() {
        return Err(failure(
            "AI_CLAUDE_HOME",
            "CLAUDE_CONFIG_DIR 必须为绝对路径",
        ));
    }
    Ok(path)
}

fn command(runtime: &Runtime, directory: &Path) -> Command {
    let mut command = Command::new(&runtime.executable);
    command
        .current_dir(directory)
        .env("CLAUDE_CONFIG_DIR", &runtime.home)
        .args([
            "--safe-mode",
            "--setting-sources",
            "user",
            "--settings",
            r#"{"disableAllHooks":true,"disableClaudeAiConnectors":true}"#,
        ]);
    command
}

struct Process {
    child: Child,
    output: BufReader<ChildStdout>,
    stderr: Option<tokio::task::JoinHandle<Zeroizing<Vec<u8>>>>,
    _directory: tempfile::TempDir,
    received: usize,
}
impl Drop for Process {
    fn drop(&mut self) {
        if let Some(stderr) = &self.stderr {
            stderr.abort();
        }
    }
}
impl Process {
    async fn start(
        mut command: Command,
        directory: tempfile::TempDir,
        input: Option<&[u8]>,
    ) -> Result<Self, Error> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(local_cli::io_error)?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| failure("AI_CLAUDE_IO", "Claude Code 诊断管道不可用"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| failure("AI_CLAUDE_IO", "Claude Code 输出管道不可用"))?;
        let mut process = Self {
            child,
            output: BufReader::new(output),
            stderr: Some(local_cli::drain_stderr(stderr)),
            _directory: directory,
            received: 0,
        };
        if let Some(mut stdin) = process.child.stdin.take() {
            if let Some(input) = input {
                stdin.write_all(input).await.map_err(local_cli::io_error)?;
            }
            stdin.shutdown().await.map_err(local_cli::io_error)?;
        }
        Ok(process)
    }
    async fn finish(&mut self) -> Result<ExitStatus, Error> {
        let status = self.child.wait().await.map_err(local_cli::io_error)?;
        if let Some(stderr) = self.stderr.take() {
            // Retain bounded diagnostics until process completion, never expose raw credentials or provider payloads.
            let _diagnostic = stderr
                .await
                .map_err(|error| Error::Worker(Box::new(error)))?;
        }
        Ok(status)
    }
    async fn authentication(&mut self) -> Result<Value, Error> {
        let mut output = Zeroizing::new(Vec::new());
        while let Some(line) = local_cli::read_line(&mut self.output, &mut self.received).await? {
            output.extend_from_slice(&line);
            if output.len() > 64 * 1024 {
                return Err(failure("AI_OUTPUT_LIMIT", "Claude Code 认证状态超过限制"));
            }
        }
        let status = self.finish().await?;
        let value: Value = serde_json::from_slice(&output).map_err(|_| {
            failure(
                "AI_CLAUDE_PROTOCOL",
                "无法读取 Claude Code 认证状态，请检查原生 CLI 版本",
            )
        })?;
        if !status.success() || value["loggedIn"] != true {
            return Err(failure(
                "AI_CLAUDE_AUTH",
                "本地 Claude Code 尚未登录，请在终端运行 claude auth login 或配置已有服务后刷新",
            ));
        }
        Ok(value)
    }
    #[cfg(test)]
    async fn completion(&mut self) -> Result<Completion, Error> {
        self.completion_with_sink(None).await
    }
    async fn completion_with_sink(
        &mut self,
        sink: Option<crate::streaming::TextSink>,
    ) -> Result<Completion, Error> {
        let mut streamed = String::new();
        let mut result = None;
        let mut initialized = false;
        while let Some(line) = local_cli::read_line(&mut self.output, &mut self.received).await? {
            let event: Value = serde_json::from_slice(&line)
                .map_err(|_| failure("AI_CLAUDE_PROTOCOL", "Claude Code 返回了无效的流式 JSON"))?;
            match event["type"].as_str() {
                Some("system") if event["subtype"] == "init" => {
                    if initialized
                        || event["tools"]
                            .as_array()
                            .is_none_or(|tools| !tools.is_empty())
                        || event["mcp_servers"]
                            .as_array()
                            .is_none_or(|servers| !servers.is_empty())
                    {
                        return Err(failure(
                            "AI_CLAUDE_TOOL",
                            "Claude Code 仍加载了额外工具，已停止本次请求",
                        ));
                    }
                    initialized = true;
                }
                Some("stream_event") => {
                    if !initialized {
                        return Err(failure("AI_CLAUDE_PROTOCOL", "Claude文本流未初始化"));
                    }
                    let inner = &event["event"];
                    match inner["type"].as_str() {
                        Some("message_start") => {
                            streamed.clear();
                            crate::streaming::emit(sink.as_ref(), "", true).await?;
                        }
                        Some("content_block_start")
                            if inner["content_block"]["type"] == "tool_use" =>
                        {
                            return Err(failure("AI_CLAUDE_TOOL", "Claude Code请求了未授权工具"));
                        }
                        Some("content_block_delta") if inner["delta"]["type"] == "text_delta" => {
                            let delta = inner["delta"]["text"].as_str().ok_or_else(|| {
                                failure("AI_CLAUDE_PROTOCOL", "Claude文本增量无效")
                            })?;
                            if streamed.len() + delta.len() > 256 * 1024 {
                                return Err(failure("AI_OUTPUT_LIMIT", "Claude回答超过256 KiB"));
                            }
                            streamed.push_str(delta);
                            crate::streaming::emit(sink.as_ref(), delta, false).await?;
                        }
                        _ => (),
                    }
                }
                Some("assistant")
                    if event["message"]["content"].as_array().is_some_and(|items| {
                        items.iter().any(|item| item["type"] == "tool_use")
                    }) =>
                {
                    return Err(failure(
                        "AI_CLAUDE_TOOL",
                        "Claude Code 请求了助手范围外的工具，已停止",
                    ));
                }
                Some("result") => {
                    if !initialized
                        || result.is_some()
                        || event["subtype"] != "success"
                        || event["is_error"] != false
                        || event["permission_denials"]
                            .as_array()
                            .is_some_and(|denials| !denials.is_empty())
                    {
                        return Err(failure(
                            "AI_CLAUDE_FAILED",
                            "Claude Code 请求失败，请检查已有服务、登录状态或额度",
                        ));
                    }
                    let text = event["result"]
                        .as_str()
                        .filter(|text| !text.trim().is_empty())
                        .ok_or_else(|| {
                            failure("AI_CLAUDE_PROTOCOL", "Claude Code 未返回完整文本回答")
                        })?;
                    if text.len() > 256 * 1024 {
                        return Err(failure("AI_OUTPUT_LIMIT", "Claude Code 回答超过 256 KiB"));
                    }
                    if text.starts_with(&streamed) {
                        crate::streaming::emit(sink.as_ref(), &text[streamed.len()..], false)
                            .await?;
                    } else {
                        crate::streaming::emit(sink.as_ref(), text, true).await?;
                    }
                    let usage = &event["usage"];
                    let usage = usage["input_tokens"]
                        .as_u64()
                        .zip(usage["output_tokens"].as_u64())
                        .map(|(input_tokens, output_tokens)| Usage {
                            input_tokens: input_tokens
                                .saturating_add(
                                    usage["cache_read_input_tokens"].as_u64().unwrap_or(0),
                                )
                                .saturating_add(
                                    usage["cache_creation_input_tokens"].as_u64().unwrap_or(0),
                                ),
                            output_tokens,
                        });
                    result = Some(Completion {
                        text: text.to_owned(),
                        usage,
                        incomplete: false,
                    });
                }
                _ => {}
            }
        }
        let status = self.finish().await?;
        if !status.success() {
            tracing::warn!(
                operation = "ai_claude_exit",
                exit_code = status.code(),
                "Claude Code failed; diagnostic payload omitted"
            );
            return Err(Error::Connection {
                code: "AI_CLAUDE_EXIT",
                message: "本地 Claude Code 已异常退出，请检查 CLI、配置和登录状态",
                source: Some(Box::new(std::io::Error::other(format!(
                    "Claude Code exited with {status}"
                )))),
            });
        }
        result.ok_or_else(|| {
            failure(
                "AI_CLAUDE_PROTOCOL",
                "Claude Code 响应未正常完成，请手动重试",
            )
        })
    }
}

async fn inspect(runtime: &Runtime) -> Result<(Config, String), Error> {
    let directory = tempfile::Builder::new()
        .prefix("serverdeck-claude-")
        .tempdir()
        .map_err(local_cli::io_error)?;
    let mut command = command(runtime, directory.path());
    command.args(["auth", "status", "--json"]);
    let account = Process::start(command, directory, None)
        .await?
        .authentication()
        .await?;
    configuration(runtime, &account).await
}

async fn configuration(runtime: &Runtime, account: &Value) -> Result<(Config, String), Error> {
    let mut hash = Sha256::new();
    hash.update(runtime.executable.as_os_str().as_encoded_bytes());
    hash.update(runtime.home.as_os_str().as_encoded_bytes());
    for name in [
        "authMethod",
        "apiProvider",
        "email",
        "orgId",
        "organizationId",
    ] {
        hash.update(account[name].to_string());
    }
    for name in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ] {
        hash.update(name);
        if let Some(value) = std::env::var_os(name) {
            hash.update(value.as_encoded_bytes());
        }
    }
    let path = runtime.home.join("settings.json");
    let settings = match tokio::fs::File::open(path).await {
        Ok(file) => {
            let mut bytes = Zeroizing::new(Vec::new());
            file.take(1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(local_cli::io_error)?;
            if bytes.len() > 1024 * 1024 {
                return Err(failure(
                    "AI_CLAUDE_CONFIG",
                    "Claude Code 用户配置超过 1 MiB",
                ));
            }
            hash.update(&*bytes);
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|_| failure("AI_CLAUDE_CONFIG", "Claude Code 用户配置不是有效 JSON"))?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(error) => return Err(local_cli::io_error(error)),
    };
    let model = std::env::var("ANTHROPIC_MODEL")
        .ok()
        .or_else(|| {
            settings["env"]["ANTHROPIC_MODEL"]
                .as_str()
                .map(str::to_owned)
        })
        .or_else(|| settings["model"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "default".into());
    let config = Config {
        provider: Provider::LocalClaudeCode,
        base_url: "claude-code://local".into(),
        model,
        max_output_tokens: 8192,
        ..Config::default()
    };
    config.validate()?;
    Ok((config, format!("{:x}", hash.finalize())))
}

pub async fn snapshot() -> Result<Snapshot, Error> {
    snapshot_with_directory(None).await
}
pub fn executable(directory: Option<&Path>) -> Result<Option<PathBuf>, Error> {
    local_cli::find_executable(executable_candidates).and_then(|found| {
        crate::local_tools::with_managed(found, directory, Provider::LocalClaudeCode)
    })
}
pub async fn snapshot_with_directory(directory: Option<&Path>) -> Result<Snapshot, Error> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let executable = executable(directory)?.ok_or_else(|| {
            failure(
                "AI_CLAUDE_MISSING",
                "未找到本地 Claude Code，请安装原生 CLI 并将 claude 加入 PATH，然后重启 ServerDeck",
            )
        })?;
        let mut runtime = Runtime {
            executable,
            home: home()?,
            revision: String::new(),
        };
        let (config, revision) = inspect(&runtime).await?;
        runtime.revision = revision.clone();
        Ok(Snapshot {
            config,
            revision,
            runtime: Zeroizing::new(
                serde_json::to_vec(&runtime).map_err(|error| Error::Worker(Box::new(error)))?,
            ),
        })
    })
    .await
    .map_err(|_| failure("AI_CLAUDE_TIMEOUT", "检查本地 Claude Code 状态超时"))?
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
        .map_err(|_| failure("AI_CLAUDE_CONFIG", "Claude Code 运行快照无效，请刷新后重试"))?;
    check_request_budget(
        config,
        serde_json::to_vec(body)
            .map_err(|error| Error::Worker(Box::new(error)))?
            .len(),
        u64::from(config.max_output_tokens),
    )?;
    tokio::time::timeout(Duration::from_secs(60), async {
        if inspect(&runtime).await?.1 != runtime.revision {
            return Err(Error::Conflict);
        }
        let messages = body["messages"]
            .as_array()
            .filter(|messages| messages.len() >= 2)
            .ok_or_else(|| failure("AI_CLAUDE_PROTOCOL", "Claude Code 请求消息无效"))?;
        let prompt = messages[0]["content"]
            .as_str()
            .ok_or_else(|| failure("AI_CLAUDE_PROTOCOL", "Claude Code 请求缺少系统规则"))?;
        let directory = tempfile::Builder::new()
            .prefix("serverdeck-claude-")
            .tempdir()
            .map_err(local_cli::io_error)?;
        let prompt_path = directory.path().join("system.txt");
        tokio::fs::write(&prompt_path, prompt)
            .await
            .map_err(local_cli::io_error)?;
        let input = Zeroizing::new(
            serde_json::to_vec(&messages[1..]).map_err(|error| Error::Worker(Box::new(error)))?,
        );
        let mut command = command(&runtime, directory.path());
        command
            .args([
                "--print",
                "--verbose",
                "--output-format",
                "stream-json",
                "--input-format",
                "text",
                "--no-session-persistence",
                "--max-turns",
                "1",
                "--tools",
                "",
                "--disallowedTools",
                "*",
                "--permission-mode",
                "dontAsk",
                "--permission-prompts",
                "none",
                "--disable-slash-commands",
                "--strict-mcp-config",
                "--mcp-config",
                r#"{"mcpServers":{}}"#,
                "--no-chrome",
                "--system-prompt-file",
            ])
            .arg(&prompt_path);
        if sink.is_some() {
            command.arg("--include-partial-messages");
        }
        Process::start(command, directory, Some(&input))
            .await?
            .completion_with_sink(sink)
            .await
    })
    .await
    .map_err(|_| failure("AI_CLAUDE_TIMEOUT", "Claude Code 回答超时，已停止本次进程"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture(scenario: &str) -> Process {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/claude/cli.mjs");
        let mut command = Command::new("node");
        command.arg(path).arg(scenario);
        Process::start(
            command,
            tempfile::tempdir().unwrap(),
            Some(b"fixture question"),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn native_text_deltas_arrive_before_the_result_and_successful_exit() {
        let mut process = fixture("stream").await;
        let (sink, mut receiver) = tokio::sync::mpsc::channel(16);
        let result = tokio::spawn(async move { process.completion_with_sink(Some(sink)).await });
        loop {
            if receiver.recv().await.unwrap().text == "{\"answer\":\"" {
                break;
            }
        }
        assert!(!result.is_finished());
        assert_eq!(
            result.await.unwrap().unwrap().text,
            "{\"answer\":\"OK\",\"commands\":[]}"
        );
    }
    #[tokio::test]
    async fn native_stream_requires_successful_exit_and_rejects_tools_and_partial_answers() {
        let result = fixture("success").await.completion().await.unwrap();
        assert_eq!(result.text, r#"{"answer":"OK","commands":[]}"#);
        let usage = result.usage.unwrap();
        assert_eq!(usage.input_tokens, 16);
        assert_eq!(usage.output_tokens, 3);
        assert!(!result.incomplete);
        for (scenario, expected) in [
            ("failed", "AI_CLAUDE_FAILED"),
            ("crash", "AI_CLAUDE_EXIT"),
            ("partial", "AI_CLAUDE_PROTOCOL"),
            ("duplicate", "AI_CLAUDE_FAILED"),
            ("missing-init", "AI_CLAUDE_FAILED"),
            ("tool", "AI_CLAUDE_TOOL"),
            ("mcp", "AI_CLAUDE_TOOL"),
            ("tool-use", "AI_CLAUDE_TOOL"),
            ("denied", "AI_CLAUDE_FAILED"),
            ("invalid", "AI_CLAUDE_PROTOCOL"),
            ("oversize", "AI_OUTPUT_LIMIT"),
        ] {
            let error =
                tokio::time::timeout(Duration::from_secs(5), fixture(scenario).await.completion())
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
    async fn authentication_requires_logged_in_status_and_excludes_sensitive_diagnostics() {
        assert_eq!(
            fixture("auth").await.authentication().await.unwrap()["loggedIn"],
            true
        );
        let error = fixture("logged-out")
            .await
            .authentication()
            .await
            .err()
            .unwrap();
        let error = serverdeck_core::IpcError::from(error);
        assert_eq!(error.code, "AI_CLAUDE_AUTH");
        assert!(!error.message.contains("fixture-secret"));
    }

    #[tokio::test]
    async fn config_and_account_changes_invalidate_snapshot_but_refreshed_credentials_do_not() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = Runtime {
            executable: PathBuf::from("fixture"),
            home: directory.path().to_owned(),
            revision: String::new(),
        };
        let account =
            json!({"loggedIn":true,"authMethod":"claude.ai","email":"fixture@example.test"});
        let (_, original) = configuration(&runtime, &account).await.unwrap();
        tokio::fs::write(
            directory.path().join(".credentials.json"),
            "rotated-credential",
        )
        .await
        .unwrap();
        assert_eq!(configuration(&runtime, &account).await.unwrap().1, original);
        tokio::fs::write(
            directory.path().join("settings.json"),
            r#"{"model":"sonnet"}"#,
        )
        .await
        .unwrap();
        let (_, changed) = configuration(&runtime, &account).await.unwrap();
        assert_ne!(changed, original);
        let other = json!({"loggedIn":true,"authMethod":"claude.ai","email":"other@example.test"});
        assert_ne!(configuration(&runtime, &other).await.unwrap().1, changed);
        tokio::fs::write(directory.path().join("settings.json"), "invalid")
            .await
            .unwrap();
        assert!(configuration(&runtime, &account).await.is_err());
    }

    #[tokio::test]
    async fn cancelled_request_kills_its_own_process() {
        let mut process = fixture("hang").await;
        let pid = process.child.id().unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(150), process.completion())
                .await
                .is_err()
        );
        drop(process);
        tokio::time::sleep(Duration::from_millis(150)).await;
        let status = Command::new("node").args(["-e", "try { process.kill(Number(process.argv[1]), 0); process.exit(1); } catch { process.exit(0); }", &pid.to_string()]).status().await.unwrap();
        assert!(
            status.success(),
            "cancelled Claude Code child is still running"
        );
    }

    #[tokio::test]
    #[ignore = "uses the user's installed Claude Code and may consume a small amount of account usage"]
    async fn local_claude_live_completion() {
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
