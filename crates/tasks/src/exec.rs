use crate::*;

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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_utf8() {
        let mut d = Decoder::default();
        let mut text = String::new();
        for byte in "中文😀".as_bytes() {
            text += &d.feed(&[*byte]);
        }
        text += &d.finish();
        assert_eq!(text, "中文😀");
    }
}
