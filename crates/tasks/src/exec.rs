use crate::*;
use tokio::io::AsyncReadExt;

pub struct Outcome {
    pub state: &'static str,
    pub code: Option<u32>,
    pub message: Option<String>,
}
impl Outcome {
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            state: "failed",
            code: None,
            message: Some(message.into()),
        }
    }
    pub fn uncertain(message: impl Into<String>) -> Self {
        Self {
            state: "uncertain",
            code: None,
            message: Some(message.into()),
        }
    }
    pub fn status(code: Option<u32>) -> Self {
        Self {
            state: if code == Some(0) {
                "completed"
            } else if code.is_some() {
                "failed"
            } else {
                "uncertain"
            },
            code,
            message: if code == Some(0) {
                None
            } else {
                Some(match code {
                    Some(127) => "工具不存在，请在执行来源安装所需工具".into(),
                    Some(c) => format!("命令退出码 {c}，请查看错误输出；可能缺少权限或目标无响应"),
                    None => "未取得退出码，执行结果未确认".into(),
                })
            },
        }
    }
}
#[derive(Default)]
struct Decoder(Vec<u8>);
impl Decoder {
    fn feed(&mut self, bytes: &[u8]) -> String {
        self.0.extend_from_slice(bytes);
        let mut output = String::new();
        let mut used = 0;
        while used < self.0.len() {
            match std::str::from_utf8(&self.0[used..]) {
                Ok(s) => {
                    output.push_str(s);
                    used = self.0.len();
                }
                Err(e) => {
                    let end = used + e.valid_up_to();
                    if let Ok(s) = std::str::from_utf8(&self.0[used..end]) {
                        output.push_str(s);
                    }
                    used = end;
                    if let Some(n) = e.error_len() {
                        output.push('\u{fffd}');
                        used += n;
                    } else {
                        break;
                    }
                }
            }
        }
        self.0.drain(..used);
        output
    }
    fn finish(&mut self) -> String {
        let s = String::from_utf8_lossy(&self.0).into_owned();
        self.0.clear();
        s
    }
}
struct LocalDecoder {
    utf8: Decoder,
    #[cfg(windows)]
    legacy: Option<encoding_rs::Decoder>,
}
impl LocalDecoder {
    fn new(#[allow(unused_variables)] codepage: Option<u16>) -> Self {
        Self {
            utf8: Decoder::default(),
            #[cfg(windows)]
            legacy: codepage.and_then(|c| {
                let label = match c {
                    65001 => "utf-8".into(),
                    936 => "gbk".into(),
                    950 => "big5".into(),
                    932 => "shift_jis".into(),
                    949 => "euc-kr".into(),
                    n => format!("cp{n}"),
                };
                encoding_rs::Encoding::for_label(label.as_bytes())
                    .map(|e| e.new_decoder_without_bom_handling())
            }),
        }
    }
    fn feed(&mut self, bytes: &[u8], last: bool) -> String {
        #[cfg(windows)]
        if let Some(d) = &mut self.legacy {
            let mut s = String::with_capacity(bytes.len() * 3 + 16);
            let _ = d.decode_to_string(bytes, &mut s, last);
            return s;
        }
        let mut s = self.utf8.feed(bytes);
        if last {
            s += &self.utf8.finish();
        }
        s
    }
}
async fn local_codepage(cancel: &CancellationToken) -> Option<u16> {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let path =
            std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = tokio::process::Command::new(path);
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Write([Console]::OutputEncoding.CodePage)",
            ])
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .creation_flags(0x08000000);
        let output = tokio::select! {r=tokio::time::timeout(Duration::from_secs(3),command.output())=>r.ok()?.ok()?,_=cancel.cancelled()=>return None};
        std::str::from_utf8(&output.stdout)
            .ok()?
            .trim()
            .parse()
            .ok()
    }
    #[cfg(not(windows))]
    {
        let _ = cancel;
        None
    }
}
pub(crate) async fn remote(
    engine: &serverdeck_ssh::Engine,
    id: &str,
    command: &str,
    seconds: u16,
    cancel: &CancellationToken,
    output: impl FnMut(&str, bool) + Send,
) -> Outcome {
    remote_input(engine, id, command, None, seconds, cancel, output).await
}
pub(crate) async fn remote_input(
    engine: &serverdeck_ssh::Engine,
    id: &str,
    command: &str,
    input: Option<&[u8]>,
    seconds: u16,
    cancel: &CancellationToken,
    mut output: impl FnMut(&str, bool) + Send,
) -> Outcome {
    let deadline = tokio::time::sleep(Duration::from_secs(seconds.into()));
    tokio::pin!(deadline);
    let opened = tokio::select! {r=engine.open_ops_channel(id)=>r,_=cancel.cancelled()=>return Outcome::uncertain("已取消；远端尚未执行或结果未确认"),_= &mut deadline=>return Outcome::uncertain("SSH Channel 创建超时，结果未确认")};
    let mut opened = match opened {
        Ok(v) => v,
        Err(e) => return Outcome::failed(serverdeck_core::IpcError::from(e).message),
    };
    let mut stdout = Decoder::default();
    let mut stderr = Decoder::default();
    let execute = async {
        if opened.channel.exec(true, command).await.is_err() {
            return Outcome::uncertain("SSH exec 发送失败，结果未确认");
        }
        let mut input_failed = false;
        if let Some(input) = input {
            for chunk in input.chunks(16384) {
                if opened.channel.data(chunk).await.is_err() {
                    input_failed = true;
                    break;
                }
            }
            if opened.channel.eof().await.is_err() {
                input_failed = true;
            }
        }
        let mut accepted = false;
        let mut code = None;
        while let Some(msg) = opened.channel.wait().await {
            match msg {
                russh::ChannelMsg::Success => accepted = true,
                russh::ChannelMsg::Failure => return Outcome::failed("SSH 服务端拒绝 exec"),
                russh::ChannelMsg::Data { data } => output(&stdout.feed(&data), false),
                russh::ChannelMsg::ExtendedData { data, .. } => output(&stderr.feed(&data), true),
                russh::ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                russh::ChannelMsg::ExitSignal { .. } => {
                    return Outcome::failed("远端命令被信号终止");
                }
                russh::ChannelMsg::Close => break,
                _ => (),
            }
        }
        if !accepted {
            Outcome::uncertain("未取得 SSH exec 确认，结果未确认")
        } else if input_failed && code == Some(0) {
            Outcome::uncertain("脚本输入未完整发送，结果未确认")
        } else {
            Outcome::status(code)
        }
    };
    let result = tokio::select! {r=execute=>r,_=cancel.cancelled()=>Outcome::uncertain("已请求停止；不保证远端进程已终止，请独立核对"),_= &mut deadline=>Outcome::uncertain("执行超时；不保证远端进程已终止，禁止盲目重试"),_=opened.session_closed.cancelled()=>Outcome::uncertain("SSH 租约已关闭，结果未确认"),_=opened.transport_closed.cancelled()=>Outcome::uncertain("SSH 连接中断，结果未确认")};
    output(&stdout.finish(), false);
    output(&stderr.finish(), true);
    if result.state == "uncertain" {
        let _ = tokio::time::timeout(
            Duration::from_millis(250),
            opened.channel.signal(russh::Sig::TERM),
        )
        .await;
    }
    let _ = tokio::time::timeout(Duration::from_millis(500), opened.channel.close()).await;
    result
}
pub(crate) async fn local(
    program: std::path::PathBuf,
    args: Vec<String>,
    seconds: u16,
    cancel: &CancellationToken,
    mut output: impl FnMut(&str, bool) + Send,
) -> Outcome {
    let started = std::time::Instant::now();
    let budget = Duration::from_secs(seconds.into());
    let codepage = match tokio::time::timeout(budget, local_codepage(cancel)).await {
        Ok(cp) => cp,
        Err(_) => {
            return Outcome {
                state: "timed_out",
                code: None,
                message: Some("本地诊断初始化超时".into()),
            };
        }
    };
    if cancel.is_cancelled() {
        return Outcome {
            state: "cancelled",
            code: None,
            message: Some("本地诊断已停止".into()),
        };
    }
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .env("LC_ALL", "C");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => return Outcome::failed(format!("本地工具无法启动（工具不存在或权限不足）：{e}")),
    };
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let mut readers = tokio::task::JoinSet::new();
    async fn read(
        mut stream: impl tokio::io::AsyncRead + Unpin,
        tx: tokio::sync::mpsc::Sender<(bool, Vec<u8>)>,
        stderr: bool,
    ) -> std::io::Result<()> {
        let mut buf = [0; 8192];
        loop {
            let n = stream.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            if tx.send((stderr, buf[..n].to_vec())).await.is_err() {
                break;
            }
        }
        Ok(())
    }
    if let Some(s) = child.stdout.take() {
        readers.spawn(read(s, tx.clone(), false));
    }
    if let Some(s) = child.stderr.take() {
        readers.spawn(read(s, tx.clone(), true));
    }
    drop(tx);
    let mut stdout = LocalDecoder::new(codepage);
    let mut stderr = LocalDecoder::new(codepage);
    let collect = async {
        while let Some((err, bytes)) = rx.recv().await {
            output(
                &if err {
                    stderr.feed(&bytes, false)
                } else {
                    stdout.feed(&bytes, false)
                },
                err,
            );
        }
        match child.wait().await {
            Ok(s) => Outcome::status(s.code().and_then(|v| v.try_into().ok())),
            Err(e) => Outcome::failed(format!("读取本地退出状态失败：{e}")),
        }
    };
    let result = tokio::select! {r=tokio::time::timeout(budget.saturating_sub(started.elapsed()),collect)=>r.unwrap_or_else(|_|Outcome{state:"timed_out",code:None,message:Some("本地诊断超时".into())}),_=cancel.cancelled()=>Outcome{state:"cancelled",code:None,message:Some("本地诊断已停止".into())}};
    if child.id().is_some() {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    }
    drop(rx);
    if result.state != "completed" {
        readers.abort_all();
    }
    let mut read_error = false;
    while let Some(r) = readers.join_next().await {
        if !matches!(r, Ok(Ok(()))) {
            read_error = true;
        }
    }
    output(&stdout.feed(&[], true), false);
    output(&stderr.feed(&[], true), true);
    if read_error && result.state == "completed" {
        Outcome::failed("本地工具输出读取失败")
    } else {
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_utf8() {
        let mut d = Decoder::default();
        let b = "中文😀".as_bytes();
        let mut s = String::new();
        for c in b {
            s += &d.feed(&[*c]);
        }
        s += &d.finish();
        assert_eq!(s, "中文😀");
    }
    #[cfg(windows)]
    #[test]
    fn windows_legacy_decoder_keeps_split_multibyte_characters() {
        let (bytes, _, errors) = encoding_rs::GBK.encode("诊断 中文");
        assert!(!errors);
        let mut d = LocalDecoder::new(Some(936));
        let mut out = String::new();
        for byte in bytes.iter() {
            out += &d.feed(&[*byte], false);
        }
        out += &d.feed(&[], true);
        assert_eq!(out, "诊断 中文");
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn local_child_cancel_and_timeout_reap_process_and_pipes() {
        let input = DiagnosticInput {
            tool: Tool::Ping,
            origin: Origin::Local,
            target: "127.0.0.1".into(),
            port: 22,
            count: 100,
            timeout_secs: 15,
        };
        let (program, args) = crate::network::local_command(&input).expect("Windows system ping");
        let cancel = CancellationToken::new();
        let observed = Arc::new(tokio::sync::Notify::new());
        let ready = observed.clone();
        let token = cancel.clone();
        let started = std::time::Instant::now();
        let task = tokio::spawn(async move {
            local(program, args, 15, &token, move |s, _| {
                if !s.is_empty() {
                    ready.notify_one();
                }
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), observed.notified())
            .await
            .expect("actual ping output");
        cancel.cancel();
        let r = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .expect("child reaped")
            .expect("runner");
        assert_eq!(r.state, "cancelled");
        assert!(started.elapsed() < Duration::from_secs(8));
        let (program, args) = crate::network::local_command(&input).expect("ping");
        let start = std::time::Instant::now();
        let r = local(program, args, 2, &CancellationToken::new(), |_, _| {}).await;
        assert_eq!(r.state, "timed_out");
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
