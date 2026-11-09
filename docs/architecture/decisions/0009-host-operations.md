# ADR 0009：共享 SSH 主机上下文的 CLI 运维和受限日志流

整理状态：公开插件领域接口已被 [ADR 0016](0016-plugin-platform.md) 替代；宿主私有服务可保留，旧页面和确认特例不代表当前 SDK。

以下保留原决策正文和当时验证边界；当前接口及功能以[总体架构](../ARCHITECTURE.md)和[决策索引](../DECISIONS.md)为准。

日期：2026-11-01；状态：已实现，证据见 [运维验收](../../validation/operations/VALIDATION_OPERATIONS.md)。

用户明确追加 PRD P1 运维范围。选择现有 SSH + Docker CLI，而非新增 Docker HTTP 客户端和 API 转发：CLI 兼容协商与 JSON 格式足够当前操作，减少认证/网络暴露面。只显式连接标准 Unix Socket并清除 context/Host/TLS 环境覆盖；不默认启用 TCP、sudo 或 su。普通账号无权限就失败，测试服务器权限由用户在服务器侧授予，应用不修改权限。

所有动作由 Rust 封闭枚举构造，参数严格校验/单引号转义；容器/镜像用全 ID，服务带明确 scope，写操作要求 confirmed，UI 输入全文并绑定 SessionId。容器环境全部默认遮蔽，显式确认才显示；不将输出存日志/数据库。进程信号选 pidfd + boot/start 标识，不使用存在 PID 复用窗口的检查后 kill；代价是信号需要较新的 Linux 和 Python pidfd 支持，能力不足明确失败。

Logs 不复用交互终端，用独立非 PTY Channel 和 ACK，每块最多 16 KiB、渲染后应答，暂停背压。前端 1 MiB/5000 行、最多 8 标签，纯文本过滤/导出；关闭请求 TERM 并 close。已有终端、SFTP 和 Monitor 仍保持独立所有权。操作成功只代表命令返回成功，断线/超时不等于回滚，失败提示要求重新核对。反馈仅本次应用内有界元数据；持久审计留待明确需求。

依据：[Docker 格式化](https://docs.docker.com/engine/cli/formatting/)、[Docker 容器详情](https://docs.docker.com/reference/cli/docker/container/inspect/)、[systemctl](https://www.freedesktop.org/software/systemd/man/256/systemctl.html)、[Linux proc stat](https://www.man7.org/linux/man-pages/man5/proc_pid_stat.5.html)，实现以锁定依赖源码和实机验证为准。
