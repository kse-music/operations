# ServerDeck 总体架构

本文描述当前模块职责、数据流、安全边界与生命周期。需求见[PRD](../product/PRD.md)，状态见[实施计划](../product/IMPLEMENTATION_PLAN.md)，设计演变见[技术决策](DECISIONS.md)。精确插件协议由[SDK 文档](../plugins/PLUGIN_SDK.md)维护，避免在总览复制多份契约。

## 系统边界与工程结构

应用为本地 Tauri 2 + Vue 3/TypeScript/Pinia 客户端，Rust Cargo Workspace 使用 Tokio。通过 SSH/SFTP 管理远端，不依赖 HTTP 服务端、云账号或远程 Agent。前端不直接访问 SQLite、凭据库或任意本地 Shell。

| 位置                                        | 当前职责                                                    |
| ------------------------------------------- | ----------------------------------------------------------- |
| `apps/desktop/src`                          | 页面、公共组件、工作区状态、类型化 IPC、主题与交互          |
| `apps/desktop/src-tauri`                    | 组合根、主窗口 ACL、原生选择器/剪贴板、窗口和退出协调       |
| `crates/core`                               | 宿主 DTO、配置校验、安全错误；不依赖 UI/数据库              |
| `crates/application`                        | 用例编排、连接/文件/模型/插件所有权、受限阻塞工作、关闭协调 |
| `crates/storage` / `security`               | SQLite 当前 schema/配置；原生系统凭据及秘密生命周期         |
| `crates/ssh` / `sftp`                       | 认证、信任、Transport/Channel；文件、后台传输和原子编辑     |
| `crates/monitor` / `ops`                    | 宿主内部监控与运维服务，不作为插件领域 SDK 暴露             |
| `crates/tasks` / `ai`                       | 有界 SSH 单次执行；模型提供者传输、本地 CLI 和安装器        |
| `crates/plugin-core` / `plugin-runtime`     | 包校验、仓库、授权；无 WASI 的 Wasmi 运行时                 |
| `crates/plugin-sdk` / `packages/plugin-sdk` | 通用平台协议、WASM async 执行器、TS 客户端和通用 UI         |
| `plugins/system/{assistant,docker}`         | 独立 Vue/WASM 业务实现，只依赖公开 SDK 和普通库             |
| `crates/windows-file-drag`                  | Windows Shell 虚拟文件拖放，FFI 收敛在专用模块              |
| `tools` / `tests/fixtures`                  | 构建、隔离 QA、SSH 探针和不分发的协议/插件夹具              |

依赖方向以 `desktop → application → 具体服务 → core` 为主；`ssh → storage/security` 获取受管连接和秘密，SFTP/监控/执行复用 SSH 能力。模块不反向依赖 UI。仅秘密后端等必要边界使用窄接口，不引入通用依赖注入框架。

产品版本只在根目录 `Cargo.toml` 的 `[workspace.package].version` 声明，平台 Rust 包使用 `version.workspace = true`。Tauri 不设置独立 `version`，使用 Cargo 包版本；关于页通过 bootstrap 读取应用层的 `CARGO_PKG_VERSION`。根目录及桌面 npm 私有工程不声明产品版本，发布清单工具通过 Cargo metadata 获取真实桌面版本，并拒绝 npm/Tauri 重复声明。`tools/tauri.mjs` 的 dev/build 在磁盘检查后自动调用 `prepareAppVersion`：先检查来源，再用 `cargo update --workspace` 同步生成锁记录，成功后原样转交 CLI 参数，失败停止；候选 CI 在 Rust 的 locked 检查前执行同一准备流程。用户无需额外命令，SDK、插件和数据格式版本独立。具体发布步骤见[发布检查表](../release/RELEASE_CHECKLIST.md#版本来源与更新)。

## 启动、IPC 与错误

1. 单实例检查聚焦已有主窗口。
2. 在打开业务数据库/日志/WebView 前解析本机存储定位及用户明确发起的待迁移操作。
3. 打开当前数据库、校验完整配置并初始化日志，创建 Application 和各有界引擎；日志先于内置插件分发初始化。
4. 内置插件逐包分发，聚合单插件问题；主窗口 bootstrap 读取真实状态。
5. 前端初始化 Pinia 和工作区，显示欢迎页，不恢复旧终端或自动连接。

初始化数据库、配置或安全目录失败保留原件并诊断，不降级创建空库。单插件记录故障按下文隔离，不提升为整个应用的致命失败。

```text
Vue / Pinia → 类型化 invoke → Tauri 主窗口 ACL → Application
  → Rust DTO/范围/修订校验 → SSH/SFTP/模型或有界 spawn_blocking
  → 真实结果 DTO / IpcError → 状态与可见通知
```

主窗口命令集中注册并受 capability 白名单约束。Rust/TS 显式维护一致的 camelCase DTO，拒绝未知字段；命令派发与 ACL 由实际 IPC 测试验证。秘密读取不作为前端 IPC，普通浏览器预览明确显示未连接后端，不提供假数据。

`IpcError = {code, message}` 对用户提供安全文案；Rust 保留 source 原因链。SQL、输入正文和敏感参数不原样跨 IPC 或进入日志。Mutation 已提交但秘密清理失败须区分成功与待清理警告，不能伪装完整失败或静默成功。

错误经 `error-notifications` 和有界通知 Store 进入 `NotificationToasts`。共享 Store 观察共享失败，页面只观察局部失败，避免重复记录/弹出；弹窗内通知移入可交互顶层。失败状态、重试入口、原始业务输出和安全确认独立保留。

## 工作区与设置

主窗口默认 1280×820、最小 960×600 逻辑像素，约束由 Tauri 窗口配置定义。窗口恢复读取相同配置的最小宽高，再按当前显示器尺寸约束；窗口状态通道保存归一化后的普通窗口尺寸。存储校验继续接受此前有效的 900px 宽记录，由恢复层放大，避免调整界面下限导致既有数据无法读取。设置弹窗受视口边距约束，内容区独立滚动，保留操作区和未保存保护。

`AppHeader` 负责侧栏开关和全局搜索；`AppNavigation` 提供固定本地终端及设置，`HostSidebar` 提供多级主机树。侧栏收起保留 52px 图标栏，树用 `v-show` 保持搜索/展开状态，结束拖动和菜单交互；窄窗口使用浮层，不改变会话或持久化宽度。

Workspace 按实际打开顺序保存本地、远程主机和全局插件标签，不再维护顶部模块或“全部主机”派生页。HostId 是持久目标标识，活动页变化不能修改已有资源的真实目标。`HostTools` 平铺 SSH、SFTP 和启用插件；主机内部保存最近工具、插件页面和会话。

`settingsView` 独立于活动工作区。`SettingsDialog` 复用 `SettingsPanel`、`ModelsView`、`PluginsView`、`AboutView`；同一偏好草稿在窗口存续期间持续挂载。插件列表隐藏时保留筛选，`PluginSettingsPanel` 在同窗口展示详情和自有设置。工作区入口只设置 `pluginConfiguration`，由独立 `PluginSettingsDialog` 承载同一插件面板，不挂载全局设置或改变底层插件的 active 状态，因此关闭不会触发可见性恢复后的重复查询。配置 iframe 校验当前插件、贡献页面及 owner，不依赖全局设置分类；取消只关闭插件配置；助手配置页顶部仅提供刷新，聊天页的模型管理入口仍可显式转入全局模型设置。

`ModelsView` 使用本地来源/远程模型两个 Tab，默认 remote；两个面板通过 `v-show` 保持挂载，切换只改变展示，不停止本地下载或重置模型表单。键盘方向键/Home/End 由页内 Tab 导航处理，不创建新的工作区标签。

`pluginSettingsBusy` 联合插件管理 busy 阻止返回、分类切换和关闭；`settingsCloseGuard` 检查保存/迁移及未保存偏好/目录修改。取消关闭保留草稿，放弃才清除字号预览；模型和插件独立保存，关闭后恢复入口焦点。

`product.language` 沿用既有字符串字段，严格接受 `zh-CN` / `en-US`，不改变数据库或配置格式版本。应用 store 仅以已保存配置驱动响应式 locale；桌面、SDK 通用组件与各内置插件分别维护自己的英文词典，插值仅替换位置参数，不翻译用户数据。界面标题、菜单、状态、日期及排序读取当前 locale，不通过重挂载页面切换语言。插件桥在既有公开 context 推送 `language`，SDK runtime 更新 locale 和 HTML `lang`，不重新授权或调用业务；独立文本编辑器通过 `editor_load` 读取打开时的语言；原生编辑器标题及文件选择框同样读取已保存偏好。配置尚不可读的启动失败提示采用中英双语。上传插件元数据保持原文，内置元数据在呈现层翻译。原始后端/远端诊断保留证据内容。

前端插件配置写入成功后，UI 桥递增对应插件的运行期 `settingsRevision` 并通过公开 context 推送；不推送配置载荷，不改变业务页可见性。助手据此重读模型绑定，保存页在自身保存中跳过重读以保留成功反馈；失败和取消不触发通知。

主机关闭按冻结范围异步协调：禁止新文件连接/提交，审核 dirty 文件和插件草稿、确认取消传输，排空安全提交及清理，关闭文件租约和终端/插件 owner，成功后清除本主机临时传输记录。任何失败保留工作区与可诊断状态；轮询代号防止晚到快照恢复已清记录。切页只隐藏，不执行主机关闭流程。

## 主机与凭据

### 主机目录、测试和导入

SQLite 持久化 HostId、文件夹及当前 SSH 参数；根目录使用空父节点，多级文件夹有自引用外键和防环校验。删除文件夹在事务中将主机和直接子文件夹提升至父级。主机只按名称/地址/用户名搜索；SQL 中已有的闲置历史列保留数据，但不再进入 DTO 或业务读写。

`host_test` 使用待保存草稿、可选原 HostId 和实际凭据/代理/跳板构建连接计划，复用正式握手和信任；首次确认后重新握手验证同一指纹，认证完成即断开。五分钟、单次测试结果绑定规范化草稿、主机、路由和凭据/秘密摘要；`host_create_tested` / `host_update_tested` 提交前再次校验。文件夹移动等受控调用继续使用原更新用例。

OpenSSH Config 解析上限 1 MiB、10,000 行、500 个明确别名，支持 Host/HostName/Port/User/IdentityFile/超时/Keepalive 和受管 ProxyJump。遵循 first-value-wins、引号/注释和明确别名匹配；通配符不展开成资产。不执行 ProxyCommand；Include/Match、多个身份或未知关键项无法安全确定时阻止导入。跳板只接受明确受管别名或 none，最多四层，拒绝循环、缺失和端点冲突。提交重新解析，按依赖事务导入，重复跳过不覆盖；不写回 ssh_config，不提供主机 JSON 归档接口。

### 秘密版本与跨存储一致性

NativeStore 使用系统凭据库，当前服务为 `cn.hiboot.desktop.credentials.v1`。SQLite 保存 opaque secret_ref、类型及 revision，秘密 DTO 不实现 Debug/Serialize，Rust 使用 Zeroizing；前端临时输入提交/卸载清空，不宣称 JS/OS 内存副本绝对清零。

新秘密先登记 `secret_gc` 意图，再写新系统 entry；SQLite 事务切换引用并递增修订，提交后清理旧引用。提交失败补偿清理新 entry，崩溃/删除失败保留意图并在后续相关保存/删除重试。系统库不可用明确失败，不创建明文或内存替代。

主机认证变更创建独立凭据版本，复制/共享该旧凭据的其他主机保留原认证；只清理失去全部引用的主机专用凭据，显式共享凭据不自动删除。导入私钥的解锁口令只用于导入，受保护正文进入系统库；现有路径型身份/OpenSSH 路径仍遵守连接校验，不代表保留旧格式自动迁移。

## SSH、终端与流量控制

### 连接与所有权

持久 HostId 与运行时 ConnectionId/SessionId/TaskId 分离。Engine 注册表拥有 Transport 和 Session，工作区持关联句柄。复用键包括主机、端点、用户、认证方式/引用/revision、完整跳板链、代理凭据及超时/Keepalive，配置变化不得复用旧认证上下文。

```text
连接：Disconnected → Connecting → AwaitingHostTrust → Authenticating → Connected
      → Disconnecting → Disconnected / Failed
会话：Creating → Running → Closing → Closed / Failed
```

应用自己的 `ssh_known_hosts` 按规范化 hostname+port 保存完整公钥、SHA256 和信任时间。未知主机认证前等待活跃 challenge 的用户核验，60 秒超时；竞争确认复验公钥，已知密钥变化硬拒绝，证书默认拒绝。系统 known_hosts 哈希/CA/撤销尚未接入。本地 RSA 私钥签名受[密码学门禁](DECISIONS.md)拒绝，不能以测试通过代替安全审查。

每个终端独立 PTY/取消令牌/任务句柄，关闭只结束自身 Channel 和所属转发；Transport 在无相关租约后释放。SFTP/Monitor/执行拥有独立租约，单个子系统失败不误关其他会话。`TerminalPane` 的 `connect` 清空输入与待确认粘贴，关闭旧 Session 后创建新 Shell，generation 隔离迟到事件；会话菜单通过按 PaneKey 注册的连接控制回调协调同标签全部窗格；先确认并排空拖放上传，断开旧 Session 后保留 xterm、标签和分屏。断开成功递增 generation 并清除运行期标识、旧目录、输入和待确认粘贴，迟到事件不再更新界面；断开失败保留原连接状态和错误。重连复用 `connect` 创建普通新 Shell，旧连接关闭成功后在 xterm 输出队列中追加 CAN + RIS，先取消未完成控制序列再完整重置正常/备用缓冲、滚动历史、选区和控制模式；重置排在已接收旧输出之后、新连接输出之前，同时关闭查找并清空查询/装饰，保留实例、尺寸和显示偏好。关闭失败不清屏，主动断开仍保留历史。操作期间阻止重复连接和并发关闭；文件/容器动作及插件票据不允许重放，主机连接配置仍与当前目录校验。同步锁只作短暂注册表操作，不跨 await 或串行化全部输出。

### 有界输入输出与布局

`TerminalPane` 通过 xterm `WebLinksAddon` 识别普通 HTTP/HTTPS 文本，并让 OSC 8 `linkHandler` 共用左键激活处理。链接走仅本地主窗口授权的 `terminal_open_link` IPC，Rust 校验 HTTP/HTTPS、主机及有界无控制字符的 URL 后，在阻塞任务调用系统默认浏览器；不向前端开放任意程序、文件或通用 Shell 权限。隐藏/已卸载窗格与被其他弹窗阻挡的终端不激活链接，打开失败使用已有错误通知。

PTY 每块最多 16 KiB，经 Tauri Channel 交给 xterm，`xterm.write(callback)` 完成后 ACK 才读取下一块。输入/resize 独立运行，输出等待不能阻止 Ctrl+C 和取消；输入队列、单次大小和粘贴确认均有界，resize 合并最新尺寸。russh 内部仍有非全有界队列，不承诺恶意服务器下的进程硬内存限额。

应用全局状态栏的 `TerminalStatus` 只绑定当前主机、活动会话中的焦点窗格；非终端页面或无当前会话不挂载。`TerminalPane` 通过 xterm 公开的 `onCursorMove`、`onResize` 和活动缓冲更新运行期 `screen`（行列数与从 1 开始的光标行列；待换行时限制在最后一列），不改变 PTY 生命周期或持久配置。SSH `Verifier::kex_done` 只提取协商算法名称，不读取/保存共享秘密；逐跳握手各有 watch 通道，仅最终目标的算法进入 Connection。每个终端订阅其 Transport 的算法，Shell 就绪前及后续重协商时发出内部 `TerminalEvent::Connection { cipher }`，共享会话和首个窗格关闭后仍可更新。前端沿用 generation 丢弃旧事件，重连清除旧算法，断开/失败显示连接状态；本地使用真实 Shell 名称，仿真标记统一为 `xterm-256color`。CAP/NUM 只监听 WebView 的 keydown/keyup，不拦截按键；初始与窗口 blur/focus 后为未知，下一键盘事件同步。状态区独立可横向滚动并可键盘聚焦，不增加 IPC 命令、SDK 版本、数据库字段、远端采集或全局键盘钩子。

前端区分会话标签、PaneKey 和 Session。二叉树仅计算分屏几何，固定 PaneKey 保持 xterm 挂载；每标签最多八窗格，全应用最多 32。后台终端持续消费 ACK。编号按主机运行内计数，最后会话成功关闭后重置；不持久化终端布局、标题、正文或会话，不保留旧 workspace_load/save 接口。xterm 的 cursorBlink/disableStdin 随连接状态同步：仅 connected 允许输入并沿用用户闪烁偏好；非连接状态同时停止光标 CSS 动画，覆盖远端 DECSCUSR 模式对本地闪烁选项的覆盖，保留光标所在字符和历史正文。重连恢复原偏好，不重建 xterm 或写回配置。

`TerminalsView` 挂载会话新建、拖动排序、双击重命名、关闭、分屏快捷键及绑定目标 TabKey 的会话菜单；菜单复用 store 的重命名/断开/重新连接/关闭/按主机关闭所有；任一窗格处于 closed/failed/disconnected 时，名称前显示红色圆形白横杠图标。复制只调用普通 `open(host)`，不复制动作或票据。菜单支持右键和键盘、视口限位与焦点恢复。重新连接的菜单禁用态与 store 执行入口共用 `canReconnect`，仅当全部窗格属于 closed/failed/disconnected 且没有动作/票据或进行中的连接操作时允许；已连接或未曾连接的标签与混合状态分屏均拒绝重连。`TerminalPane` 不挂载底部操作栏、快捷键提示及其重连/转发/SFTP/导出界面，内容区菜单仅复制/粘贴，查找和字号快捷键保留；SFTP 使用主机工具栏入口。默认键位由 `core::terminal::default_shortcuts` 与前端偏好共同约束，关闭的是当前窗格而非整个工作区。

纯文本复制粘贴使用受限 Tauri 原生剪贴板服务，只在用户动作后运行。异步读取绑定连接 generation，重连/卸载废弃旧读取及待确认粘贴；2 MiB 上限、大文本确认和 Bracketed Paste 保留。字号/行高变化适配当前 xterm 和 PTY，不重启 Shell。终端容器使用 content-box，让 FitAddon 读取的高度不包含外层内边距，避免多计算一行而被容器裁切；容器背景同步当前终端主题。xterm 6 的旧 `.xterm-viewport` 保留 DOM，但覆盖其黑色背景和强制原生滚动条样式，实际滚动继续由 `.xterm-scrollable-element` 负责。窗口 resize 事件适配当前尺寸并明确请求强制滚到底部，覆盖最大化、还原和拖动调整窗口尺寸；强制标记保留至下一渲染帧，不因随后 ResizeObserver 的 fit 被覆盖。侧栏、分屏或显示偏好引发的普通 fit 仅在原本处于底部时同步滚动条，不覆盖历史阅读或用户随后滚动。两种路径均通过公开滚动 API 修正 xterm 6 的旧像素位置，仅作用于同一可见普通缓冲；合并连续 fit，卸载移除窗口监听并取消回调，不滚动隐藏或备用屏幕。

Linux 本地 PTY 使用有效 `$SHELL`、账户 Shell 或 `/bin/sh` 的交互模式。AppImage 仅在子进程环境剔除 APPDIR 内 Python 和搜索路径，不修改应用全局环境或用户文件。Windows 使用 PowerShell。

### 路由、转发和 ZMODEM

首跳可经 SOCKS5/HTTP CONNECT，后续 direct-tcpip 嵌套 SSH，逐跳信任与认证。端口转发归属 Session，默认回环、公共绑定需确认；Local/Remote/Dynamic 有界并发与取消。远端取消未确认时关闭所属 Transport，明确报告共享会话可能断开；不自动恢复转发。

当前终端界面不挂载转发管理对话框；Rust 转发服务、IPC 及会话清理边界保留，未因删除界面入口放宽权限或更改生命周期。

rz 使用固定版本 ZMODEM 实现与流式握手识别。Rust 原生选择器发放绑定终端/取消令牌的文件句柄，不提供任意路径读取；分块读取，等待选择和上传不阻塞输出 ACK，普通输入在上传时隔离。关闭/取消撤销句柄，迟到选择不能向新 Session 发送文件。协议与实际验证见[ZMODEM 记录](../validation/terminal/VALIDATION_ZMODEM.md)。

### 当前 Shell 拖放上传

主窗口原生拖放事件登记有界、两分钟有效的一次性授权，前端按物理坐标和 devicePixelRatio 命中可见普通 SSH 窗格；IPC 仅接受授权/会话标识，不接受任意本地路径。确认后 Rust 在受限阻塞任务中扫描并生成临时 tar，拒绝链接和重解析点，读取期间检查取消和源变化。复用 TerminalUploads 的单会话互斥、文件句柄、分块读取和释放，归档块上限 64 KiB，关闭令牌撤销授权；与 rz 互斥。

固定接收脚本由原 PTY 启动，不创建新认证上下文或调用 sudo，当前有效 UID、目录及 umask 直接继承。随机 nonce 的有界流式帧承载 READY、序号 ACK、校验/提交阶段及最终结果；64 KiB 原始数据逐块 Base64，收到匹配确认才推进进度，PTY 输出 ACK 不等待用户确认或上传。输入队列保留原边界，普通输入在上传期间隔离。脚本保存 stty，接收超时、取消与退出走恢复/清理；只有最终帧确认恢复后才解除隔离，未知结果要求关闭会话。

确认 Modal 保持同一实例并切换到上传进度，完成本地授权释放后成功自动关闭，失败留在弹窗中。前端从 READY 后用单调时钟计时，以匹配 ACK 累计的原始归档字节计算传输平均速度，不计准备、接收端启动或后续校验/解包；容量复用 SFTP 的格式化函数，非传输阶段不显示速度。不改动 PTY 分块或确认协议。命令首字节发出至原 Shell 的 RETURN 帧之间归属上传：启动回显、PS2 续行提示、接收诊断和协议字节均不进入 xterm，结果/故障经协议转为弹窗状态。接收端 DONE/ERROR 之后还等待原 Shell 发送 RETURN，防止提前关闭界面或泄漏退出尾部内容；随后真实 Shell 提示符在旧空白输入行原地刷新。准备阶段和返回边界之后恢复普通输出，不清屏或清理已有滚动历史。

拖放接受时由 TerminalPane 激活并聚焦目标窗格，让原生 Modal 记住正确的返回目标；弹窗完全卸载后，上传组件携带原 SessionId 通知父窗格，再复用 xterm 的焦点入口恢复输入。恢复前重新检查连接代次、Session、可见性、工作区关闭状态及其他弹窗，已失效会话或当前另有交互时不抢焦点。不通过重建 xterm 或修改光标闪烁偏好修复焦点。

目标目录独占私有暂存，接收归档先核对 SHA-256，再禁止恢复属主/特殊权限地解包。所有顶层名称预检后逐项不覆盖提交，并检查源是否确实移走，不以 mv -n 的退出码单独判断成功。取消不删除已提交项目，清理不跟随链接且仅针对本次暂存；断线清理无法保证时报告限制。前端运行期取消句柄随窗格注册，关闭会话/主机先确认并排空，重连/卸载废弃旧结果。接口类型位于 core terminal 与桌面 types/terminal，不改变插件 SDK、SFTP 身份或持久数据格式。取舍见 [ADR 0033](decisions/0033-terminal-drop-upload.md)，执行证据见[拖放上传验证](../validation/terminal/VALIDATION_TERMINAL_DROP.md)。

## SFTP、传输与编辑

普通 Files 租约复用完整认证路由并请求 SFTP 子系统，不启动 Shell。目录使用 SFTP v3 RawSftpSession，传输各有独立 Channel；请求、响应、目录条目/名称和递归规划均有上限。原生选择器只通过受限文件命令开放，不授予通用 fs/shell 权限。

`files_switch_user` 仅允许本地主窗口调用。它核对原租约与当前主机配置，创建不复用已有 Files 租约的候选连接；候选目录读取成功且原连接无传输/编辑文档后关闭旧连接，失败释放候选。sudo 身份固定在独立 Control 上，各 Channel 用同一身份启动外部 sftp-server；目标用户与程序路径严格校验并按 Shell 参数转义。无 PTY；固定包装先切到目标 HOME（失败时 `/`），发送随机就绪标记后 exec 服务。密码仅响应 stderr 中本次唯一提示标记，最多发送一次；认证与 SFTP 二进制流分开，启动超时/关闭会释放 Channel。密码用 Zeroizing 保存在租约内存，不改变主机或凭据配置。前端隔离旧事件、目录请求和轮询结果，主机关闭等待切换完成。插件仅选择 `login_file_connections`，不会继承 sudo 身份。取舍见 [ADR 0029](decisions/0029-sftp-user.md)。

Pinia 保存每主机文件连接、实际目录和独立导航历史；连续目录请求由代号隔离，失败保留原目录。权限按 mode 展示，owner 仅从受限 longname 格式解析，未知回退 UID，不猜测名称。两栏内部滚动，活动传输面板与页头记录共用同一任务状态。

本地地址栏的磁盘选择通过仅授权主窗口的 `files_local_drives` 返回 `LocalDrive { path, name }`。Windows 复用原生文件互操作 crate，在阻塞任务中调用 GetLogicalDrives/GetDriveTypeW 读取真实盘符及类型，不启动 Shell；非 Windows 仅提供 `/` 文件系统入口，不枚举挂载点。前端按实际/待加载路径匹配盘符，选择后复用 `files_local` 与原导航历史及失败恢复，不改变传输权限或持久格式。本地磁盘与远程目录共用 `FileLocationPicker`（由 `LocalDrivePicker` 提取），使用 combobox/listbox 呈现图标与名称，目录支持层级缩进；弹出列表 Teleport 到 body 并限制在视口内。键盘焦点保留在入口，通过 `aria-activedescendant` 指向当前高亮项，确认时才导航。外部点击/焦点、Esc、Tab、窗口失焦/缩放或父层滚动关闭菜单；工作区受阻或组件卸载时同步关闭并移除监听器。

远程目录层级由 `remoteDirectoryLocations` 从 SFTP 的当前规范路径或已提交绝对目标拆分，保留各级名称和累计绝对路径；相对路径及带 `.`/`..` 的未解析目标沿用已确认层级，地址栏草稿不参与计算。点选通过现有 `store.navigate`/`files_list` 读取，不新增 IPC 或远程授权；失败、连续导航与历史仍由原请求代号和状态处理。菜单按 SFTP 连接 ID 绑定生命周期，切换身份会销毁旧弹层；关闭主机、切用户和断开期间禁用。

`ConflictPolicy` 与后端支持 fail/skip/rename/overwrite；`FilesView` 当前确认表单仅提供 fail/skip/overwrite，文件“重命名”动作与传输冲突的自动重命名是两条不同链路。

任务由 Rust 保存，状态为 queued/scanning/running/verifying/completed 或 cancelling/cancelled/failed。默认每主机三个活动任务、可配置 1–6，全局最多 12 活动，其他队列/历史限额有界；降低设置不抢占已开始工作。页面隐藏不取消，主机关闭或退出走显式确认/排空，不跨进程恢复任务。

上传/下载先在目标同目录独占临时文件、流式写入并回读 SHA-256，复验源和目标后提交；无覆盖使用不覆盖提交，覆盖须用户确认。取消不撤销已提交文件，提交临界区等待结果，清理失败给出恢复路径。递归不跟随链接，显式普通文件链接下载在读取及提交前复核真实目标。Windows 窗口外拖放通过 Shell 虚拟文件按需读取，复用 SFTP 校验队列，数据对象释放后清理专用暂存。

Monaco/worker 本地按需加载，桌面 UI 一次打开一个内置或外部编辑文档，内置文本为不超过 2 MiB 的严格 UTF-8 普通文件。文件服务仍保留八个文档的底层总配额，不代表桌面支持多窗口并行编辑。保存检查原始 hash、大小/时间/uid/gid/mode，验证 WRITE 权限，创建同目录临时文件并校验，保留并复核 uid/gid/mode 后使用 OpenSSH posix-rename。缺少扩展/权限/元数据保留失败不降级为 unlink 或原地截断。

本地双击通过仅主窗口可用的 `files_open_local` 调用 Windows 原生应用选择器；验证普通绝对文件路径，以主窗口作为 owner，在 STA 阻塞工作线程中调用，不开放通用 Shell/opener 权限。远程外部编辑由文件服务管理 token，复用传输队列下载到数据根下独立 `external-edits/edit-*` 目录，完成后复核下载前属性及本地/远端 SHA-256，才将副本交给系统应用。外部文档与文本共用八个文档配额和原子保存链路；二进制流式回传，不转换编码，回传前后核对本地副本和远端原始快照，取消在提交前检查，rename 临界区等待结果。身份、远程路径与本地路径由 token 绑定，IPC 不接受任意回传源或更换目标。

外部会话在结束前持续计入未保存保护，即使刚回传也不能假设外部应用不会再次修改，不能通过文本 dirty 接口解除。页面重载取消尚未提交的外部回传，已移除会话不因迟到的保存完成而重新注册；数据目录迁移前要求结束外部编辑。副本按用户权限保存，结束、失败和退出不删除，重启不自动恢复授权或上传。前端独立显示下载/打开/回传状态和确认；结束时通过通知直接提示副本路径，复用有界通知 Store 的关闭与 6 秒自动消失机制。文件操作成功反馈不存入全局文件状态或重复渲染为页头横幅，切页、重连和重开主机不重放旧消息。内置编辑器的加载故障在局部边界处理；已进入编辑的运行错误不销毁草稿。取舍与限制见 [ADR 0031](decisions/0031-external-file-editing.md)。

`editor_open` 由主窗口调用，Rust 单例登记绑定文档和唯一 `remote-editor-*` 标签后创建无 parent/owner 的顶层 `WebviewWindow`；使用当前数据定位中的 WebView 目录，不增加持久配置。独立入口只加载 `EditorWindow` 和按需 Monaco，不挂载主应用、主机/终端 Store 或插件服务。编辑器专用 capability 仅允许绑定文档的加载、dirty、保存、重新读取、关闭、事件监听和剪贴板；Rust 按实际调用窗口解析文档，编辑器 IPC 不接受任意 token/session/path。主窗口只接收文档摘要与 dirty，保存成功通知主窗口刷新列表；不跨窗口广播正文或逐键同步全文。

Rust 使用绑定文档的路径生成系统标题，主窗口提供当前 SFTP 用户及主机地址作为显示文字。`RemoteEditor` 在窗口内固定一行图标工具栏和底部状态栏，Monaco 使用伸缩空间及 automaticLayout，系统缩放/最大化不重建 model。初始主题/字号从后端偏好读取，系统主题变化继续跟随，主窗口后续偏好修改在下次打开时应用；卸载释放监听和编辑资源。保存按钮/快捷键共用忙碌、只读检查，后端继续向原保存链路传入 `confirmReplace: true`；dirty 更新按顺序完成后才保存/关闭，失败保留草稿。默认保存取舍见 [ADR 0032](decisions/0032-default-atomic-text-save.md)。

原生关闭事件只向对应编辑器请求审核；加载前可直接关闭，进入编辑后提供返回、保存后关闭和明确放弃。读取/保存与关闭互斥，主程序退出确认也检查进行中的编辑操作；全局退出明确放弃全部未保存修改。编辑器打开期间阻止所属连接/主机主动关闭、身份切换和数据目录迁移，并阻止主窗口/编辑器导航重载。窗口销毁按唯一标签释放对应 token，不影响后续文档；意外销毁未保存文档记录诊断，不提供草稿持久恢复。主窗口页面重载清理、全局退出审核和主窗口尺寸记录均限定主窗口，编辑器加载/关闭/尺寸变化不触发终端清理或覆盖主窗口几何。窗口边界取舍见 [ADR 0037](decisions/0037-independent-file-editor.md)。

原子替换改变 inode，SFTP v3 不能完整保留 ACL/xattr/硬链接或消除最终检查到 rename 的竞态，限制保留在[使用说明](../guides/USER_GUIDE.md)；外部编辑回传仍显示覆盖确认。提交后断线可能结果未知，须重新核对。插件文本文件请求另受 SDK 更小的配额和授权根限制，不能套用桌面编辑器上限。

OSC 7 仅作为已校验路径提示，不作为权限依据。已连接 SSH 窗格的“打开 SFTP 文件”动作发出其 Host、cwd 和 PaneKey，复用 App 既有 files 事件处理；重连清除旧 cwd，没有有效提示时不猜路径。文件页→目录/less/tail 的动作经确认后使用固定且转义的独立 PTY，不注入现有 Shell。未保存文档在关闭/重载前审核，保存失败保留草稿及恢复信息。

## 插件平台

### 包、运行时和业务边界

Host/Rust/TS SDK 5.4.0，UI v4、ABI/wire 1；拒绝旧开发期合同。WASM 无 WASI/任意原生导入，受线性内存、fuel、消息及并发限额；自带 Vue JS/CSS 位于不带 same-origin 的受限 iframe，经认证 MessageChannel 访问可信桥，不能任意转发 Tauri IPC。

```text
插件 Vue → 认证桥 → 本包 action → WASM async Runtime
  → Platform request + bindings → Native 权限/目标/配额/审批
  → 通用 SSH/SFTP/模型传输 → 原 Future 续接 → 插件解析与展示
```

命令/SQL、容器语义、DTO、解析、脱敏、提示词、工具循环和计划均归插件。SDK 只提供平台协议/客户端/通用 UI，公开目录不含认证、代理、秘密或内部租约。宿主内部 Ops/Monitor 可继续服务自身用例，不以领域枚举或插件 ID 特判开放给插件。

一个安装修订共享有界 VM，每页具有可信 owner。资源绑定插件、安装修订、VM 代和 owner，目标另绑定真实 SSH 配置或模型修订。审批保存原 WASM Future/请求，批准或拒绝从等待点续接，不从动作开头重放。隐藏禁止新动作/审批并释放流/PTY，关闭只撤销自有工作；禁用/撤权/升级/卸载清理整个插件，保留其他 owner/共享连接及远端服务。

插件终端由 `PluginFrame` 按一次性票据标识挂载 `PluginTerminalDialog`，复用独立 `TerminalPane`；最大化、查找、字号和本地清屏只操作当前 xterm，不创建工作区终端或重用票据。通用桥接收可选纯文本呈现上下文并校验字段和限额，主机地址由宿主实际 `Host` 展示，呈现信息不进入原生执行授权。弹窗内的右键菜单和滚轮缩放使用同一顶层弹窗检查，嵌套指纹/粘贴确认仍阻止底层终端交互；关闭和迟到打开沿用原 PTY 清理。契约见[公开 SDK](../plugins/PLUGIN_SDK.md)。

### 授权和确认

授权绑定 ID/版本/包摘要/安装修订、权限/operation 和文件根。system 由发行流程写入，仅决定分发与预置权限；上传同 ID 不继承 system，执行规则、配额和目标复验相同。目前无密码学签名校验，摘要/作者元数据不证明可信来源。

Execute 默认由可信宿主逐次确认实际目标与命令；提供易读说明的确认只显示业务摘要，原生仍绑定完整请求。可选 `preapprovedCommands` 保存 1–16 条完整 Command、总 JSON 不超过 48 KiB，须同时声明并授予 `ssh.execute` 和独立 `ssh.execute.preapproved` 权限/operation。仅 program/args/timeoutSecs 完全匹配才跳过单次审批，无参数模板/通配符或只读声明。StreamOpen/Terminal 另由独立 `ssh.interactive.preapproved` 权限/operation 预授权当前安装修订启动任意交互命令，仍需基础 SSH 授权；上传包默认不授予。两类预授权均不适用于 SaveFile/TcpConnect；交互预授权不适用于 Execute。详见 [ADR 0030](decisions/0030-interactive-preapproval.md)。

执行槽等待后、真正执行前和结束时复验绑定；配置变化拒绝或报告可能已执行，不能静默换目标/重试。单次审批绑定完整请求、owner、安装/VM 代和 SSH 摘要，60 秒一次消费。文件保存绑定规范路径、授权根及原始摘要，安全提交开始后排空；取消不宣称已写操作被回滚。

原生审批独立返回实际 `target`。前端 `invoke` 可携带冻结的纯文本确认说明，有原生目标时展示目标与业务摘要，不展示执行详情或命令脚本；原生审批仍绑定完整命令，缺少原生目标时沿用完整提示。说明不传入 WASM、不参与原生授权，也不能改写目标或请求。Docker 的操作名称、容器/镜像名称及影响文案归插件，宿主只处理通用呈现；字段契约见 [UI 扩展](../plugins/PLUGIN_UI_EXTENSION.md)。

### 构建分发与安装故障

`tools/system-plugins.mjs` 按稳定顺序扫描 `plugins/system` 直接子目录，校验完整源码/锁文件/manifest/入口，拒绝链接、重复 ID 和残缺输入；`packages` 是保留输出，不参与发现。全部包构建并校验成功后发布标准包和生成的 `packages/registry.rs`，`bundled_plugins.rs` 引入注册；夹具不分发，不按旧产物决定注册。

当前只分发 Docker 与助手。外部 MySQL 从应用下载的开发包独立开发后上传，不进入内置目录；新增完整系统插件目录可自动构建，不维护服务白名单、不做运行时热扫描。开发包由 Vite 打入客户端，主窗口专用保存命令将固定 ZIP 写入用户选择位置。

Docker 插件以十一条完整固定命令预授权版本/操作系统、列表、详情、资源、按需环境变量、Compose 项目列表、服务快照、容器启动配置快照及 Compose 配置隐藏/显式变量查询。版本查询同时读取当前 daemon 的 `OperatingSystem`，只投影该字段；失败保留 stderr 并将操作系统标记为不可用，不用客户端系统或本机系统代替。详情和资源读取主机快照，由插件按完整容器 ID 筛选；概览格式不包含环境变量，普通容器的环境变量明文只在进入环境变量或启动配置标签时单独读取，前端只收到所选容器的数据。日志和 Shell 通过独立交互会话预授权直接打开；容器启动、停止、行内重启、删除、镜像删除及 Compose 项目启停/重启只保留宿主一次确认，无需输入目标 ID。快照仍受通用输出和超时限额约束，未声明命令沿用原审批，不在宿主增加 Docker 专用匹配规则。

Compose 业务在 Docker 插件内实现，通过项目列表及仅投影必要标签/状态的容器快照发现项目和服务，不新增 SDK/IPC 或数据库字段。变更及日志先绑定真实 SSH 配置修订，再从当前非一次性服务容器标签核对一致的工作目录和有序配置文件，逐项引用目录/文件参数，显式选择项目及全部 profiles；缺失/冲突/非绝对路径不猜测。项目操作执行 `start`、`stop`、`restart` 和 `logs`，配置查看使用下述只读 `config`，不拉取或重建，原始自定义环境文件等参数未完整恢复时可能失败。前端沿用资源列表和流组件，缓存标签页的激活状态参与可见性判断；切页释放日志，迟到打开的流显式停止。

容器详情的启动配置由 Docker 插件 `container_startup` 请求实现，端口和挂载统一使用 Compose YAML 展示。先绑定 SSH 配置修订，读取固定快照并按完整 ID 筛选；容器快照只输出环境变量名称，不输出值。普通容器转换 Config、HostConfig、Mounts 和网络信息，未映射的有效设置列为限制，现有卷和网络使用 external 引用。Compose 配置采用隐藏/显式变量两条完整固定脚本，在远端从标签发现项目、按项目去重、复验全部成员的目录和有序文件一致性；位置参数传递路径，不使用 eval 或拼接动态 Shell。按 `compose config --help` 能力检测，仅支持时添加 `--no-env-resolution`；隐藏模式只在支持时跳过 env_file 解析；启动配置 UI 进入时直接使用显式变量查询，展示当前项目环境解析后的值，不再提供查看/隐藏按钮。WASM 仍隔离当前 service，内联 secrets/configs 内容始终隐藏。项目结果使用独立 JSON 对象及按完整 ID 分段的 stderr，单个项目失败不污染其他项目诊断；WASM 再核对项目、当前成员和标签路径，只返回当前完整 service 及引用的顶层定义。固定脚本受现有精确预授权、超时和输出限额约束，变更确认及上传包独立授权保持，不扩展 SDK/IPC 或数据库；取舍见 [0036](decisions/0036-compose-config-preapproval.md)。当前文件/环境无法保证恢复历史 env-file 或启动时 shell 环境。前端以纯文本 YAML 显示，组件卸载及新请求清理明文、隔离迟到结果；失败保留诊断，可显式选择 inspect 转换。Docker 插件 CSS 仅针对包含容器详情的 Modal 设置有界 flex 布局和外层 overflow hidden，标题/关闭按钮与标签不收缩；中间包装和详情根节点允许收缩，tabpanel 独立 overflow auto 并隔离过度滚动。按当前标签重建 panel，使滚动位置复位。通用 Modal、其他详情和日志弹窗保持各自布局。

SDK 的 `StreamDialog` 使用同一有界日志流、DOM 更新后的末尾定位及 ResizeObserver，不重开命令。记录上次处理的输出高度和视口高度，过滤或窗口/字号重排期间产生的滚动不能单凭距底部距离改变跟随意图；当前渲染帧的滚轮、指针和滚动键输入单独标识，保证真实用户滚动在布局变化时仍生效。动画帧仅用于释放输入标记，不延迟日志或增加重试；滚动消费标记，卸载取消标记帧与轮询、断开观察并停止自有流。无重排时沿用 24px 末尾阈值，跟随模式才自动定位，暂停/历史模式不被过滤为空或自然位置钳制切换为跟随。保留浏览器原有滚动锚定，输出仍为纯文本及 1 MiB/5000 行有界缓存；协议、权限和持久格式不变。

已退出容器批量重启和日志清理由 Docker 插件自己的 `container_maintenance` 请求实现，沿用通用 SSH 执行及宿主单次审批，不增加预授权、SDK/IPC 或持久字段；`restart_all` 已移除且拒绝解析。确认后的同一远端脚本查询完整容器 ID 并校验，按精确 `exited` 范围一次调用 Docker 批量重启，从返回 ID 统计逐项结果；行内重启复用 `container_action` 的完整 ID 校验和确认。清理按 daemon 数据目录、驱动及实际日志路径核对，只截断普通 `json-file` 当前日志，拒绝符号链接和路径不一致，保留轮转文件。脚本返回操作计数，WASM 校验合计并保留 stderr；部分失败返回失败，前端提示核对实际状态，平台原有 30 秒超时仍适用。

仓库汇总有效安装与问题项，单插件旧/损坏记录隔离并显示诊断，原记录/载荷/配置不动；仓库根安全故障和数据库错误仍传播。主窗口私有 `plugin_inventory` / `plugin_reinstall_bundled` 不属于 SDK。显式重装确认绑定原记录摘要，先逐字持久备份再原子提交，保留旧载荷/配置，新安装默认禁用且不继承旧授权；不存在兼容解码或自动迁移。

SDK 5.1 的通用文件传输原语通过冻结端点及原生审批复用既有 SFTP 队列，支持单文件本机上传和服务器间流式中转。后台持续复验授权及修订，字节不经模型/插件桥；结果未知不自动重试。文本读取也需宿主确认，保存增加读回复查。详细契约及限制见[SDK](../plugins/PLUGIN_SDK.md#文件与传输51)、[助手架构](ASSISTANT_AGENT.md#文件与传输)。

审批模式与计划确认复用通用SDK：请求批准、帮我批准和完全访问按发送时模式绑定owner/VM。帮我批准以独立权限匹配固定读取与严格完整argv参数模板，未知/风险命令仍确认；完全访问必须由可信宿主首次确认并生成无计时过期的当前会话策略，切换模式、新建对话、关闭owner或撤权/停止/升级时撤销；隐藏/返回保留。撤销同步删除Full句柄与待批准项，启用会话随机标识绑定首次批准，原子签发拒绝撤销前的迟到批准；前端等待撤销确认，失败阻止新请求并提示重试。模型/主机修订及其他临时句柄仍保持原有效期，基础权限、目录和目标复验不变。计划继续预检并冻结请求摘要/次数，按模式取得授权后仅在同一WASM动作限次消费，不能扩大或重放。详见[助手审批模式](ASSISTANT_AGENT.md#审批模式与单次计划确认)、[ADR0038](decisions/0038-three-approval-modes.md)、[ADR0039](decisions/0039-session-full-access.md)。

## 模型传输与 AI 业务

模型注册、系统 Key、真实连接测试和修订管理属于 Native；通用 `models.use` 能力在授权后传输插件构造的消息，Key/CLI 登录数据不进入 Guest。助手插件拥有资产匹配、上下文采集/脱敏、严格 query/plan/answer、冻结计划和执行后复查，不再依赖私有宿主 AI 业务 API。具体预算和资源协议见[SDK](../plugins/PLUGIN_SDK.md)。

模型生成增加SDK5.4通用有界模型流和文本进度资源：远程SSE、本地Codex/Claude文本增量由Native传输，WASM提取并脱敏可见回答，前端在原动作执行中读取进度，完整结果仍校验后才开放计划。资源与取消均绑定原owner/VM，基本权限和审批不变；详见[流式回答](ASSISTANT_AGENT.md#流式回答)、[ADR0040](decisions/0040-assistant-streaming.md)。

`ai::model_test` 只保留测试绑定摘要，签发 300 秒单次凭证；保存新建/关键配置或 Key 变更时消费并复验配置、凭据及编辑身份，不能用一次旧成功测试批准新配置。模型 Key 没有读取回显接口，空输入保留已有值，清除/删除走明确的用例及秘密 GC。`check_model_edit` 在 baseUrl 变化且仍有旧 Key 时要求新输入或明确清除，防止默认将原凭据发送给其他服务。

助手 `workflow` 对单主机执行最多六轮/十二查询/每轮三项的只读循环，`agent::build_plan` 从完整证据冻结最多 32 项；多主机命令建议标记 manual_only；文件工具使用明确匹配的 hostId，不能隐式选择一台执行命令。预览和计划按准备时刻五分钟清理，单次消费且绑定 owner/模型/SSH 修订；执行超过 100 秒不启动后续步骤，在途按平台提交边界收尾。业务清单由插件保存，Native 可对固定请求集合一次确认，再逐项复验并按次数消费授权，插件确认文字不能代替授权。策略理由见[ADR 0027](decisions/0027-assistant-policy.md)。

助手 `tools` 目录统一现有 13 项只读、5 项变更工具的元数据与完整参数，模型批次在查询前全部校验，查询/执行共用工具结果。`task` 模块维护最多 32 个运行期快照，绑定原 owner、模型及 SSH 修订，覆盖准备、查询、待审核、执行、复查及终态；终态不恢复执行，任务查询仍经 Native 复验；传输状态/取消不依赖过期模型句柄，但不能启动或改变目标。前端展示状态及未确认结果，不提供实时状态事件或持久恢复。协议和限额见[助手工具与任务](ASSISTANT_AGENT.md)，取舍见[ADR 0033](decisions/0033-assistant-tools-tasks.md)。

模型响应的 usage 才是实际 Token 来源；任一轮缺 usage 时不伪造累计值。准备阶段先按完整查询统计，再对选定原值脱敏，最后截短展示明细；诊断仅携带命中主机，普通知识不附目录，明确资产清单问题才附目录。`budget::fit` 在准备（消息 40 KiB）及每轮补全（44 KiB）按含 JSON 转义、模型和输出配置的完整请求估算输入并预留最大输出；不足时依次削减成功查询的可选明细、最早完整历史轮次，保留问题/归属/统计/失败及省略标记，仍不足才拒绝。前端按实际准备请求编码限制 48 KiB，删除完整旧轮次而不切断文本；压缩不改写旧消息或本地完整执行证据。验证见[上下文回归](../validation/ai/VALIDATION_ASSISTANT_CHAT.md#2026-11-09-上下文脱敏范围与预算修复)。

助手固定脱敏规则在 WASM startup 中编译，每个 VM 复用规则并将单规则 lazy-DFA 缓存限制为 64 KiB；自定义秘密与地址脱敏选择仍归各请求，不进入共享缓存。初始化失败明确阻止激活。采集范围判断复用问题的小写副本，预算只在消息实际变化后重新编码，避免正常准备消耗过多燃料；通用 VM 的每入口 20,000,000 fuel、2 秒及内存限制保持。回归见[提问燃料故障验证](../validation/ai/VALIDATION_ASSISTANT_CHAT.md#2026-11-09-提问触发-plugin_fuel-修复)。

本地 Codex/Claude Code 使用独立本机授权和保留来源 ID，由 CLI 管理自身登录与刷新，Native 仅保存授权/版本及路径/配置摘要快照。撤销/账户或配置变化使旧请求失效；进程使用临时目录、临时会话和有界 stdin/stdout，关闭/取消终止本次进程。通过进程级参数关闭外部工具、hooks、MCP 等，并验证协议结果，避免 CLI 获得 ServerDeck 外的执行通路。

工具安装与本地访问授权分开。Installer 单并发、超时/下载量/域名/重定向有界，从固定官方源校验大小、SHA-256 和 `--version` 后原子提交应用专用目录，取消不发布半成品、不改 PATH 或覆盖用户安装；当前自动下载覆盖 Windows x64/ARM64。

## 宿主内部监控与运维

Monitor 使用独立 SSH 租约及固定只读脚本，NUL 分节、有界响应/超时，逐项记录状态；CPU/网卡以计数和 uptime 差分，首次或异常为未知，磁盘保留 mountinfo 语义并过滤伪/重复挂载。每主机有界内存历史，隐藏暂停并在恢复时重置基线，不落长期时序库。

Ops 保留宿主自身类型化查询/变更及 ACK 日志流；Tasks 仅保留通用有界 SSH 执行、超时、取消和输入通道。已移除网络诊断、批量/自动化及调度器调用链，不初始化本地计划。保留 crate 不意味着分发对应插件或恢复旧公开 SDK；当前插件通过平台原语自行实现业务。

## 数据、日志与退出

### 当前存储和用户迁移

SQLite 由 bundled SQLite 提供，当前 `user_version=10`。`storage::migrations` 为新库和已支持的 schema 1–9 执行同一连续 SQL 链；10 起保存迁移名称和规范化换行的 SHA256 校验，拒绝历史变更、缺失及未来版本。表重建只处理已知结构，保留关联和闲置数据；未知字段/索引/触发器造成丢失风险时停止。空且版本 0 的库可初始化，无版本非空库不猜测来源。

`Database::open` 在业务资源创建前持有 `BEGIN IMMEDIATE`，通过独立只读连接和 SQLite Backup API 保存一致快照（含 WAL）；副本校验、关闭和落盘并发布成功后，才在同一事务升级结构、应用配置和版本，完整性/外键检查通过后提交。备份位于数据库旁 `migration-backups/`，独立命名、不覆盖、不自动清理；路径拒绝链接/重解析点，失败副本保留为 `.partial`。失败不重置配置，原因链留在 Rust，IPC 仅展示安全阶段诊断。

应用配置独立升级至 v2，在存储边界按已知 v1 契约补充新增字段、转换字号别名/退役快捷键，保留现有值和原更新时间；历史默认值及每步目标版本固定，当前 DTO/IPC 严格校验。模型注册 v1/旧单模型在首次使用时独立备份并事务升级为 v2，保留身份、修订和系统秘密引用；不读取秘密，不让损坏模型阻断主机启动。定位文件、插件协议/授权和旧身份目录没有被自动转换。完整步骤、支持范围与故障语义见[数据升级契约](DATA_MIGRATIONS.md)，取舍见[ADR 0028](decisions/0028-safe-data-upgrades.md)。

`application_settings` 保存应用/终端/产品偏好、窗口几何和本地模型授权；不保存密码、私钥或对话正文。SQLite/系统库阻塞工作进入受限 `spawn_blocking`，元数据单任务、最多 16 个在途/等待、等待最长三秒，超限 BUSY；5 秒数据库 busy timeout、外键开启，不引入连接池或 WAL。

数据默认标准用户目录；`storage-location.json` 在默认 app_config_dir 记录本机定位，不属于可搬运偏好。用户明确迁移时使用目标磁盘专用暂存、文件清单/摘要、空间预检和只读数据库校验；Copied 未确认启动可回退源，Committed 不回退部分清理的源。目标禁止非空/嵌套/链接，源清理逐文件复验、只删除已确认副本对应项，变化/未知文件保留并报告。迁移通过正常退出排空后重启，系统凭据不复制。迁移 IPC 的 `true` 仅表示已登记迁移并安排重启；前端保留处理中弹窗与关闭保护直到进程退出，不据此显示完成。新进程在创建主窗口前复制并校验；前后端启动确认及源清理结果由 `app_storage_ready` 返回，准备失败则解除忙碌并保留草稿供重试。`app_bootstrap.storage.notice` 保留定位文件中的历史结果；`app_storage_ready.notice` 仅返回本次启动或本次清理尝试新产生的结果，无待迁移任务时从 Profile 运行期一次性取出本次回退/复制失败提示，不重放已有历史。前端只将 ready 返回的 notice 用于通知，合并历史结果到设置页；不改变定位文件格式或迁移/清理顺序。

Windows 主窗口或旧进程退出不等于 WebView2 子进程已经结束写入。复制前先对完整源清单探测禁止写入/替换的只读句柄；遇共享占用或退出期间临时文件消失时，每 100 ms 重新探测整份清单，最多等待约 10 秒，全部通过后才计算摘要和登记文件快照。摘要读取及源复制也使用禁止写入/替换的句柄；副本落盘后关闭写句柄再校验，校验不一致时区分源文件变化与副本错误。持续占用、后续源变化、摘要/数据库失败均保留原数据及已有暂存副本，不降低校验或自动清理失败证据。其他平台保持原有读取及完整校验路径，不能由 Windows 验证推断其原生验收结果。

### 日志与释放顺序

tracing 仅记录操作、结果和安全原因类别，不记录 DTO、终端/文件/模型正文或凭据；依赖日志默认关闭。定位数据目录后、数据库升级前先按 Info 初始化，升级成功再加载已保存日志级别，迁移失败也保留安全阶段和 SQLite/IO 类别诊断。日志队列 512 条，当前文件加三个轮转文件、每个 1 MiB，总量 4 MiB；满队列/过大单条丢弃，业务错误本身仍传播，退出保持 guard 刷出队列。

退出先由前后端实时检查任务与 dirty 状态，不能依赖轮询快照跳过确认。确认后拒绝新用例，取消安装和插件自有资源/VM、模型、终端上传/本地终端，再排空通用执行、Ops、Monitor、文件和 SSH/转发，最后等待元数据工作并刷新日志。没有已移除调度器或自动化引擎的关闭步骤。

## 验证与适用边界

当前实现不提供独立 OS 进程级插件隔离，iframe 无 CPU/内存硬配额，SFTP 不具备服务端 CAS；系统凭据及原生集成仍须按平台验收。代码位置/接口存在不等于当前版本或所有平台验证通过。

证据入口为[验证索引](../validation/README.md)及各模块报告；原生 QA 使用隔离数据目录和复制后的 EXE，不锁定根 `target/`。发布、安全/性能及跨平台未完成项由[实施计划](../product/IMPLEMENTATION_PLAN.md#剩余工作与验收门禁)统一跟踪，不在此重复逐次构建日志。
