use super::*;
use serverdeck_core::files::SftpUser;

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn command(user: &SftpUser, prompt: &str, ready: &str) -> String {
    let server = if user.server_path.is_empty() {
        "sd_server=; for sd_path in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server; do if test -x \"$sd_path\"; then sd_server=$sd_path; break; fi; done; test -n \"$sd_server\" || exit 127".into()
    } else {
        format!("sd_server={}", quote(&user.server_path))
    };
    // The fixed wrapper announces successful sudo authentication before any SFTP bytes are sent.
    // No PTY: terminal line discipline must never modify the binary protocol.
    let wrapper = format!(
        "cd -- \"$HOME\" 2>/dev/null || cd / || exit 1; printf '%s' {}; exec \"$1\"",
        quote(ready)
    );
    let flags = if user.password.is_some() {
        format!("-S -p {}", quote(prompt))
    } else {
        "-n".into()
    };
    format!(
        "export LC_ALL=C; export PATH=/usr/bin:/bin:/usr/sbin:/sbin; {server}; exec sudo {flags} -H -u {} -- /bin/sh -c {} serverdeck-sftp \"$sd_server\"",
        quote(&user.username),
        quote(&wrapper)
    )
}

pub(crate) async fn start(
    channel: &mut Channel<client::Msg>,
    user: &SftpUser,
) -> Result<(), Error> {
    user.validate()?;
    let token = Uuid::new_v4().simple().to_string();
    let prompt = format!("__SD_SUDO_{token}__");
    let ready = format!("__SD_SFTP_{token}__");
    channel
        .exec(true, command(user, &prompt, &ready))
        .await
        .map_err(network)?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut sent = false;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => (),
            Some(ChannelMsg::Data { data }) => {
                stdout.extend_from_slice(&data);
                if !ready.as_bytes().starts_with(&stdout) {
                    return Err(failure(
                        "SFTP_SUDO_PROTOCOL",
                        "SFTP 启动输出异常，请检查远程 Shell 配置",
                    ));
                }
                if stdout == ready.as_bytes() {
                    return Ok(());
                }
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                if stderr.len() + data.len() > 16 * 1024 {
                    return Err(failure(
                        "SFTP_SUDO_OUTPUT",
                        "sudo 启动错误输出过多，已停止连接",
                    ));
                }
                stderr.extend_from_slice(&data);
                if stderr
                    .windows(prompt.len())
                    .any(|part| part == prompt.as_bytes())
                {
                    if sent {
                        return Err(failure("SFTP_SUDO_AUTH", "sudo 密码未通过，原文件连接保留"));
                    }
                    let password = user.password.as_ref().ok_or_else(|| {
                        failure(
                            "SFTP_SUDO_AUTH",
                            "服务器要求 sudo 密码，请输入登录用户的 sudo 密码",
                        )
                    })?;
                    let mut input = Zeroizing::new(password.as_bytes().to_vec());
                    input.push(b'\n');
                    channel.data(input.as_slice()).await.map_err(network)?;
                    sent = true;
                    stderr.clear();
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                let (code, message) = if exit_status == 127 {
                    (
                        "SFTP_SERVER_MISSING",
                        "找不到 sftp-server，请填写服务器上该程序的绝对路径",
                    )
                } else {
                    (
                        "SFTP_SUDO_DENIED",
                        "sudo 切换失败：请检查密码、目标用户、sudo 授权及 requiretty 策略；原文件连接保留",
                    )
                };
                return Err(Error::Connection {
                    code,
                    message,
                    source: Some(Box::new(std::io::Error::other(format!(
                        "sudo SFTP startup exited with status {exit_status}"
                    )))),
                });
            }
            Some(ChannelMsg::Failure | ChannelMsg::Close | ChannelMsg::Eof) | None => {
                return Err(failure(
                    "SFTP_SUDO_DENIED",
                    "服务器拒绝 sudo SFTP；请检查 sudo 权限及 sftp-server 路径",
                ));
            }
            _ => (),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_parameters_and_keeps_password_out_of_command() {
        let mut user = SftpUser {
            username: "root".into(),
            server_path: "/tmp/sftp';$(touch injected)".into(),
            password: Some(Zeroizing::new("secret-value".into())),
        };
        user.validate().unwrap();
        let value = command(&user, "prompt", "ready");
        assert!(!value.contains("secret-value"));
        assert!(value.contains("'\\''"));
        assert!(value.contains("sudo -S -p 'prompt' -H -u 'root' -- /bin/sh"));
        user.password = None;
        assert!(command(&user, "prompt", "ready").contains("sudo -n"));
        for username in ["", "-root", "root;id", "root\n"] {
            user.username = username.into();
            assert!(user.validate().is_err());
        }
    }
}
