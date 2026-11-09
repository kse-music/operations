# ADR 0006：日常终端、受管路由与归属明确的端口转发

整理状态：部分被 [ADR 0018](0018-workspace-lifecycle.md) 替代；路由与转发边界保留，终端布局不再持久化。

以下保留原决策正文和当时验证边界；当前接口及功能以[总体架构](../ARCHITECTURE.md)和[决策索引](../DECISIONS.md)为准。

日期：2026-11-01；状态：已实施。证据见 [SSH 使用增强验收](../../validation/terminal/VALIDATION_SSH_USABILITY.md)。

继续使用锁定的 russh 0.65：connect_stream 接受 TCP、代理流或 direct-tcpip ChannelStream，避免为了代理执行本地 Shell。受管跳板逐跳验证密钥、独立认证，最多 4 层，配置和凭据 revision 参与 Transport 复用。SOCKS5 支持无认证/用户名密码，HTTP CONNECT 支持无认证/Basic；秘密仍来自 OS 库。HTTP 代理不使用 TLS，代理认证没有额外加密，界面明确提示可信网络边界。ProxyCommand 不启用；Include/Match、复杂 ProxyJump 字符串拒绝，不能忽略后连接错误目标。导入依赖按事务排序，同名跳板端点冲突阻断，不写回 ssh_config。

标签拥有布局，窗格拥有 Session，Transport 可共享；二叉树只计算百分比几何，不重排 xterm DOM，避免拖动导致 Shell 重启。最多 8 窗格/标签、32 总窗格。布局只持久化 HostId、标题、顺序和比例，重启恢复未连接状态；不保存终端正文，不回放命令。终端偏好追加到原版本配置并默认兼容，键位校验保留 Ctrl+C/Z；大文本先确认并遵守远端 Bracketed Paste，显式本地导出，默认不录制。

转发归属于创建它的 Session，不采用全局永久隧道服务。Local/Remote/Dynamic 显式启停，默认回环、公共绑定需要前后端显式确认；Remote 仍受服务端 GatewayPorts/AllowTcpForwarding 策略约束。并发流、记录、入口队列均有上限。停止、断线、关闭清理监听和子任务；同一远程端口的精确所有权防止重复请求撤销其他隧道。远程取消未确认时断开所属 Transport，优先避免服务器遗留监听，并明确提示共享终端受影响。Dynamic 暂限无认证 CONNECT，不支持 UDP/BIND；Remote 不支持端口 0；转发不自动恢复。

原生验证发现并修复两项实际交互缺陷：ResizeObserver 不再抢搜索焦点；布局保存与凭据读取改为有界元数据等待，连接前 BUSY 有限重试必须新建 Tauri Channel。输入数据只在原 Session 内重试，重连清空旧队列，不能重放命令。

依据：[OpenSSH 配置语义](https://man.openbsd.org/ssh_config)、[xterm 终端偏好/Bracketed Paste](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)、固定版本本地 russh client Config/Handle/Handler 源码与实际协议测试。未引入 SFTP、远程执行命令模板或通用任务框架。
