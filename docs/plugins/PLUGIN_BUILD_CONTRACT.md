# 插件源码与构建契约

本页定义源码布局、依赖、构建产物和安装数据边界，随公开 SDK 及独立开发包分发。业务与平台职责见[插件架构](PLUGIN_ARCHITECTURE.md)，当前协议版本见[版本约定](PLUGIN_API_VERSIONING.md)，接口见[公开 SDK](PLUGIN_SDK.md)。入门、操作步骤和开发教程统一由[官网开发者中心](https://ops.hiboot.cn/developers/)维护。

## 构建环境与依赖

独立开发包面向 Node.js 22.13+、稳定 Rust 1.94+、Cargo/rustup 和 `wasm32-unknown-unknown`，不依赖宿主源码或 Tauri。构建盘至少 10 GiB 空闲；使用包内锁文件，首次或锁文件变化后准备完整公开依赖。

正式构建使用 locked/offline，不通过改锁绕过缺失依赖。`cargo fetch --locked` 不限定 `--target`，因为离线解析仍可能读取其他目标的依赖清单。SDK、锁文件、示例及公开契约须匹配；插件业务版本与 SDK 版本分别管理，安装修订和授权失效规则见[版本约定](PLUGIN_API_VERSIONING.md)。

## 源码布局

```text
<plugin>/
  manifest.json            # schema1，apiVersion 覆盖实际使用的能力
  ui.json                  # UI4、frontend入口、页面与动作声明
  frontend/main.ts         # mountPlugin(App)
  frontend/App.vue         # 业务页面/类型/样式/测试
  backend/Cargo.toml       # 独立[workspace]、cdylib
  backend/Cargo.lock
  backend/src/lib.rs       # async SDK Runtime、插件自己的业务
```

后端仅依赖公开 `serverdeck-plugin-sdk` 和可编译为 wasm32-unknown-unknown 的普通库。下载包样例相对 SDK 路径是 `../../crates/plugin-sdk`；源码仓库系统插件是 `../../../../crates/plugin-sdk`。前端从 `@serverdeck/plugin-sdk` 或其公开子路径导入；编译器拒绝宿主/Tauri/越界源码依赖。不要复制私有 SSH 池、凭据库或修改宿主注册表。

## 构建产物与内置发现

打包产物是[标准 `.sdplugin`](PLUGIN_PACKAGE_FORMAT.md)，包含清单、WASM、UI 声明及单文件前端资源；输出文件必须不存在，最终权威校验由 Rust 完成。独立开发包的样例生成 `example.sdplugin`，包含问候设置页和主机内存巡检页；业务命令、解析和规则均在插件内。

宿主源码的 `plugins/system/<小写目录名>/` 使用相同布局和唯一 ID。桌面构建工具扫描完整目录，独立编译 WASM/Vue、生成 `.sdplugin` 及嵌入注册表，Rust 构建读取同一发现结果；无需修改 Cargo workspace、构建脚本、注册数组或宿主页面。仓库构建命令由研发指南维护。

`plugins/system/packages` 是生成产物。系统来源仅影响发行及预置授权策略，执行契约与上传包相同。新增完整目录后需重新构建客户端；不是运行中的桌面自动监听源码热安装。

## 验证与资源边界

业务命令、SQL、规则、提示词和 DTO 均由插件维护，SDK 及宿主只提供通用原语。交付检查覆盖类型、前端与 Rust 测试、标准包构建和隔离安装，至少验证参数拒绝、真实失败/截断、取消、健康规则及页面错误状态；写入保留确认、冲突与结果复查。远端 fixture、模型模拟响应与真实服务验证分别判断，不据此宣称真实账号或所有系统通过。

宿主仓库原生单测复用根 `target/`，Windows 测试 EXE 复制到 QA 目录运行；独立开发包使用自己的共享原生测试目录。WASM 缓存为 `.local/plugin-build/<plugin>`。更多契约见[UI](PLUGIN_UI_EXTENSION.md)、[运行时](PLUGIN_RUNTIME.md)、[安全边界](PLUGIN_SECURITY.md)和[包格式](PLUGIN_PACKAGE_FORMAT.md)。

## 安装数据边界

上传后安装位置是**应用数据目录**，不是开发源码目录：`plugins/upload/<ID>/versions/<revision>/`，统一记录在 `plugins/packages/<ID>/record.json`；插件配置在 `plugins/data/<ID>/`，授权在 `plugins/authorizations/`。系统包位于同级 `plugins/system/<ID>/versions/<revision>/`。实际应用数据根由平台目录配置决定。
