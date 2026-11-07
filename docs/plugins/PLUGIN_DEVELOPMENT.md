# 插件开发与本地安装

## 下载独立开发包

在「插件 → 插件管理」点击「下载插件开发包」，选择 ZIP 的保存位置，解压后阅读根目录的 `README.md`。ZIP 随客户端提供配套 SDK、接口文档和独立样例。准备 Node.js、Rust 及 WASM 目标后，按快速入门安装依赖、修改样例并运行 `npm run package`。把生成的 `example.sdplugin` 拖到插件管理页，安装、授权并启用后，从插件卡片打开样例配置页。下文命令适用于从 ServerDeck 源码仓库开发。

## 当前推荐：完整插件目录与 UI v4

两个系统插件和上传插件采用同一源码/包结构：

```text
plugins/system/<name>/       # 上传源码可放任意显式目录
  manifest.json              # apiVersion ^4.0.0
  ui.json                    # uiVersion 4 + frontend 入口
  frontend/
    main.ts                  # SDK mountPlugin
    App.vue / 业务组件及样式
    *.test.ts                # 该插件的界面/编排回归
  backend/
    Cargo.toml / Cargo.lock  # 独立 workspace，只依赖公开 Rust SDK
    src/lib.rs               # 自身 WASM 业务/能力策略及 Rust 测试
```

公共前端类型、客户端、Store、基础 UI 和主题在 `packages/plugin-sdk`；前端导入 `@serverdeck/plugin-sdk/...`，禁止引用 `apps/desktop`、其他插件或 Tauri。共享基础优先提入 SDK，避免插件互相引用业务实现。完整新业务示例是 `tests/fixtures/plugins/custom-ui`，不需要在宿主新增页面/工具分支。旧 v2/v3 兼容源码单独放在 `plugins/compat`，不作为新插件开发模板。

```powershell
npm run typecheck
npm test
cargo test --manifest-path plugins/system/docker/backend/Cargo.toml --target-dir target --offline --locked
node tools/build-plugin.mjs plugins/system/docker .local/docker-v4.sdplugin
npm run plugins:build
node tools/plugin-ui-isolation-e2e.mjs
```

单包构建同时编译独立 WASM 与 Vue 前端，并检查源码边界，打成 backend.wasm/ui.json/frontend.js/frontend.css。运行时使用 sandbox iframe，不访问宿主 DOM；仅使用 SDK 已公开服务和自身声明动作。UI资源必须单文件，不可远程加载或任意读取本地文件。打包输出仍需不存在且在源目录之外。原生 QA 使用全新目录和自己的 HTTP/TCP 夹具，不能代替真实 SSH 或其他平台验收。

版本为 Host API / Rust SDK / Vue SDK 4.0.0。以下旧 v1/v2/v3 开发说明继续用于兼容包；旧版本/“只包含三文件”以本节 UI4 流程为准。自动运维、批量运维及依赖已删除权限的旧安装记录会停用归档，保留用户数据；其余已有上传安装不自动升级或重置；用户主动升级沿用原确认/备份/重新授权机制。

## 配置插件图标

在 `manifest.json` 中添加 `"icon": "rocket"`（或 `bot`、`database` 等支持的图标名），并声明 `"apiVersion": "^4.0.0"`。按原流程打包、预览及安装后，上传插件即可显示自己选定的图标；不填写使用默认 `boxes`。完整名称列表、旧版兼容及校验规则见[包格式中的图标配置](PLUGIN_PACKAGE_FORMAT.md#可选插件图标host-api-130)。无需增加权限、文件或前端代码。

## 工作区工具插件

AI 助手独立，系统服务保留监控、进程端口、systemd 与日志；两者只依赖公开 SDK；例如 `node tools/build-plugin.mjs plugins/system/assistant .local/assistant.sdplugin`。公开 UI v3 和工具能力对上传包同样开放，完整契约、权限及宿主职责见 [内置插件](BUILTIN_PLUGINS.md)。仓库 plugins/upload 不预置插件，旧 Nginx 测试插件已删除；四个协议测试包源码位于 tests/fixtures/plugins，构建这些夹具必须传显式目录。

两个内置系统插件也是独立标准 WASM 包，源码位于 plugins/system，使用本文相同的构建/安装/授权流程。公开服务器能力和 UI v2 对上传包同样开放；来源由宿主记录，见 [BUILTIN_PLUGINS.md](BUILTIN_PLUGINS.md)。

平台 SDK 4.0.0，API wire version=1（兼容不使用已移除能力的 ^1.x/^2.x/^3.x 包）；包 formatVersion=1、manifest schemaVersion=1，UI 支持 v1 表单、v2 标准服务器视图和 v3 工作区工具。当前只支持显式确认的未签名本地开发包，不存在在线市场或可信官方签名发行流程。官方示例代码也显示来源未验证。

## 构建公开 SDK 示例

需要稳定 Rust、`wasm32-unknown-unknown` 目标、Node 22+；按环境先安装目标与获取锁定依赖。示例是独立 Cargo workspace，只依赖公开 `serverdeck-plugin-sdk` 与其公开 serde 类型，不依赖 application/core/Tauri 内部 IPC。

```powershell
rustup target add wasm32-unknown-unknown
node tools/build-plugin.mjs tests/fixtures/plugins/host-info .local/host-info.sdplugin
node tools/build-plugin.mjs plugins/system/docker .local/docker.sdplugin
npm run plugins:build
```

打包输出必须不存在且位于源目录外。构建脚本使用 --offline --locked；新环境先通过 Cargo 正常获取示例 Cargo.lock 对应依赖。`.local/plugin-build` 保存独立 WASM 构建缓存及临时打包输入，不进入产品目录。打包工具只包含 manifest、backend.wasm、ui.json；摘要由工具生成，安装端重新验证。

Host Info 演示主机脱敏信息、只读 uname、独立设置和五种贡献点。早期 hello-world 是生命周期测试，diagnostics 是公开 SDK 能力集成测试，不冒充实际业务。自定义插件参考其 manifest/backend/ui 文件及 [PLUGIN_SDK.md](PLUGIN_SDK.md)、[PLUGIN_UI_EXTENSION.md](PLUGIN_UI_EXTENSION.md)。

## 桌面安装流程

“插件 → 插件管理” → 点击“安装插件”选择一个 .sdplugin 文件 → 弹窗核对身份/权限/摘要 → 明确接受未验证包 → 安装。没有手工路径输入；默认禁用且未授权。Rust 重新验证普通文件、包大小、摘要和预览绑定。

顶部不再提供运维工具模块或插件侧栏。单主机功能从主机工具进入当前主机工作区，无上下文的快捷功能入口仍由宿主统一选择一次。主机 SSH/SFTP 右侧平铺显示具有功能页面的启用插件按钮，不再显示主机选择器。未授权/未启用功能显示状态及设置入口；全部安装身份及其详情、来源、启停、权限、目录范围和包声明的 settings 页面集中在“设置 → 插件管理”，禁用、未授权或无功能页面的包也保留在管理列表。功能页“插件设置”打开同一配置标签，始终归属设置并选中插件管理。主机工作区、全局功能和设置之间切换保留功能草稿，不自动执行。管理列表提供安装、升级、详情入口和卸载。语言沿用全局偏好，公开贡献协议不变。

全部插件无需选择允许访问的主机，启用并具备对应能力后适用于所有已登记主机，单主机工具由宿主传入入口主机并建立/复用连接，批量和自动化在执行表单明确选择多目标。上传插件仍在自己的设置页授予清单内权限、具体操作和规范远程目录；内置系统分发包的声明权限、操作和所需目录由系统预置且不可修改，已有禁用选择保留。SSH 其他命令、文件写入及系统修改仍逐次确认，首次连接核验主机指纹；上传包不要为方便测试授予 `/` 写入范围。详见 [内置插件](BUILTIN_PLUGINS.md)。

安装更高版本时提示旧版本并保留备份，全部授权失效，升级后需重新授权并启用。包变化/非法版本拒绝且保留已安装代。禁用、撤权会停止调用/流；卸载默认保留本地设置，另有明确清理选择；均不会删除远程服务器配置或日志。

升级会先明确确认停止插件资源和放弃未保存内容；取消保持编辑不变。提交失败恢复旧安装代/授权和能力门控，旧页面重新打开后绑定连接；不会恢复已被明确放弃的草稿或后台任务。错误通过现有通知显示，不用旧版本元数据伪装升级成功。

## 开发契约与验证

WASM ABI、受控 API、取消/配额/错误码见 [PLUGIN_RUNTIME.md](PLUGIN_RUNTIME.md)、[PLUGIN_SDK.md](PLUGIN_SDK.md)。业务操作逐次使用真实 Host 响应；非零退出、权限拒绝、取消、超时、断线、冲突必须保留原因，不得伪装通过。内部 Host 响应只通过保留 Resume 操作返回，普通 UI payload 不能伪造。

Windows 本地自动化：`cargo test --workspace`、前端 test/typecheck/build/lint；隔离 Linux SDK 验证使用 `tools/plugin-test-host/test.ps1`。真实桌面 UI 使用 `-Mode ui`，会构建任务专用 Tauri 客户端、创建全新独立数据目录及无宿主挂载的临时容器，测试结束清理其 OS 凭据与容器，不读取用户主机配置。Docker 镜像准备、环境调整、真实执行结果与平台范围见 [PLUGIN_TEST_REPORT.md](../validation/plugins/PLUGIN_TEST_REPORT.md)。用户服务器不作为开发测试目标。

仓库 plugins/upload 与客户端安装仓库是不同位置，前者不被启动扫描或自动注册。Windows 普通配置的上传内容位于 `%APPDATA%/cn.hiboot.desktop/plugins/upload/<ID>/versions`，安装记录位于同一 plugins 根目录的 packages/<ID>/record.json。安装成功后设置中的插件管理立即显示插件，禁用或未授权不会隐藏安装身份；启用且有功能页面时才显示在当前主机工具栏。旧路径自动迁移且授权/配置保持不变。内置源码/内容分别位于项目 plugins/system 和应用数据目录 plugins/system，协议测试夹具位于 tests/fixtures/plugins，完整迁移边界见 [BUILTIN_PLUGINS.md](BUILTIN_PLUGINS.md)。
