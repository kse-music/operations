# Docker 管理

独立 UI v4 标准插件包。界面、交互业务与前端测试在 `frontend/`，WASM 能力策略与 Rust 测试在 `backend/`；分别只引用公开 `@serverdeck/plugin-sdk` 和 `serverdeck-plugin-sdk`，普通 Vue/测试依赖按工作区管理。宿主通过相同沙箱、SDK、WASM 和授权机制加载内置与上传包。

验证：`npm run test -w @serverdeck/desktop -- ../../plugins/system/docker/frontend`；`cargo test --manifest-path plugins/system/docker/backend/Cargo.toml --target-dir .local/plugin-unit-tests --offline --locked`。构建会同时打包 WASM、UI 声明和独立 JS/CSS，完整契约见 [开发指南](../../../docs/plugins/PLUGIN_DEVELOPMENT.md)。

构建：`node tools/build-plugin.mjs plugins/system/docker OUTPUT.sdplugin`。

该包可像用户上传的插件一样安装、授权、启停、升级及卸载；系统来源只由应用的首次分发记录设置。
