# ServerDeck 插件开发包

本开发包随 ServerDeck 分发。样例使用 Host API 4.0 和 UI v4，包含独立的 Vue 页面和 Rust WASM 动作。解压到任意工作目录即可开始，无需下载 ServerDeck 源码或安装 Tauri 开发工具。

## 从解压到安装

1. 准备 Node.js 22.13+ 和 Rust 1.94+（含 rustup 与 Cargo）。首次构建需要从 npm 和 crates.io 获取锁定的依赖，构建盘需要至少 10 GiB 可用空间。
2. 在解压目录运行以下命令准备依赖。

   ```sh
   rustup target add wasm32-unknown-unknown
   npm ci
   cargo fetch --manifest-path example/backend/Cargo.toml --target wasm32-unknown-unknown --locked
   ```

3. 修改 `example/manifest.json` 的 `id`、`name` 和 `author`。在 `example/frontend/App.vue` 修改页面标题，在 `example/backend/src/lib.rs` 修改问候词。保留贡献 ID 与 `example/ui.json` 中页面 ID 的对应关系。
4. 运行 `npm run package` 生成 `example.sdplugin`。再次打包前移动上次产物，或用 `node tools/build-plugin.mjs ./example ./另一个文件名.sdplugin` 指定新输出。
5. 在 ServerDeck 打开「插件 → 插件管理」，把 `.sdplugin` 拖到上传区或用「安装插件」选取。核对包信息，确认安装本地开发包。打开插件卡片，授予 `ui.contribute` 权限并启用。点击「插件配置」打开问候页，输入姓名并点「生成问候」，即可看到修改后的 WASM 返回值。该样例无需添加主机。

更新已安装的同一插件时，先提高 `manifest.json` 的 `version`，打包后走升级确认和重新授权流程。

## 接口和规范

- [SDK 接口](docs/plugins/PLUGIN_SDK.md)涵盖 Rust 能力、权限、前端服务和自身 WASM 动作。完整类型与导出在 `crates/plugin-sdk/src/` 和 `packages/plugin-sdk/src/`。
- [UI 扩展](docs/plugins/PLUGIN_UI_EXTENSION.md)包含贡献点、`ui.json` 和前端启动方式。
- [包格式](docs/plugins/PLUGIN_PACKAGE_FORMAT.md)包含清单字段、路径限制和摘要规则。
- [运行时与错误码](docs/plugins/PLUGIN_RUNTIME.md)、[权限和隔离](docs/plugins/PLUGIN_SECURITY.md)与[版本兼容](docs/plugins/PLUGIN_API_VERSIONING.md)说明宿主行为。

参考文档中的历史示例和验证记录引用 ServerDeck 源码仓库。独立构建命令以上面的快速入门为准。
