# 插件架构

## 当前：源码归属与 UI v4

Host API 1.4 / Rust SDK 1.3 / Vue SDK 1.0 起，九个标准插件的前端和测试位于各自 `plugins/system/<name>/frontend`，Guest 位于 `backend`。公开前端 SDK 为 `packages/plugin-sdk`；宿主提供桥接与公共原生服务，业务视图不再由宿主静态导入。新通用 frontend 贡献可以定义独立 WASM 动作，扩展新业务无需修改宿主工具枚举。

构建输出为标准包内的 WASM、ui.json、单一 JS 和 CSS。内置与上传共用该构建/校验/加载/调用链；资源进入不透明来源的 sandbox iframe，桥绑定安装代并保留现有逐请求授权。UI v1 保持声明式表单；旧 v2/v3 的标准视图使用兼容资源进入相同沙箱，不强制重装。公共服务实现与 SDK 接口的职责、缓存生命周期见[总体架构](../architecture/ARCHITECTURE.md#2026-11-04插件源码归属与-ui-v4)，新边界见[安全](PLUGIN_SECURITY.md)。下文 UI v2/v3 的“固定可信组件”描述为历史协议行为，由当前加载方式替代。

## 工作区工具标准化

AI 助手、批量、自动运维和网络诊断各自成为独立标准包，源码/锁文件/产物独立，系统与上传使用相同公开 ToolInvoke/UI v3 契约。PluginToolSurface 注入通过实际 WASM 的领域 API；App/workspace 仅解析已安装且启用/授权的贡献，不直接挂载原生业务页。顶部合并为一个运维工具入口；任务中心/调度器/引擎为宿主公共能力，禁用或卸载不删除已授权工作。票据及 AI 资源归属和边界见 [内置插件](BUILTIN_PLUGINS.md)。

2026-11-04：系统内置与上传插件统一为标准 WASM 包及运行时，来源由宿主记录。系统包预置声明权限和必要路径，grant/revoke IPC 不允许改写；上传包仍显式授权。全部插件使用当前主机，无主机白名单，旧 hostIds 仅兼容读取且不再输出。工具下拉只显示已启用插件，管理列表只有卸载。五个源码和完整契约见 [BUILTIN_PLUGINS.md](BUILTIN_PLUGINS.md)；下文 13A 为历史阶段，默认禁用只描述上传安装。

13A-1：desktop → application → plugin-core → core。插件包、元数据、信任接口和仓库独立于 SSH、Agent 与 Tauri。13A-2 新增 application → plugin-runtime → plugin-core/core/Wasmi，带后端的包在启用或按需激活时真实执行 WASM。元数据包继续不执行代码。能力 API/UI 尚未实现，不能视为可用。ABI、配额与未实现的 OS 保障见 [PLUGIN_RUNTIME.md](PLUGIN_RUNTIME.md)。

本地数据目录下 `plugins/packages/<id>/record.json` 为唯一当前状态指针，`plugins/system/<id>/versions/version-*/` 或 `plugins/upload/<id>/versions/version-*/` 按来源保存经过校验的独立内容代。`plugins/data/<id>/` 保存插件配置/用户数据，`plugins/cache/<id>/` 为可清缓存。仓库拒绝符号链接/Windows 重解析点，写入新代不覆盖旧入口。

安装：有界读包 → 严格清单/平台/API/路径/摘要校验 → 新代写入并 sync 文件 → 同目录临时 record 写入并 sync → 原子替换 record。提交失败时临时代自动释放，原指针、启用状态、旧内容保持有效；旧当前代作为升级前备份。新安装/升级默认禁用。重复/降级拒绝，升级必须绑定当前 expectedVersion；升级增加权限后续必须重新授权。

每次升级开始只清理不被当前指针/备份引用的内容代，成功升级保留上次当前代和之前备份，最多三代。异常退出可能留下候选代，后续升级清理；它们不会被发现或执行。没有宣称断电后文件系统级持久事务保证；正常错误返回不发生提交后再删除新代的问题。

卸载需要 confirmed，先持久禁用，再移除代码目录和缓存；默认保留 data，只有 clearData=true 才删除本插件数据。清理先验证本插件专属绝对路径与全树类型，不跟随链接；失败传播，不伪装成功。包中没有远端数据删除语义。其他用户进程同时恶意改写同用户仓库的 TOCTOU 不属于此文件协议的隔离承诺。

IPC：plugin_preview(path) → Manifest；plugin_install(input) → InstalledPlugin；plugin_list() → 数组；plugin_detail(id)；plugin_set_enabled(id, enabled)；plugin_uninstall(input)。输入见 Rust/TS 同名契约。错误使用现有 IpcError（PLUGIN_INVALID/CONFLICT/NOT_FOUND/STORAGE/BUSY/SHUTTING_DOWN），IO/JSON 原因链保留于 Rust，不跨 IPC 输出原始载荷。只有本地主 main 白名单允许调用；插件不能获得这些 IPC。

应用层复用有界后台入口串行化元数据操作，不在 Tokio 执行器同步读写包。Repository 的写 API 要求调用者按仓库串行化；桌面只创建一个 Application，多进程由现有单实例机制限制。

13A-3 增加公开 plugin-sdk（独立 1.0.0，仅 serde/serde_json），plugin-core 复用其权限枚举并持久化独立授权；application/plugins 的 Host 在现有 Engine/Files/Tasks/Operations 上执行受控能力。WASM 仍无导入，通过 invoke→yield HostCall→Rust 授权执行→专用 resume 返回，单次最多八项能力。Host Context 绑定主机、租约配置及不可复用的上下文代；取消、文档/任务/日志所有权和一次性操作批准都在 Rust。授权不与用户设置放在同一文件，升级/重装不继承旧安装代的授权。

新增七项主窗口 IPC：plugin_grant/permissions/revoke/context/approve/events/capability。Guest 不能调用管理/批准接口，也不能在 Request 中指定其他插件身份或原始租约。SDK、错误/配额、权限与兼容性见 [PLUGIN_SDK.md](PLUGIN_SDK.md)、[PLUGIN_SECURITY.md](PLUGIN_SECURITY.md)、[PLUGIN_API_VERSIONING.md](PLUGIN_API_VERSIONING.md)。没有数据库结构迁移或第二套连接池。
