# 公开 SDK 诊断插件

## 用途

本目录是开发验证夹具，保留用于协议、权限、生命周期或 UI 回归；不随产品预装，也不放在业务上传插件目录。

backend 是独立 Cargo 项目，只引用公开 `serverdeck-plugin-sdk`。用户授权当前主机的 hosts.read、ssh.execute（ssh.read_only 操作）后，diagnose 先读取基本主机信息，再通过既有 SSH 运维租约执行真实 `uname -a`。没有 mock 正式功能，也不引用内部 IPC 或私有 crate。

在仓库根目录执行：

```powershell
rustup target add wasm32-unknown-unknown
cargo build --manifest-path tests/fixtures/plugins/diagnostics/backend/Cargo.toml --target wasm32-unknown-unknown --release --locked --target-dir .local/plugin-13a/sdk-guest
New-Item -ItemType Directory -Path .local/plugin-13a/diagnostics -Force
Copy-Item tests/fixtures/plugins/diagnostics/manifest.json .local/plugin-13a/diagnostics/manifest.json
Copy-Item .local/plugin-13a/sdk-guest/wasm32-unknown-unknown/release/serverdeck_diagnostics_example.wasm .local/plugin-13a/diagnostics/backend.wasm
node tools/package-plugin.mjs .local/plugin-13a/diagnostics .local/plugin-13a/diagnostics.sdplugin
```

主窗口 IPC 顺序：preview → install（明确开发模式）→ grant（绑定安装 revision、主机 ID 和操作范围）→ set_enabled → context（现有已验证租约）→ call `{action:"diagnose"}`。权限/单次审批与主窗口 IPC 仅供 Host 管理，Guest 只使用 SDK 消息。完整管理界面在 13A-4 提供。

真实隔离 Linux 验证：先构建 `tools/plugin-test-host/Dockerfile`，再运行 `tools/plugin-test-host/test.ps1`（当前环境为 Windows + WSL Ubuntu-24.04 + Docker）。脚本创建随机命名/标记、有限内存/CPU/PID、无宿主挂载、仅回环端口的测试容器。随机密码仅经 stdin/子进程环境传递，验证主机公钥；临时 OS 凭据和容器在结束时清理。不得将脚本目标改为用户生产容器。

测试同时覆盖公共 SDK 的 SSH/SFTP、编辑冲突/未保存保护、路径越权、日志/任务、确认单次使用、超时/输出上限、并发与取消。它是真实 Ubuntu/OpenSSH 集成，不是 Rust 协议响应夹具；并不代表所有发行版或桌面平台已验收。
