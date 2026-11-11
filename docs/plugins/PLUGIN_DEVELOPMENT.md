# 插件开发与安装

## 独立开发

在「设置 → 插件」点击「下载插件开发包」，保存 ZIP 后解压。只需 Node.js 22.13+、稳定 Rust 1.94+、Cargo/rustup；不需要宿主源码或 Tauri。首次准备需要下载公开依赖，构建盘至少10 GiB空闲。

```sh
rustup target add wasm32-unknown-unknown
npm ci
cargo fetch --manifest-path example/backend/Cargo.toml --target wasm32-unknown-unknown --locked
npm run typecheck
npm test
npm run package
```

输出 `example.sdplugin`。在界面上传，审核本地开发包身份，启用并授予声明权限。样例含无需主机的问候设置页，以及从主机工作区打开的真实 `free -b` 内存巡检页；后者的命令、解析和低内存判断都在插件内。首次远程动作需确认真实 SSH 目标与命令。

修改样例的 manifest id/name/author 和自己的业务后，使用相同工具打包。更新包提高 version，输出到新文件名，经过升级与重新授权。SDK 主版本为5，只使用下载包公开源码，不引用宿主私有目录或其他插件。

## 完整目录

```text
<plugin>/
  manifest.json            # schema1, apiVersion ^5.4.0
  ui.json                  # UI4、frontend入口、页面与动作声明
  frontend/main.ts         # mountPlugin(App)
  frontend/App.vue         # 业务页面/类型/样式/测试
  backend/Cargo.toml       # 独立[workspace]、cdylib
  backend/Cargo.lock
  backend/src/lib.rs       # async SDK Runtime、插件自己的业务
```

后端仅依赖公开 `serverdeck-plugin-sdk` 和可编译为 wasm32-unknown-unknown 的普通库。下载包样例相对 SDK 路径是 `../../crates/plugin-sdk`；源码仓库系统插件是 `../../../../crates/plugin-sdk`。前端从 `@serverdeck/plugin-sdk` 或其公开子路径导入；编译器拒绝宿主/Tauri/越界源码依赖。不要复制私有 SSH 池、凭据库或修改宿主注册表。

## 内置插件自动发现

在 `plugins/system/<小写目录名>/` 新增上述完整目录，ID唯一。运行 `npm run plugins:build` 或正常桌面构建；工具扫描目录、独立编译 WASM/Vue、生成 `.sdplugin` 及嵌入注册表，Rust构建同样读取发现结果。无需修改 Cargo workspace、构建脚本、注册数组或宿主页面。

`plugins/system/packages` 是生成产物。系统来源仅影响发行及预置授权策略，执行契约与上传包相同。新增完整目录后需重新构建客户端；不是运行中的桌面自动监听源码热安装。

## 完成标准

业务命令/SQL/规则/提示词/DTO都在插件；SDK及宿主只有通用原语。用例至少覆盖参数拒绝、真实失败/截断、取消、健康规则和页面错误状态；涉及写入保留确认、冲突与结果复查。执行 `npm run typecheck`、`npm test`、独立 Rust 单测及 `npm run package`，再在隔离数据目录上传验证。远端 fixture、模型模拟响应与真实服务验证分开记录，不冒称真实账号/所有系统通过。

Rust原生单测复用根 `target/`，编译后复制EXE到QA目录运行；WASM缓存为 `.local/plugin-build/<plugin>`。首次Cargo依赖使用fetch，正式打包用locked/offline，失败不能改锁绕过。更多契约见[SDK](PLUGIN_SDK.md)、[UI](PLUGIN_UI_EXTENSION.md)和[包格式](PLUGIN_PACKAGE_FORMAT.md)。

上传后安装位置是**应用数据目录**，不是开发源码目录：`plugins/upload/<ID>/versions/<revision>/`，统一记录在 `plugins/packages/<ID>/record.json`；插件配置在 `plugins/data/<ID>/`，授权在 `plugins/authorizations/`。系统包位于同级 `plugins/system/<ID>/versions/<revision>/`。实际应用数据根由平台目录配置决定。
