# Hello WASM

## 用途

本目录是开发验证夹具，保留用于协议、权限、生命周期或 UI 回归；不随产品预装，也不放在业务上传插件目录。

真实最小后端：WAT 编译成 WASM，激活返回固定诊断。没有服务器业务模拟，也不接触 SSH、网络或本地文件。

在仓库根目录执行（PowerShell，输出需不存在）：

```powershell
New-Item -ItemType Directory -Path .local/plugin-13a/hello -Force
Copy-Item tests/fixtures/plugins/hello-world/manifest.json .local/plugin-13a/hello/manifest.json
cargo run -p serverdeck-plugin-runtime --example compile_wat -- tests/fixtures/plugins/hello-world/backend.wat .local/plugin-13a/hello/backend.wasm
node tools/package-plugin.mjs .local/plugin-13a/hello .local/plugin-13a/hello.sdplugin
```

通过主窗口 plugin_preview / plugin_install（developmentConfirmed=true）安装后，plugin_set_enabled 会真实激活；plugin_health/plugin_call 返回 WASM 写入的结果，禁用和卸载释放实例。完整管理界面在 13A-4 提供。来源为本地开发且未验证，ServerDeck 作者字符串不是数字签名。
