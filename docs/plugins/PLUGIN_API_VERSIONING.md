# 插件 API 版本策略

## 3.0.0：移除网络诊断

Host API、Rust SDK 和 Vue SDK 升至 3.0.0，三个系统包升至 1.3.0。删除 network.run、tools::Tool::Network、DiagnosticStart/List/Cancel、网络诊断 UI 分类/兼容页面以及原生 diagnostic_* IPC；前端不再导出 services/tasks、types/tasks 或 PluginToolIntent。通用导出使用 services/download；AI、SSH/SFTP、监控网络流量与端口能力保留，ABI/wire/包格式仍为 1。未使用移除契约的 ^1.x/^2.x 包继续使用。

启动时只对已知系统服务记录归档原始元数据、收窄旧权限，再以标准包升级保留启停/配置/卸载选择；升级完成前不开放运行时。旧诊断上传包退出注册并保留记录、payload 和用户数据，不能通过旧包恢复能力；旧备份记录中的已删除能力不再反序列化为活动安装。新包及旧 IPC 请求均拒绝已删除契约。以下为历史版本说明。

## 2.1.0：UI v4 组合分类与缓存可见性

Host API、Rust SDK、Vue SDK 为 2.1.0，三个系统包 services/docker/assistant 为 1.2.0。UI v4 operations.sections 新增 overview/disks/network/diagnostics，允许一个标准 server 贡献组合公开能力；UI v2/v3 类别保持原限制。没有新原生 IPC 或权限，后台仍按 Guest 白名单、grant、上下文和单次审批复验。SDK 新增 usePluginVisibility，组合页面文档和 KeepAlive 激活状态。

保留网络 ToolInvoke/旧 monitor/tool UI 协议及兼容资源；旧 ^2.0 与未使用已删除能力的 ^1.x 包继续兼容。旧四项 system 记录归档、用户数据与上传来源保留，services 沿用自己的配置和启停。ABI/wire 与包/manifest 格式仍为 1。下文记录各历史版本。

## 2.0.0：移除自动运维和批量运维

Host API、Rust SDK 和 TypeScript/Vue SDK 均为 2.0.0。删除 batch.run、automation.manage、tasks.create 及其对应操作、Tool 枚举、DTO 和 IPC；系统包 1.1.3 声明 ^2.0.0。WASM ABI、wire、Manifest/包格式仍为 1，UI v4 不变。

Host 同时协商当前 2.0 与保留能力的 1.4 范围；仅使用保留接口的旧 v1 包、UI v1–v3 和上传权限逻辑继续兼容。声明已移除权限的旧安装先转为非活动历史，新包请求未知/已移除权限或操作直接拒绝。较新的不支持范围仍拒绝，测试继续验证主版本边界。下文版本条目记录其发布时状态。

## 1.4.0：包内前端与公共 Vue SDK

Host API 1.4.0、Rust SDK 1.3.0 新增 UI v4 的 frontend 入口及通用 frontend surface；新包声明 `apiVersion: "^1.4.0"`，避免旧 Host 严格字段检查失败。TypeScript/Vue SDK `@serverdeck/plugin-sdk` 独立版本为 1.0.0。SDK 实现统一有界桥，既有 Capability/WASM ABI/wire、manifest schemaVersion 和包 formatVersion 仍为 1，旧 SDK 1.0–1.2 的能力和 UI v1–v3 继续兼容。

九个分发包版本为 1.1.0。预置逻辑保留已有安装，不强制升级、重写摘要或继承新的授权；新安装使用 UI v4，旧 v2/v3 由兼容资源渲染。用户主动安装更高版本仍遵循标准升级确认、备份、重新授权规则。以下各版本条目描述其发布时状态，当前 Host/SDK 版本以上述为准。

## 1.3.0：插件清单图标

Host API 升至 1.3.0，manifest 增加可选 icon 图标名。旧清单省略字段仍可读取，None 序列化时不增加字段；使用图标的新包声明 ^1.3.0，旧 Host 对未知字段的严格拒绝保持。SDK crate 仍为 1.2.0，包 formatVersion/schemaVersion、WASM ABI、消息版本和 UI 版本不变。不增加权限、资源加载或动态代码能力。支持名称及默认回退见[包格式](PLUGIN_PACKAGE_FORMAT.md#可选插件图标host-api-130)。

## 1.2.0：工作区工具

API/SDK 1.2.0 在主版本 1 内新增四个封闭权限及 ToolInvoke，UI v3 增加 tool 贡献与工具类型枚举。新工具包要求 ^1.2.0；UI v1/v2、SDK 1.0/1.1 旧能力继续可用，ABI/消息/Capture Request 版本仍为 1。新能力不接受任意 IPC 或 Guest 确认字段。AI、网络、批量和自动化工具走公开标准能力；模型管理/凭据/任务中心保留为宿主基础能力。旧文末“AI API 不属于此版本”的限制仅适用于历史 1.0。

- 包 formatVersion=1、manifest schemaVersion=1 是独立严格格式；未知版本拒绝。manifest apiVersion 为 SemVer 范围，当前 Host API 为 1.3.0。
- WASM ABI sd_api_version 必须为 1，生命周期消息 protocolVersion=1；Host Capability Request.apiVersion=1。版本不兼容在执行能力前拒绝。
- SDK crate 独立版本为 1.2.0，只依赖公开 serde 协议，不依赖私有 Host crate。Rust 与 TS DTO 同步，并通过真实 IPC/独立 WASM 编译与 Linux SSH/SFTP 测试校验。
- 13A-3 增加仅 Host 可发出的 resume（操作码 7）；普通 UI 不能选择该入口。旧 hello-world 的无能力 invoke 行为保留，不强制转成业务插件。
- 增加可选能力/扩展点应在兼容主版本内明确协商；严格 DTO 的新字段不能不加版本就假定旧 Host 会忽略。改变现有语义、必需字段或安全约束必须升级对应协议/主版本并保留迁移说明。
- 授权记录 version=1，绑定包摘要和安装代。升级不迁移权限，必须重新批准，包括新增权限；用户数据/设置可保留，但不作为授权证据。单次高风险批准不跨上下文、版本或升级复用。

13A-4 已交付声明式 UI uiVersion=1（SDK ui 模块），只接受 JSON。早期阶段的 .html 元数据不代表已支持 Web UI，不执行脚本；新安装需要改为 ui.json。Host Info 使用公开 SDK 和 UI 协议；当时用于验收的 Nginx 测试插件现已删除。Agent、AI API、在线市场和跨机器分发不属于此版本兼容性承诺。
