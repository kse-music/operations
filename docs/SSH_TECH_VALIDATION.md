# SSH / SFTP 技术验证与暂定决策

> SSH 使用增强：russh 同时承载受管跳板、SOCKS5/HTTP CONNECT、三类端口转发；分屏、偏好与布局已接入。当前结果见 [VALIDATION_SSH_USABILITY.md](VALIDATION_SSH_USABILITY.md) 和决策 0006，产品 SFTP 仍未开发。

> 阶段三更新（2026-11-01）：生产 SSH 现已落入 `crates/ssh`，真实 Windows → Ubuntu OpenSSH、Linux PTY 与原生 xterm 已验证。下文保留阶段一的探针记录，涉及“尚未接入”“无授权服务器”的描述仅适用于当时。当前结论、命令、测试范围与未完成矩阵以 [VALIDATION_STAGE3.md](VALIDATION_STAGE3.md) 和 [决策 0005](DECISIONS.md) 为准。RSA 本地私钥签名限制仍保留；本轮没有开发产品 SFTP。

2026-11-01。对应 PRD §7/8/16/18，探针位于 `tools/ssh-probe`，**不是已交付的桌面 SSH 功能**。

## 决策与依据

暂定候选 `russh 0.65.0` + `russh-sftp 3.0.1`，Tokio 原生异步；明确关闭 russh 默认 feature，启用 ring 与 RSA。
实际解析版本固定于 Cargo.lock。独立开发工具加入 workspace，但未加入桌面依赖链。
选择它们是因为可直接在同一 Transport 上创建 PTY、exec、SFTP Channel，避免阻塞式 SSH 实现占用通用 IO 线程。
最终采用仍以真实 OpenSSH/Agent 与跨平台测试为门禁。

依据是下载到本机的**固定版本源码**、编译结果及真实回环 TCP 测试，而非只参考示例：

- [russh client API](https://docs.rs/russh/0.65.0/russh/client/struct.Handle.html)：密码、公钥、Agent 签名、独立 session Channel。
- [russh Handler](https://docs.rs/russh/0.65.0/russh/client/trait.Handler.html)：异步主机密钥校验默认拒绝。
- [russh-sftp API](https://docs.rs/russh-sftp/3.0.1/russh_sftp/client/struct.SftpSession.html)：接受 AsyncRead/AsyncWrite，接在 request_subsystem 的 ChannelStream 上。
- [russh 源码/安全通告](https://github.com/Eugeny/russh/security/advisories)：接入生产前需对照锁定版本检查全部相关通告。

注意：上游部分示例直接 `check_server_key → true`，不能用于产品。0.65 API 有变化（主机 key/certificate 类型、服务端 VerifiedPublicKey、bytes 数据类型），探针以真实编译为准。

## 已执行的自动验证

`cargo test -p serverdeck-ssh-probe --test protocol` 启动临时的 russh 协议测试服务端，仅监听 `127.0.0.1:随机端口`。
测试使用真实握手、加密、签名、Channel 与 SFTP 协议帧，不模拟业务状态。fixture 不启动本地 Shell，PTY 操作由协议 handler 接收并验证；**不能据此宣称 vim/top 或 OpenSSH 已兼容**。

| 范围       | 自动化证据                                                                                             | 还不能证明                                               |
| ---------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 密码认证   | 正确密码通过，错误密码拒绝                                                                             | PAM、keyboard-interactive/MFA、真实服务器策略            |
| 私钥认证   | 加密 OpenSSH Ed25519 与 RSA 密钥序列化/加载、错口令拒绝、解密后真实签名认证                            | PuTTY PPK、所有 PEM/ECDSA/FIDO/硬件令牌                  |
| RSA 安全   | 必须协商 RSA SHA-2；不允许 SHA-1 fallback                                                              | 所有旧服务器支持程度                                     |
| 主机密钥   | SHA256 带外 pin 匹配成功；不匹配握手失败且 auth 调用数为 0；证书默认拒绝                               | TOFU 交互、known_hosts 的哈希/撤销/CA/多算法策略         |
| PTY        | request_pty 收到确认、request_shell 确认、window-change 到 100×40；其他 Channel 关闭后仍可验证尺寸响应 | fixture 无真实 OS PTY，需外部 stty、vim/top、Ctrl+C 测试 |
| 多 Channel | 同一 Transport 上独立 PTY、两个 exec、SFTP；exec 输出完全隔离；关闭子 Channel 后 PTY 继续收发          | 20 会话压力、重协商、长连接恢复、端到端背压              |
| SFTP       | 子系统确认、版本握手、读取真实临时目录（含中文/空格/特殊字符文件）、关闭                               | OpenSSH 扩展、上传下载/哈希、权限/rename/取消兼容性      |

探针有握手/网络操作 15s deadline、每路输出 16KiB 上限和有限 Channel buffer。开发工具的同步控制台密码输入等待用户，不是生产异步凭据流程。
`russh-sftp::read_dir` 会收集目录结果，探针只应用于有界测试目录；未来真实文件浏览需限制/分页或改用底层协议，不可假设无限目录列表也有界。
russh 内部部分控制队列为 unbounded，生产模块必须审计使用路径并在外层落实消息限额，不能把库的配置字段当作所有队列有界的证明。

## 可运行的外部探针

只能针对有明确授权的 POSIX/Linux 测试服务器运行。指纹必须从服务器控制台或其他可信渠道取得；禁止先接受网络返回值再直接当 pin。

```powershell
# 公钥/主机信息并非秘密；密码和口令只在无回显控制台提示中输入。
cargo run -p serverdeck-ssh-probe -- <host> 22 <user> SHA256:<trusted-fingerprint> password
cargo run -p serverdeck-ssh-probe -- <host> 22 <user> SHA256:<trusted-fingerprint> key <key-path>
cargo run -p serverdeck-ssh-probe -- <host> 22 <user> SHA256:<trusted-fingerprint> agent
```

探针会执行两个固定 `printf`、创建一个交互 Shell，发送 `stty size`，并通过 SFTP 列出登录目录；结束后发送 exit 并断开连接。无任意命令拼接、不修改远程文件、不安装软件。
Shell 的启动配置本身可能有副作用，使用专用测试账户。需要命令权限和 SFTP 子系统；不支持的环境明确失败。
password / key passphrase 不允许通过 CLI 参数传入，不写日志；自有临时 String 使用 Zeroizing，依赖库内部复制的清零保证不能在本探针中承诺。
Agent 在 Windows 使用 OpenSSH named pipe，Unix 使用 SSH_AUTH_SOCK；不启用 agent forwarding，不自动降级到其他凭据，也不把 Agent 证书当普通公钥。

## 未执行的兼容性矩阵 / S3 接入门禁

目前没有获得授权真实 SSH 服务器或可用测试 Agent，以下均为待验证，绝不能写成已通过：

| 客户端                         | 服务端                             | 必测                                                                                                             |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Windows 11 x64                 | Ubuntu / Debian OpenSSH            | password、Ed25519、RSA SHA2、加密/无口令私钥、未知/改变主机密钥、stty 尺寸、vim/top/Ctrl+C、多个 Channel 与 SFTP |
| Windows 11 x64                 | Rocky / AlmaLinux / CentOS OpenSSH | 系统算法策略/FIPS 差异，不放开弱算法换兼容                                                                       |
| Windows 11 x64 + OpenSSH Agent | 上述服务端                         | named pipe 可用/不可用、身份选择、错误用户、RSA SHA2，不复制私钥                                                 |
| macOS / Linux + 系统 Agent     | 上述服务端                         | 本机编译、Unix socket、系统凭据存储和完整交互                                                                    |
| 各平台                         | SFTP v3/扩展/禁用子系统            | 中文特殊名称、权限拒绝、安全替换、传输哈希、取消、超大目录与并行终端                                             |

还需测试：连接超时、认证取消、SFTP 不可用、网络中断、服务器重启/rekey、20 会话、长时间输出背压与资源释放。
没有 xterm.js 渲染和完整文件传输代码，本轮无法验收这些产品能力。

## 风险、候选方案与推荐

当前 russh 依赖链包含 ssh-key/rsa 的预发布版本。已执行 cargo-audit 0.22.2，命中 `rsa 0.10.0-rc.18 / RUSTSEC-2023-0071`，当前无修复版本。
外部探针 key 模式已禁止 RSA 私钥签名；RSA 兼容测试只使用本机生成的临时测试密钥。Ed25519 与 Agent 是外部探针候选入口，Agent 仍待实测。
审计保持非零退出，不增加 ignore，不把协议测试通过等同于密码学安全通过。实际生产桌面依赖图不含 RSA/SSH；详细决策与其他上游警告见 [ADR 0001](decisions/0001-ssh-crypto-gate.md)。

| 方案                                 | 安全与兼容                                                                 | 性能与维护                                                      |
| ------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| russh + russh-sftp（推荐继续验证）   | 应用完全负责信任与认证；原生多 Channel；需确认算法、预发布依赖及 SFTP 行为 | Tokio 原生，适合明确所有权和背压；跟进 API 变更                 |
| ssh2/libssh2（必要时的备选，未验证） | 成熟 C 库路径，但不能跳过 known_hosts/算法验证；增加原生依赖               | 需要阻塞隔离或非阻塞适配，跨平台分发更复杂                      |
| 调用系统 OpenSSH（备选，未验证）     | 沿用系统行为，但认证交互、Agent、known_hosts 配置必须可控                  | 子进程/PTY 跨平台差异；Transport/Channel 复用与 SFTP 集成更复杂 |

推荐：保留候选与隔离探针，先用授权真实 Linux 完成矩阵和依赖审计，再提取 security/ssh/sftp crate。
若出现核心不兼容，再记录 ADR 决定固定其他 russh 版本或替换库；**无需修改 PRD 或扩大产品范围**。
