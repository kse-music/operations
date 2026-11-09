# ADR 0005：russh 生产接入、独立 PTY 和应用层背压

整理状态：有效；SSH 隔离/信任/背压和 RSA 门禁保留，文中“不接入 SFTP”仅指当时阶段。

以下保留原决策正文和当时验证边界；当前接口及功能以[总体架构](../ARCHITECTURE.md)和[决策索引](../DECISIONS.md)为准。

日期：2026-11-01；状态：已实施，Windows → Ubuntu OpenSSH 实测。

采用锁定于 Cargo.lock 的 russh 0.65.0，关闭默认 feature，使用 ring + rsa。真实握手、密码、普通/加密 Ed25519、Agent 签名、独立 Channel、PTY resize、断线和有界输出已验证，无需替换实现。保持原有 probe 独立，不把 SFTP 子系统接入本阶段产品。

应用自己的 SQLite 信任表以 hostname+port 保存完整公钥；未知主机必须完成 live challenge 确认才发送认证信息，密钥变化硬性阻止。系统 known_hosts 的 CA/哈希/撤销导入没有被简化成不正确的字符串解析，明确留待后续。

Transport 与终端 Session 分开管理：复用键包含主机、端点、账户和凭据 ID/revision。每个 Shell 一个 Channel；关闭一个只取消该 Channel，最后一个退出后才关闭 Transport。重连创建新 Shell，不重放输入。总数限制 32；受远端 MaxSessions 限制时明确失败，不自动增开无限连接。

Tauri Channel 本身不提供端到端背压，采用最多一块 16KiB 输出 + xterm.write 完成回调 ACK，后台收到对应序号才继续读取。控制输入/resize 与输出消费分开，Ctrl+C 和取消不被解析等待阻塞。代价是每块有一次 IPC 往返；2MiB 实测通过，尚无长期吞吐和内存基准。russh 内部控制队列仍有无界部分，不能宣称恶意服务端下有硬内存上限。

保留 RUSTSEC-2023-0071 的非零审计结果，不添加 ignore。生产私钥文件入口拒绝 RSA；RSA Agent 使用系统进程签名并要求 SHA-2，应用不做 RSA 私钥运算。Ed25519/ECDSA 文件、密码、Agent 可用；主机 RSA 公钥验证不属于本地私钥签名。系统 Agent 的实现安全性由系统提供，当前只验证了隔离命名管道 Agent 的真实签名认证，未验证用户系统服务与实际加载身份。

依据：[russh 0.65 API](https://docs.rs/russh/0.65.0/russh/client/struct.Handle.html)、[xterm flow control](https://xtermjs.org/docs/guides/flowcontrol/)、[Tauri Channel](https://v2.tauri.app/develop/calling-frontend/#channels)、[RustSec RSA 通告](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)。实际证据与限制见 [阶段三验收](../../validation/terminal/VALIDATION_STAGE3.md)。
