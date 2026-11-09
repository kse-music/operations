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

每个终端独立 PTY/取消令牌/任务句柄，关闭只结束自身 Channel 和所属转发；Transport 在无相关租约后释放。SFTP/Monitor/执行拥有独立租约，单个子系统失败不误关其他会话。`TerminalPane` 显式重连复用既有 `connect`：保留 xterm/PaneKey、清空输入与待确认粘贴、关闭旧 Session 后创建新 Shell，generation 隔离迟到事件。连接中及固定文件/容器动作重跑须确认，插件一次性票据禁止重放；显式重连和文件导航校验当前目录中的主机连接配置。同步锁只作短暂注册表操作，不跨 await 或串行化全部输出。

### 有界输入输出与布局

PTY 每块最多 16 KiB，经 Tauri Channel 交给 xterm，`xterm.write(callback)` 完成后 ACK 才读取下一块。输入/resize 独立运行，输出等待不能阻止 Ctrl+C 和取消；输入队列、单次大小和粘贴确认均有界，resize 合并最新尺寸。russh 内部仍有非全有界队列，不承诺恶意服务器下的进程硬内存限额。

前端区分会话标签、PaneKey 和 Session。二叉树仅计算分屏几何，固定 PaneKey 保持 xterm 挂载；每标签最多八窗格，全应用最多 32。后台终端持续消费 ACK。编号按主机运行内计数，最后会话成功关闭后重置；不持久化终端布局、标题、正文或会话，不保留旧 workspace_load/save 接口。

`TerminalsView` 挂载会话新建、拖动排序、双击重命名、关闭、分屏快捷键及绑定目标 TabKey 的会话菜单；菜单复用 store 的重命名/关闭/按主机关闭所有，复制只调用普通 `open(host)`，不复制动作或票据。菜单支持右键和键盘、视口限位与焦点恢复。`TerminalPane` 在现有底部说明区提供操作菜单，内容区仍仅复制/粘贴；主动导出须确认，只读取此 xterm 的 `buffer.normal`，复用本地 UTF-8 下载能力，不自动录制。默认键位由 `core::terminal::default_shortcuts` 与前端偏好共同约束，关闭的是当前窗格而非整个工作区。

纯文本复制粘贴使用受限 Tauri 原生剪贴板服务，只在用户动作后运行。异步读取绑定连接 generation，重连/卸载废弃旧读取及待确认粘贴；2 MiB 上限、大文本确认和 Bracketed Paste 保留。字号/行高变化适配当前 xterm 和 PTY，不重启 Shell。

Linux 本地 PTY 使用有效 `$SHELL`、账户 Shell 或 `/bin/sh` 的交互模式。AppImage 仅在子进程环境剔除 APPDIR 内 Python 和搜索路径，不修改应用全局环境或用户文件。Windows 使用 PowerShell。

### 路由、转发和 ZMODEM

首跳可经 SOCKS5/HTTP CONNECT，后续 direct-tcpip 嵌套 SSH，逐跳信任与认证。端口转发归属 Session，默认回环、公共绑定需确认；Local/Remote/Dynamic 有界并发与取消。远端取消未确认时关闭所属 Transport，明确报告共享会话可能断开；不自动恢复转发。

`TerminalPane` 的操作菜单挂载既有 `ForwardDialog`，捕获该窗格当前 SessionId，复用原转发服务和后端，不使用活动工作区推断目标。本地或未连接窗格禁用入口；断开、重连或隐藏窗格关闭管理界面，转发生命周期仍由所属 Session 负责。

rz 使用固定版本 ZMODEM 实现与流式握手识别。Rust 原生选择器发放绑定终端/取消令牌的文件句柄，不提供任意路径读取；分块读取，等待选择和上传不阻塞输出 ACK，普通输入在上传时隔离。关闭/取消撤销句柄，迟到选择不能向新 Session 发送文件。协议与实际验证见[ZMODEM 记录](../validation/terminal/VALIDATION_ZMODEM.md)。

## SFTP、传输与编辑

Files 租约复用完整认证路由但不启动 Shell。目录使用 SFTP v3 RawSftpSession，传输各有独立 Channel；请求、响应、目录条目/名称和递归规划均有上限。原生选择器只通过受限文件命令开放，不授予通用 fs/shell 权限。

Pinia 保存每主机文件连接、实际目录和独立导航历史；连续目录请求由代号隔离，失败保留原目录。权限按 mode 展示，owner 仅从受限 longname 格式解析，未知回退 UID，不猜测名称。两栏内部滚动，活动传输面板与页头记录共用同一任务状态。

`ConflictPolicy` 与后端支持 fail/skip/rename/overwrite；`FilesView` 当前确认表单仅提供 fail/skip/overwrite，文件“重命名”动作与传输冲突的自动重命名是两条不同链路。

任务由 Rust 保存，状态为 queued/scanning/running/verifying/completed 或 cancelling/cancelled/failed。默认每主机三个活动任务、可配置 1–6，全局最多 12 活动，其他队列/历史限额有界；降低设置不抢占已开始工作。页面隐藏不取消，主机关闭或退出走显式确认/排空，不跨进程恢复任务。

上传/下载先在目标同目录独占临时文件、流式写入并回读 SHA-256，复验源和目标后提交；无覆盖使用不覆盖提交，覆盖须用户确认。取消不撤销已提交文件，提交临界区等待结果，清理失败给出恢复路径。递归不跟随链接，显式普通文件链接下载在读取及提交前复核真实目标。Windows 窗口外拖放通过 Shell 虚拟文件按需读取，复用 SFTP 校验队列，数据对象释放后清理专用暂存。

Monaco/worker 本地按需加载，编辑最多八个、每个不超过 2 MiB 的严格 UTF-8 普通文件。保存检查原始 hash、大小/时间/uid/gid/mode，验证 WRITE 权限，创建同目录临时文件并校验，保留并复核 uid/gid/mode 后使用 OpenSSH posix-rename。缺少扩展/权限/元数据保留失败不降级为 unlink 或原地截断。

原子替换改变 inode，SFTP v3 不能完整保留 ACL/xattr/硬链接或消除最终检查到 rename 的竞态，必须说明限制。提交后断线可能结果未知，须重新核对。插件文本文件请求另受 SDK 更小的配额和授权根限制，不能套用桌面编辑器上限。

OSC 7 仅作为已校验路径提示，不作为权限依据。已连接 SSH 窗格的“打开 SFTP 文件”动作发出其 Host、cwd 和 PaneKey，复用 App 既有 files 事件处理；重连清除旧 cwd，没有有效提示时不猜路径。文件页→目录/less/tail 的动作经确认后使用固定且转义的独立 PTY，不注入现有 Shell。未保存文档在关闭/重载前审核，保存失败保留草稿及恢复信息。

## 插件平台

### 包、运行时和业务边界

Host/Rust/TS SDK 5.0.0，UI v4、ABI/wire 1；拒绝旧开发期合同。WASM 无 WASI/任意原生导入，受线性内存、fuel、消息及并发限额；自带 Vue JS/CSS 位于不带 same-origin 的受限 iframe，经认证 MessageChannel 访问可信桥，不能任意转发 Tauri IPC。

```text
插件 Vue → 认证桥 → 本包 action → WASM async Runtime
  → Platform request + bindings → Native 权限/目标/配额/审批
  → 通用 SSH/SFTP/模型传输 → 原 Future 续接 → 插件解析与展示
```

命令/SQL、容器语义、DTO、解析、脱敏、提示词、工具循环和计划均归插件。SDK 只提供平台协议/客户端/通用 UI，公开目录不含认证、代理、秘密或内部租约。宿主内部 Ops/Monitor 可继续服务自身用例，不以领域枚举或插件 ID 特判开放给插件。

一个安装修订共享有界 VM，每页具有可信 owner。资源绑定插件、安装修订、VM 代和 owner，目标另绑定真实 SSH 配置或模型修订。审批保存原 WASM Future/请求，批准或拒绝从等待点续接，不从动作开头重放。隐藏禁止新动作/审批并释放流/PTY，关闭只撤销自有工作；禁用/撤权/升级/卸载清理整个插件，保留其他 owner/共享连接及远端服务。

### 授权和确认

授权绑定 ID/版本/包摘要/安装修订、权限/operation 和文件根。system 由发行流程写入，仅决定分发与预置权限；上传同 ID 不继承 system，执行规则、配额和目标复验相同。目前无密码学签名校验，摘要/作者元数据不证明可信来源。

Execute 默认可信宿主逐次展示实际目标与完整命令。可选 `preapprovedCommands` 保存 1–16 条完整 Command、总 JSON 不超过 48 KiB，须同时声明并授予 `ssh.execute` 和独立 `ssh.execute.preapproved` 权限/operation。仅 program/args/timeoutSecs 完全匹配才跳过单次审批，无参数模板/通配符或只读声明。StreamOpen/Terminal/SaveFile/TcpConnect 不适用。

执行槽等待后、真正执行前和结束时复验绑定；配置变化拒绝或报告可能已执行，不能静默换目标/重试。单次审批绑定完整请求、owner、安装/VM 代和 SSH 摘要，60 秒一次消费。文件保存绑定规范路径、授权根及原始摘要，安全提交开始后排空；取消不宣称已写操作被回滚。

### 构建分发与安装故障

`tools/system-plugins.mjs` 按稳定顺序扫描 `plugins/system` 直接子目录，校验完整源码/锁文件/manifest/入口，拒绝链接、重复 ID 和残缺输入；`packages` 是保留输出，不参与发现。全部包构建并校验成功后发布标准包和生成的 `packages/registry.rs`，`bundled_plugins.rs` 引入注册；夹具不分发，不按旧产物决定注册。

当前只分发 Docker 与助手。外部 MySQL 从应用下载的开发包独立开发后上传，不进入内置目录；新增完整系统插件目录可自动构建，不维护服务白名单、不做运行时热扫描。开发包由 Vite 打入客户端，主窗口专用保存命令将固定 ZIP 写入用户选择位置。

Docker 插件以六条完整固定命令预授权版本、列表、详情、资源及按需环境变量查询。详情和资源读取主机快照，由插件按完整容器 ID 筛选；概览格式不包含环境变量，环境变量只在对应标签打开时单独读取，前端只收到所选容器的数据。快照仍受通用输出和超时限额约束，停止、删除、日志、Shell 及未声明命令沿用原审批，不在宿主增加 Docker 专用匹配规则。

仓库汇总有效安装与问题项，单插件旧/损坏记录隔离并显示诊断，原记录/载荷/配置不动；仓库根安全故障和数据库错误仍传播。主窗口私有 `plugin_inventory` / `plugin_reinstall_bundled` 不属于 SDK。显式重装确认绑定原记录摘要，先逐字持久备份再原子提交，保留旧载荷/配置，新安装默认禁用且不继承旧授权；不存在兼容解码或自动迁移。

## 模型传输与 AI 业务

模型注册、系统 Key、真实连接测试和修订管理属于 Native；通用 `models.use` 能力在授权后传输插件构造的消息，Key/CLI 登录数据不进入 Guest。助手插件拥有资产匹配、上下文采集/脱敏、严格 query/plan/answer、冻结计划和执行后复查，不再依赖私有宿主 AI 业务 API。具体预算和资源协议见[SDK](../plugins/PLUGIN_SDK.md)。

`ai::model_test` 只保留测试绑定摘要，签发 300 秒单次凭证；保存新建/关键配置或 Key 变更时消费并复验配置、凭据及编辑身份，不能用一次旧成功测试批准新配置。模型 Key 没有读取回显接口，空输入保留已有值，清除/删除走明确的用例及秘密 GC。`check_model_edit` 在 baseUrl 变化且仍有旧 Key 时要求新输入或明确清除，防止默认将原凭据发送给其他服务。

助手 `workflow` 对单主机执行最多六轮/十二查询/每轮三项的只读循环，`agent::build_plan` 从完整证据冻结最多 32 项；多主机建议标记 manual_only，不能隐式选择一台执行。预览和计划按准备时刻五分钟清理，单次消费且绑定 owner/模型/SSH 修订；执行超过 100 秒不启动后续步骤，在途按平台提交边界收尾。业务清单由插件保存，Native 仍对实际请求逐项做目标与命令确认，插件确认文字不能代替授权。策略理由见[ADR 0027](decisions/0027-assistant-policy.md)。

模型响应的 usage 才是实际 Token 来源；任一轮缺 usage 时不伪造累计值。准备阶段先按完整查询统计，再对选定原值脱敏，最后截短展示明细；诊断仅携带命中主机，普通知识不附目录，明确资产清单问题才附目录。`budget::fit` 在准备（消息 40 KiB）及每轮补全（44 KiB）按含 JSON 转义、模型和输出配置的完整请求估算输入并预留最大输出；不足时依次削减成功查询的可选明细、最早完整历史轮次，保留问题/归属/统计/失败及省略标记，仍不足才拒绝。前端按实际准备请求编码限制 48 KiB，删除完整旧轮次而不切断文本；压缩不改写旧消息或本地完整执行证据。验证见[上下文回归](../validation/ai/VALIDATION_ASSISTANT_CHAT.md#2026-11-09-上下文脱敏范围与预算修复)。

本地 Codex/Claude Code 使用独立本机授权和保留来源 ID，由 CLI 管理自身登录与刷新，Native 仅保存授权/版本及路径/配置摘要快照。撤销/账户或配置变化使旧请求失效；进程使用临时目录、临时会话和有界 stdin/stdout，关闭/取消终止本次进程。通过进程级参数关闭外部工具、hooks、MCP 等，并验证协议结果，避免 CLI 获得 ServerDeck 外的执行通路。

工具安装与本地访问授权分开。Installer 单并发、超时/下载量/域名/重定向有界，从固定官方源校验大小、SHA-256 和 `--version` 后原子提交应用专用目录，取消不发布半成品、不改 PATH 或覆盖用户安装；当前自动下载覆盖 Windows x64/ARM64。

## 宿主内部监控与运维

Monitor 使用独立 SSH 租约及固定只读脚本，NUL 分节、有界响应/超时，逐项记录状态；CPU/网卡以计数和 uptime 差分，首次或异常为未知，磁盘保留 mountinfo 语义并过滤伪/重复挂载。每主机有界内存历史，隐藏暂停并在恢复时重置基线，不落长期时序库。

Ops 保留宿主自身类型化查询/变更及 ACK 日志流；Tasks 仅保留通用有界 SSH 执行、超时、取消和输入通道。已移除网络诊断、批量/自动化及调度器调用链，不初始化本地计划。保留 crate 不意味着分发对应插件或恢复旧公开 SDK；当前插件通过平台原语自行实现业务。

## 数据、日志与退出

### 当前存储和用户迁移

SQLite 由 bundled SQLite 提供，`user_version=9`，仅空且版本 0 的数据库用 `schema.sql` 初始化；现有版本 9 正常读取，其他版本拒绝且不改写。不为旧开发身份、设置缺字段/别名、旧 AI 模型或旧插件权限添加兼容转换，不删除既有闲置列/附加表。完整配置严格校验，新配置显式 Default。

`application_settings` 保存应用/终端/产品偏好、窗口几何和本地模型授权；不保存密码、私钥或对话正文。SQLite/系统库阻塞工作进入受限 `spawn_blocking`，元数据单任务、最多 16 个在途/等待、等待最长三秒，超限 BUSY；5 秒数据库 busy timeout、外键开启，不引入连接池或 WAL。

数据默认标准用户目录；`storage-location.json` 在默认 app_config_dir 记录本机定位，不属于可搬运偏好。用户明确迁移时使用目标磁盘专用暂存、文件清单/摘要、空间预检和只读数据库校验；Copied 未确认启动可回退源，Committed 不回退部分清理的源。目标禁止非空/嵌套/链接，源清理逐文件复验、只删除已确认副本对应项，变化/未知文件保留并报告。迁移通过正常退出排空后重启，系统凭据不复制。

### 日志与释放顺序

tracing 仅记录操作、结果和安全原因类别，不记录 DTO、终端/文件/模型正文或凭据；依赖日志默认关闭。日志队列 512 条，当前文件加三个轮转文件、每个 1 MiB，总量 4 MiB；满队列/过大单条丢弃，业务错误本身仍传播，退出保持 guard 刷出队列。

退出先由前后端实时检查任务与 dirty 状态，不能依赖轮询快照跳过确认。确认后拒绝新用例，取消安装和插件自有资源/VM、模型、终端上传/本地终端，再排空通用执行、Ops、Monitor、文件和 SSH/转发，最后等待元数据工作并刷新日志。没有已移除调度器或自动化引擎的关闭步骤。

## 验证与适用边界

当前实现不提供独立 OS 进程级插件隔离，iframe 无 CPU/内存硬配额，SFTP 不具备服务端 CAS；系统凭据及原生集成仍须按平台验收。代码位置/接口存在不等于当前版本或所有平台验证通过。

证据入口为[验证索引](../validation/README.md)及各模块报告；原生 QA 使用隔离数据目录和复制后的 EXE，不锁定根 `target/`。发布、安全/性能及跨平台未完成项由[实施计划](../product/IMPLEMENTATION_PLAN.md#剩余工作与验收门禁)统一跟踪，不在此重复逐次构建日志。
