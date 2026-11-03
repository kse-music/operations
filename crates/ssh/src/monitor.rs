use super::*;

fn collector_command() -> String {
    include_str!("monitor.sh").replace("\r\n", "\n")
}

impl Engine {
    pub fn monitor_ready(&self, id: &str) -> Result<bool, Error> {
        let owner = self.control(id)?;
        if owner.kind != SessionKind::Monitor || owner.cancel.is_cancelled() {
            return Err(failure("MONITOR_DISCONNECTED", "监控 SSH 租约已关闭"));
        }
        Ok(owner.ready.load(Ordering::Acquire))
    }
    // Only this fixed read-only collector is exposed; no arbitrary command IPC.
    pub async fn collect_monitor(
        &self,
        id: &str,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, Error> {
        if !self.monitor_ready(id)? {
            return Err(failure("MONITOR_NOT_READY", "监控连接尚未就绪"));
        }
        let owner = self.control(id)?;
        let transport = locked(&self.registry)?
            .transports
            .values()
            .find(|t| t.id == owner.info.transport_id)
            .cloned()
            .ok_or(Error::NotFound)?;
        let connection = transport
            .connection
            .lock()
            .await
            .clone()
            .ok_or(Error::NotFound)?;
        let mut channel = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(3),connection.channel_open_session()) => result.map_err(|_| failure("MONITOR_TIMEOUT","监控 Channel 创建超时"))?.map_err(network)?,
            _ = cancel.cancelled() => return Err(Error::ShuttingDown),
            _ = owner.cancel.cancelled() => return Err(failure("MONITOR_DISCONNECTED","监控连接已关闭")),
        };
        let collecting = async {
            channel
                .exec(true, collector_command())
                .await
                .map_err(network)?;
            accepted(&mut channel).await?;
            let mut output = Vec::new();
            let mut errors = 0usize;
            let mut status = None;
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        if output.len() + data.len() > 2 * 1024 * 1024 {
                            return Err(failure(
                                "MONITOR_OUTPUT_LIMIT",
                                "采集输出超过 2 MiB 安全上限",
                            ));
                        }
                        output.extend_from_slice(&data);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        errors += data.len();
                        if errors > 16384 {
                            return Err(failure("MONITOR_STDERR_LIMIT", "采集错误输出超过上限"));
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => status = Some(exit_status),
                    Some(ChannelMsg::ExitSignal { .. }) => {
                        return Err(failure("MONITOR_COMMAND", "采集命令被信号中止"));
                    }
                    None | Some(ChannelMsg::Close) => break,
                    _ => (),
                }
            }
            if status != Some(0) {
                return Err(failure(
                    "MONITOR_COMMAND",
                    "采集命令执行失败或未返回退出状态",
                ));
            }
            Ok(output)
        };
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(8), collecting) => result.unwrap_or_else(|_| Err(failure("MONITOR_TIMEOUT","指标采集超过 8 秒，当前值已过期"))),
            _ = cancel.cancelled() => Err(Error::ShuttingDown),
            _ = owner.cancel.cancelled() => Err(failure("MONITOR_DISCONNECTED","监控连接已关闭")),
            _ = connection.alive.cancelled() => Err(failure("MONITOR_DISCONNECTED","SSH 连接中断")),
        };
        let _ = tokio::time::timeout(Duration::from_millis(500), channel.close()).await;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::collector_command;

    #[test]
    fn collector_command_uses_posix_line_endings() {
        let command = collector_command();
        assert!(
            !command.contains('\r'),
            "remote shell commands must not contain Windows carriage returns"
        );
        assert!(command.starts_with("export LC_ALL=C\n"));
    }
}
