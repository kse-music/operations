# 插件 UI v1 / v2 / v3 / v4

## 当前标准界面范围（Host/SDK 4.0.0）

系统服务及宿主提供的监控、进程、端口、systemd 和日志分类已经删除；Monitor surface 不再接受，operations.sections 仅允许 containers/images。旧 Docker 兼容界面复用当前 Docker 页面并只显示声明的分类。独立前端 frontend surface 仍可使用授权的通用系统/指标/日志能力。旧系统界面声明需升级，安装时提示；已有安装或失效备份按[版本策略](PLUGIN_API_VERSIONING.md)保留数据并归档。下文涉及旧分类的段落为历史约定。

## 使用入口与上下文（2026-11-06）

内置 system 助手采用工作区生命周期：已启动的匹配/准备/回答/查询和已批准执行在隐藏时继续，返回显示结果，关闭所属主机（全局入口为自身标签）时停止。宿主保留真实 visible:false，注入 keepRunning 并校验每页流程；只有已开始流程的必要续接可在后台进行，新执行审批仍须回到可见页面。上传及其他插件继续以下隐藏释放规则。

workspace/navigation/server/host_menu/command 等主机功能从当前设备打开，宿主提供固定 hostId，插件页面不提供第二个目标主机选择器；无上下文时由宿主统一选择一次。自动运维与批量运维已移除，不再接受其 tool 枚举。assistant 可从主机或全局进入。已授权的 settings 贡献由插件自己的 UI/WASM 提供，通过管理卡片配置按钮或功能页“插件设置”在宿主弹窗中展示，使用空 hostId。

功能界面按插件、贡献和主机保留。各插件的启停、授权与包信息也由设置弹窗展示。未提供 settings 贡献或尚未授权的包直接显示宿主管理面板。隐藏 iframe 会收到 visible:false，不应继续轮询或提交操作；Host 会拒绝非当前页面请求，撤销在途交互并使旧资源失效。恢复 visible:true 后需重新获取监控/日志等不透明资源；不得复用已失效的句柄，错误须正常呈现。已读日志与输入草稿可保留，恢复不自动执行原操作。标准系统包提供对应可见性处理。

Host API / Rust SDK / Vue SDK 当前为 4.0.0；ABI/wire 仍为 1，UI v1–v4 格式保留。仅剩 assistant 工具领域；旧 ^1.x 包未使用已删除权限与枚举时继续兼容。

## 2.1 组合分类与缓存页面

UI v4 的 operations.sections 可组合 overview/disks/network 与原运维分类，v2/v3 仍只接受其既有类别。系统服务用一个 server 贡献实现资源、进程/端口、systemd 三分类；独立日志 renderer 已移除，旧 logs-only 兼容页面显示升级提示，不执行其他分类。服务与容器日志使用 ResourceLogDialog 就地弹窗，不使用 logIntent 或跨插件导航；通用日志协议保留。SDK usePluginVisibility 返回包含 KeepAlive 激活状态的响应式可见性，资源弹窗关闭或隐藏时释放流。Shell 事件由宿主 ContainerTerminalDialog 展示，保持原主机及插件页；其免二次确认仅适用于内置 System Docker，权限与票据复核保留。AI 的历史回答可保留，旧上下文命令引用失效后不能继续执行。

## UI v4：包内独立界面

Host API 1.4.0 / Rust SDK 1.3.0 新增 `uiVersion:4` 和必填 `frontend:{script:"frontend.js",style:"frontend.css"}`。页面仍声明 id/title/fields/actions 等严格字段；`surface:{kind:"frontend"}` 允许全新业务页面，普通 workspace/navigation/host_menu/command/settings 贡献映射到同 ID 页面，无需增加宿主类型。通用页面的 actions/fields 声明可由 SDK invoke 使用；初始动作及 log 仍为空，插件自行管理 UI 状态。保留的 operations（仅 containers/images）及 tool surface 在 v4 也可使用，标准 surface 的单一 bridge 动作约束不变。

前端入口使用公开 SDK：

```ts
import { mountPlugin } from '@serverdeck/plugin-sdk/runtime';
import App from './App.vue';
import '@serverdeck/plugin-sdk/ui/base.css';
mountPlugin(App);
```

`@serverdeck/plugin-sdk` 的 `invoke(action, values)` 只能调用该页面已声明的自身 WASM 动作。公共服务客户端、Store 和组件分别位于 services/stores/ui 子路径。源码不得引用 desktop 的服务、类型、状态或 Tauri；构建器拒绝这些引用。完整独立示例为 `tests/fixtures/plugins/custom-ui`，常规业务示例为 `plugins/system/<name>/frontend`。

宿主 PluginFrame 用不透明来源的 sandbox iframe 加载包入口，theme/当前主机/允许读取的状态经 MessageChannel 注入；插件 API 仅通过白名单桥到实际 WASM 和授权 Host。可信 Host 操作确认根据冻结输入生成，不接受 Guest 自行批准。iframe 的请求、并发、事件和速率有界；资源每次检查安装代、grant 和摘要。详见[安全边界](PLUGIN_SECURITY.md#ui-v4-的页面隔离与原生能力)。

工具标签持续挂载，切换标签或查看自身设置保留草稿；隐藏页面经 SDK 收到可见性通知，监控暂停。禁用/撤权/升级/卸载释放对应资源；网络诊断及专属后台任务已删除。UI v1 保持原表单；旧 v2/v3 标准视图使用兼容资源进入相同 iframe，保留能力的旧包不强制升级。下文 v1–v3 的“不执行包内 JS、frame-src none”是这些协议最初的约束，不适用于新增 v4；主窗口当前仅允许本地 sdplugin frame。

## UI v3：可信工作区工具

`uiVersion:3` 可声明 `surface:{kind:"tool",tool:"assistant"}`，tool 仅为 assistant；manifest 对应贡献 `kind:"tool", tool:"assistant", id:"assistant"`。贡献与相同 ID 页面的类型必须匹配，标准视图必须有 WASM 后端；fields 为空、actions 只有 bridge、无 log/initialAction。未知枚举或脚本字段安装时拒绝。UI v3 也兼容原 monitor/operations 标准视图。

可信共享组件根据封闭类型选择原有完整页面，注入的业务 API 每次通过实际 WASM 调用；上传包没有专用页面限制或 ID 特判。Host 表单通过主窗口限定 IPC 冻结用户确认的完整输入，Guest 仅看到单次工具票据。分块结果、撤销、重启及来源/权限设置均复用标准机制，详见 [内置插件](BUILTIN_PLUGINS.md)。顶部旧业务工具组已合并；任务中心作为宿主公共入口保留。

13A-4 采用数据与可执行逻辑分离的渲染边界：`entry.ui` 指向经过摘要校验的 JSON（最多 64 KiB），只有固定 Vue 组件可以渲染它。插件不能提供 HTML、JavaScript、CSS、iframe、导航地址、资源 URL、事件处理器或 Vue 组件。未知字段直接拒绝；字符串始终通过 Vue 文本插值/表单 value 显示，不使用 v-html。业务逻辑仍在无 WASI 的 WASM Guest 中执行。

## 声明与贡献

公开定义位于 `crates/plugin-sdk/src/ui.rs`，完整示例为 `tests/fixtures/plugins/host-info/ui.json`。根字段为 uiVersion=1、title、pages；title/label 支持字符串或同时包含 zh-CN/en-US 的字典。最多八页，每页最多 32 个字段、32 个动作。标识符只允许 ASCII 字母、数字、下划线与短横线，拒绝原型保留键。

字段只支持 text/textarea/checkbox、受限标量默认值、readonly，以及编辑文档的 documentField 绑定。动作包含 id、label、discardDirty、enabledWhen；initialAction 为首次加载动作。日志通过 log.resourceField 绑定 Host 返回的日志句柄。大文本最多 32 KiB、消息最多 60 KiB（运行时上限 64 KiB）。未知字段/动作、非标量状态、超限数据和原型字段被校验拒绝。

manifest.contributions 的每个 id 必须存在对应页面：

| kind       | 入口                                      |
| ---------- | ----------------------------------------- |
| workspace  | 主机工具栏按钮打开该插件的首选功能页      |
| navigation | 功能贡献，可从主机工具/搜索等功能入口打开 |
| host_menu  | 主机树右键菜单                            |
| command    | Ctrl+K 全局搜索中的插件命令               |
| settings   | 插件配置页中的自有设置（无主机上下文）    |

启用且当前安装代获得 ui.contribute 权限/操作授权才注册。禁用、卸载、撤权、升级或修改授权后撤销页面/菜单；Host 同时停止相关能力资源。崩溃显示错误态，用户显式重新激活。同一插件仅保留一个工作区上下文；切换贡献/主机前处理未保存内容，关闭插件页不关闭主应用终端。

## 受控桥

动作只发送 `{action,values}` 到该安装插件的 WASM。Guest 可以返回 `{values?,output?,saved?}`，只能改变自己页面的标量值/文本结果。saved=true 表示 Guest 已核实真实保存成功；保存失败必须保持编辑内容，不得返回成功。Host 响应的操作审批由主程序独立对话框展示插件、版本、实际目标与完整操作，单次批准绑定 Host 请求；Guest 无审批 API。原生命令、插件身份和内部租约不来自 UI JSON。

主程序连接器选择已登记主机，复用运维/SFTP Store，使用已有指纹核验、凭据和连接池。租约只传给 Rust Host，Guest 只能通过授权能力操作。每个请求仍在 Rust 校验版本、范围与资源所有权。设置页不能伪造主机上下文。文档/任务/日志只使用不透明公开句柄。

主窗口 CSP 保持 script-src self、frame-src none、object-src none、form-action none，connect-src 仅 IPC；不为插件放开远程脚本/资源或通用 Tauri 权限。不是把不可信 JS 放入宿主 DOM 的“沙箱”，而是根本不执行插件页面脚本。需要任意 Web UI 的插件不兼容 v1。

样式只使用主程序主题变量，支持亮/暗色。插件管理文案及插件 UI 的字典标签跟随已保存的全局 product.language，唯一选择入口为“设置 → 工作区与连接”；没有独立插件语言状态或页面选择器。当前全局仅支持完整简体中文，SDK 的 zh-CN/en-US 字典结构保留，不据此宣称主程序支持完整英文。manifest 的稳定 label 由作者提供（可使用双语文案）。安装预览显示未验证来源、权限、API/平台兼容声明、包摘要；安装请求绑定预览摘要，升级后必须重新授权。

## 生命周期与限制

离开但未关闭的插件标签保留内存界面草稿；隐藏时释放 Host 上下文资源及 WASM 实例，返回时先重新激活并重新获取所需句柄。文件/日志等 Host 句柄不能作为持久草稿保留。切换主机/连接代会停止旧资源，关闭时询问放弃修改；禁用/授权变化/卸载对话框明确说明资源与草稿处理。程序退出仍使用已有后端 dirty 检查及统一确认。草稿不持久化到磁盘。

日志前端只保留最近 65,536 字符（不是字节），后台仍采用有界通道与 ACK。错误进入现有通知系统；命令输出/正文不进入主应用日志。安全边界和运行时限制另见 [PLUGIN_SECURITY.md](PLUGIN_SECURITY.md)、[PLUGIN_RUNTIME.md](PLUGIN_RUNTIME.md)。

## UI v2 标准服务器视图

SDK 1.1.0 起 uiVersion 可为 2；旧 v1 表单不变。server 贡献需要相同 id 的页面声明 surface，缺失安装时拒绝。页面 surface 为 `{kind:"monitor",sections:["overview","disks","network"]}` 或 `{kind:"operations",sections:["containers","images","processes","ports","services","logs"]}` 的非空子集，不允许混合/重复/未知分类。surface 页面 fields 必须为空、log/initialAction 为空、actions 仅一个 bridge 动作。

可信共享组件根据公开声明渲染安全表格、图表、详情、日志及操作入口；不是包内脚本/HTML/组件导入。每次动作序列化 Capability，通过同一 plugin_call 执行该包 WASM，再进入逐请求授权的 Host。上传包与系统分发包具有相同的 server 贡献与 surface 能力，菜单来源不决定可用的渲染器或权限。完整示例位于 plugins/system 的五个独立目录；构建与配额见 [BUILTIN_PLUGINS.md](BUILTIN_PLUGINS.md)。

## 管理与自身设置入口

管理和全部插件配置统一位于“设置 → 插件管理”，顶部不再提供运维工具模块或插件侧栏；公共任务中心从底部状态栏打开弹窗。可信宿主 PluginPage 提供来源、运行状态、启停、权限和包信息，禁用、未授权或无 UI 包也能进入。功能页“插件设置”打开同一配置标签，始终归属设置并选中插件管理；返回设备标签保留功能页与草稿。只有功能区挂载经过授权的 PluginView；禁用/撤权释放功能与资源，保留自身设置。其他声明页面通过页内选择器访问，管理列表提供安装、升级、详情入口和卸载。终端右上角 SFTP 右侧平铺显示每个已启用且有功能页面的插件按钮，每个安装身份一项，保留图标并高亮当前插件；不再提供工具下拉菜单。所有插件适用于全部主机，使用当前选中主机；系统预置权限和路径只读，上传权限可编辑。页面铺满可用宽度，安装仍为拖放或文件选择，无手填路径。
