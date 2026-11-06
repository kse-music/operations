# ServerDeck v0.1 架构

## 2026-11-06 主机工作区标签分层

`App.vue` 按 `isHostTab` 将既有工作区投影为页面与主机两行。「全部主机」是由现有主机标签派生的入口，使用最近主机的 `hostId` 恢复活动工作区。切换顶部模块只更换侧栏菜单，页面行由工作区集合决定，主机行由当前页面决定。方向键在各行内切换，「关闭右侧」也按同行顺序处理。连接和会话归属继续由现有工作区处理。

## 2026-11-06 主机 JSON 导入导出下线

移除主机标题栏 JSON 控件、App 文件读写、前端服务方法、Tauri 命令及其权限、应用用例和存储归档模块。SQLite 数据模型继续读取已有主机、文件夹及连接配置。已有主机缺少代理密码引用时可编辑配置，连接规划继续要求补绑凭据。OpenSSH Config 使用独立解析和提交链路。

## 2026-11-06 私钥导入和模型上下文窗口

主窗口通过已有 `credential_save` 传入选中的 `keyData` 与可选解锁口令。Rust 在阻塞任务中解析、校验算法并将密钥规范化为 OpenSSH 格式，使用不可变随机引用写入系统凭据库。`key_path` 为空的私钥凭据必须有 `secret_ref`，SSH 认证直接读取该秘密。导入失败保留旧版本，成功替换后由既有秘密清理队列删除旧引用。公开 DTO 仅返回状态，保留旧路径作为兼容元数据。

模型 `Config` 增加 `contextWindowTokens`。旧注册表和单模型设置在读取时丢弃旧价格字段并补默认窗口。连接测试票据继续绑定完整配置。请求构建和发送边界按 UTF-8 JSON 字节数加 64 估算输入 Token，并加上本次请求的最大输出，与配置窗口比较。96 KiB 是独立硬上限。内置准备流程优先省略可选明细和较早的完整对话轮次，智能体和主机匹配同样在发送前校验。旧费用响应字段保留空值。

## 2026-11-06 应用配置备份与恢复下线

移除资产管理的备份恢复页面、全局搜索入口、备份 JSON 数据结构与存储实现，以及三条 Tauri 命令和对应权限。窗口几何持久化移入通用数据库实现，沿用原设置键和值格式。OpenSSH Config 导入和数据目录迁移使用独立调用链。本次移除无需数据库迁移。

## 2026-11-05：镜像删除的宿主单次确认

ResourceView 对 image_remove 直接提交能力请求，由既有 Rust approval 阻止未批准执行，移除包内重复目标输入。Approval 增加可选 imageId，仅从已冻结的 SystemQuery/ImageRemove 生成，其他操作不序列化此字段；PluginApproval 前端类型同步。宿主 plugin-server 使用原生 imageId、真实主机目录和插件身份生成结构化确认，PluginDialogs 展示目标、完整 ID 和删除约束；取消按原协议拒绝批准，批准后仅重试原冻结载荷。

不更改 requires_confirmation、权限、安装代/上下文代、TTL 或单次消费。旧后端无 imageId 时继续使用原通用宿主审批，不回退到信任 iframe 目标。SDK/Host API 仍为 4.0.0，Docker 包 1.5.1 更新独立 UI，兼容资源同步重建；无数据库迁移或新增 IPC 命令。

## 2026-11-05：插件管理独立导航

NavigationModule 增加 plugins；plugins 与 pluginSettings 两种工作区视图统一映射至插件模块，AppNavigation 将唯一的插件管理入口从 system 移至 plugins。继续复用 Workspace 的标签激活与配置标签去重，功能页面仍属于 hosts，切换顶部模块只切换菜单、不改变当前工作区及主机上下文。

PluginsView 基于真实 installed 清单在本地组合来源、启用状态与关键字筛选；卡片通过内容区容器查询在双列和单列间切换，不依赖整个窗口宽度。安装、原生拖放、预览代校验及卸载复用既有服务，无 IPC、Rust、权限或数据结构变化。下文设置模块下的插件管理归属为历史描述，以本节为准。

## 2026-11-05：本机目录定位与重启迁移

application/storage_location 维护版本化本机定位文件 storage-location.json，保存在默认 app_config_dir；目录选择不进入 AppConfig，无 SQLite schema 变化。Locations 明确 data/logs/webview，统一布局为根目录数据库和 plugins、logs、webview。已有安装沿用原分散位置，新安装使用统一布局。系统凭据服务和独立下载位置保持原契约。

主窗口关闭自动创建，单实例及旧标识目录处理后，setup 在打开业务数据库/日志/WebView 前解析定位状态和执行待处理复制，再用已解析 webview 路径创建 main 窗口。启动故障使用原生对话框提示，不降级到空库。Bootstrap 增加可选 storage；app_storage_preview、app_storage_migrate、app_storage_ready 仅授权本地主窗口，后台文件操作放 spawn_blocking，Rust/TS 数据类型同步。

迁移使用同一目标磁盘上的专用暂存目录，记录来源、目标、普通文件及空目录清单、字节数与 SHA-256；空间预检预留 16 MiB。Pending 可根据清单校验续传，Copied 尚未确认启动时重启回退源目录，Committed 在清理前持久化且永不回退到部分清理的源。数据库副本以只读 quick_check、版本及偏好校验。前端启动确认提交候选后逐文件复核并删除源，只尝试移除空目录；定位文件、未知新增文件和变化文件保留，清理故障提示并在下次就绪重试。

迁移先申请普通退出，复用窗口状态保存、任务取消和排空；排空完成并冲刷日志后才 request_restart，避免 Tauri 的重启退出码绕过退出延迟。源/目标祖先、文件和清理目录拒绝链接及 Windows 重解析点；目标不得非空、覆盖或与源嵌套。同路径别名视为无需迁移。摘要/数据库/复制失败保留源，暂存及候选失败副本保留供诊断。

## 2026-11-05：系统服务退役与 Docker 兼容复用

系统服务插件、发行包、资源监控/进程端口/systemd/服务日志专属界面及旧标准视图兼容实现已移除，内置只分发 Docker 管理和 AI 运维助手。保留 AI、Docker 和独立插件仍使用的通用指标采集、类型化系统查询、受控操作及日志能力，不提供替代系统页面。

当前及旧域名 services 身份启动退役，依赖已删除标准界面的旧安装退出注册；有效安装仅旧备份依赖已删合同时，归档原始记录和可独立恢复的包后清除活动回滚指针。原包、设置、授权和用户数据保留，迁移可重复执行、错误传播，禁止重新安装被删身份或标准视图。第三方需升级使用自带界面；未使用移除合同的旧包继续兼容。

Host/Rust/Vue SDK 为 4.0.0，Docker 包 1.5.0、助手包 1.6.0，要求 ^4.0.0；ABI、wire、包格式仍为 1。下文系统服务页面及三插件范围仅为历史记录，以本节为准。

旧 Docker 标准界面直接复用 Docker 插件现有前端，按声明限制分类；移除旧监控及 OperationsView、专属注入适配。仓库在当前 SDK 解码前以有界读取及摘要核验识别旧 UI，同时支持旧/新 payload 布局；归档记录附 reason.json，原授权不作为重新激活依据。共享能力验收改用不分发的 server-capabilities WASM 夹具。

## 2026-11-05：内置助手的工作区生命周期

插件来源为 system 且 ID 精确匹配内置助手时，Plugins Store 维护多个页面 owner，并使用稳定的原生空上下文。AI 输入本身携带并复验实际 SSH Binding，无需随可见主机或设置页面重绑原生上下文；切换 owner 不增加 contextVersion，最后一个 owner 关闭时再释放 VM/上下文。其他插件及上传同 ID 包继续独占上下文和隐藏释放。

PluginView 在所属主机工作区（或全局助手标签）仍存在时保留 iframe 与 contextReady，真实 visible:false/inert 继续生效。宿主注入 keepRunning；useAssistant 保留 pending、请求 ID、对话版本和未过期计划，不因隐藏丢弃结果。前端 begin/end 通过现有 MessageChannel 标记本页已启动的流程，不增加原生 IPC；begin 必须在可见页面，只有本页流程和工作区仍有效时才放行匹配、连接、准备、发送等必要续接和既有结果返回。后台不能启动新的 ai_execute，可信审批在展示和批准后都复验页面是否可见；已批准执行可收尾。

桥为每个 iframe 跟踪自己的 AI 根请求及 AbortController。隐藏内置助手不 abort 在途请求和连接事件，卸载该页面时仅取消自有根请求并撤销排队票据，其他 owner 不受影响。每插件现有有界队列和模型单并发保持，未引入后台并行调度。模型/连接身份、授权、安装代、资源 TTL 与取消规则继续校验。助手包1.5.1，SDK/Host仍3.0，ABI/wire/权限/数据库不变。

## 2026-11-05：SSH 智能体与冻结执行计划

新增 ai/agent 有界编排，使用同一 OpenAI-compatible HTTP 提供者和严格 JSON query/plan/answer 协议。查询经过只读 allowlist 和现有 Request 参数校验，由 Application AgentHost 适配器执行，每次核验实际 SSH 身份。最多六轮、十二次模型申请查询，每轮三项、150秒总预算；原96 KiB wire/256 KiB 响应/单并发上限保持。模型只接收脱敏、有总数和省略标记的摘要，完整证据留在宿主选取目标，Token/费用按全部已知轮次累计。

Plan 存入 Assistant 有界内存表，不向 Guest 开放可修改的执行载荷。无标签清理从完整成功 Images 证据选取、按完整 ID 去重并排除带标签别名；容器与服务先被查询，再读取详情冻结状态。每计划最多32项、十分钟单次消费，绑定模型 ID/版本、根请求和 Binding。复用 ai_execute 票据、所有权、安装代和上下文代校验，宿主从保存清单生成易读确认。仅 system 来源且精确内置 ID 启用智能体，上传及旧原生 IPC 保留原合同。

Application 顺序执行固定计划，每项核验模型/连接/取消和前置状态；100秒调度预算后停止新变更，在途操作按原 SSH 超时收尾。Operations 内部 remove_untagged_image 使用严格完整 ID、Shell 引号、固定本机 socket、远端 RepoTags 再验及 rm --no-prune，无 force；复用原变更锁/反馈及错误日志。操作后重新查询验证删除、运行状态、重启时间或启用状态；失败/未知停止后续项，返回逐项完成、失败、未知或跳过，执行结果只在本地展示。

模型撤销/取消/关闭会清除待执行计划并取消活动任务；执行票据 abort 关联到根 AI 请求，页面关闭或 SDK 超时会停止后续项。Answer/Execution 增加可选 agent 字段，TS 同步；复用现有 IPC/权限与包格式，无数据库迁移或依赖。AssistantAgent 展示查询/清单/复查，点击审核由可信宿主完成一次审批。助手包1.5.0，Host/SDK仍为3.0，兼容旧调用。

## 2026-11-05：内置助手按需上下文与请求预算

application/ai/context 按用户当前问题生成本地采集计划；模糊追问从用户历史继承最近明确领域，不读取模型回答或远端数据中的指令决定采集。复用已有类型化只读查询及临时监控采样，只执行选定来源，不开启后台监控。systemd 为 system 作用域；容器日志不猜测目标，本轮仅提供容器状态并明确缺少日志证据。上传插件和旧原生 IPC 的显式 selection 合同保持。

成功查询先对完整记录统计，再限制发送字段、最多 12 条/4 KiB 明细；指标只含聚合 CPU，磁盘按使用率取前 8 项，网卡前 8 项，journal 外发片段最多 4 KiB。脱敏先于截短，避免截断凭据后漏脱敏。诊断请求不重复附带全资产目录，只携带已命中资产。

ai crate 统一构造脱敏请求，并以实际 JSON wire 字节计费估算和校验 96 KiB 上限。内置入口超预算时清除可选明细并保留全部主机统计/失败，再按完整轮次省略旧历史；请求带 omitted 字段，聊天合并准备和响应阶段的提示。命令权限、SSH 身份/模型版本冻结、取消和单次快照不变，无数据库或 IPC 变更。

## 2026-11-05：资源日志弹窗与容器终端弹窗

删除 services/frontend/logs、旧 OpsLogPanel、工作区 logIntent 导航链和对应样式/打包依赖；系统服务使用三个分类及有界缓存。SDK ResourceView 在原列表内打开共享 ResourceLogDialog，使用原 ops_log_* → 插件桥 → SystemLog* 能力，冻结原会话/来源并在关闭、上下文变化、KeepAlive 隐藏时释放流；旧兼容渲染器同步使用该弹窗，不再提供独立文件日志页。保留有限 UTF-8 缓冲、逐流解码和渲染后 ACK，晚到结果不能遗留远程流。

PluginFrame 将 Shell 事件交给宿主 ContainerTerminalDialog，复用 TerminalPane 的 xterm、输入队列、尺寸同步和关闭生命周期；standalone 状态由弹窗自身维护，不创建主机终端标签或改变插件页。终端在所属 modal 内可聚焦、使用上下文菜单和缩放，关闭时仅释放自身 PTY。旧 log 事件也由同一插件桥授权后在弹窗处理，不再跨插件导航。

services Guest 仅允许 Service 日志来源并移除 SFTP 权限；docker Guest 新增 Container 日志来源及 logs.read，均拒绝其他来源。宿主仅对 System 来源且 ID 精确为 cn.hiboot.plugins.docker 的 ContainerShell 跳过二次确认，授权、完整容器 ID、连接签名、60 秒单次票据与交接复核保留；上传安装不继承例外。无新增 IPC 或数据库迁移，Host/SDK 仍为 3.0.0，两个包更新为 1.4.0。

## 2026-11-06 插件配置弹窗

工作区单独持有当前插件配置弹窗的安装 ID 和可选贡献 ID。贡献 ID 为空时由 PluginSettings 在弹窗内显示启停、权限、访问目录和包信息。宿主通过 Modal、PluginView 和 PluginFrame 渲染已授权配置贡献，使用独立的无主机 owner，授权仍按安装代和已批准的 UI 能力检查。

显示自有配置时，宿主暂时停用背后同插件的交互，让无主机配置贡献取得上下文。内置助手沿用多 owner 及后台请求续接机制，保留聊天 iframe。关闭或切换到权限与详情时恢复可见性，已有模型绑定加载逻辑读取持久化值。助手 1.6.1 的取消及保存完成通过当前系统助手配置窗口的内部消息关闭弹窗。宿主在写入期间禁用关闭，上传包和其他界面无法请求该内部动作。配置弹窗继续支持已授权的声明式表单和独立前端。

## 2026-11-05：插件配置与功能页布局

PluginPage 将自有 settings 贡献放在主区域，PluginSettings 的生命周期、权限和包信息置于辅助区域；容器宽度不足时按配置优先堆叠。移除设置根页面因后代 iframe 而撑满剩余高度的规则，为配置 surface 提供独立可用高度；模型设置内部以 flex 分配候选列表和固定操作区，长列表滚动不挤出保存按钮。权限的展示折叠不影响授权数据、表单校验和上传包默认展开。共享 SDK 资源表格调整行距、滚动上限及粘性表头；系统服务四等分导航、日志表单、Docker 摘要和 AI 快捷问题沿用既有数据及事件。无新增依赖、IPC、数据库或权限变化。系统服务/Docker 包 1.3.1，助手包 1.3.3。

## 2026-11-05：助手模型绑定作为插件配置

助手新增 settings 贡献与独立 SettingsView，公开 SDK SurfaceState 允许本插件 SettingsRead/SettingsWrite；清单增加 settings.read/settings.write，系统自动预置，包版本 1.3.2。model-binding composable 通过既有能力读取/合并写入插件自己的 settings.json（modelId；16 KiB），不保存模型 Key，不新增 IPC、数据库结构或依赖。App 按贡献路由聊天/设置，聊天删除整条模型栏及对应样式，读取绑定模型；返回可见页面时重新加载，模型版本或绑定变化撤销旧对话。

宿主 assistant.use 权限允许设置页获取公开模型列表。Rust 对系统内置助手在工具 stage 与执行前核对持久绑定；空绑定/已删除模型/传入其他模型均拒绝。SettingsWrite 验证登记模型，绑定变化时调用原有 plugin_cancel_tool_requests 撤销该插件的旧票据、预览和建议，不影响其他插件/模型。普通 AI IPC 和上传插件继续原契约，模型凭据仍只由系统库提供。

## 2026-11-05：内置助手固定上下文与免外发弹窗

AssistantView 采用全宽对话，删除侧栏、读取范围、日志及脱敏配置状态；入口主机作为首次匹配线索，后续沿用本次命中目标。首次 SSH 指纹核验在聊天区内显示。宿主根据 PluginSource::System 与 cn.hiboot.plugins.assistant 双重条件识别内置助手，ai_resolve_hosts/ai_send 不再返回 ToolReview，ai_execute 保留独立审核；上传插件不能靠 ID 取得免审。

内置 AiPrepare 使用 ai_prepare_builtin 固定开启上下文和地址脱敏，既有 selection/IPC 不变。固定监控采集器复用同一已验证运维 Transport 临时读取两次，间隔 250ms，不创建后台监控；进程和 Docker 复用原类型化查询，日志固定使用无 follow 的 system journal 最近 100 行/32 KiB。可选数据失败写入上下文及脱敏 warning，连接/资产绑定失效仍中止；取消绑定插件 call token，日志不记录载荷。普通 AI IPC 和上传插件保持原显式采集语义。无新依赖、数据库迁移、任意 Shell 或模型执行权限。助手标准包升级为 1.3.1，保留其他插件版本与用户状态。

## 2026-11-05：删除网络诊断完整调用链

删除 services/frontend/network、compat/network、Guest 的网络工具转发、Core 的诊断 DTO、Tasks 网络队列/本机进程、Application 包装及 Tauri diagnostic_* IPC/ACL；SDK 删除网络权限、工具枚举、诊断操作、分类与专属 intent。Tasks 仅保留 AI/公开 execute 共用的有界 SSH 单次执行、超时、取消和输入通道；监控网卡、端口与 AI 只读查询不改。BackgroundSnapshot 仅返回连接状态；通用下载从 services/tasks 移至 services/download。

系统服务页面缓存上限为四类。Host/SDK 3.0 与系统包 1.3 协商接口移除，保留 ^1.x/^2.x 的其他能力和 ABI/wire 1。仓库先保留原始记录：已知 system 服务的旧权限收窄后由启动标准升级保留 enabled/设置，旧授权按安装代和版本先判失效，避免反序列化已删除枚举；诊断上传包归档停用，旧 payload/data 保留。废弃 backup 指针退出活动反序列化，原始记录已归档。所有迁移故障继续传播，目录链接与范围校验保持。

## 2026-11-05：SFTP 记录归属主机工作区

移除 App 任务中心组件/弹窗、搜索事件和专用样式；设置与默认快捷键只保留 search/settings。ProductPreferences 反序列化 shortcuts 时仅移除历史 tasks 键，保留其他键的严格验证与原配置兼容，无数据库迁移。

TransferPanel 按 hostId 筛选传输及未完成数量。Workspace.close 在主机关闭期间通过 files.closingHosts 阻止新连接和传输提交，Files Store 等待已经发出的连接请求，获取该主机全部文件租约和传输；存在活动传输时复用共享确认对话框，再调用现有 files_close 的取消/排空机制。未保存文档阻止关闭。终端或插件关闭失败保留设备与记录；成功关闭前调用仅限主窗口的 transfer_clear_host，后端持队列锁拒绝清理任何尚未结束的本主机传输，仅移除该 hostId 的内存记录，不操作文件。清理失败不移除工作区。

前端清理成功后移除该主机文件连接和记录，并递增轮询代号，拒绝清理前发出的迟到快照恢复旧记录。其他主机连接和任务保留。后台传输引擎、SHA-256、安全提交、恢复路径、退出检查不变；切换页面只隐藏界面，实际关闭主机才结束本次记录生命周期。以下任务中心章节为历史设计。

## 2026-11-05：主机工具栏直接展示插件

HostTools 将启用且具备功能贡献的安装身份直接渲染为 SSH/SFTP 后的同级按钮，复用 primaryPluginPage 与 plugin 事件传递。App 传入活动插件 ID，extension 页面按该 ID 设置 active 与 aria-current，避免同时选中其他插件。移除下拉状态、Teleport 菜单、定位、窗口/文档监听及专属样式；主机工具栏使用 flex-wrap 在窄窗口换行。主机绑定、插件配置入口、权限和页面生命周期保持，无 Rust、IPC、SDK 或持久化变化。以下工具菜单描述为历史入口。

## 2026-11-05：插件导航集中到设置与主机工作区

NavigationModule 只保留 hosts/assets/system；删除 AppNavigation 的插件侧栏、插件设置事件及安装列表依赖。插件管理 plugins 与单插件 pluginSettings 均映射 system，配置页激活时“插件管理”菜单同时标记 active 与 aria-current。WorkspaceTab 移除 settingsModule 来源字段，openPluginSettings 复用同一配置标签且始终通过 moduleForView 归属设置，不再随入口改变模块。

HostTools 保留已启用且有功能贡献的插件，每个安装身份一项，通过现有 openPlugin 和当前主机打开功能。设备标签、按插件/页面/主机缓存的 pluginPages、草稿和连接生命周期不变；从功能页进入设置后返回设备仍恢复原功能。assistant/network/extension 的模块映射统一为 hosts，以兼容既有全局搜索、插件命令和任务结果跳转，不增加顶部入口或变更贡献协议。无 Rust、IPC、SDK、权限、数据库或持久配置变化。下方较早章节中的顶部运维工具及配置侧栏仅描述当时实现，以本节为准。

## 2026-11-05：系统服务五合一与界面布局

分发清单仅保留 services/docker/assistant。原资源、进程、日志、诊断的 frontend/测试迁入 services/frontend 的各自子目录；现有 systemd 列表成为 ServiceUnits。统一 App 以一个 server 贡献和五分类呈现，通过 KeepAlive 最多缓存五页。SDK usePluginVisibility 将 document/宿主可见性与 Vue 激活状态合并；采样器、资源列表、日志和诊断轮询只在自己的激活页运行。离开日志停止流而保留缓冲/输入，返回监控重新获取资源；隐藏页迟到列表结果被代号拒绝。Docker 两类列表同样缓存输入并在离开时清除详情与待确认操作。

Host/Rust/Vue SDK 升至 2.1：只对 UI v4 扩展 operations.sections 为概览/磁盘/网络/诊断及原运维分类；v2/v3 保持原分类限制，ABI/wire 不变。serverPluginFor 继续按声明匹配，不按内置 ID 路由。网络全局入口通过显式 diagnostics 分类，只有真实声明此分类和 network.run 的包允许无主机打开，不让其他服务器分类隐式选主机。ToolInvoke 的 network 合同仍对上传开放；旧 monitor、operations、network UI 分别复用合并包或兼容资产，不依赖删除的分发包。

服务 Guest 只允许监控、进程/端口/systemd、日志和网络能力；继续拒绝 Docker/AI/任意 execute/设置。逐请求 Host 授权、精确目标确认、队列和资源配额保持。Repository 启动前置归档旧四项 current.source=system（含旧域名）记录；上传源和用户数据保留，services 标准升级仍保存启停/配置/卸载墓碑。无新依赖、数据库或 IPC。

界面采用统一紧凑标题、主机条、五分类导航、搜索工具栏和有界表格；Docker 摘要来自真实列表，不单独伪造统计。AI 将对话与上下文分列且输入区常驻，收起上下文不清除授权草稿，快捷问题不发起请求。

## 2026-11-05：移除两个工具及专属执行链

分发清单、前端路由/搜索/终端菜单、任务中心、桥白名单、Rust/TS SDK、Tauri 命令/ACL 与 Cargo Workspace 同步移除自动运维和批量运维。删除两个完整插件、serverdeck-automation、Core/Storage/Application 业务模块、批量队列和自动化脚本启动器。serverdeck-tasks 保留网络诊断与 AI/插件共用的有界 SSH 命令执行；共享输入通道、编码、取消、配额和 SSH/SFTP 实现继续保留。

Repository 在反序列化 SDK 类型前，通过有界原始记录识别已移除身份/权限，原子移动 packages 记录至 retired，保留 payload、授权文件与 data。新包校验拒绝已移除身份和权限；旧记录不进入列表、资源加载或激活。故障继续传播，拒绝链接和越界路径。

数据库版本维持 7，迁移序号 5 保留为空档：新数据库不再创建旧业务表，已有表及数据不改写，初始化不再构造或启动调度器。Host API/Rust SDK/Vue SDK 2.0 声明接口移除；保留 v1.4 能力范围协商和 ABI/wire 1，旧保留能力的包仍可用。

七个系统包 1.1.3 保留用户启停与设置后升级。模型管理导航为已授权、无数据返回的本地界面动作，成功离开自身页面后只返回空回执；其他请求继续复核活动 owner 和上下文代。验证包括旧启用记录归档、数据保留、删除接口拒绝及七插件真实 SSH，见本轮插件验证记录。

## 2026-11-04：配置入口与运行时回归修复

AppNavigation 仅发出 pluginSettings 事件，使用全部 installed 身份，无需功能贡献或主机上下文。HostTools/主机快捷入口仍打开功能；全局功能可通过搜索进入。配置页不读取功能 UI 或激活业务 WASM。

SDK 收到相同 JSON 上下文时不重新替换 props/主机目录/连接/模型；ResourceView 监听 session ID、连接状态及列表请求值，避免响应同步触发查询反馈。请求队列上限仍为 24，不通过提高限额掩盖循环。

plugin_clear_context 停止交互资源后调用既有 Runtime.deactivate 释放 VM；不关闭共用 SSH 连接，不禁用插件，不停止已提交任务/计划，不清除 iframe 草稿。store 将上下文绑定及激活放在同一插件串行队列内；PluginView 仅在当前 owner 的绑定与激活完成后恢复桥。返回缓存页同样重新激活；准备期间 v-show 隐藏缓存 frame、显示准备状态，激活完成后再开放可见操作，避免 inert 时第一次点击丢失。崩溃 VM 的状态/错误继续保留，须显式重新激活。运行时仍最多八个活动实例，不修改 IPC/SDK/数据库。实际九插件与主机切换证据见[逐项验证](../validation/plugins/PLUGIN_TEST_REPORT.md#2026-11-04配置入口请求循环与九插件逐项验证)。

## 2026-11-04：插件使用与主机工作区统一

Workspace 将设备导航标签与插件页面缓存分离：设备保持 host:<HostId> 一个标签，pluginPages 按插件/贡献/主机缓存，activePluginKey 指向当前功能页。SSH/SFTP 切换只改变设备当前视图；单主机插件归属 hosts 模块，批量/自动化归属全局工具。运维工具侧栏的所有已安装项打开 pluginSettings 配置标签，保留 plugins 模块；设置管理入口打开同一配置标签并保留 system 模块，PluginPage 只负责详情、宿主权限及包声明的 settings 页面；PluginView 负责功能。

PluginView 在显示时按权限自动建立/复用入口主机连接，继续使用真实指纹核验、配置一致性检查和显式重连。插件 store 为每次绑定记录页面 owner，旧页面 release 不能清除另一主机刚建立的上下文。后端仍保持单插件单活跃上下文，未引入多上下文 IPC。缓存 iframe 的桥在请求前后检查页面激活状态和上下文代，既有有界 WASM 队列继续复验；隐藏页面停止交互请求及日志轮询，旧响应不能进入新上下文。SDK 可见性通知用于重开监控和刷新列表，日志输出/表单仍留在原 frame。AI 页面恢复时刷新公共模型列表。

系统标准包为 1.1.2。启动分发复用仓库校验、较高 semver 限制和原子记录切换，仅升级 source=system 的旧安装；新记录在同一提交中继承启停选择，上一安装代保留为备份，随后生成当前系统固定授权。配置、任务、计划和卸载墓碑保留；上传源及较新/同版本安装不覆盖。该部分替代先前“已有系统安装不自动重装”的约定；用户上传流程仍显式升级/授权。Host API、SDK/ABI、包格式、IPC、数据库和依赖不变。

完成标准及实际证据见[插件验证记录](../validation/plugins/PLUGIN_TEST_REPORT.md#2026-11-04插件使用统一)。

## 2026-11-04：插件源码归属与 UI v4

九个插件各自拥有 `plugins/system/<name>/frontend`、`backend`、清单和 UI 契约；页面、交互业务、样式及相关测试随插件维护。前端只引用本目录、公开 `packages/plugin-sdk` 和普通库，Rust Guest 只依赖 `crates/plugin-sdk`。构建器检查源码边界，拒绝导入桌面内部代码或 Tauri。宿主不再静态导入助手、批量、自动化、诊断及五个服务器业务页面。

UI v4 在标准包中携带独立构建的 `frontend.js`/`frontend.css`，Host API 为 1.4.0，Rust SDK 为 1.3.0，TypeScript/Vue SDK 为 1.0.0；ABI/wire 与包格式仍为 1。新增通用 `surface:{kind:"frontend"}`，全新业务插件无需修改宿主工具枚举或路由。内置与上传共用编译、摘要校验、仓库、资源加载器、SDK 桥、WASM 和授权机制；来源仅决定首次分发及既有权限策略。

宿主只承担连接/指纹/凭据、模型提供者、受控系统查询/监控/日志、文件与命令执行、任务/调度/历史和权限审批等公共服务。SDK 包含公开类型、客户端、响应式状态、通用组件和主题基础；这些原生服务的实现仍在 Rust 宿主，SDK 不携带密钥或连接池。插件负责界面编排、用户输入、结果展示及自身 WASM 动作，不直接访问应用 Store 或原生 IPC。

包内脚本运行在独立不透明来源 iframe，主页面仅维护 `PluginFrame`。受限 `sdplugin` 资源协议每次复验安装代、启用状态、授权、页面和文件摘要，只提供可信 HTML 壳及该包声明的两个入口文件。MessageChannel 绑定实际 frame、插件和安装代，白名单桥有并发/速率/大小限制；危险操作的宿主弹窗来自 Rust 冻结输入和真实预览，不能依赖插件的 `confirmed` 或自述说明。

工具标签通过持续挂载加 `v-show` 保留 iframe、状态及草稿，隐藏状态经 SDK 通知监控暂停。设置返回保留原实例，关闭/撤权/升级按原资源生命周期处理。UI v1 表单继续兼容；旧 v2/v3 使用 `plugins/compat` 或分发包内的兼容渲染资源，同样进入 iframe。已有安装不自动重装，不重置授权、禁用选择、计划、历史或用户数据。安全细节和平台限制见[插件安全边界](../plugins/PLUGIN_SECURITY.md)，实际证据见[本次验证](../validation/plugins/PLUGIN_TEST_REPORT.md#2026-11-04插件源码归属与-ui-v4)。下列同日章节按各自当时版本记录。

## 2026-11-04：插件图标配置

Host API 1.3.0 在 Manifest 增加可选 icon，Rust 校验名称格式并透传预览/安装/列表/详情，前端使用共享 PluginIcon 与固定图标映射。九个系统清单声明图标，上传使用同一字段；省略和未知名称回退 boxes。旧 system 安装记录缺字段时，显示层按当前分发清单补默认值，不改写已安装清单、摘要、安装代、启停、授权或卸载选择；user 来源不继承系统回退。图标只使用静态导入的 Lucide 组件，不新增资源协议、权限、数据库或依赖。包/清单格式、SDK 1.2.0 和 ABI/UI 协议版本保持，使用新字段的包声明最低 Host API ^1.3.0。

## 2026-11-04：应用域名统一

应用 identifier 为 `cn.hiboot.desktop`，系统凭据服务为 `cn.hiboot.desktop.credentials.v1`，内置插件继续使用 `cn.hiboot.plugins.*`；QA 应用标识、Docker 所有权标签、发布校验和文档路径同步使用 cn.hiboot。旧应用标识和插件前缀仅在 core/identity.rs 的兼容常量中保留，由目录、凭据及既有插件迁移读取，不用于新安装或新写入。

单实例插件之后、WebView 与 Application 初始化之前，通过 Tauri 插件 setup 迁移默认数据、本地数据、配置、缓存和日志目录。仅将同一父目录下的旧标识普通目录原子重命名为新标识，保留数据库、插件版本/授权/配置及权限；新目录已有内容时优先使用新目录，不合并或覆盖。文件、符号链接和 Windows 重解析点拒绝，错误终止启动。自定义 appDirectoriesOverride 和 QA 标识不执行真实用户目录迁移。升级前须退出旧版，不能让新旧标识的程序并行运行。

NativeStore 新写入使用新服务；读取先查新服务，缺失时读取旧服务并复制到新服务，写入失败按真实错误返回。旧条目保留以便回退，用户明确删除凭据时先删旧条目再删新条目，避免旧值通过兼容回读复活；引用及秘密不写日志或普通文件。无数据库 schema 变化，macOS/Linux 原生目录和凭据迁移仍须平台验收。

## 2026-11-04：任务中心底部弹窗（当前入口）

任务中心从运维工具菜单移回底部状态栏。App 的 taskPanel 控制单个共享 Modal，按需挂载原 TaskCenterView 内容；全局搜索发出独立 tasks 事件，原可配置 tasks 快捷键打开同一弹窗。任务中心从 WorkspaceView 字典及模块映射移除，不创建工作区标签，不改变当前模块、页面和终端。关闭按钮与 Esc 只卸载弹窗；重试或查看结果关闭弹窗并复用原目标导航。原传输、自动化及后台 store、全局轮询、危险操作确认继续复用；无 Rust、IPC、数据库或权限变化。本节替代下方历史记录中运维工具下 tasks 工作区的入口描述。

## 2026-11-04：四个工作区工具标准插件（当前）

新增 assistant、batch、automation、network 四个独立 WASM 包，系统总计九个标准插件。SDK/API 1.2.0、UI v3 的 tool 贡献对上传包同样开放；按声明类型选择可信组件，不按内置 ID 路由。业务 API 注入经 plugin_tool_stage 单次不可变票据、实际 Guest/WASM、ToolInvoke 和原有 Host 服务。输入/结果/AI 引用都有归属、安装代、上下文代与配额，主窗口 IPC 不开放给其他窗口/远程来源。

顶部旧工具组与 plugins 合并，显示名为“运维工具”。工作区/快捷入口只打开启用且授权的贡献，插件管理仍在设置。批量/自动化/网络页按标签保留内存草稿；设置切换不丢草稿，禁用/撤权卸载功能区。公共模型管理、SSH/凭据、任务引擎、调度器、历史和任务中心留在宿主，已提交工作不因插件卸载而删除；任务中心独立提供停止与暂停。详情见 [内置标准包](../plugins/BUILTIN_PLUGINS.md)。

空 examples/plugins 删除，四个开发测试包移至 tests/fixtures/plugins，旧 Nginx 测试插件及其专用验收入口已删除。仓库 plugins/upload 不预置插件、不被启动扫描；客户端上传安装内容仍存于应用数据目录 plugins/upload，安装记录由 packages/<ID>/record.json 管理，只有明确安装后才出现在管理列表和运维工具中。无数据库迁移，不重置已有配置/任务/计划/用户包；本节替代下方历史阶段的五个包及旧菜单描述。

## 2026-11-04：工具菜单与系统预置权限（上一阶段）

HostTools 在 SFTP 右侧增加工具下拉，替代服务器管理常驻按钮；按 enabled 安装身份列出一次，点击使用现有 openPlugin 和当前主机。工具菜单包括没有 UI 的启用包，其进入可信设置；顶部插件侧栏继续保留全部安装身份，方便启用禁用项。管理列表只保留卸载，启停留在自身设置。PluginPage/管理页移除最大宽度与重复内边距，使用工作区可用宽度。

全部插件取消主机白名单，GrantInput 的 hostIds 可省略，旧授权字段兼容读取但忽略，新授权/响应不再序列化；仍要求真实当前主机、同主机/配置租约及资源所有权。系统分发仅对 source=system 的五个已知安装预置完整声明权限、操作和必要根目录，启动时补齐旧授权，保留已有禁用及卸载选择；新系统安装启用，上传安装不自动授权。PluginSettings 禁止编辑系统权限/范围，application grant/revoke 同样拒绝，不能只靠 UI 禁用。危险操作确认和 WASM 隔离保持。以下同日早期章节记录之前阶段，默认禁用/逐主机授权由本节替代。

## 2026-11-04：插件管理与单插件设置分离

管理视图归属 system 设置模块，顶部 plugins 只列已安装插件。PluginPage 包装所有已安装身份，允许禁用/未授权/无 UI 包进入安全的宿主设置；PluginView 仅在启用且具有当前 UI grant 时挂载。禁用/撤权保留自身设置页，只有卸载撤销整个标签；资源仍由 Host 取消/释放，旧排队请求不能跨上下文执行。来源、权限、主机/目录范围和包信息移到自身页面，列表只有启停与卸载。管理页使用原生拖放/文件选择及摘要绑定预览，不提供路径输入、不放宽事件 ACL。

仓库 packages 只保留记录，内容按 system/upload 分目录，配置/授权路径不变。旧内容分代原子移动，冲突/重解析点拒绝；新安装代支持系统包被上传升级时跨来源备份。五个系统 ID 改为 cn.hiboot.plugins.*：保留设置与原卸载选择，旧记录停用归档，新身份默认禁用/重新授权，不改写第三方包 ID。项目上传示例也移动到 plugins/upload，公开构建工具兼容原简名调用。见 [内置标准包与迁移](../plugins/BUILTIN_PLUGINS.md)。

## 2026-11-04：五个独立标准系统插件

服务器管理的资源、Docker、进程与端口、systemd、日志分别位于 plugins/system 的五个独立 crate，只有公开 SDK 依赖，独立编译成 WASM/.sdplugin。应用嵌入标准发行包，启动时通过统一校验/仓库安装一次，初始禁用、未授权；分发标记保留卸载结果，不覆盖已有安装。source=system/user 仅表示分发来源，全部使用同一运行时、权限与生命周期。

公开 SDK 1.1.0 和严格 UI v2 新增 server 贡献及 monitor/operations surface。可信共享组件通过注入的标准桥接调用实际 WASM，再由 Host 逐次检查能力；上传包也可使用完整表格、图表、日志和终端。ServerView 是贡献入口，插件侧栏显示全部安装，来源和详细管理在插件自己的页面。无固定 ID 的原生提供者、独立 builtin IPC 或特权授权。

结构化结果采用有配额/TTL/归属的大结果句柄；监控、日志、审批和单次容器终端票据绑定安装代及上下文。采样共享既有 SSH 池并保留 AI 的真实 transport/时间校验；配置更新、连接重置及插件停止完整作用于资源。详见 [标准内置插件](../plugins/BUILTIN_PLUGINS.md)。此前原生提供者方案由本次标准化替代，旧配置不删除、不自动授权迁移。

## 2026-11-03：13A 插件平台

2026-11-04 导航与语言统一：顶部新增 plugins（插件）模块，插件管理及所有插件工作区通过 types/navigation.ts 归属该模块；navigation/settings 两类贡献只在插件侧栏显示，设置侧栏保留原五项。顶部模块切换仍只改变菜单，不选择页面或重建连接。plugins store 从 application.state.config.product.language 派生只读语言，不再维护或导出独立 locale，管理页与工作区移除选择器；当前全局仍仅简体中文，公开 SDK 的双语标签结构不变。无新增 IPC、配置项、迁移或依赖。

13A-5：`plugins/upload/nginx-manager` 是独立 workspace 的公开 SDK 消费者，仅依赖 plugin-sdk。检测、SFTP 编辑/冲突、真实验证、按主机/摘要/参数绑定的显式重载、日志都在该 WASM 状态机中，不向核心增加 Nginx 专用 IPC。测试另建临时 rootless Nginx/SSH 容器，重载以实际 HTTP 响应变化核验；禁用/升级/卸载只管理插件，不操作远程服务文件。

13A-4：管理页连接真实安装/授权/生命周期 IPC。公开 SDK 增加严格声明式 UI v1，由固定 Vue 组件渲染，不执行包内 HTML/JS，不暴露原生消息。五类贡献按已启用安装代和 ui.contribute 授权动态注册/撤销；单插件单主机上下文复用运维/SFTP 租约，关闭前处理 dirty，崩溃显式重启，主窗口 CSP 不放宽。新增预览摘要绑定与 UI 授权读取/本地包选择三项 IPC；实际 ACL 覆盖共 21 项。主题和插件范围中英切换复用现有样式。详见 [PLUGIN_UI_EXTENSION.md](../plugins/PLUGIN_UI_EXTENSION.md)。

新增 application → plugin-core → core，提供严格本地包、安装仓库、启用元数据、升级备份/失败回滚与数据保留卸载。无 SQLite 迁移；不加载原生动态库，不访问远程 Agent。六项主窗口 IPC 及 TS 契约同步。13A-1 启用只写状态，不执行第三方代码；隔离运行时、权限能力和 UI 在后续阶段按顺序推进。设计详见 [PLUGIN_ARCHITECTURE.md](../plugins/PLUGIN_ARCHITECTURE.md) 与 [PLUGIN_PACKAGE_FORMAT.md](../plugins/PLUGIN_PACKAGE_FORMAT.md)。

13A-2 新增 application → plugin-runtime → plugin-core/core/Wasmi。WASM 无 WASI/原生导入，内存/fuel/消息/并发受限，有界后台执行和单实例生命周期，崩溃不自动重启。启用带后端的插件会实际激活，禁用/升级/卸载/退出清理运行时；五项运行时 IPC 仅授予主窗口。13A-1 的“仅元数据”描述是历史阶段状态，由本段对有后端插件的行为替代。限制和测试见 [PLUGIN_RUNTIME.md](../plugins/PLUGIN_RUNTIME.md)。

13A-3：公开 plugin-sdk 只依赖 serde；plugin-core 复用公开权限类型并在 authorizations 目录绑定安装代/版本/主机/操作/路径授权。application/plugins 复用 Engine 租约、Files 原子编辑器、Tasks 有界 exec/任务、Operations ACK 日志。所有能力在 Rust 逐请求验证，HostCall/resume 协议不开放 WASI；普通 invoke 不能伪造 Host 返回。七项管理/能力 IPC 仍仅授予本地主窗口，配置数据、内部租约和凭据不跨 Guest 边界。接口、资源/取消限制和验证见 [PLUGIN_SDK.md](../plugins/PLUGIN_SDK.md)、[PLUGIN_SECURITY.md](../plugins/PLUGIN_SECURITY.md)、[PLUGIN_TEST_REPORT.md](../validation/plugins/PLUGIN_TEST_REPORT.md)。

## 2026-11-03：关联全部资产、自动匹配与连接

助手移除手动主机选择，发送链路为资产刷新→ai_resolve_hosts→既有 ops_open/事件→ai_prepare→ai_send。useAssistantHosts 管理匹配、顺序连接、120 秒等待和取消，ops.open(host, false) 不改变其他运维页面的 activeHostId。已有连接身份不一致明确拒绝复用；待信任的主机密钥仍由现有 SSH 流程验证，绝不自动接受。

应用层从数据库投影最小 HostAsset（ID/name/hostname/port/username/group）。本地字面值、同名歧义、全部资产及追问规则优先；否则只将脱敏问题、最小目录和 previousHostIds 交给固定系统规则的路由请求。严格解析 HostChoice，拒绝额外字段、未知或重复 ID、超过八台及工具调用；路由不读取服务器内容或执行命令，取消/模型撤销复用 Assistant 的单并发与 active 请求表。HostRoute 返回模型 revision，准备前再次核验。

PrepareInput 兼容保留 sessionId，新增缺省 sessionIds/autoHosts/expectedModelRevision；多连接最多八个且禁止重复主机。autoHosts 模式从当前目录核验连接的主机 ID/地址/端口/用户名；关联目录总是参与脱敏，命中项含 matchedHost，详细上下文仍按原 selection 授权。多主机使用 context.hosts，每项自带主机 ID；准备快照保留所有 related_bindings，发送前逐一核验，任一失效都拒绝。多主机建议一律 manual，单主机仍绑定唯一连接并单条审批。未启动监控时 server 信息可仅含 SSH 端点，只有 metrics 必须存在同 Transport 的有效样本，非 NotFound 监控错误继续传播。

匹配失败、连接失败、取消及清理失败均显示真实原因；命中任一连接失败则不继续生成分析。页面只读展示全部资产数量、命中主机和首次指纹审核，无选择/批量连接控件。自动命中目标变化保留同一资产会话的历史，模型/授权/脱敏变化清空。新增一项本地主窗口 IPC，无数据库迁移、新依赖或任意 Shell 执行能力。验证与限制见 [VALIDATION_ASSISTANT_HOSTS.md](../validation/ai/VALIDATION_ASSISTANT_HOSTS.md)；本节替代历史手动选择服务器的交互约定。

## 2026-11-03：直接对话与受限 Markdown

按用户最新要求，助手聊天 UI 点击发送后直接调用原 prepare→send 管线，不再展示发送预览、费用批准或第二次发送。confirmed 表示用户明确发起发送，非预览审批；底层一次性模型版本/连接/凭据绑定保留。上下文复用原采集和脱敏，命令执行仍独立批准，受控变更仍须输入专属确认语句。

PrepareInput/PreparedContext 增加 history（旧调用缺省为空）：最多十二条/六轮、48 KiB，严格 user/assistant 配对，无 system/tools 角色或额外字段。ai 在固定系统消息与当前 user JSON 之间插入重新脱敏的历史；历史权限声明仍是不可信数据，提供商不带工具。前端 useAssistant 管理最多二十轮内存消息、等待/失败/停止、六轮限量历史和过大回答摘要；不包含命令审批或执行输出，清空/切换模型服务器授权范围后撤销全部旧请求建议。输入草稿不触发撤销。

AssistantMarkdown 使用已有 marked 14.0.0 词法分析，映射固定 Vue h 节点；无 v-html/HTML 注入/任意属性。HTML literal、图片不加载，链接仅 HTTP(S)。包声明为直接依赖，版本及许可已在原锁和清单中。消息区独立滚动，输入位于底部；CSS 使用工作区容器查询，在小窗口将服务器上下文放到聊天下方。没有新增 IPC、数据库迁移或模型执行能力。旧章节的 UI 预览要求由本段替代，历史阶段证据保留。

## 2026-11-03：授权上下文 AI 辅助诊断

新增 `application → ai → core/reqwest/rustls/Tokio`。ai 不依赖 SSH、数据库、凭据库或 Tauri，仅处理脱敏、协议、预览与单条建议授权；ModelProvider 预留其他协议，当前实现 OpenAI 兼容 Chat Completions。应用层负责 OS Key、实际 SSH 运维连接及身份核验，复用 monitor/ops 采集。模型没有工具，固定 system 规则与包含问题/不可信远程上下文的 user JSON 分离，回答以纯文本渲染。

2026-11-03 模型管理升级：已有 application_settings 的 ai_models 行以格式版本 1 保存最多 100 个注册模型，每项含 UUID、名称、config、随机 secret_ref 和 revision。首次访问在 IMMEDIATE 事务内转换旧 ai_config 为“默认模型”，保留配置与原 Key 引用，成功才移除旧行；失败回滚，损坏 AI 数据不进入应用启动路径。无需数据库 schema 迁移或版本变化，独立于 AppConfig。ModelInput 不实现 Debug/Serialize，复用 SecretStore、不可变秘密版本及 durable GC；更改地址须替换/清除 Key，删除单项需明确确认和版本匹配，失败清理返回警告。HTTP 客户端禁止重定向/环境代理/自动重试，HTTPS 保留系统证书验证，HTTP 需显式允许。日志只记录错误类别或状态码。

上下文按 server/metrics/processes/docker/指定日志独立授权，默认全关闭。系统/指标仅复用同一实际 Transport、60 秒内样本；进程/Docker 使用既有固定查询；日志使用类型化 LogSource 的非 follow 快照，1–200 行/32 KiB。PrepareInput 明确传 modelId，后端仅加载对应配置/Key，并在预览中冻结模型 ID/版本和完整脱敏请求，按同一 Value 发送；发送时从预览解析模型 ID，不能改传其他模型。编辑/删除通过 revoke_model 撤销本模型预览、在途 HTTP 和未消费建议，其他模型不受影响；版本变化和删除均不能发送旧预览，5 分钟/8 个上限。

响应只解析 answer/commands，工具调用拒绝，非规范/截断结果只展示。固定命令映射为既有 Request 或新增 Diagnostic(Uptime/Memory/Disk)，未知命令无执行权限。变更仅限严格目标的既有 systemd/Docker start/stop/restart。后端令牌绑定 Session/Transport/profile，10 分钟/64 个、单次消费；变更单独校验完整确认语句。模型 HTTP/执行并发分别为 1；退出取消模型请求，命令沿用 ops 超时/断线取消。执行输出不自动进入模型上下文。

| IPC              | 输入                                                      | 输出                                       |
| ---------------- | --------------------------------------------------------- | ------------------------------------------ |
| ai_models        | 无                                                        | Model 列表，只有 hasKey，无秘密或引用      |
| ai_model_save    | ModelInput（新建或 ID/expectedRevision 编辑，Key 仅输入） | Mutation<Model> 与清理警告                 |
| ai_model_test    | ModelInput（临时 Key 或读取当前模型的已有 Key）           | ModelTest：id、elapsedMs、expiresInSeconds |
| ai_model_delete  | ID + expectedRevision + confirmed                         | Mutation<()> 与清理警告                    |
| ai_resolve_hosts | 模型 ID、请求 UUID、问题、上次命中 ID、脱敏设置           | 已登记 hostIds、澄清信息、modelRevision    |
| ai_prepare       | PrepareInput（单/多 Session、问题、授权、脱敏、模型版本） | 完整 Preview 和输入 Token 估算             |
| ai_send          | 预览 ID + confirmed                                       | Answer/Proposal/Usage                      |
| ai_execute       | Proposal ID + confirmed + 独立变更确认                    | Execution（脱敏本地输出）                  |
| ai_cancel        | 预览 ID                                                   | 撤销预览/建议或取消模型请求                |

九项 IPC 同步到 main capability/AppManifest/handler，仅本地主窗口可调用，删除旧 ai_settings/ai_configure。types/ai 定义 TS 契约，services/ai 封装 IPC，models store 共享列表/选中 ID/更新，ModelsView/ModelDialog 位于资产管理，model-form composable 持有临时 Key 和测试/保存状态，AssistantView 选择模型并承载聊天、授权与命令审核。列表/版本变化会撤销 UI 旧结果，不自动改选其他提供商。详情及验证见 [AI_ASSISTANT.md](../guides/AI_ASSISTANT.md)、[VALIDATION_MODEL_MANAGEMENT.md](../validation/ai/VALIDATION_MODEL_MANAGEMENT.md)。

注册测试调用同一 provider，用固定无服务器数据的消息及 256 Token 上限验证真实补全。成功才在 Assistant 内存签发随机单次 ID（五分钟/32 个），绑定 ID/旧 revision/config 与 Key 的 SHA-256 摘要；ai_model_save 对新建、配置修改或 Key 替换先核验并消费测试 ID，再写系统凭据/数据库。重命名及单独清除 Key 保留离线编辑能力。新增 model_test 模块复用同一 HTTP 并发、超时和退出取消；仅复用锁内已有 sha2 0.10，无新依赖包或存储迁移。

基线：`docs/product/PRD.md` v1.0；当前实现基础设施、主机/凭据管理、真实 SSH 终端、SFTP 文件管理、Agentless Linux 监控、当前主机运维，网络诊断、显式批量运维，以及可复用命令/脚本与本地计划。2026-11-02。

## 范围与原则

2026-11-03 主机行操作入口归并：HostTreeControls 不再渲染行内编辑/删除按钮，仅保留供 HostSidebar 右键菜单调用的编辑与删除确认弹窗。移除图标导入、悬停/焦点显隐样式和两个按钮的右侧预留空间；主机行保留单个主机按钮。右键菜单、键盘入口、目标绑定、保存/删除失败处理及连接生命周期继续复用原流程。此项替代下文历史行内操作区约定，无 IPC、数据库或依赖变化。

2026-11-03 根目录与多级主机文件夹：HostSidebar 删除顶部整条管理分组/刷新/新建工具栏，布局为固定本地设备、全部主机/导入导出、搜索框、可滚动树。新增 services/host-tree 的层级/祖先/路径计算；内置 null ID 根目录容纳旧未分组主机，旧分组的 parentId 默认 null，按真实父目录显示多级文件夹。选择深层主机展开祖先，搜索展示匹配祖先，有界主机加载不变。

右键目标为 folder（含根目录）或 host 的联合类型。仅文件夹菜单提供新建，根目录没有删除/重命名，主机菜单复用 HostTreeControls 的编辑/删除确认与 host_copy 用例；复制结果通过 saved 定位，不发起连接。GroupManager 改为按固定父目录创建/重命名文件夹的单一表单；App 将 create(groupId) 传入 HostDialog，主机表单不再选择分组。菜单处理键盘焦点、窗口边界及失焦/缩放/滚动/模块隐藏时关闭，不替代系统剪贴板或终端菜单。

SQLite v7 追加 007_host_folders.sql，为 host_groups 增加 parent_id 自引用外键、禁止自身引用的 CHECK 及索引，保留旧表、ID、唯一名称和主机归属。group_save 在 IMMEDIATE 事务内校验父目录存在及祖先无环；group_delete 在同一事务内将主机和直接子文件夹提升至父目录后删除当前文件夹，不递归删除内容。HostGroup/GroupInput 与 TypeScript 同步 parentId，旧输入缺省为 null。

主机配置导出升级 v2，包含文件夹 ID/parentId 和主机 groupId。旧应用拒绝 v7 数据库，避免误降级。此项替代下文历史单层分组、禁止主机右键和顶部工具栏的约定。

2026-11-03 根目录与多级主机文件夹：HostSidebar 删除顶部整条管理分组/刷新/新建工具栏，布局为固定本地设备、全部主机/导入导出、搜索框、可滚动树。新增 services/host-tree 的层级/祖先/路径计算；内置 null ID 根目录容纳旧未分组主机，旧分组的 parentId 默认 null，按真实父目录显示多级文件夹。选择深层主机展开祖先，搜索展示匹配祖先，有界主机加载不变。

右键目标为 folder（含根目录）或 host 的联合类型。仅文件夹菜单提供新建，根目录没有删除/重命名，主机菜单复用 HostTreeControls 的编辑/删除确认与 host_copy 用例；复制结果通过 saved 定位，不发起连接。GroupManager 改为按固定父目录创建/重命名文件夹的单一表单；App 将 create(groupId) 传入 HostDialog，主机表单不再选择分组。菜单处理键盘焦点、窗口边界及失焦/缩放/滚动/模块隐藏时关闭，不替代系统剪贴板或终端菜单。

SQLite v7 追加 007_host_folders.sql，为 host_groups 增加 parent_id 自引用外键、禁止自身引用的 CHECK 及索引，保留旧表、ID、唯一名称和主机归属。group_save 在 IMMEDIATE 事务内校验父目录存在及祖先无环；group_delete 在同一事务内将主机和直接子文件夹提升至父目录后删除当前文件夹，不递归删除内容。HostGroup/GroupInput 与 TypeScript 同步 parentId，旧输入缺省为 null。

主机配置导出升级 v2，包含文件夹 ID/parentId 和主机 groupId。旧应用拒绝 v7 数据库，避免误降级。此项替代下文历史单层分组、禁止主机右键和顶部工具栏的约定。

2026-11-03 主机列表操作调整：移除 HostSidebar 的三点入口、toolsOpen 及折叠工具面板；hosts store 删除 HostSort/sort 及地址、修改时间排序分支，查询结果保持原默认名称和 ID 顺序。“全部主机”标题移到本地设备下方、远程列表正上方，右侧以两个独立图标按钮触发原 import/export 事件，沿用原 App 弹窗、API 和错误提示；标题及操作不参与列表滚动。保留未加载/操作中的禁用状态，清理面板专用样式和验收工具的旧入口定位。不增加 IPC、迁移、配置或依赖。此项替代下文历史布局中的主机树工具和排序设置描述。

应用运行于本地，通过 SSH/SFTP 管理 Linux，不需要云账号、HTTP 后端或远端 Agent。
当前实现应用壳、主机/分组 CRUD、搜索排序、安全凭据引用、OpenSSH 预览导入及非敏感 JSON 导出，保留第一阶段配置/日志/生命周期。

2026-11-03 主机管理精简：HostDialog 移除标签、备注和收藏控件；HostSidebar 移除标签/收藏筛选及收藏图标，“全部主机”改为静态标题并保留总数。hosts store 删除 tag/favorites 状态，filterHosts 仅按名称、地址和用户名查询，保留排序、分组和有界加载。HostInput 的历史字段与 Rust IPC、SQLite 和主机配置导出格式保持兼容，hostInput 在编辑及移动分组时原样传回，避免清空用户数据；无需数据库迁移。下文历史布局中的标签/收藏筛选描述由本条替代。
生产 SSH 位于 `crates/ssh`，已链接桌面应用；终端使用真实 Linux PTY，无模拟数据，支持多标签、可调整分屏、代理/跳板和端口转发。SFTP 文件管理、后台传输和 Monaco 文本编辑已接入；原有探针独立保留，Agentless 监控和 Docker/日志/进程/端口/systemd 运维已接入。

## 工程与依赖

```text
Cargo.toml                         Rust workspace / shared dependencies / lints
package.json                       npm workspace / common verification commands
apps/desktop/
  src/
    components/SettingsPanel.vue   settings form
    views/HostsView.vue            real host inventory and details
    views/CredentialsView.vue      secret reference management (no readback)
    views/AboutView.vue            product information and real backend diagnostics
    stores/                       Pinia: application + host catalog/loading/error
    services/                     typed IPC boundaries
    composables/theme.ts          theme resolution and OS preference subscription
    types/ipc.ts                  explicit camelCase IPC contract
    styles/                       shared dark/light design tokens and layout
  src-tauri/
    src/commands.rs               thin Tauri commands
    src/lib.rs                    composition root, paths, single-instance, shutdown
    capabilities/main.json        local main window command allowlist
crates/
  core/                           DTOs, configuration validation, safe errors
  application/                    use cases, bounded DB work, shutdown, logging
  storage/                        SQLite connections, migration, config repository
  security/                       OS credential store, zeroizing secret boundary
  ssh/                            russh transports, authentication, trust, PTY, bounded streams
  sftp/                           SFTP v3 filesystem, background transfers, guarded editor saves
  monitor/                        fixed SSH sampling, delta metrics and bounded history
  ops/                            typed host operations, bounded exec and ACK log streams
  tasks/                          local/remote diagnostics and bounded shared SSH command execution
tools/ssh-probe/                   independent real SSH/SFTP protocol spike
docs/                             requirements, architecture, plan, validation
```

当前依赖方向额外包含 `application → sftp → ssh/core/Tokio/russh-sftp`；SFTP 不依赖 Tauri，原生选择器位于桌面层。

当前依赖方向：`desktop → application → storage → core`，`application → security → core`，`application → ssh → storage/core/Tokio/russh`。SSH 不依赖 Tauri，Channel 通过窄 Sink 回调注入。
core 不依赖 Tauri、数据库、Vue；storage 不依赖 UI；前端只调用声明过的 IPC，不访问 SQLite、文件系统或本地 Shell。
application 直接使用具体 storage 类型；仅秘密存储定义窄接口，供真实 OS 后端和故障注入测试使用，不引入通用依赖注入框架；本地自动化执行器为具体用例，见文末。

模块状态：

| 模块                    | 职责                                                        | 允许依赖                                    |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| security（已实现）      | OS 凭据存储、秘密生命周期                                   | core、原生系统凭据库                        |
| ssh（已实现）           | Transport、认证、主机信任、Channel、PTY、流式输入输出及断线 | core、storage、Tokio、russh 0.65            |
| sftp（已实现）          | 目录、文件操作、传输、取消、冲突                            | core、ssh 的 Channel 能力、russh-sftp 3.0.1 |
| monitor（已实现）       | SSH exec 采集、差分计算、有界采样历史                       | core、ssh                                   |
| application（逐步扩展） | 主机用例、连接注册表、Session/Task 所有权协调               | 上述具体模块                                |

不会预先创建空 crate。xterm.js 6 与 fit/search 插件已接入；Monaco 0.57 按需加载，仅用于 UTF-8 文本编辑。

## 当前数据流与 IPC

```text
Vue mounted → Pinia.initialize → invoke(app_bootstrap)
  → Tauri 本地 main 窗口 ACL
  → Application.bootstrap
  → Tokio spawn_blocking → SQLite → 已校验 Bootstrap DTO
  → Pinia → 真实版本/路径/数据库状态

设置表单 → invoke(config_save, {config})
  → DTO 反序列化（拒绝未知字段） → Rust 范围与版本校验
  → 有界阻塞任务 → 参数化 SQLite upsert → 成功后更新 Pinia/主题
```

| 命令          | 输入                  | 成功输出                                                         | 错误     |
| ------------- | --------------------- | ---------------------------------------------------------------- | -------- |
| app_bootstrap | 无                    | appVersion、databaseVersion、dataDirectory、logDirectory、config | IpcError |
| config_save   | `{config: AppConfig}` | 已持久化的 AppConfig                                             | IpcError |

主机/凭据新增命令：`host_list`（返回 Catalog：主机、分组、凭据元数据、待清理数量）、`host_create`、`host_update`、`host_delete`、`host_copy`、`group_save`、`group_delete`、`credential_save`、`credential_delete`、`credential_status`、`credential_cleanup`、`hosts_import_preview`、`hosts_import`、`hosts_export`。
所有命令使用同一 AppManifest 和 main capability 白名单。没有读取秘密的 IPC、任意本地文件或 Shell API。
CredentialInput 只反序列化、不实现 Debug/Serialize，秘密在 Rust 使用 Zeroizing；前端仅在临时表单中持有输入，提交/卸载清空。JS 内存无法保证清零，不作此承诺。
普通 mutation 成功后重新读取 SQLite；失败不会在 Pinia 中生成假主机。已提交但旧秘密清理失败通过 Mutation.warnings 提示，避免把已保存的操作误报为完全失败。

`IpcError = {code, message}`；稳定 code 包含 VALIDATION、VERSION_UNSUPPORTED、STORAGE、BUSY、WORKER、SHUTTING_DOWN、NOT_FOUND、CONFLICT、SECURE_STORE_UNAVAILABLE。
不把 SQL 错误、输入正文或敏感参数原样跨 IPC 回传。Tauri 自身的协议/权限拒绝也必须作为失败处理。
存储与后台 JoinError 在 Rust 内保留 source 原因链；日志仅记录 SQLite 数字错误码、IO/JSON 分类或任务失败类别，不输出原始错误载荷。
Rust 与 TS 都显式定义 DTO；Rust IPC 测试验证实际序列化、命令派发和 ACL，TS 测试验证前端契约与错误路径。未来 DTO 数量增长时再评估代码生成。

普通浏览器预览没有本地 IPC，界面明确报“未连接 Rust 后端”，不回退到 mock 数据。

错误文案统一经 `composables/error-notifications.ts` 进入既有有界 notifications store。共享 store 在自身作用域观察错误与连接状态，页面/弹窗只观察其局部错误；同步观察保留同一 tick 内清空后重试的失败通知，快照比较避免轮询重报。文件传输的原因与恢复路径合并进通知，后端错误对象及恢复数据继续保留。

`NotificationToasts.vue` 是唯一错误展示入口，固定右下角，保留告警语义与关闭按钮。它捕获原生表单 invalid 事件并替换浏览器字段气泡，聚焦本次首个无效字段；同一轮校验只提示一项。原生 dialog 打开时将通知容器移动到当前弹窗内并通过 manual popover 进入顶层，避免被 backdrop 遮挡或因 modal inert 而无法关闭；弹窗关闭后移回 body。页面不渲染错误文案，失败状态、重试动作、样本过期标记和安全确认继续独立呈现。不增加 IPC、数据库迁移或第三方依赖。

## 主机工作区布局

2026-11-03 模块导航布局：AppModules 提供顶部四个大模块，AppNavigation 接收明确的当前模块并显示其菜单。`types/navigation.ts` 穷举视图所属模块；workspace.module 独立保存顶部选择，selectModule 只更新该值，不改变 active、current 或 hostId。中央继续渲染原活动页，原终端保持挂载、可见和会话上下文；无活动页时保留欢迎页，不渲染“请选择功能”卡片。显式点击左侧功能或页面标签调用 navigate/activate 时，同步顶部模块与对应菜单。移除最近模块标签 Map，不再因顶部切换自动恢复另一个页面。仅主机运维模块展示主机树，已有草稿、PTY、SFTP 和后台任务保留。

主机运维侧栏使用 HostSidebar，其他模块隐藏主机树并保留其状态。HostTools 移至中央 workspace-header 右侧，在三个远程主机页面显示并沿用 navigate 和 HostId；本地及全局页面不显示这组菜单。终端会话和新建按钮仍由 TerminalsView Teleport 到稳定容器，PTY 组件、Pane key 和连接所有权不变。移除 WorkspaceTab.filesOpen、文件面板入口及挂载逻辑，窄窗口通过工具栏换行和菜单内部滚动适配。

AppNavigation 在 system（设置）模块依次展示通用、终端、快捷键、工作区与连接、关于；顶栏 system 按钮用 margin-left: auto 贴齐最右侧。types/product.ts 中 settingsCategories 统一分类 ID、WorkspaceView 和标签，原 settings: 保留为通用入口，新增 settingsTerminal:/settingsShortcuts:/settingsWorkspace:，移除未持久化的 overview: 页面。各分类仍复用一个 SettingsPanel，App 只要存在设置分类标签就保持实例挂载，按当前分类控制显示；关闭全部设置分类标签销毁草稿。校验通过 category 事件请求 App 导航后聚焦字段，侧栏、顶栏与工作区标签同步。about: 继续是唯一全局标签，AboutView 合并产品信息和原 WorkspaceView 的后端诊断及重新检查，删除旧页面组件；加载、保存时禁用重新检查，保留版本/诊断读取中及未就绪状态。全局搜索沿消息字典自动覆盖新分类。配置、IPC、数据库及连接所有权不变。

FilesView 仅保留完整文件页，移除 compact 属性、专用布局和样式。终端文件事件经原 currentConfiguration 校验后 navigate 到 files，继续向 files.open 传递路径与来源窗格。切换主机前同步 files.active，沿用每主机 FileConnection 的实际连接快照、路径及传输/编辑/安全确认流程；卸载页面仅清理拖放监听，不关闭 SFTP、终端或传输。无新增 IPC、数据库迁移或依赖。

## 存储、配置与日志

- 数据路径通过 `tauri::Manager::path().app_data_dir()` 获取；日志通过 `app_log_dir()` 获取。安装目录不参与数据写入。
- SQLite 绑定 bundled SQLite，避免依赖用户预装数据库。
- `PRAGMA user_version = 8`。001–007 保留既有迁移，008 在 IMMEDIATE 事务内重建凭据表并校验外键，支持系统凭据库中的导入私钥。旧凭据 ID、版本、路径和主机关联均保留，迁移失败回滚，未来版本拒绝降级。
- `application_settings` 的 `app_config` 保存版本化偏好 JSON，是配置唯一真源；不维护第二份普通 JSON 配置。
- hosts 使用 UUID、强类型字段、端口/超时 CHECK、分组和凭据外键。tags 为经过校验/去重的 JSON 数组。凭据类型在事务内与主机认证类型匹配；Agent 禁止附带 credential_id。
- `HostInput.name` 仍为字符串，空字符串表示未填写；后端 trim 后只校验非空名称的 128 字符及控制字符限制，分组/凭据名称仍必填。006 重建 hosts 时保留 ID、时间、关联、SSH 选项和索引，仅放宽名称长度下界。前端 `hostDisplayName` 与 Rust `display_name` 优先使用名称，否则按地址及非 22 端口展示；树、标签和主机选项保持一致。复制主机以显示名称加“副本”生成名称。编辑继续读取原始 name，地址/端口变化可实时改变未命名主机的显示名。
- host_groups 没有 parent_id，只支持单层。删除分组将主机移到未分组；删除主机不删除共享凭据；复制只新建 HostId，并共享原凭据引用。
- credentials 保存名称、类型、旧式私钥路径、opaque secret_ref 和 revision。密码、私钥正文和解锁口令存储边界在系统凭据库及临时内存。删除关联凭据须明确确认解除关联，主机保留并显示待配置凭据。
- 配置 version=1；默认深色、侧栏 248px、字号 14、连接超时 15s、采样 3s、INFO。后端拒绝非法数值与未知字段。仅界面/运行偏好，不允许密码或密钥字段。
- 小规模设置读写每次创建连接，5s busy timeout、foreign_keys=ON。当前使用默认事务日志，不引入连接池或 WAL；正式主机模块与实际并发需要时再评估。
- SQLite 与 OS 凭据操作在 `spawn_blocking` 内；本地元数据单任务执行，最多接纳 16 个在途/等待请求，等待额度最长 3 秒，超限返回 BUSY。元数据写入与新窗格读取凭据可有界排队，避免普通分屏因瞬时竞争失败；SSH 输出完全独立。
- tracing 仅记录固定操作名称/结果，不记录 DTO、终端内容、文件正文、凭据、私钥或任意错误对象。依赖库日志默认关闭，RUST_LOG 不覆盖本策略。
- 日志后台队列上限 512 条，满时丢弃；当前文件及 3 个轮转文件，每个最大 1MiB，超大单条丢弃，总量上限 4MiB。Windows 先关闭句柄再 rename。WorkerGuard 保持到应用退出以刷出队列。
- 日志等级更改保存后下次启动生效。主题和侧栏宽度在保存成功后生效；system 主题监听 OS media query。

### 系统凭据与跨存储一致性

keyring 4.2 的 v1 后端在 Windows 使用 Credential Manager、macOS 使用 Keychain、Linux 使用 Secret Service。没有内存或普通文件 fallback。当前已实际验证 Windows；其他平台尚未验收。
秘密使用 UTF-8 bytes 写入系统服务，最大 2048 字节；服务名为 ServerDeck 专属命名空间，引用由后端生成随机 UUID。前端只看到 hasSecret 和关联主机数。
新建 private_key 凭据通过选择文件导入，解锁口令仅用于导入。旧路径和 OpenSSH Config 导入凭据可继续引用源文件并保存其解锁口令，编辑时可选择文件原位迁移。SSH Agent 认证复用用户已有的系统代理。

SQLite 与系统凭据库不能共享事务，因此采用小型意图记录及不可变秘密版本：

1. 新秘密引用先进入 secret_gc（只有 opaque ID），然后写入 OS 库。
2. SQLite 事务更新元数据引用、增加 revision、移除新引用的清理意图，并登记旧引用待清理。
3. 提交成功后删除旧秘密。失败则保留 tombstone，界面提示并提供重试清理。
4. 数据库提交失败补偿删除新秘密；崩溃或清理失败时意图仍可恢复。不静默丢弃已有秘密，也不复用旧 entry 原位覆盖。

服务不可用时秘密写入失败，原凭据引用保留，不创建明文替代；只修改非秘密元数据或无口令路径引用可以独立完成。带关联的凭据删除需要明确选择解除主机关联；OS 删除失败会明确显示尚有旧秘密待清理。

### OpenSSH Config 导入

前端通过文件选择器读取或粘贴 UTF-8（最大 1MiB），Rust core 解析并预览。支持 Host、HostName、Port、User、IdentityFile、ConnectTimeout、ServerAliveInterval、ServerAliveCountMax 和受限 ProxyJump，大小写不敏感关键字、双引号、注释、等号、首次赋值规则，以及对明确别名匹配的 * / ? / ! 模式。
解析限制为 10000 行、500 个明确别名及有界参数/警告，防止外部配置放大预览内存；导入路径与手动凭据遵循相同长度/字符边界。
多个 IdentityFile、ProxyCommand、未知影响端点/认证/信任的选项阻止条目导入；Include/Match 无法安全确定影响时阻止文件条目。compression 等未实现项显示警告。ProxyJump 仅接受一个明确的受管 Host 别名或 none；逗号链、user@host:port 和 token 展开拒绝。受管主机可递归引用最多 4 个跳板，循环/缺失/重名或同名端点不一致阻止提交；选中条目按依赖在同一事务内导入。通配符不展开为资产，缺省用户取本地当前用户名；预览显示实际用户、认证方式和超时。
导入提交重新解析原文并校验选中别名，SQLite 事务内再次检查同名或同 hostname+port+username，重复跳过，不覆盖。IdentityFile 只生成路径凭据引用，口令需另行设置。无 SSH Config 写回接口。

## 应用生命周期（当前实现）

1. 注册单实例插件；第二次启动聚焦已有主窗口，不重复初始化数据库。
2. 获取标准用户目录，创建/迁移数据库，读取并校验配置，初始化日志，托管 Application。
3. 启动本地计划调度循环；前端通过 IPC 读取启动状态；组件异常与未处理 Promise 拒绝进入全局可见错误提示。
4. 收到退出请求先评审未完成传输、诊断/批量/自动化任务和未保存文档；用户确认后置 shutting_down，拒绝新用例，依次排空 automation、tasks、Operations、Monitor、SFTP、SSH/转发，最后等待在途 SQLite 写入。
5. 最终释放状态和日志 guard。传输可跨页面后台运行；监控页面隐藏后暂停采样，没有托盘常驻。

无法初始化本地数据库/配置/日志时启动失败，保留原文件；不销毁数据库重建。启动前的错误只能通过启动进程 stderr/错误结果诊断，不承诺已具备完整图形恢复向导。

## SSH 连接和终端生命周期（已实现）

持久 `HostId` 与运行时 `ConnectionId`、`SessionId`、`TaskId` 分离。工作区只持 HostId 及关联句柄，不拥有全部 Transport。

```text
Connection: Disconnected → Connecting → AwaitingHostTrust → Authenticating
            → Connected → Disconnecting → Disconnected
            ↘ Failed（阶段与原因）
Session:    Creating → Running → Closing → Closed / Failed
Task:       Queued → Running → Completed / Failed / Cancelling → Cancelled
```

Connecting 不等于已登录；只有主机信任与认证成功才发布 Connected。
未知主机展示算法和 SHA256 指纹，用户显式接受后写信任记录再继续；改变密钥硬性阻断；不支持的算法单独报错。
本机 `ssh_known_hosts` 以规范化 hostname+port 为主键，保存完整规范公钥、SHA256 指纹及信任时间。首次握手在后端挂起认证，UI 显示算法与指纹，确认必须对应仍存活的会话挑战，60 秒超时拒绝。INSERT OR IGNORE 后再次比较，竞争确认不能替换已有密钥；证书默认拒绝。此表是应用自己的信任库，尚不导入系统 known_hosts 的哈希/CA/撤销语义，没有覆盖变化密钥的快捷入口。

Application 拥有 Engine，Engine 注册表拥有 Transport/Session。复用键包含 HostId、端点、用户名、认证方式、凭据 ID 和 revision，不能把更新后的凭据复用到旧认证上下文。Transport 可承载独立 PTY 和显式创建的 TCP 转发 Channel；SFTP 使用独立租约和子系统 Channel；只有用户确认的文件目录/less/tail 操作可以创建固定 exec PTY，没有任意本地 Shell API。复用键额外包含所有跳板端点、认证引用/revision、超时/keepalive 选项与代理凭据 revision，路径改变不能复用旧连接。
关闭一个窗格只取消它的 PTY/输入/输出及所属转发，发送 Channel close；关闭标签遍历其窗格。最后一个 Session 释放后断开 Transport；断网会使所有关联 Channel 失败。关闭主机全部连接先同时发出取消，再等待各任务退出。切换视图/标签保持 xterm 挂载和 ACK。手动重连创建新的 Session 和 Shell，不重放输入；其他会话仍在线时可复用已认证 Transport。

每个 Session 有 CancellationToken 和 JoinHandle；总上限 32。注册表的同步锁只做短暂查找/更新，从不跨 await；单 Transport 的异步锁只覆盖初始化/认证和 Arc 连接句柄取用，Channel 创建与转发网络等待不占该锁。读写半部独立运行，输出等待 ACK 时仍可写入 Ctrl+C 或关闭。TCP/代理、握手、PTY 使用主机连接超时；认证有独立 1–120 秒超时；指纹确认时间独立。每跳 Keepalive 可设 1–3600 秒、1–10 次未答复，默认 15 秒/3 次；有静默 TCP 黑洞测试。

数据流：远端 PTY → russh ChannelReadHalf → 每块最多 16 KiB 的 Tauri Channel 消息 → Uint8Array → xterm.write(callback) → terminal_ack → 读取下一块。最多一块尚未解析的输出，不进入 Pinia/日志，不在后端拼接 UTF-8。SSH window 64 KiB、每 Channel 队列 16 条；前端滚动缓冲默认 5000、可配 0–20000 行。russh 内部控制队列不是全有界，应用只开放有限会话及输入/resize/ACK；不承诺对恶意服务端具备进程级硬内存配额。

输入每次最多 16 KiB、后端 8 条、前端普通输入最多 128 KiB；用户确认的单次粘贴最多 2 MiB（含边界预留）。输入按 16 KiB 分块，BUSY 时等待重试，超限明确提示未发送，重连清空旧代队列。resize 用 watch 合并为最新尺寸（2–500 列、1–300 行），前端 80ms 合并，只传 cols/rows，排除 xterm 6 未在类型中声明的内部字段。大量输出及未 ACK 时不继续发送的行为均有测试。

SSH 输出在 xterm 前经过 services/zmodem.ts 的有界握手识别器，保留最多一个未完成初始化头，跨 IPC 分片校验 CRC；普通文本直接显示。协议编解码使用固定 zmodem.js 0.1.10，识别 `rz` 后自动调原生选择器，不向远端注入 Shell 命令或另建 SFTP 连接。传输响应按字节消费以保留同一 SSH 块中的 ZFIN 和后续提示符；即使等待文件选择，当前块仍经 xterm 写入完成屏障 ACK，不能因 UI 等待停止接收保活响应。

新增仅本地 main 窗口允许的 terminal_upload_pick(id)、terminal_upload_read(id, token, index, offset)、terminal_upload_release(id, token)。后端仅为已就绪的 SSH 终端生成批次 token；原生选择器返回的路径直接在 Rust 中打开，只向前端返回 token、文件名和大小。读取不接受路径，校验会话与批次，单块 8 KiB、最多 32 个在途读取，文件变更则失败。每会话最多一批，全应用最多 32 批，每批最多 100 个文件，单文件小于 4 GiB。文件数据复用有界终端输入队列，并等待 flush 后读取下一块。协议步骤 30 秒超时，选择器等待期间发送保活；取消选择正常关闭协议，取消上传发送 CAN，断线/关闭自动释放批次和文件句柄，晚返回的选择无法附着到新会话。退出确认将待选或上传中的批次计入未完成任务。ZMODEM 状态归属终端，不纳入可脱离终端的 SFTP 后台队列；不记录内容、自动重试或支持 sz 下载。

终端命令：terminal_open（流式 Channel）、terminal_input、terminal_resize、terminal_ack、terminal_trust、terminal_close、terminal_close_host。没有读取秘密或任意本地执行命令的接口。终端模拟器处理 ANSI/VT、UTF-8、256/True Color、alternate screen、鼠标协议与组合键；查找只搜索本地滚动缓冲，复制粘贴通过受控原生文本剪贴板 IPC，不请求网页剪贴板授权。

### 终端布局、偏好与生命周期

2026-11-06 字距修复：TerminalPane 可先建立 xterm 缓冲及输入输出监听，只有窗格活动且容器宽高均非零时才调用一次 `open`。隐藏期间的显示偏好和字号更新延迟到再次可测量时应用，再执行 fit；避免 xterm DOM 渲染器将隐藏元素的零字宽缓存成额外字距。切页不重建 xterm 或 Shell，后台输出及 ACK 继续处理。

Linux 默认字体回退：`services/terminal-font.ts` 在 Linux 将旧默认字体栈 `Cascadia Mono, Consolas, monospace` 解析为系统 `monospace`，避免 WebKit/Fontconfig 将缺失的首选字体替换成比例字体，导致 xterm 为窄字符逐个补入明显间距。仅在渲染时解析，不改写已保存配置；用户自定义字体和其他平台的既有解析保持原样。

用户追加的本地交互终端由 application 内的 `LocalTerminals` 管理，通过 portable-pty 0.9 使用 Windows ConPTY / Unix PTY；Windows 固定启动系统 Windows PowerShell（`-NoLogo -NoProfile`），Linux 固定 `/bin/sh -i`，初始目录为当前用户目录。`terminal_local_open(size, events)` 仅接受尺寸和事件 Channel，不接受可执行文件或启动命令，返回 `{id, shell}`；现有 input/resize/ack/close 根据 `local:` 会话 ID 分派。仅本地 main 窗口授权，不增加通用 shell 插件权限。输入和输出均不记录到日志。

本地最多 16 个会话，每会话 64 条有界输入/尺寸消息，单次输入最多 16 KiB；输出每帧最多 8 KiB，解析 ACK 前不发送下一帧，30 秒未确认取消会话。阻塞 PTY 操作位于专用阻塞任务/输出线程，不占用 Tokio 异步执行线程。关闭会话、页面重新加载及应用退出均取消并回收本地 Shell 和 PTY；关闭超时明确失败。ConPTY 清理期间继续排空输出，避免关闭伪终端时管道阻塞。启动仅显示欢迎页，终端列表为空，不创建本地 Shell、恢复旧标签、自动登录或重放命令。本地 Shell 中主动脱离终端运行的进程不承诺随页签结束。

前端窗格以 `host: null` 表示本地，使用已有 xterm 输入、复制粘贴、查找、分屏和标签；隐藏 SSH 专用的文件/运维/监控/转发动作。旧版布局 IPC 中 `hostId: null` 表示本地，原字符串 HostId 继续兼容；产品不再读写该记录，SQLite schema 不变。单击主机树恢复对应工作区，终端工具显式新建独立会话；主机配置在树行编辑或确认删除，移除复制入口，按钮在悬停或键盘操作时显示。工作区和终端页签的关闭操作均复用原终端会话清理逻辑，工作区中键同样关闭该设备的全部终端。

工作区导航没有固定默认页签，允许 tabs 为空、current 未定义；此时显示欢迎页。首次初始化和重启均不调用本地终端导航，不读取旧终端布局，用户显式打开设备工作区时才创建一个新会话。HostSidebar 内置的“本地设备 / 本地终端”独立于当前主机和筛选结果，位于固定筛选栏之后、滚动列表之前；通过 localTerminal 事件由 App 显式执行 navigate('terminals', '')，新建或复用本地会话。远程主机工具使用另一个插槽，不能替换该固定菜单。AppNavigation 的“主机管理”为无图标、不可点击的静态标题，不再发出 workspace 事件。最后一个导航页签关闭后不补页签；关闭某主机/本地设备的最后一个实际终端时，清除对应的空终端导航页签。欢迎页保留打开本地终端和新建主机，不在空工作区自动创建连接。主机栏展开按钮固定在标签栏左侧，聚焦不重置横向滚动，收起/展开后重新定位当前标签，避免窄窗口活动标签移出可见范围。

Pinia 区分 Tab、Pane 和 Session：一个标签包含 1–8 个窗格，全应用最多 32 个。二叉树只描述 rows/columns、10–90 比例和 PaneKey；xterm 组件以固定 PaneKey 平铺挂载，通过百分比定位，拖动不会重建 Shell，后台标签持续消费 ACK。标签支持拖动、重命名、关闭单个或当前主机全部会话。焦点只在明确切换或连接时变更，ResizeObserver 不抢占搜索框。

默认“会话 N”使用 terminals store 在创建标签时分配的固定 sessionNumber，不再依赖展示索引。计数按 HostId 独立保存在本次 store 生命周期中，本地设备使用空 HostId；仍有会话时持续递增，最后一个标签成功移除时删除该 HostId 的计数与最近会话记录，重新打开从 1 开始。失败保留会话与计数，分屏和创建受限不消耗编号。编号、计数器、自定义标题和分屏仅在本次运行内保留；重启后首次创建从 1 开始。

设备工作区关闭由 workspace.close 异步协调：按 current/right/others/all 快照选取工作区，复用 terminals.closeAll 关闭每个目标 HostId 的终端标签及分屏；仍有关闭失败的终端时保留工作区，其余目标继续处理。closing 记录正在关闭的工作区 key，防止重复提交；App 的零窗格导航清理在此期间暂停，避免误删范围外的空工作区。成功后按原相邻标签规则移除导航，文件连接和后台任务继续由各自 store 管理。全局功能页关闭不触发终端关闭。

终端顶部采用紧凑组合：App 的 workspace-header 仅承载 HostTools；TerminalsView 的 terminal-session-header 只承载可横向滚动的会话标签，移除七个操作图标及专用样式。页签菜单按“复制、重命名、关闭所有、关闭”排序，移除关闭其它入口与专用 store 方法。“复制”从右键目标标签取主机快照，复用 store.open 创建并选中一个新窗格，不复制运行 ID、分屏、cwd、文件动作或容器命令；本地标签使用 host=null，错误沿用 store.error。closeAll 按右键目标主机生成页签快照并逐一复用 close，包含目标本身及所有分屏，不关闭其他主机的连接。关闭失败保留页签并通过 store.error 报错，继续处理剩余目标；终端布局仅保留在运行内。重命名/关闭菜单、新建/分屏快捷键保留。TerminalPane 移除常驻的 terminal-toolbar、主机信息和按钮区，画面紧接会话栏；原窗格操作移到 Teleport 至 body 的终端菜单，继续调用同一 connect/copy/paste/find/forward/export/emit 逻辑，绑定原 PaneKey、主机快照、cwd 和会话 ID。会话标签显示状态，菜单可查看主机端点，窗格保留可访问名称/状态描述。默认右键打开菜单；快捷粘贴开启后右键仍粘贴，Shift+右键、Shift+F10 或菜单键打开菜单，支持方向键/Home/End/Esc、外部关闭和视口边缘约束。操作不改变挂载、连接或取消生命周期；导出、粘贴、主机信任和配置变化保护保留，收到待确认指纹时关闭菜单并使用原对话框。

AppConfig v1 新增有默认值的 terminal 偏好，兼容旧设置：字体、10–32 字号、100–200% 行高、历史上限、四种主题、光标和 11 个快捷键。快捷键必须包含约束修饰键并去重，不占用远端 Ctrl+C/Z。大于阈值或 50 行的粘贴须确认，通过 xterm.paste 尊重远端 Bracketed Paste；不会承诺远端关闭此模式时换行安全。复制走原生系统文本剪贴板；导出需主动确认，只下载当前普通屏幕和滚动历史 UTF-8 文本，无自动录制。

终端快捷复制粘贴使用同一偏好中的 `quickCopyPaste: boolean`，Rust 默认和旧 JSON 缺失字段均为 false，无数据库结构迁移。开启时 xterm 非空选区变化写入系统剪贴板，仅活动窗格响应；终端内容容器捕获右键按下及菜单事件，避免同时触发 xterm 的鼠标上报或右键选词，再复用原剪贴板读取、大文本确认、2 MiB 限制和有界输入。快捷开启时 Shift+右键与键盘菜单操作不读取剪贴板，菜单、查找框和其他页面不触发右键粘贴。剪贴板读取绑定终端连接 generation，重连或卸载后丢弃旧读取结果，重连时取消旧待确认粘贴；剪贴板不可用或读写失败沿用安全错误提示，不记录内容。services/clipboard.ts 复用 ensureDesktop，并调用 @tauri-apps/plugin-clipboard-manager 2.5.0 的 readText/writeText；Rust 注册同版本插件，main capability 只增加 allow-read-text/allow-write-text，其他窗口、远程来源及图片/HTML/清空等命令不获授权。终端快捷键、菜单、选中复制及全应用的路径/结果/日志复制共用此服务；只在用户动作后读写，不申请网页权限，也不回退 navigator.clipboard。浏览器原生 paste 事件仍从 clipboardData 取得用户已粘贴的文本，并复用原确认和输入流程。

terminals store 不再提供布局快照、恢复或自动保存，App 启动不调用 workspace_load。旧 workspace_load/workspace_save IPC 与 application_settings.terminal_workspace 的 v1 格式保留兼容，产品不再读写，也不删除已有记录或修改主机、分组、凭据及偏好。启动或 WebView 重载时会话列表为空；用户显式打开设备后才创建一个新 Shell。WebView 重新加载会关闭旧终端及未认证的文件租约，保留已认证文件租约和后台传输；应用退出先排空文件操作，再取消全部 Session/转发，最后等待数据库任务。

显式主机选择是 Shell 连接意图：主机树通过 setContext(hostId, true) 进入或恢复该主机工作区；已有远程主机 Shell 标签激活和 Shell 工具选择也复用 navigate。当前工具为 Shell 时，activateHost 选择最近会话，仅将当前 idle 窗格的 connectRequested 置为 true；没有 Shell 会话时复用 open 创建一个。TerminalPane 原有监听发起真实 terminal_open，保留认证、信任确认与取消。启动不恢复终端元数据，主菜单返回本次运行内已有工作区及自动相邻导航不新增请求；Files/Monitor 等工具保持原上下文。连接中、等待指纹、已连接及失败状态不被重复点击重开；失败仍由显式重新连接重试，多标签/分屏不会全部自连。

### 代理、跳板与转发

connection_plan 在后端读取受管跳板链及系统库秘密。第一段可经 SOCKS5（无认证或用户名/密码）或 HTTP CONNECT（无认证或 Basic），后续用 direct-tcpip 内嵌 SSH；每跳独立校验密钥和认证。代理只用于首段，冲突的代理设置明确拒绝；不执行 ProxyCommand 或本地 Shell。HTTP 代理链路本身不是 TLS，Basic/SOCKS 用户名密码不具有额外传输加密，UI 明示此边界。

forward_start/list/stop 显式控制归属于 Session 的 Local/Remote/Dynamic。默认 127.0.0.1，Rust 校验所有非回环地址必须 confirmPublic；Remote 实际暴露仍受服务器 GatewayPorts 策略影响。Local/Dynamic 支持端口 0，Remote 须指定非零端口。全局最多 16 个运行转发、64 个状态记录；每转发最多 32 条并发流及有界远程入口，copy_bidirectional 不累积正文。Dynamic 为 SOCKS5 无认证 CONNECT，远端 DNS，不支持 UDP/BIND。

转发监听及 JoinSet 归属取消 token，停止/Session 关闭/SSH 断线都会关闭监听并取消流。Remote 注册表以监听地址/端口和 ForwardId 精确所有权匹配，重复请求不会撤销已有路由；拒绝未知服务端转发 Channel。远程取消若未获服务器确认，断开所属 Transport 以防残留监听并报告原因；此异常安全路径会使共享该 Transport 的其他窗格断线。转发不自动持久化、重启或重连。

SFTP TaskId 和退出确认已接入，监控采样也已接入独立租约；不恢复远端旧 Shell，也不持久化或自动重放文件终端动作。

## SFTP 文件工作区（已实现）

`core::files` 定义路径、目录、元数据、传输、编辑及固定文件终端动作 DTO。`ssh::subsystem` 增加 Files 租约：复用原有完整路由/凭据 revision 的 Transport，但不启动 PTY/Shell。租约与终端一样参与引用计数，关闭最后一个终端不影响 SFTP。目录浏览使用一个 SFTP Channel，每个活动传输使用独立 Channel；SFTP 子系统错误不关闭其他 PTY。传输并发和服务器 MaxSessions 不等价，服务器拒绝新 Channel 时明确报错。

`sftp::remote` 使用 russh-sftp RawSftpSession 完成 SFTP v3 请求和扩展协商，固定每块 32 KiB、单请求 15 秒、响应包最多 1 MiB。不用会无界累积整个目录的高级 read_dir；逐批读取、20,000 项/8 MiB 名称及批次数上限，拒绝恶意文件名路径。`sftp::local` 使用 Tokio filesystem，拒绝非 Unicode 路径的有损转换；本地目录显示规范化路径。原生文件/目录选择器仅通过 files_pick 暴露，不授予通用 fs/shell 插件命令。

前端 FilesView 为双栏目录、路径输入、父目录、排序、分页（200 项）、复选多选、右键操作和原生路径拖放入口。Pinia 中保存 HostId/FileSessionId/目录，任务属于 Rust，不依赖页面挂载。files_connections 和 transfer_list 只读同步健康状态，已有终端与 SFTP 一起汇总主机在线状态。页面错误保留旧目录，不把失败显示为空目录。删除需要明确范围与确认；递归选项单独勾选，不跟随目录中的链接，根目录禁止删除。SFTP v3 没有 openat/O_NOFOLLOW/CAS，路径重检能阻止已观察到的重定向，不能承诺恶意服务器或并发改链接时具备内核沙箱保证。

远程列表的权限以九位 `rwxr-xr-x` 形式展示，含 setuid/setgid/sticky 的 s/S/t/T，不显示文件类型前缀。FileEntry 新增可空 `owner`，保留 uid/gid 和数值 mode；本地条目 owner 为 null。SFTP v3 ATTRS 仅带数字 ID，目录响应 NAME.longname 中常见 Unix ls 形式提供属主名称：仅识别合法类型/九位权限/链接数的前缀，提取有界且不含控制字符的属主字段；未知格式回退原 UID，不从 UID 0、登录用户名或文件名猜测 root。名称只用于显示，不用于路径、权限检查或保存属主，不增加 SSH 命令或额外远程查询。

### 后台传输与取消

Transfers 保存独立 TaskId、状态、总字节/已传/剩余、速度、文件数、跳过项、错误和恢复路径。默认每 HostId 最多 3 个活动任务，可在原配置中设 1–6；同时全局最多 12 活动、64 未完成、128 条历史。设置降低时不抢占现有任务。每个任务最多选择 256 个源、源/目标路径总长 64 KiB，递归最多 100,000 项/64 层且规划路径预算 8 MiB，避免路径图无限累积。文件内容按 32 KiB 流式传输，不整文件进入前端。

状态为 queued → scanning → running/verifying → completed，或 cancelling → cancelled、failed。排队由 Rust 调度，页面关闭或 WebView 重载不取消已认证 Files 租约及任务；应用进程结束后任务不恢复，也不宣称断点续传。失败/取消重试必须选择同主机连接、从头重传，并重新选择冲突策略。源数据或目标属性变化时失败，不悄悄覆盖。

上传先在目标同目录 CREATE|EXCLUDE 新建 0600 的 .serverdeck-UUID.part，写入、fsync（若支持）、回读 SHA-256，检查源和目标后提交。下载在本地目标同目录独占临时文件，flush/sync_all，对比本地与远端 SHA-256 后提交；不覆盖用 persist_noclobber，覆盖需确认并保留可支持的基本权限。目录合并，已有普通文件可停止/跳过/自动重命名/覆盖，链接或特殊文件不被覆盖。跨平台名称不可表示时明确失败（如 Windows 保留名、ADS、尾点），不偷偷改名。

每个任务有取消 token、所属租约关闭 token和完成通知。取消停止后续文件，清理独占临时文件，已经提交的文件保留；单文件提交开始后等待其结果，避免把不可撤销的提交说成已撤销。SSH/文件连接关闭会使在途与排队任务失败。清理失败显示确切恢复路径，临时数据可能在网络故障时留存，不能保证远端立即删除。手动断开 Files 先检查未保存文档和活动传输，必须明确取消；离开文件页面不做断开。

### Monaco 编辑与替换边界

最多 8 个内存编辑文档，每个不超过 2 MiB，只接受无 NUL、严格 UTF-8 的普通文件。Monaco 和 worker 全部打包本地、按需加载，仅提供基础语言高亮/查找/编辑；没有远程脚本、预览执行或 IDE 插件。未保存状态在前端维护，后端仅登记 dirty 标志，正文不持久化。关闭/重新加载须确认放弃；beforeunload 保护重载，实际重载后清除旧编辑句柄。

读取保存 SHA-256 和 size/mtime/uid/gid/mode。保存前及提交前重读内容和属性，同大小同时间戳的修改也由 hash 检出。先验证对原文件有 WRITE 权限但不截断它，再创建同目录 0600 临时文件、写入并校验，设置并重新核对原 uid/gid/mode，最后调用 posix-rename@openssh.com。没有原子扩展、无权限、属主无法保留或冲突则失败，绝不以 unlink 或截断原件降级。清理失败返回恢复路径。

原子替换改变 inode；SFTP v3 无法完整查询/保留 ACL、扩展属性及硬链接关系，编辑器明确要求用户确认这一边界，不适用于必须保留这些元数据的文件。外部修改检测与最终 rename 之间没有服务端 CAS，不能承诺消除所有竞态；提交后断网可能无法确认结果，必须重新加载核对。

### 终端联动及退出顺序

TerminalPane 的 SFTP 按钮携带同一 HostId 和来源 PaneKey。目录只接收经过 URI/长度/NUL 校验的 OSC 7 file:// 报告，不解析任意 Shell 输出猜 pwd。用户勾选跟随后，SFTP 按报告的绝对路径导航；未集成 OSC 7 的 Shell 显示未报告并保留手动导航，不修改远端启动文件。远端应用可以报告任意路径，这不是权限依据或命令授权。

文件右键打开目录/less/tail 前显示主机与绝对路径并确认，后端只生成固定命令并做 POSIX 单引号转义，在新的 PTY exec Channel 执行，不向已有 Shell 注入输入。FileTerminalAction 仅保留在本次运行内，手动重连才重新执行已确认动作。退出信号（如 tail 的 Ctrl+C）是正常 Channel 结束，和 SSH Transport 断线分开处理。

主窗口关闭先进入前端/后端退出评审，后端实时检查任务及 dirty 标志，不能用轮询缓存决定是否跳过提示。确认后拒绝新用例，先取消并等待监控，再清理传输和文件元数据操作，最后关闭 SFTP/SSH/转发，最后等待数据库工作并刷日志。异步提交/重试始终在 Tokio 运行时执行，错误线程入口返回安全错误而非 panic。

## 安全边界与兼容性

Tauri AppManifest 与 capability 显式列出自定义命令，仅授予本地 `main`，不授予远程 origin、通用本地 Shell、任意文件读写、SQL 或窗口创建插件。
CSP 限制本地资源/IPC，开发额外允许固定 loopback Vite/HMR；没有远程脚本/CDN。保留系统标题栏，窗口控制交给 OS。
核心代码禁止 unsafe。对用户输入的防线在 Rust，前端校验仅改善交互。
目前只在 Windows x64 构建/验证；macOS/Linux 需在各自系统运行后才能声明支持。性能目标尚无基准，不宣称满足 3s/150MB/20 会话。

依据：[Tauri capabilities](https://v2.tauri.app/security/capabilities/)、[Tauri security](https://v2.tauri.app/security/)。SSH 候选、证据与限制见 [SSH_TECH_VALIDATION.md](../validation/terminal/SSH_TECH_VALIDATION.md)。

## Agentless Linux 监控（已实现）

依赖 `desktop → application → monitor → ssh/core/Tokio`，不依赖 Tauri 或 SQLite。core::monitor 为显式 camelCase DTO。SSH Engine 增加 Monitor 租约类型：与 Terminal/Files 共用完整路由及凭据 revision 的 Transport，独立引用计数，不借用用户 PTY。Engine 只暴露固定监控采集入口，不提供来自 IPC 的任意 exec 字符串。

`ssh/src/monitor.sh` 是编译时固定的 POSIX 只读脚本，设置 LC_ALL=C 和固定系统 PATH，读取 procfs、os-release、uname/date、ip 地址及 df。各节 NUL 分隔，附命令状态；不 eval/source 远端文件，不插入用户路径或主机输入，不记录 stdout/stderr。单次 exec 创建不带 PTY 的 Channel；创建 3 秒、执行 8 秒，成功/失败/取消均请求关闭 Channel；stdout 总上限 2 MiB、stderr 16 KiB，df 使用远端 timeout 4 秒。缺少工具/权限或异常数据返回分项警告，协议破损为整个采样错误。

监控脚本和 `core/src/ops_capabilities.sh` 的嵌入文本在生成远端命令时统一将 CRLF 转为 LF，避免 Windows 检出内容经 SSH exec 原样发送后触发 Bash/sh 语法错误。`.gitattributes` 同时约束 Shell 脚本按 LF 检出；回归检查生成命令及实际监控 SSH exec 载荷不含回车。命令内容、权限、协议、超时和取消边界不变。

Monitors 注册表以 HostId 为键，最多 8 台；同主机多次打开返回同一 SessionId，不因图表数量创建任务。每个 Control 有取消 token、设置 watch、JoinHandle、当前快照及 revision。同步锁只短暂更新状态，不跨 await。设置值未变化不通知 worker，避免重新打开视图触发过密采样。3/5/10/30 秒为采集完成后的等待间隔，实际时间以远端 uptime 为准，不承诺严格墙钟定时。

状态：connecting → sampling → running/partial，失败为 error（保留旧样本并标过期）或 failed（连接结束）。隐藏页面/文档不可见时设 visible=false，在途采集完成后 paused，不采集新指标；恢复清空差分基线。WebView 重载先 pause_all，保留已认证 Monitor 租约；重载后只在用户打开该视图时继续。停止等待 worker 取消和 Channel 清理，再释放自身 SSH 租约；应用退出先停止监控，再执行 SFTP/SSH/数据库顺序。Engine 在任何会话结束后通知租约 token，暂停中的任务也能检测断线。

CPU 取 /proc/stat 前八项，排除 guest/guest_nice 重复计数；busy 不含 idle/iowait。iowait 负差钳为 0，其余负差或总差为 0 返回未知；支持每核心及热插拔。网络以远端 uptime 连续差值计算 bytes/s，结合接口名和 ifindex，计数回退、换接口、异常速率、不同 boot_id、时间差小于 0.1 秒或大于 120 秒均等待新基线。累计计数仍显示实际值。内存 used=MemTotal−MemAvailable；老内核以 Free+Buffers+Cached+SReclaimable−Shmem 近似并标注，不把所有缓存算作已用。Swap 未启用与采集失败分开表示。

disk 解析 mountinfo 的八进制路径转义，与 df -P -k -T 完整挂载路径后缀匹配；设备 major:minor 和文件系统类型去重，优先根/短路径。保留重复关系、容器 overlay 标识、伪文件系统、只读镜像标识及每挂载点不可用原因。UI 默认隐藏伪文件系统/镜像/重复挂载，可查看全部。磁盘错误气泡与默认列表共用持久挂载筛选，不将上述正常缺失的 df 数据作为错误通知；勾选全部挂载也不改变告警范围。真实持久盘（含独立 overlay 挂载）的错误注明挂载路径，整体采集失败与采集警告继续保留；容量按 df 的 1024 字节单位转换，使用率沿用 df 的非特权可用空间口径，允许满盘超过 100% 和负可用量归零。持久盘达到 90% 标示高占用，未实现系统通知或持续告警服务。

桌面虚拟挂载在 Rust disk 分类阶段识别：`fuse.portal`、`fuse.gvfsd-fuse`，以及文件系统为 `fuse` 且路径严格符合 `/run/user/<数字 UID>/gnome-remote-desktop/cliprdr-<非空单级名称>` 的剪贴板挂载标为 pseudo。后端容量不可用统计与前端默认列表、通知因此保持一致；原始容量缺失和原因仍在全部挂载中可查。不按所有 FUSE 或整个 `/run/user` 目录过滤，SSHFS、rclone、普通 FUSE 数据盘及整体 df 命令失败继续保留诊断。

当前样本最多 1024 个每核计数、256 接口（每接口 32 地址）、2048 挂载。历史仅保存 CPU、内存及非 lo 接口收发合计，最多 600 点且裁剪至 30 分钟；不把所有每核/每接口历史复制进内存。失败点为 null，图表留空，不补 0。snapshot(afterRevision) 未变化返回 null，避免每秒重复传输历史；页面每秒只轮询当前主机。

Vue TrendChart 使用持久 SVG 节点更新折线，没有引入 ECharts 或图表实例销毁循环；MonitorView 约 13 KiB、按需加载。容器虚拟网桥可能重复承载同一流量，合计标注为非物理线路吞吐。采集代表当前 SSH 命名空间的 procfs/挂载视图，不计算 cgroup CPU/内存配额，不额外启动远程 Agent 或后台驻留程序。

## 当前主机 Linux 运维

依赖 `desktop → application → ops → ssh/core/Tokio`。core::ops 定义封闭的 Request、LogInput、ContainerShell 和返回 DTO；前端只能提交枚举动作及经过校验的参数，没有任意 exec 字符串入口。OperationsView 的所有资源标签共享 OpsStore 当前 HostId/File-like 租约，入口来自主机详情、右键及终端；树节点在线状态也合并运维连接。SessionKind::Operations 使用原有完整 TransportKey（端点、路由、账号、凭据 revision）参与复用，独立于 PTY、Files 和 Monitor。配置修改后需断开/重新连接运维上下文以应用新设置。

### 命令和权限边界

所有命令设置固定 PATH/LC_ALL、禁用 pager/交互认证；Docker CLI 显式选择 Unix Socket：优先 /run/user/UID/docker.sock，存在时使用，否则 /var/run/docker.sock。清除 DOCKER_HOST/DOCKER_CONTEXT/TLS 环境覆盖，不执行远程 context、TCP Docker API、sudo 或 su。容器和镜像须完整不可变 ID，不用名称作为写操作目标；删除不加 force 或 volumes。服务单元校验 .service 名称、作用域为 system/user，systemctl 始终 --no-ask-password。危险和普通状态修改统一要求 confirmed，UI 还要求输入目标全文，确认绑定原 SessionId；执行中禁止取消对话框后悄悄换主机。

容器详情仅输出状态、镜像、环境、端口、挂载和重启策略等指定字段，忽略无关 Cmd/Labels；所有环境值在 Rust 返回 IPC 前遮蔽，revealEnv=true 也必须 confirmed。显式显示只在内存中，不进日志/SQLite/反馈历史。文件路径经 POSIX 单引号参数转义；允许中文/空格/引号，拒绝 NUL、过长参数；容器 ID、服务单元、PID、信号和网络目标另有严格校验。没有拼接未经验证的 shell 选项。

进程列表来自 ps 的 PID/user/pcpu/pmem/etimes/comm，CPU 为生命周期均值，UI 明示；不自动读取命令参数或进程环境。详情返回 proc stat/status/exe 和 boot_id/start_ticks。信号仅允许 TERM/KILL/INT/HUP、PID 2–i32::MAX；远端 Python 先 pidfd_open，再验证同一启动标识，最后 pidfd_send_signal，避免检查后误杀复用 PID。Python/pidfd 不可用则失败，没有传统 kill 降级。端口来自 ss -lntup，关联进程缺失保留 null，不从端口号猜进程。TCP probe 由用户指定本地 Tokio 或远端 Python，目标和端口明确、有超时。

### 执行与日志生命周期

运维查询使用独立非 PTY Channel，最多 8 个在途请求、等待槽 3 秒、执行 30 秒、stdout 2 MiB/stderr 16 KiB。只读查询不占写锁；少量写操作用独立异步互斥锁串行，等待最多 3 秒，避免 UI 连点并发修改。同步锁不跨 await。成功要求 SSH exec 接受且 exit-status=0；非零状态保留有限错误到当前 UI，不记录输出。超时/断线明确标为结果未确认，不能把远端 Docker/systemd 已提交动作当成回滚；用户应刷新后再决定重试。

每个日志标签拥有独立 LogId、Channel、取消 token、pause/ack watch 和 JoinHandle，全局最多 8 个。Docker logs --timestamps --tail/--follow、tail -n/-F 和 journalctl --unit 都只读用户主动选择的来源。数据每块最多 16 KiB，Rust 等待序号 ACK 才继续；前端分别解码 stdout/stderr，在 50ms 合并节奏渲染后 ACK，不在 Pinia 中无限追加。LogBuffer 同时限制 UTF-8 1 MiB 和 5000 行；过滤/复制/导出只基于当前有界文本，用 Vue 纯文本渲染，不执行 HTML/ANSI。暂停停止消费并依赖 SSH window 背压，继续后按现有流继续，不额外启动第二条流。

关闭日志或离开运维页面取消 worker，向该 exec Channel 的远端命令请求 TERM 后 close；断线/连接关闭也结束流。切换主机通过 SessionId key 销毁原日志组件。认证后的运维租约可跨页面保留，ops_connections 用于健康同步；关闭运维连接只清理自身日志和租约，不关已有容器 PTY/SSH/SFTP。容器 Shell 是确认后的 docker exec -it /bin/sh 或 /bin/bash，独立 PTY 进入原终端体系；不持久化 ContainerShell 动作、终端标签或分屏，重启后不恢复容器 Shell。

WebView 重载先关闭所有日志；应用退出先取消运维流/请求并排空槽，再停止 Monitor、SFTP、SSH/转发及数据库。操作反馈只保留本进程内最多 100 条 HostId/目标/动作/结果，不存敏感输出，不宣称提供持久审计或事务回滚。运维模块本身不新增数据库表；schema v5 的新增表属于自动化，v6 仅放宽主机名称约束。

## 网络诊断与批量运维

`application → tasks → ssh/sftp/core/Tokio`。tasks 不依赖 Tauri；新增封闭诊断工具枚举和显式批量请求，无通用本地 Shell IPC。Network 与 Batch 使用现有主机目录、Operations/Files 连接及严格信任，用户先点击连接并逐台核对未知指纹，再预览执行。每个结果携带独立任务 ID、HostId、SessionId；连接失败目标记录未执行，不把其他主机输出归到该行。

### 诊断数据流

本机诊断调用系统目录内的固定程序和独立参数（Windows ping/tracert/ipconfig/netstat；Linux/macOS 对应工具），DNS/TCP 用 Tokio 系统解析器/连接器。Windows 子进程隐藏窗口，双管道通过容量 8 的队列消费，按系统代码页增量解码；代码页查询只运行固定 PowerShell 表达式，不包含用户命令。远端诊断由经过校验的 IP/域名和固定模板构造，SSH exec 与现有交互 Shell 分离。MTR 使用 raw 实时输出，工具缺失和 raw socket 权限错误保留失败输出，不自动提权。DNS 当前只返回系统解析器的地址结果，不提供所有 DNS 记录类型。

单次诊断 1–300 秒、1–100 次（次数仅适用于重复探测工具），Traceroute 最多 16 跳；SSH 延迟为已认证连接上的 Channel+exec 往返，包含 Shell/调度，不冒充握手或纯网络 RTT。每个诊断独立取消，历史最多 16 条，每条文本 256 KiB，裁剪旧 UTF-8 字符并计数。Ping 失败不修改主机在线状态。结果仅保留内存，由用户主动复制/导出。

### 批量队列与安全

一个 Batch 包含 1–32 个去重目标，默认前端并发 3，后端验证 1–8，每台执行限时 1–3600 秒。批量命令是用户明确输入并确认的远端 Shell 命令；应用不尝试用不可靠关键词判断任意 Shell 是否危险，因此全部命令显示完整目标/账号/地址/内容并要求输入目标数量。确认预览冻结目标和 SessionId，不使用随后变化的选中项。服务器断线不自动重连执行、不自动重试命令。

全局诊断/批量执行最多 8 个活动槽，每批还有独立 semaphore；最多 4 个未结束批次，历史最多 8 批。排队任务可单独取消，默认保留已执行任务继续；“请求停止全部”另取消在途任务。每行分别保留 stdout/stderr 各 32 KiB、退出码、错误、时间、丢弃字节。超时、断线或请求停止的远端 exec 标为 uncertain；只请求该 Channel 的 TERM/close，不宣称进程必已停止，不关闭共享 Transport。

文件分发复用现有 Rust Transfers，每目标一个单文件 Upload，保留源变化检查、临时文件、回读 SHA-256、安全提交和冲突策略；不另建前端传输循环。批量并发槽贯穿该目标的排队/传输和取消清理；取消后等待最多 35 秒清理/提交屏障，未确认时保留 SFTP 队列和恢复路径。只对已结束批次的失败/取消/未确认文件目标提供显式重试，仍使用原冲突策略，原传输未结束不重试；命令没有自动重试入口。

### 页面和退出

Network/Batch 页面轮询有 revision 的快照，IPC 只发送已变化记录，避免持续序列化旧大输出到 WebView。后端历史有界，前端也裁剪到相同条数；文本通过 Vue 转义展示，无自动执行 HTML/ANSI。页面关闭不取消已明确请求继续的任务，重开从 Rust 取回；进程重启不恢复执行命令或任务输出。

退出评审把诊断/批量和原 SFTP 未完成任务共同计入，确认退出先取消并等待 tasks，再关闭 Operations、Monitor、SFTP 和 SSH。Network/Batch 仍只保留内存历史，不将其命令及输出写入 SQLite（schema v5 新增的持久记录仅供自动化使用），不默认修改系统配置；复制和导出可能包含用户命令中的敏感信息，由用户主动触发。

## 可复用运维任务与本地计划

新增依赖为 `desktop → application → automation → storage/tasks/ssh/core/Tokio`。automation 不依赖 Tauri；复用 tasks 的全局执行槽和 SSH 非 PTY Channel，不向已有交互 Shell 注入命令。Vue 的 AutomationView、三个条目/执行/计划对话框、类型化 IPC 服务与状态提示接入当前 HostId；主机详情、右键、终端均有入口。不是独立演示页面，也不增加 DAG、Agent 或云端调度服务。

常用模板在 AutomationView 中使用每项独立的原生 details/summary，替代整组展开后的多列卡片；模板名称始终可见，每项初始关闭，展开后显示完整正文和原编辑器入口。折叠状态仅属于当前 DOM，无持久配置或自定义展开状态管理；保留原生键盘操作和焦点样式，不改变模板数据或执行链路。

### 数据和执行边界

SQLite schema 通过事务从 v4 迁移到 v5，新增 automation_groups、automation_entries、automation_schedules、automation_runs；保留原主机、信任、配置和凭据数据。条目和计划使用 revision 拒绝过期编辑。正文、风险、参数定义、执行选项变化会停用关联计划；名称/说明/分组/收藏变化不撤销执行授权。删除条目会删除关联计划，但保留历史快照；删除分组解除条目分组。任务历史不自动删除，通过带确认的单条删除清理。历史按时间和 ID 游标每页 50 条，可按名称、状态、计划查询；状态和计划索引避免每次通知读取全部任务正文。

命令和脚本都由用户审查正文。脚本参数按定义顺序对应 `$1`、`$2` 等，支持文本/整数/端口/绝对路径/主机校验；必须以 `"$1"` 等方式使用，应用不会替用户改写任意 Shell。SSH exec 字符串只有固定的 Python bootstrap，脚本与参数作为分离的 JSON 字段经 Channel stdin 发送，随后 EOF。bootstrap 校验长度/类型后用 `os.execv('/bin/sh', ['sh', '-c', script, 'serverdeck-task', *args])` 执行，没有把参数插进脚本文本、eval 或拼入 exec 命令。依赖远端 Python 3 和 POSIX `/bin/sh`，缺少时明确失败，不自动安装/提权。脚本的 shebang 不决定解释器，Bash 专有语法需用户明确改写执行内容。

正文及普通参数会保存在本地 SQLite，不能在正文、描述或普通默认值中写秘密。秘密参数无默认值，Rust 使用 Zeroizing，输入 DTO 不实现 Debug/Serialize，前端提交/卸载清空且不进入 Pinia。只要条目含秘密参数定义，该次 stdout/stderr 就不展示、不缓存、不持久化，即使用户选择保存输出，防止分块、编码或变形回显绕过简单替换。计划不保存秘密参数，因此此类条目只支持手动执行。秘密作为远端进程参数仍可能被同用户或管理员观察，UI 明示该边界；不承诺 JS、SSH 依赖及远端 OS 内存绝对清零。

普通任务默认只持久化状态、时间、退出码、错误、正文和非秘密参数/目标快照；实时 stdout/stderr 各 8 KiB，按 UTF-8 边界裁剪并计数。保存输出为条目上的显式选项，持久化仍遵循每流 8 KiB。内存仅保留最近最多 8 个任务控制器，只有 worker 完成后才能移除；DB 历史持续保留，用户应留意本地磁盘空间。后端/日志不默认记录正文、参数及输出。

### 确认、连接和状态机

`automation_prepare` 返回真实条目和完整目标预览。提交绑定 entry revision 及每个目标的完整路由签名，涵盖端点、用户名、跳板、代理、认证及凭据 revision；执行前再次校验，并选择匹配当前签名的已认证 Operations 租约。目标改变则拒绝旧授权。未连接目标明确失败；执行器不静默读取密码登录、不代替用户接受主机指纹。先在对话框连接并核验指纹，再冻结预览；手动执行须输入目标数量，危险等级另须勾选确认。风险由用户声明，应用不能证明任意 Shell 安全。

一次任务含 1–32 个独立 HostId 行；最多 4 个活动任务，每任务并发 1–8（默认 3），共用 tasks 全局 8 个执行槽，单台超时 1–3600 秒。排队期间可取消，只有取得执行槽、检查真实连接并持久化 Running 后才发送 SSH exec。后台每秒及完成时保存 revision 单调递增的快照，旧 Pending 无法覆盖新 Running；存储错误显示全局提示，不能伪装成功。

状态为 Pending → Running → Success / Failed / Unknown；未执行的取消为 Cancelled。取得 exit-status=0 才是 Success，明确非零/服务端拒绝/缺少工具为 Failed；超时、断线、在途取消或缺少退出码为 Unknown，请求 TERM/close 不意味着远端进程已经停止。批次状态按独立行聚合，结果始终携带 HostId。取消未开始的行不会中断其他在途行，另有“请求停止在途任务”。不自动重试或重放命令，也不撤销已经产生的副作用。

应用启动将持久化 Running 行恢复为 Unknown，未启动 Pending 行改为 Cancelled；待人工批准的 Pending 保留。恢复仅用于查询，不自动重新执行。关闭页面不取消 Rust 任务；退出评审包括运行中/正在保存的自动化任务，确认退出先停调度、取消并等待自动化，再释放 tasks、Operations、Monitor、SFTP、SSH 和数据库。同步锁不跨 await，SQLite 在有界 spawn_blocking 工作中运行。

### 本地调度

计划支持每日、每周及五字段 Cron，持久化固定 UTC 偏移（默认创建时的本机偏移），不跟随夏令时或之后的系统时区变化。Cron 支持数字、星号、范围、列表和步长；星期 0/7 为周日，日期和星期均不以 `*` 开头时按 OR，否则 AND。不支持秒、名称、L/W/#/@；五年内无有效时间则拒绝。

一秒 Tokio 调度循环使用 Skip，DB 事务同时推进下次时间并插入带 `(schedule_id, scheduled_for)` 唯一约束的执行记录。授权普通计划只使用已有可信连接；连接不存在会失败并提示，应用不无人值守登录。危险计划每次到期只创建 Pending 待确认，手动预览并确认后执行。相同计划已有在途或待批准任务时记录本次跳过，避免积压；全局容量不足明确失败，不无限排队。

桌面退出、关机或休眠期间不能保证执行。启动时的过期计划、循环间隔超过 75 秒或迟到超过 60 秒按错过处理：skip 记录 Cancelled，ask 创建一条 Pending 待确认，再计算未来时间，不补跑全部错过次数。条目/目标执行配置变化会使计划失效并停用，必须重新预览授权。计划失败、Unknown 和待确认数量通过根级通知及导航徽标展示，在终端页也可见。状态轮询只传元数据，不自动持久化通知中的输出。

## 产品整合：统一工作区与全局偏好

前端 workspace Pinia 状态以 `host:<HostId>` 保存每台主机唯一的一级工作区标签，本地设备使用 `host:`；全局工具仍以模块为键。主机标签保存当前工具及最近的服务器管理分类，`hostId` 是最近活动主机的上下文。`selectHost` 恢复该主机工作区，新主机默认进入终端；切换工具只更新该主机标签，激活其他主机不会改写已有标签的目标。主机树和一级标签可直接切换主机，原顶部主机选择器及独立主机管理页面移除。HostSidebar 提供树内新建、分组、搜索、标签筛选、排序和导入导出；每行的 HostTreeControls 提供编辑和确认删除，移除复制按钮及前端处理，复用 HostDialog、hostsApi 和 store.run。操作区默认透明并禁用鼠标命中，只在对应行 hover 或包含 focus-visible 时显示并允许点击，保留 Tab 顺序和键盘可访问性；选中或鼠标点击后的普通焦点不使按钮常驻，预留两个按钮的宽度，显隐不移动名称。管理操作通过 saved 事件定位树中主机，保持工作区及实际会话，不依赖右键菜单。`HostTools` 在主机工作区内提供 Shell、SFTP、服务器管理二级导航，本地设备仅展示 Shell。终端内部仍只展示当前主机的会话，切回时恢复最近会话；轮换及关闭所有会话保持当前主机边界。关闭一级设备工作区先关闭该 HostId 的全部终端会话及分屏，关闭失败保留工作区与失败会话；SFTP 和后台任务继续保留。关闭最后一个工作区后显示欢迎页。

批量运维、自动化、网络诊断及资产/设置属于全局入口，不依赖 `workspace.hostId` 或 `hosts.selectedId` 来隐式选择执行目标。独立工具页面通过 `KeepAlive` 在导航标签打开期间保留草稿、已选目标和结果；关闭对应标签后释放页面缓存，后台任务仍由原执行引擎管理。网络诊断在页内明确选择本机/远程来源及远程 HostId；“诊断连接”的独立请求序号支持重复预填同一主机的端点。自动化只接受显式快捷入口的主机预填，执行对话框继续冻结目标并要求预览确认。全局页收起主机侧栏和二级工具，返回主机工作区恢复侧栏偏好。导航元数据在本次运行内保持，不新增数据库或配置项，不自动恢复远端连接或重放命令。

OperationsView 的连接按自己的 chosen HostId 取值，不再借用会被批量连接器改变的全局 ops.active。信任和关闭操作也显式传 HostId；确认仍绑定原 SessionId，真正切换目标后旧确认不可执行。Files/Monitor/Operations 切换目标通过组件 key 隔离旧页面请求；原后台传输保留、监控隐藏暂停、日志离页结束，生命周期沿用原有所有权。Engine 只新增只读连接状态摘要，包含 SessionId/HostId/TransportId/租约类型/状态，不返回凭据。连接树、状态条和任务中心据真实注册表同步，Monitor 单独连接也能正确显示在线。

跨模块入口保留原 SFTP/文件终端/tail、Docker 日志/Shell；新增 Monitor→Processes、进程详情→明确 PID 对应 ss 监听信息、连接异常→预填目标地址和 SSH 端口的本机 TCP 诊断。端口关联只匹配 ss 显式报告的完整 pid，权限不足保留未知，不根据端口或进程名称猜测。常用命令搜索打开当前主机的预览，意图消费后清空，不因再次进入页面而重复弹出或执行。

全局搜索由可配置快捷键打开，顶部搜索按钮已移除，查询主机、模块和命令/脚本名称/说明，最多显示 50 项，支持方向键/Enter/Esc，不检索远端输出。快捷键只接收 Ctrl（macOS 同时接收 Command）及可选 Shift；后端拒绝重复组合及常见终端控制键，模态对话框中不触发全局导航。全局通知最多 5 条，普通通知 6 秒消失、错误手动关闭；任务失败仅提示元数据和查看入口，不把任务输出放入通知/日志。后台任务摘要不复制命令或 stdout/stderr。TaskCenterView 是运维工具下的全局 tasks 工作区，复用 TransferPanel 及 background/automation/files store，展示传输、网络与批量任务、自动化状态；保留取消传输、停止确认、错误气泡和按原 HostId 跳转查看结果/重试。底部两个任务按钮及 BackgroundTasks 弹窗移除，菜单、全局搜索、tasks 快捷键统一调用 navigate，重复进入复用 tasks: 标签。关闭任务中心只移除页面，不停止全局轮询或任务；未读和读取失败的状态明确显示。

主机树按组一次计算，初始最多渲染 200 个主机，可继续加载，方向键和 Home/End 移动焦点；主机表初始 100 行。已有文件/运维分页保持。侧栏分隔条可拖动或键盘调整，完成后保存 200–400 逻辑像素偏好。窗口宽高/最大化状态由 Rust 原生事件获取，按 DPI 转为逻辑尺寸，单 watch 通道去抖 500ms，退出前刷新；独立 application_settings.window_geometry，不把最大化尺寸覆盖普通窗口尺寸，不保存可能跨屏失效的位置。恢复时按当前屏幕尺寸约束，窗口最小 900×600；不是跨平台/物理混合 DPI 验收的替代。

侧栏 `sidebarWidth` 的后端契约为 u16 整数。指针坐标可带小数，前端对拖动预览和提交使用同一取整/200–400 范围限制，确保不将缩放或小数位移产生的浮点宽度传入 config_save；键盘仍按 8 逻辑像素调整，统一在提交边界限制范围。

2026-11-02 布局调整：应用壳使用全局功能栏、通高主机栏、中央工作区三列。`AppNavigation` 提供主机工作区、独立工具及资产/设置入口，使用图标、名称、当前页和任务数量；主机内功能由 `HostTools` 提供。`HostSidebar` 的标题工具、搜索/收藏筛选和底部统计不参与滚动，仅中间主机列表滚动。主机行显示名称与地址，原有分组/有界加载/连接行为继续复用。侧栏宽度仍使用既有 `sidebarWidth` 偏好，分隔条位置包含全局功能栏宽度；收起状态只在本次界面内保持。窄视口使用可展开主机抽屉，一级标签支持横向滚动，工作区表格在自身区域滚动。无 IPC、数据库或连接所有权变化；浏览器预览仍明确显示后端未连接。主机工作区验收见 [VALIDATION_HOST_WORKSPACES.md](../validation/hosts/VALIDATION_HOST_WORKSPACES.md)，早期布局记录保留于 [VALIDATION_LAYOUT.md](../validation/workspace/VALIDATION_LAYOUT.md)。

各菜单的公共视觉规则集中在 `styles/controls.css`，由主题提供 32px 标准控件、28px 紧凑工具和 4px 控件圆角变量。页面复用 `page-view`、`work-section`、`form-row`、`action-row` 等布局类；终端和文件保留各自工作区结构。中央滚动区作为命名容器，按实际可用宽度切换文件双栏、监控图表和设置表单，避免只看窗口宽度而忽略主机栏占用。图标沿用现有 Lucide 依赖，保留可访问名称和悬浮提示。新增浏览器渲染测试仅在独立页面内提供测试夹具，生产服务、IPC 和连接生命周期保持原有边界。

顶部精简：移除顶部重复的工作区/功能名称及右上角全局搜索按钮。主机栏顶部移除“主机”标题文字，左侧保留收缩图标，由 HostSidebar 发出 collapse 事件、App 管理展开状态；收起后工作区标签栏左侧提供展开按钮，切换后焦点交给对应按钮，支持连续键盘操作。主机搜索图标保留在原输入框内，名称/地址/标签筛选及既有全局快捷键继续复用。全局工具页不展示主机展开入口。没有 IPC、配置或数据库变化。

侧栏主机跨组移动使用 Pointer Events，不依赖 Windows WebView2 被 Tauri 原生拖放处理器替换的 HTML 拖放。鼠标移动达到阈值后显示主机预览，以当前指针命中的分组为目标，支持空组、折叠组及未分组；松手复用 `hosts.move → host_update` 保存，不在前端提前修改分组。取消、移出主机树及原组松手不写入；拖动后的 click 被拦截，避免误打开 SSH。保留 Tauri 原生外部文件拖放与既有连接生命周期。

AppConfig 保持 version=1，新增 serde(default) product 偏好，旧数据可直接读取，不新增数据库表或重置配置。内容为当前支持的 zh-CN 语言标识、下载目录、新建主机默认 SshOptions（不设置全局跳板）、全局快捷键。语言字典先覆盖工作区/搜索导航，当前完整 UI 仍仅简体中文，不宣称已完成英文翻译。现有主题、终端字体/字号/快捷键、监控间隔、传输并发及日志等级继续真实生效。默认连接超时、认证超时、Keepalive、代理仅复制到新建主机，不改写已有主机或在途连接。默认下载目录用于新下载任务的预选目标，仍可选择其他目录。代理密码只引用原生凭据库；不存在/类型不匹配拒绝保存，删除仍被全局默认代理引用的凭据会被拒绝，要求先修改设置。

窗口关闭和应用退出统一进入确认，包括普通 SSH 会话；后端继续实时检查传输、任务及 dirty 文档。关闭主机全部连接新增明确范围确认，涉及依赖跳板及所有模块，未保存文档先处理。危险操作、断线 Unknown、未保存文件和传输提交边界均保留原保护，不为简化 UI 绕过。

整合验收补充：连接摘要同时提供 Transport 中实际的地址、端口和用户名。顶部按当前模块的真实 Session/租约显示端点，配置编辑后不把旧连接重新标成新地址；配置已变更时，原终端/文件/容器上下文不能直接新开另一个配置端点的模块，要求先从主机管理确认或重新连接。批量预览优先使用实际连接快照，诊断来源按原 Session 匹配；原会话结束后保留标识，不用当前主机地址冒充历史来源。窗口缩放后也会把活动工作区标签滚入可见区域。Toast 文本不拦截底层控件的指针事件，关闭按钮仍可操作；避免错误通知长期遮住确认按钮。

## QA 与测试版发布边界（2026-11-02）

统一版本为 0.1.0-beta.1，当前应用标识为 cn.hiboot.desktop，标识迁移见本文“应用域名统一”；Cargo/npm/Tauri 版本一致。Release 开启 thin LTO、单 codegen-unit 和 strip，前端嵌入二进制；NSIS 采用当前用户安装，不把数据放在安装目录。多尺寸 ICO/ICNS/PNG、许可证清单及依赖通知随包，未引入更新器。

本轮修复 Unix 目录权限：仅初始化应用专属数据/日志叶目录到 0700，并在迁移前把 SQLite 文件收紧至 0600，符号链接叶目录拒绝；不修改 HOME 等父目录。Windows 保留系统用户目录 ACL，不声称与 Unix mode 等价。权限失败向上传播，不静默继续。

发布 QA 复用真实前后端代码。`native-terminal-e2e.mjs --installed-exe` 驱动 NSIS 安装出的实际程序，拒绝非空用户主机目录，不清空普通安装的数据；保存/恢复原偏好，临时凭据只进入系统凭据库。CDP 只通过 QA 子进程环境开启回环端口，包默认不启用该入口。临时容器、远端文件、主机和任务都有 UUID 所有权边界；正常退出通过实际 IPC 触发完整 shutdown。

基准输出是测量证据，不是生产指标承诺；进程树内存包含 WebView 子进程，RSS 可能含共享页，另列 private bytes。性能门禁、未支持的 SFTP 面板模式及平台风险以 TEST_REPORT/RELEASE_CHECKLIST 为准。CI 只准备 Windows x64、macOS arm64/x64、Linux x64 候选构建，RustSec 门禁故意保留失败，不把未运行 CI 写成通过。

## 2026-11-03：服务器管理统一视图

WorkspaceView 使用 server 替代 monitor/operations 两个界面入口；HostTools、终端上下文菜单、全局搜索均进入 ServerView。types/server.ts 定义九个分类，WorkspaceTab.section 按 HostId 保存本次运行内的选择。App 按当前分类查询实际 monitor/operations 连接快照，主机配置变更提示仍使用建立连接时的端点。

ServerView 组合 MonitorView 与 OperationsView，不合并后端 IPC 或租约。三个资源 Tab 复用同一 MonitorView，切到运维分类时卸载并暂停采样；重新进入沿用后端既有主机采样器。运维六个分类复用 OperationsView 与已连接会话；日志分类离开时卸载 OpsLogPanel，关闭流，终端/SFTP 不受影响。

Modal 统一承载系统、核心、警告、运维详情、探测和操作反馈。详情使用独立请求序号，关闭、分类/连接变化及卸载后忽略晚到结果；进程信号仍冻结 sessionId、PID/startTicks/bootId，危险操作保留目标输入确认。OpsDetails 展示常用字段并折叠原始状态，敏感环境值沿用显式确认，关闭详情清除。列表高度受限并使用内部滚动，分类 Tab 保持可见且支持标准键盘切换。无新增数据库、IPC 或生产依赖。
