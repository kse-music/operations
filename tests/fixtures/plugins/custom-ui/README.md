# 自定义 UI 隔离夹具

只依赖公开 Rust/前端 SDK，不声明任何固定 tool/server 类型。界面布局与 WASM 业务均由本包提供。

`node tools/build-plugin.mjs tests/fixtures/plugins/custom-ui .local/custom-ui.sdplugin`

`node tools/plugin-ui-isolation-e2e.mjs` 在独立 QA 配置中验证安装、显式授权、包内界面与真实 WASM 调用；不连接远程服务器。
