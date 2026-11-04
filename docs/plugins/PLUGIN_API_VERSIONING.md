# 插件 API 版本策略

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
