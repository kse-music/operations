# 声明式插件 UI v1 / v2 / v3

## UI v3：可信工作区工具

`uiVersion:3` 可声明 `surface:{kind:"tool",tool:"assistant"}`，tool 还可取 batch、automation、network；manifest 对应贡献 `kind:"tool", tool:"assistant", id:"assistant"`。贡献与相同 ID 页面的类型必须匹配，标准视图必须有 WASM 后端；fields 为空、actions 只有 bridge、无 log/initialAction。未知枚举或脚本字段安装时拒绝。UI v3 也兼容原 monitor/operations 标准视图。

可信共享组件根据封闭类型选择原有完整页面，注入的业务 API 每次通过实际 WASM 调用；上传包没有专用页面限制或 ID 特判。Host 表单通过主窗口限定 IPC 冻结用户确认的完整输入，Guest 仅看到单次工具票据。分块结果、撤销、重启及来源/权限设置均复用标准机制，详见 [内置插件](BUILTIN_PLUGINS.md)。顶部旧业务工具组已合并；任务中心作为宿主公共入口保留。

13A-4 采用数据与可执行逻辑分离的渲染边界：`entry.ui` 指向经过摘要校验的 JSON（最多 64 KiB），只有固定 Vue 组件可以渲染它。插件不能提供 HTML、JavaScript、CSS、iframe、导航地址、资源 URL、事件处理器或 Vue 组件。未知字段直接拒绝；字符串始终通过 Vue 文本插值/表单 value 显示，不使用 v-html。业务逻辑仍在无 WASI 的 WASM Guest 中执行。

## 声明与贡献

公开定义位于 `crates/plugin-sdk/src/ui.rs`，完整示例为 `tests/fixtures/plugins/host-info/ui.json`。根字段为 uiVersion=1、title、pages；title/label 支持字符串或同时包含 zh-CN/en-US 的字典。最多八页，每页最多 32 个字段、32 个动作。标识符只允许 ASCII 字母、数字、下划线与短横线，拒绝原型保留键。

字段只支持 text/textarea/checkbox、受限标量默认值、readonly，以及编辑文档的 documentField 绑定。动作包含 id、label、discardDirty、enabledWhen；initialAction 为首次加载动作。日志通过 log.resourceField 绑定 Host 返回的日志句柄。大文本最多 32 KiB、消息最多 60 KiB（运行时上限 64 KiB）。未知字段/动作、非标量状态、超限数据和原型字段被校验拒绝。

manifest.contributions 的每个 id 必须存在对应页面：

| kind       | 入口                                       |
| ---------- | ------------------------------------------ |
| workspace  | 工具下拉菜单打开该插件的首选功能页         |
| navigation | 运维工具菜单下的插件导航                   |
| host_menu  | 主机树右键菜单                             |
| command    | Ctrl+K 全局搜索中的插件命令                |
| settings   | 运维工具菜单下的插件设置页（无主机上下文） |

启用且当前安装代获得 ui.contribute 权限/操作授权才注册。禁用、卸载、撤权、升级或修改授权后撤销页面/菜单；Host 同时停止相关能力资源。崩溃显示错误态，用户显式重新激活。同一插件仅保留一个工作区上下文；切换贡献/主机前处理未保存内容，关闭插件页不关闭主应用终端。

## 受控桥

动作只发送 `{action,values}` 到该安装插件的 WASM。Guest 可以返回 `{values?,output?,saved?}`，只能改变自己页面的标量值/文本结果。saved=true 表示 Guest 已核实真实保存成功；保存失败必须保持编辑内容，不得返回成功。Host 响应的操作审批由主程序独立对话框展示插件、版本、实际目标与完整操作，单次批准绑定 Host 请求；Guest 无审批 API。原生命令、插件身份和内部租约不来自 UI JSON。

主程序连接器选择已登记主机，复用运维/SFTP Store，使用已有指纹核验、凭据和连接池。租约只传给 Rust Host，Guest 只能通过授权能力操作。每个请求仍在 Rust 校验版本、范围与资源所有权。设置页不能伪造主机上下文。文档/任务/日志只使用不透明公开句柄。

主窗口 CSP 保持 script-src self、frame-src none、object-src none、form-action none，connect-src 仅 IPC；不为插件放开远程脚本/资源或通用 Tauri 权限。不是把不可信 JS 放入宿主 DOM 的“沙箱”，而是根本不执行插件页面脚本。需要任意 Web UI 的插件不兼容 v1。

样式只使用主程序主题变量，支持亮/暗色。插件管理文案及插件 UI 的字典标签跟随已保存的全局 product.language，唯一选择入口为“设置 → 工作区与连接”；没有独立插件语言状态或页面选择器。当前全局仅支持完整简体中文，SDK 的 zh-CN/en-US 字典结构保留，不据此宣称主程序支持完整英文。manifest 的稳定 label 由作者提供（可使用双语文案）。安装预览显示未验证来源、权限、API/平台兼容声明、包摘要；安装请求绑定预览摘要，升级后必须重新授权。

## 生命周期与限制

离开但未关闭的插件标签保留内存草稿和 Host 文档；重新进入相同上下文不重新创建资源。切换主机/连接代会停止旧资源，关闭时询问放弃修改；禁用/授权变化/卸载对话框明确说明资源与草稿处理。程序退出仍使用已有后端 dirty 检查及统一确认。草稿不持久化到磁盘。

日志前端只保留最近 65,536 字符（不是字节），后台仍采用有界通道与 ACK。错误进入现有通知系统；命令输出/正文不进入主应用日志。安全边界和运行时限制另见 [PLUGIN_SECURITY.md](PLUGIN_SECURITY.md)、[PLUGIN_RUNTIME.md](PLUGIN_RUNTIME.md)。

## UI v2 标准服务器视图

SDK 1.1.0 起 uiVersion 可为 2；旧 v1 表单不变。server 贡献需要相同 id 的页面声明 surface，缺失安装时拒绝。页面 surface 为 `{kind:"monitor",sections:["overview","disks","network"]}` 或 `{kind:"operations",sections:["containers","images","processes","ports","services","logs"]}` 的非空子集，不允许混合/重复/未知分类。surface 页面 fields 必须为空、log/initialAction 为空、actions 仅一个 bridge 动作。

可信共享组件根据公开声明渲染安全表格、图表、详情、日志及操作入口；不是包内脚本/HTML/组件导入。每次动作序列化 Capability，通过同一 plugin_call 执行该包 WASM，再进入逐请求授权的 Host。上传包与系统分发包具有相同的 server 贡献与 surface 能力，菜单来源不决定可用的渲染器或权限。完整示例位于 plugins/system 的五个独立目录；构建与配额见 [BUILTIN_PLUGINS.md](BUILTIN_PLUGINS.md)。

## 管理与自身设置入口

管理位于设置模块，顶部“运维工具”只列出已安装身份；公共任务中心从底部状态栏打开弹窗。可信宿主 PluginPage 提供来源、运行状态、启停、权限和包信息，禁用、未授权或无 UI 包也能进入。只有功能区挂载经过授权的 PluginView；禁用/撤权释放功能与资源，保留自身设置。其他声明页面通过页内选择器访问，管理列表仅保留卸载。终端右上角 SFTP 右侧工具下拉菜单为每个已启用插件提供一个入口，不再把 workspace 贡献逐项平铺在工具栏。所有插件适用于全部主机，使用当前选中主机；系统预置权限和路径只读，上传权限可编辑。页面铺满可用宽度，安装仍为拖放或文件选择，无手填路径。
