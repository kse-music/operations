# SSH 与交互式终端验收

2026-11-01。当前环境 Windows x64、Rust 1.97.1、Tauri 2、Vue 3/TypeScript、russh 0.65.0、xterm.js 6.0.0。仓库没有 Git 元数据，未初始化 Git、未提交；原有 PRD 和业务数据保留。

## 实现和修改文件

- Cargo.toml / Cargo.lock：新增生产 serverdeck-ssh 与锁定依赖。
- crates/ssh：Transport/Session 注册表、TCP/握手、主机验证挑战、密码/私钥/加密私钥/系统 Agent、PTY、输入、resize、流式 ACK、超时、取消、断线、重连及资源释放；tests/engine.rs、tests/live.rs 和 Agent 单测。
- crates/core/src/terminal.rs、lib.rs：终端 DTO、安全错误、数据库版本 3。
- crates/storage：003_known_hosts.sql、trust.rs；主机读取、不可覆盖信任记录及迁移测试。
- crates/application：terminal.rs、lib.rs、logging.rs、Cargo.toml；后端凭据读取、SSH 用例及退出清理，日志只记录安全错误码。
- apps/desktop/src-tauri：commands.rs、lib.rs、build.rs、capabilities/main.json、生成的 terminal 权限 TOML、tests/ipc.rs；7 个显式终端 IPC。
- apps/desktop/src：TerminalPane.vue、TerminalsView.vue、services/terminal.ts、stores/terminals.ts、types/terminal.ts、terminal.css 及测试；App/main/HostsView/HostSidebar 接入连接入口和真实会话状态，WorkspaceView/SettingsPanel 同步功能提示。
- package.json、package-lock.json、apps/desktop/package.json：xterm/fit/search 与原生终端测试入口。
- README.md：当前功能、连接操作与安全限制。
- tools/native-terminal-e2e.mjs：隔离 WebView2/SQLite/OS 凭据库的真实 Linux 端到端流程。
- ARCHITECTURE.md、IMPLEMENTATION_PLAN.md、DECISIONS.md、decisions/0001-ssh-crypto-gate.md、SSH_TECH_VALIDATION.md、本文件：同步实际状态和发布门禁。

## 安全边界

测试地址由用户授权，Ed25519 SHA256 指纹经用户带外核对后确认。密码仅通过无回显控制台/进程环境进入测试，在 Rust 使用 Zeroizing；原生测试用系统凭据库存储临时秘密，结束经后端删除主机及凭据。没有把真实密码/私钥口令放进测试源码、参数、SQLite、JSON 或日志。没有修改远端认证配置、安装软件或写入持久文件；vim 使用 -n/-i NONE，job-control 测试只清理该测试 Shell 创建的进程。

系统安全存储不可用时不降级。主机变化不能从普通连接 UI 覆盖；不支持证书/CA、keyboard-interactive/MFA、ProxyJump/ProxyCommand、agent forwarding、PuTTY PPK、自动重连或旧 Shell 恢复。RSA 私钥本地签名受安全门禁拒绝。终端输出和输入不进入应用日志，测试截图保存在忽略的 .local 下。

## 自动化验证

生产引擎回环测试使用随机主机/用户密钥、真实 TCP、握手和签名，不是模拟终端；服务端 fixture 只验证协议，不运行本地 Shell。真实 Linux 与原生桌面测试另外证明 POSIX 交互能力。

覆盖：未知密钥确认前认证次数为零、拒绝/接受、变化密钥阻断、错误密码、普通/加密 Ed25519/错口令、隔离 Windows named-pipe Agent 身份列表与实际签名认证、PTY 尺寸、同机独立 Channel、多主机同时连接、关闭主机范围、握手超时、TCP 拒绝、硬断 TCP、正常退出、取消确认、重连、未 ACK 不继续发送、2MiB 输出完整及注册表资源归零。v1/v2→v3 迁移和原有主机/凭据安全测试保留。

前端验证流式 IPC、二进制输入、ACK、拒绝路径、单标签关闭目标、失败保留标签、32 标签上限；加入 xterm 6 resize 隐藏字段的回归断言，防止严格 Rust DTO 拒绝合法尺寸更新。

可重复运行：

```powershell
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
node tools/tauri.mjs build --debug --no-bundle
```

真实 Linux 测试需要 SERVERDECK_TEST_HOST、SERVERDECK_TEST_USER、SERVERDECK_TEST_PIN（带外核对），密码可从无回显提示读取：

```powershell
cargo test -p serverdeck-ssh --test live -- --ignored --nocapture
```

`npm run test:terminal` 还需用本地安全启动器把密码放进本次进程的 SERVERDECK_TEST_PASSWORD；不要把密码写进脚本/命令行/环境文件。工具重新构建一个独立 identifier 的测试 EXE，检查 bootstrap 数据目录再操作，完成后恢复普通 Debug 产物并删除测试凭据。CDP 只在测试进程的 loopback 启用。应用正常构建不启用 CDP。

## 实际结果与限制

真实 Ubuntu 24.04.4 / OpenSSH 9.6p1：Linux Shell、密码、用户确认的指纹、stty 100×30→110×42、双 Shell、关闭一个保留另一个、vim、top、Ctrl+C、2MiB 输出、正常退出和新 Shell 重连通过。完整原生 WebView2 流程已通过首次信任、双标签、vim 中文输入、top、Ctrl+C、查找、2MiB 和重连。测试截图已人工检查，未使用演示数据或替代终端。

最终常规检查：Rust workspace **38 项通过**（2 个需要实际环境的用例默认 ignored，真实 Linux 用例另行显式执行通过）；前端 **11 项通过**；Clippy -D warnings、ESLint 零警告、vue-tsc、Rustfmt/Prettier、Vite 生产构建和 Tauri Debug 嵌入资源构建均通过。原生扩展流程 **11 项通过**，包括 Ctrl+Z、less 翻页和 htop。目标未安装 htop，通过已配置的 Ubuntu apt 源下载并在 `/tmp/serverdeck-htop.<随机值>` 解包运行，trap 清理已核对的私有临时路径，没有安装系统软件或修改软件源。保留的 20 会话与平台矩阵未冒充通过。

原生最新证据位于 `.local/terminal-e2e/1793528920322-af9c931a-32b3-4a42-aa59-4c53b356028b`；包含 result.json、terminal.png 和 last-state.png。首次信任、多标签、vim、top、less、Ctrl+C/Z、大量输出和重连均来自真实桌面应用。测试密码没有写入这些产物。

尚未完成：真实系统 Agent 服务的用户身份（当前机器无可用服务）、真实 OpenSSH 私钥认证矩阵（已有真实协议签名测试）、ECDSA/硬件令牌/证书矩阵、macOS/Linux 客户端构建、其他 Linux 发行版、20 会话/长时间重协商/内存和吞吐基准、系统 known_hosts 互操作、完整鼠标协议和系统剪贴板自动化矩阵。远端 MaxSessions 可低于应用 32 个标签上限；拒绝会明确失败。丢失 ACK 会背压等待，可随时取消，不无限积累 WebView 数据。SFTP/Docker/监控均未开发。

依赖审计仍命中 rsa 0.10.0-rc.18 / RUSTSEC-2023-0071，无 ignore，cargo-audit 保持退出 1；生产本地 RSA 签名明确阻止，不把功能测试通过表述为审计全绿。npm 生产依赖审计 0 漏洞。Rust 增量缓存硬链接在本机文件系统失败时退化为复制，属于构建环境警告，未修改用户工具链配置。
