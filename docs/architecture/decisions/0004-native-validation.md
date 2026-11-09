# ADR 0004：实际桌面 E2E 与数据隔离

整理状态：有效；工具和版本以当前实现为准，历史通过项只适用于原记录环境。

以下保留原决策正文和当时验证边界；当前接口及功能以[总体架构](../ARCHITECTURE.md)和[决策索引](../DECISIONS.md)为准。

日期：2026-11-01。

原生窗口截图工具未返回可用页面内容，增加 Playwright CDP 对实际 WebView2 的流程测试。无 IPC mock：点击/填写真实 Vue 页面，经权限边界调用 Rust、SQLite 和系统凭据库。
测试使用 Tauri 构建配置覆盖及不同 identifier，把数据库、日志和 WebView 数据放在 `.local/native-e2e/<随机目录>`；首次变更前通过实际 bootstrap 检查目录。测试 EXE 单独复制，根目录 Debug 产物恢复普通配置；debugging 只对该测试子进程开放 loopback 端口，正式配置不启用 CDP。
端到端测试在每次启动使用新随机端口并直连 WebSocket endpoint，避免旧 WebView 退出与调试端点启动竞争。重启验收通过终止自己创建的测试进程后重新启动来检查提交后的持久化，不将其描述为系统窗口关闭按钮验收。

依据：[Playwright WebView2](https://playwright.dev/dotnet/docs/webview2)、[Microsoft WebView2 flags](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags)。调试参数与测试目录只存在于测试工具生成的临时配置及进程环境。
