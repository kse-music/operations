# 系统内置标准插件

## 工作区工具：SDK 1.2 / UI v3

四个新包分别声明公开 `tool` 贡献和 `{kind:"tool",tool:"assistant|batch|automation|network"}`（实际取其中一个枚举值），需要 SDK/API ^1.2.0 和 UI v3。固定可信渲染器注入同一桥接 API，根据贡献类型选择视图；不按内置 ID 路由，不执行包内脚本。第三方上传相同声明也能使用完整页面，但必须获得 ui.contribute 和对应 assistant.use / batch.run / automation.manage / network.run 权限及操作授权。

业务链路为可信表单 → plugin_tool_stage → 单次不可变输入票据 → 包内 WASM → tool_invoke → 类型化 Host 能力 → 原任务/AI/自动化服务 → WASM Resume。Guest 仅收到票据、封闭操作和限额结果，不得到模型 Key、私有 SSH 租约、完整确认载荷或原生 IPC 名称。输入票据绑定插件/安装代/上下文代/精确操作，TTL 60 秒、每份最多 1 MiB、全局八份/每插件两份、合计 4 MiB。结果沿用公开分块资源。

模型管理、主机库存、可信连接/文件选择、任务引擎、调度器、持久化历史和任务中心是宿主基础能力。禁用/卸载撤销交互请求、AI 预览/建议、输入和结果资源；已明确提交的网络/批量/自动化任务及计划继续由宿主管理，不删除或悄悄取消。任务中心无需安装业务插件即可请求停止任务或暂停计划；创建、编辑和批准业务任务仍在插件页。内置配置预置且只读，上传权限仍可配置。

批量、自动运维、网络诊断标签保留内存草稿，关闭标签后释放；打开自身设置保留当前功能草稿，禁用/撤权会卸载功能区。AI 的单次取消通过绑定输入票据和自有预览根撤销，不取消整个 VM，后续可以继续提问。AI 命令仍复用现有逐条审核、目标绑定和危险操作确认，不自动执行模型建议。

服务器管理五个插件和工作区工具四个插件，共九个独立 WASM 插件，每个都有自己的 manifest、UI 声明、Rust crate、Cargo.lock 和标准 `.sdplugin` 产物。仅依赖公开 SDK，使用与用户上传包相同的校验、仓库、运行时、授权、升级和卸载流程。

| 插件 ID                      | 独立源码                    | 分类                       |
| ---------------------------- | --------------------------- | -------------------------- |
| cn.hiboot.plugins.resources  | `plugins/system/resources`  | 资源概览、磁盘、网络       |
| cn.hiboot.plugins.docker     | `plugins/system/docker`     | Docker 容器、镜像          |
| cn.hiboot.plugins.processes  | `plugins/system/processes`  | 进程、监听端口             |
| cn.hiboot.plugins.services   | `plugins/system/services`   | systemd 服务               |
| cn.hiboot.plugins.logs       | `plugins/system/logs`       | 文件、容器、服务日志       |
| cn.hiboot.plugins.assistant  | `plugins/system/assistant`  | AI 运维助手                |
| cn.hiboot.plugins.batch      | `plugins/system/batch`      | 批量命令和文件分发         |
| cn.hiboot.plugins.automation | `plugins/system/automation` | 命令脚本库、计划和执行历史 |
| cn.hiboot.plugins.network    | `plugins/system/network`    | 本机和远端网络诊断         |

## 构建与分发

单独构建：`node tools/build-plugin.mjs plugins/system/docker .local/docker.sdplugin`。统一构建：`npm run plugins:build`，输出 `plugins/system/packages/*.sdplugin`；应用的开发/构建命令先刷新这些标准发行资产。首次获取锁定依赖及 wasm32-unknown-unknown 工具链后可离线构建。源码并不编译进宿主业务模块，宿主嵌入的是完整插件包字节。

启动时将未配置过的分发包通过标准包校验器安装到普通插件仓库。系统分发的新安装默认启用，声明的全部能力、操作范围（含 Docker 容器终端）和所需目录预先授权；日志插件可读根为 `/`，仍受远端账号权限限制。已有系统安装补齐固定授权，但保留用户的禁用选择；不会自动连接服务器。existing application_settings 的 `bundled_plugin:<id>` 记录分发标记，卸载后重启不会重新安装。已有上传安装不被覆盖或自动授权；显式上传升级仍按上传包处理，默认禁用且需重新授权。

“设置 → 插件管理”提供拖拽或文件选择安装，列表只保留卸载操作，点击名称进入插件自己的页面。顶部“运维工具”显示所有已安装名称，底部保留宿主公共“任务中心”，包括禁用/未授权项；来源、运行状态、启停、权限和包详情在各自页内展示。终端右上角 SFTP 右侧的“工具”下拉菜单按插件列出已启用项（每个插件一项），点击在当前主机打开；没有 UI 的包进入自身设置，未启用项不显示。两类插件都无需配置主机白名单，能力适用于所有主机，实际调用仍绑定当前选中主机和连接代。

系统插件权限和目录范围为只读，宿主拒绝修改或撤权请求；可在自身设置启停或在管理列表卸载。上传插件仍由用户配置能力与目录，上传相同 ID/相同包也不会取得系统预置权限。来源只由宿主分发/导入路径记录，不是独立的密码学签名验证。语言沿用全局偏好。

## 标准服务器视图

公开 SDK 1.1.0、UI v2 新增 `server` 贡献和 `surface` 声明。资源、运维表格、详情、图表及日志由可信共享 Vue 渲染器展示；上传插件也能使用相同声明。包内不执行 HTML/JS，不动态导入包内组件，不根据内置 ID 选择原生页面。

每次业务调用都经过 `plugin_call → 该包 WASM → 公开 Capability → Host 授权/执行 → WASM Resume`。五个包分别限制自己提供的能力，宿主仍逐请求检查安装代、权限、当前主机、操作、连接配置及资源归属。共享 MonitorView/OperationsView/OpsLogPanel 在插件上下文注入受控 API，不直接调用原生业务 IPC。ServerView 保留标准 server 贡献入口，常用功能直接从工具菜单打开；进程/日志联动寻找已启用且具备能力、声明对应分类的提供者，上传插件同样参与。

## 宿主资源与限制

- `metrics.read` 使用本插件/上下文拥有的采样器，共用既有 SSH 连接池；最多八个插件采样器。切页暂停，停止/换连接/禁用/撤权/升级/卸载/退出释放，更新全局间隔与重置连接作用于全部采样器。AI 仍按当前真实 SSH transport 和采样时间复用数据。
- `system.read` / `system.manage` 只接受封闭类型的运维请求。环境变量明文展示、状态修改和信号仍需宿主逐次批准；不接受 Guest 自带 confirmed。容器终端另需允许 `system.shell`，批准后领取绑定插件、安装代、上下文、主机、容器和 Shell 的单次票据，60 秒有效；可信终端 IPC 复验后创建 SSH 终端。已交给终端工作区的会话独立存在，重连须重新经过 WASM 审批。
- `logs.read` 支持指定文件、容器和 systemd 日志；文件额外检查 sftp.read 和规范可读根目录。流、ACK、有限通道及轮询均检查归属，离开日志页关闭；不会自动提权。
- 超过 1 KiB 的结构化业务结果通过不透明分块资源传递，避免消耗 Guest JSON 执行预算。单结果最多 4 MiB、共 8 MiB、全局八项/每插件两项、60 秒有效，每块 32 KiB；不可跨插件/上下文读取，前端验证完整字节数和 UTF-8，读取后关闭。WASM 原有 64 KiB 消息、内存/fuel 限额未放宽。

旧 `serverdeck.builtin.*` 原生注册表、独立启停 IPC 和状态门控已移除；旧 settings 行保留不读取，不重置用户配置、主机、凭据或远端数据。新包不会继承旧原生功能的默认授权。

验证与平台边界见 [插件验证记录](../validation/plugins/PLUGIN_TEST_REPORT.md)。

## 目录与域名迁移

项目源码分别位于 plugins/system 和 plugins/upload。后者只保留真实业务插件 Nginx Manager；metadata、hello-world、diagnostics、host-info 是必要的协议/隔离测试夹具，已移至 tests/fixtures/plugins，不作为产品插件分发。原 examples/plugins 是空目录，已删除。这里只整理仓库源码，不删除客户端已安装的上传包或用户数据。实际客户端安装目录位于应用数据根下：system/<ID>/versions 保存分发包内容，upload/<ID>/versions 保存上传内容，packages/<ID>/record.json 只保存当前代和备份指针；data 与 authorizations 继续保存个人配置和授权。旧 packages/<ID>/versions 中的内容按原来源原子移动，不改变安装代、摘要、授权或设置；冲突/链接明确拒绝，不覆盖目标，部分移动后可在下次启动继续。

五个内置 ID 从 io.serverdeck.plugins.* 改为 cn.hiboot.plugins.*，应用自身 identifier 不变，以保留数据/凭据位置。迁移保留配置和旧卸载标记，旧系统记录归入 plugins/retired，新系统身份使用本版固定预置授权，不复制旧授权。已存在的新 ID 安装不覆盖，上传包 ID 不改写。旧授权文件中的 hostIds 兼容读取但不再限制主机，新授权和 IPC 不输出该字段；版本、摘要、安装代、能力、操作和路径限制继续有效。历史内容留存，不删除用户配置或远端数据。

存储布局迁移后应使用新版客户端，旧版按原 packages 路径读取内容，不支持直接回退旧程序；本轮保留原记录/数据，不提供自动回退工具。
