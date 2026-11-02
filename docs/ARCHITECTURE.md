# ServerDeck v0.1 架构

基线：`docs/PRD.md` v1.0；当前实现基础设施、主机/凭据管理、真实 SSH 终端、SFTP 文件管理、Agentless Linux 监控、当前主机运维，网络诊断、显式批量运维，以及可复用命令/脚本与本地计划。2026-11-02。

## 范围与原则

应用运行于本地，通过 SSH/SFTP 管理 Linux，不需要云账号、HTTP 后端或远端 Agent。
当前实现应用壳、主机/分组 CRUD、收藏搜索排序、安全凭据引用、OpenSSH 预览导入及非敏感 JSON 导出，保留第一阶段配置/日志/生命周期。
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
    views/WorkspaceView.vue        real backend diagnostics
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
  tasks/                          local/remote diagnostics, bounded batch execution and SFTP fan-out
  automation/                     reusable Shell tasks, durable results and local schedules
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

## 存储、配置与日志

- 数据路径通过 `tauri::Manager::path().app_data_dir()` 获取；日志通过 `app_log_dir()` 获取。安装目录不参与数据写入。
- SQLite 绑定 bundled SQLite，避免依赖用户预装数据库。
- `PRAGMA user_version = 5`；001 设置、002 主机/分组/凭据/清理、003 SSH 信任记录、004 主机 SSH 选项、005 自动化库/计划/历史在 IMMEDIATE 事务内顺序迁移。v1/v2/v3/v4 数据保留，失败回滚，未来版本拒绝降级。
- `application_settings` 的 `app_config` 保存版本化偏好 JSON，是配置唯一真源；不维护第二份普通 JSON 配置。
- hosts 使用 UUID、强类型字段、端口/超时 CHECK、分组和凭据外键。tags 为经过校验/去重的 JSON 数组。凭据类型在事务内与主机认证类型匹配；Agent 禁止附带 credential_id。
- host_groups 没有 parent_id，只支持单层。删除分组将主机移到未分组；删除主机不删除共享凭据；复制只新建 HostId，并共享原凭据引用。
- credentials 仅保存名称、类型、私钥路径、opaque secret_ref、revision。密码正文和私钥口令从不进入 SQLite。被引用的凭据删除默认拒绝，用户明确确认解除关联后才删除；主机保留并显示待配置凭据。
- 配置 version=1；默认深色、侧栏 248px、字号 14、连接超时 15s、采样 3s、INFO。后端拒绝非法数值与未知字段。仅界面/运行偏好，不允许密码或密钥字段。
- 小规模设置读写每次创建连接，5s busy timeout、foreign_keys=ON。当前使用默认事务日志，不引入连接池或 WAL；正式主机模块与实际并发需要时再评估。
- SQLite 与 OS 凭据操作在 `spawn_blocking` 内；本地元数据单任务执行，最多接纳 16 个在途/等待请求，等待额度最长 3 秒，超限返回 BUSY。布局自动保存与新窗格读取凭据可有界排队，避免普通分屏因瞬时竞争失败；SSH 输出完全独立。
- tracing 仅记录固定操作名称/结果，不记录 DTO、终端内容、文件正文、凭据、私钥或任意错误对象。依赖库日志默认关闭，RUST_LOG 不覆盖本策略。
- 日志后台队列上限 512 条，满时丢弃；当前文件及 3 个轮转文件，每个最大 1MiB，超大单条丢弃，总量上限 4MiB。Windows 先关闭句柄再 rename。WorkerGuard 保持到应用退出以刷出队列。
- 日志等级更改保存后下次启动生效。主题和侧栏宽度在保存成功后生效；system 主题监听 OS media query。

### 系统凭据与跨存储一致性

keyring 4.2 的 v1 后端在 Windows 使用 Credential Manager、macOS 使用 Keychain、Linux 使用 Secret Service。没有内存或普通文件 fallback。当前已实际验证 Windows；其他平台尚未验收。
秘密使用 UTF-8 bytes 写入系统服务，最大 2048 字节；服务名为 ServerDeck 专属命名空间，引用由后端生成随机 UUID。前端只看到 hasSecret 和关联主机数。
private_key 可以仅保存路径引用，也可以将加密私钥口令存入 OS 库；不复制私钥文件，不读取或验证其正文。SSH Agent 认证复用用户已有的系统代理，不自动启动服务或添加身份；隔离 Agent 实际签名已测，用户系统服务仍待实机验证。

SQLite 与系统凭据库不能共享事务，因此采用小型意图记录及不可变秘密版本：

1. 新秘密引用先进入 secret_gc（只有 opaque ID），然后写入 OS 库。
2. SQLite 事务更新元数据引用、增加 revision、移除新引用的清理意图，并登记旧引用待清理。
3. 提交成功后删除旧秘密。失败则保留 tombstone，界面提示并提供重试清理。
4. 数据库提交失败补偿删除新秘密；崩溃或清理失败时意图仍可恢复。不静默丢弃已有秘密，也不复用旧 entry 原位覆盖。

服务不可用时秘密写入失败，原凭据引用保留，不创建明文替代；只修改非秘密元数据或无口令路径引用可以独立完成。带关联的凭据删除需要明确选择解除主机关联；OS 删除失败会明确显示尚有旧秘密待清理。

### OpenSSH 导入与导出

前端通过文件选择器读取或粘贴 UTF-8（最大 1MiB），Rust core 解析并预览。支持 Host、HostName、Port、User、IdentityFile、ConnectTimeout、ServerAliveInterval、ServerAliveCountMax 和受限 ProxyJump，大小写不敏感关键字、双引号、注释、等号、首次赋值规则，以及对明确别名匹配的 * / ? / ! 模式。
解析限制为 10000 行、500 个明确别名及有界参数/警告，防止外部配置放大预览内存；导入路径与手动凭据遵循相同长度/字符边界。
多个 IdentityFile、ProxyCommand、未知影响端点/认证/信任的选项阻止条目导入；Include/Match 无法安全确定影响时阻止文件条目。compression 等未实现项显示警告。ProxyJump 仅接受一个明确的受管 Host 别名或 none；逗号链、user@host:port 和 token 展开拒绝。受管主机可递归引用最多 4 个跳板，循环/缺失/重名或同名端点不一致阻止提交；选中条目按依赖在同一事务内导入。通配符不展开为资产，缺省用户取本地当前用户名；预览显示实际用户、认证方式和超时。
导入提交重新解析原文并校验选中别名，SQLite 事务内再次检查同名或同 hostname+port+username，重复跳过，不覆盖。IdentityFile 只生成路径凭据引用，口令需另行设置。无 SSH Config 写回接口。
导出为版本化、字段白名单的 JSON，包含主机、分组、标签与备注；排除 credential_id、secret_ref、私钥路径及秘密字段。用户仍需自行避免将秘密写入备注。当前不实现备份恢复或有损 OpenSSH 写回。

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

终端命令：terminal_open（流式 Channel）、terminal_input、terminal_resize、terminal_ack、terminal_trust、terminal_close、terminal_close_host。没有读取秘密或任意本地执行命令的接口。终端模拟器处理 ANSI/VT、UTF-8、256/True Color、alternate screen、鼠标协议与组合键；查找只搜索本地滚动缓冲，复制粘贴需系统剪贴板权限。

### 终端布局、偏好与恢复

Pinia 区分 Tab、Pane 和 Session：一个标签包含 1–8 个窗格，全应用最多 32 个。二叉树只描述 rows/columns、10–90 比例和 PaneKey；xterm 组件以固定 PaneKey 平铺挂载，通过百分比定位，拖动不会重建 Shell，后台标签持续消费 ACK。标签支持拖动、重命名、关闭其他/右侧。焦点只在明确切换或连接时变更，ResizeObserver 不抢占搜索框。

AppConfig v1 新增有默认值的 terminal 偏好，兼容旧设置：字体、10–32 字号、100–200% 行高、历史上限、四种主题、光标和 11 个快捷键。快捷键必须包含约束修饰键并去重，不占用远端 Ctrl+C/Z。大于阈值或 50 行的粘贴须确认，通过 xterm.paste 尊重远端 Bracketed Paste；不会承诺远端关闭此模式时换行安全。复制走系统剪贴板；导出需主动确认，只下载当前普通屏幕和滚动历史 UTF-8 文本，无自动录制。

workspace_load/workspace_save 只在 application_settings 保存版本 1 的 HostId、标题、顺序、分屏比例，限制 64 KiB，不存秘密、终端内容、SessionId 或命令。自动保存属于 store 生命周期，关闭最后一个标签再切视图也会保存。恢复窗格均为 idle，逐个点击连接才创建新 Shell。WebView 重新加载会关闭旧终端及未认证的文件租约，保留已认证文件租约和后台传输；应用退出先排空文件操作，再取消全部 Session/转发，最后等待数据库任务。

### 代理、跳板与转发

connection_plan 在后端读取受管跳板链及系统库秘密。第一段可经 SOCKS5（无认证或用户名/密码）或 HTTP CONNECT（无认证或 Basic），后续用 direct-tcpip 内嵌 SSH；每跳独立校验密钥和认证。代理只用于首段，冲突的代理设置明确拒绝；不执行 ProxyCommand 或本地 Shell。HTTP 代理链路本身不是 TLS，Basic/SOCKS 用户名密码不具有额外传输加密，UI 明示此边界。

forward_start/list/stop 显式控制归属于 Session 的 Local/Remote/Dynamic。默认 127.0.0.1，Rust 校验所有非回环地址必须 confirmPublic；Remote 实际暴露仍受服务器 GatewayPorts 策略影响。Local/Dynamic 支持端口 0，Remote 须指定非零端口。全局最多 16 个运行转发、64 个状态记录；每转发最多 32 条并发流及有界远程入口，copy_bidirectional 不累积正文。Dynamic 为 SOCKS5 无认证 CONNECT，远端 DNS，不支持 UDP/BIND。

转发监听及 JoinSet 归属取消 token，停止/Session 关闭/SSH 断线都会关闭监听并取消流。Remote 注册表以监听地址/端口和 ForwardId 精确所有权匹配，重复请求不会撤销已有路由；拒绝未知服务端转发 Channel。远程取消若未获服务器确认，断开所属 Transport 以防残留监听并报告原因；此异常安全路径会使共享该 Transport 的其他窗格断线。转发不自动持久化、重启或重连。

SFTP TaskId 和退出确认已接入，监控采样也已接入独立租约；不恢复远端旧 Shell，也不自动执行保存布局中的文件命令。

## SFTP 文件工作区（已实现）

`core::files` 定义路径、目录、元数据、传输、编辑及固定文件终端动作 DTO。`ssh::subsystem` 增加 Files 租约：复用原有完整路由/凭据 revision 的 Transport，但不启动 PTY/Shell。租约与终端一样参与引用计数，关闭最后一个终端不影响 SFTP。目录浏览使用一个 SFTP Channel，每个活动传输使用独立 Channel；SFTP 子系统错误不关闭其他 PTY。传输并发和服务器 MaxSessions 不等价，服务器拒绝新 Channel 时明确报错。

`sftp::remote` 使用 russh-sftp RawSftpSession 完成 SFTP v3 请求和扩展协商，固定每块 32 KiB、单请求 15 秒、响应包最多 1 MiB。不用会无界累积整个目录的高级 read_dir；逐批读取、20,000 项/8 MiB 名称及批次数上限，拒绝恶意文件名路径。`sftp::local` 使用 Tokio filesystem，拒绝非 Unicode 路径的有损转换；本地目录显示规范化路径。原生文件/目录选择器仅通过 files_pick 暴露，不授予通用 fs/shell 插件命令。

前端 FilesView 为双栏目录、路径输入、父目录、排序、分页（200 项）、复选多选、右键操作和原生路径拖放入口。Pinia 中保存 HostId/FileSessionId/目录，任务属于 Rust，不依赖页面挂载。files_connections 和 transfer_list 只读同步健康状态，已有终端与 SFTP 一起汇总主机在线状态。页面错误保留旧目录，不把失败显示为空目录。删除需要明确范围与确认；递归选项单独勾选，不跟随目录中的链接，根目录禁止删除。SFTP v3 没有 openat/O_NOFOLLOW/CAS，路径重检能阻止已观察到的重定向，不能承诺恶意服务器或并发改链接时具备内核沙箱保证。

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

文件右键打开目录/less/tail 前显示主机与绝对路径并确认，后端只生成固定命令并做 POSIX 单引号转义，在新的 PTY exec Channel 执行，不向已有 Shell 注入输入。恢复布局不保存 FileTerminalAction，手动重连才重新执行已确认动作。退出信号（如 tail 的 Ctrl+C）是正常 Channel 结束，和 SSH Transport 断线分开处理。

主窗口关闭先进入前端/后端退出评审，后端实时检查任务及 dirty 标志，不能用轮询缓存决定是否跳过提示。确认后拒绝新用例，先取消并等待监控，再清理传输和文件元数据操作，最后关闭 SFTP/SSH/转发，最后等待数据库工作并刷日志。异步提交/重试始终在 Tokio 运行时执行，错误线程入口返回安全错误而非 panic。

## 安全边界与兼容性

Tauri AppManifest 与 capability 显式列出自定义命令，仅授予本地 `main`，不授予远程 origin、通用本地 Shell、任意文件读写、SQL 或窗口创建插件。
CSP 限制本地资源/IPC，开发额外允许固定 loopback Vite/HMR；没有远程脚本/CDN。保留系统标题栏，窗口控制交给 OS。
核心代码禁止 unsafe。对用户输入的防线在 Rust，前端校验仅改善交互。
目前只在 Windows x64 构建/验证；macOS/Linux 需在各自系统运行后才能声明支持。性能目标尚无基准，不宣称满足 3s/150MB/20 会话。

依据：[Tauri capabilities](https://v2.tauri.app/security/capabilities/)、[Tauri security](https://v2.tauri.app/security/)。SSH 候选、证据与限制见 `SSH_TECH_VALIDATION.md`。

## Agentless Linux 监控（已实现）

依赖 `desktop → application → monitor → ssh/core/Tokio`，不依赖 Tauri 或 SQLite。core::monitor 为显式 camelCase DTO。SSH Engine 增加 Monitor 租约类型：与 Terminal/Files 共用完整路由及凭据 revision 的 Transport，独立引用计数，不借用用户 PTY。Engine 只暴露固定监控采集入口，不提供来自 IPC 的任意 exec 字符串。

`ssh/src/monitor.sh` 是编译时固定的 POSIX 只读脚本，设置 LC_ALL=C 和固定系统 PATH，读取 procfs、os-release、uname/date、ip 地址及 df。各节 NUL 分隔，附命令状态；不 eval/source 远端文件，不插入用户路径或主机输入，不记录 stdout/stderr。单次 exec 创建不带 PTY 的 Channel；创建 3 秒、执行 8 秒，成功/失败/取消均请求关闭 Channel；stdout 总上限 2 MiB、stderr 16 KiB，df 使用远端 timeout 4 秒。缺少工具/权限或异常数据返回分项警告，协议破损为整个采样错误。

Monitors 注册表以 HostId 为键，最多 8 台；同主机多次打开返回同一 SessionId，不因图表数量创建任务。每个 Control 有取消 token、设置 watch、JoinHandle、当前快照及 revision。同步锁只短暂更新状态，不跨 await。设置值未变化不通知 worker，避免重新打开视图触发过密采样。3/5/10/30 秒为采集完成后的等待间隔，实际时间以远端 uptime 为准，不承诺严格墙钟定时。

状态：connecting → sampling → running/partial，失败为 error（保留旧样本并标过期）或 failed（连接结束）。隐藏页面/文档不可见时设 visible=false，在途采集完成后 paused，不采集新指标；恢复清空差分基线。WebView 重载先 pause_all，保留已认证 Monitor 租约；重载后只在用户打开该视图时继续。停止等待 worker 取消和 Channel 清理，再释放自身 SSH 租约；应用退出先停止监控，再执行 SFTP/SSH/数据库顺序。Engine 在任何会话结束后通知租约 token，暂停中的任务也能检测断线。

CPU 取 /proc/stat 前八项，排除 guest/guest_nice 重复计数；busy 不含 idle/iowait。iowait 负差钳为 0，其余负差或总差为 0 返回未知；支持每核心及热插拔。网络以远端 uptime 连续差值计算 bytes/s，结合接口名和 ifindex，计数回退、换接口、异常速率、不同 boot_id、时间差小于 0.1 秒或大于 120 秒均等待新基线。累计计数仍显示实际值。内存 used=MemTotal−MemAvailable；老内核以 Free+Buffers+Cached+SReclaimable−Shmem 近似并标注，不把所有缓存算作已用。Swap 未启用与采集失败分开表示。

disk 解析 mountinfo 的八进制路径转义，与 df -P -k -T 完整挂载路径后缀匹配；设备 major:minor 和文件系统类型去重，优先根/短路径。保留重复关系、容器 overlay 标识、伪文件系统、只读镜像标识及每挂载点不可用原因。UI 默认隐藏伪文件系统/镜像/重复挂载，可查看全部；容量按 df 的 1024 字节单位转换，使用率沿用 df 的非特权可用空间口径，允许满盘超过 100% 和负可用量归零。持久盘达到 90% 标示高占用，未实现系统通知或持续告警服务。

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

关闭日志或离开运维页面取消 worker，向该 exec Channel 的远端命令请求 TERM 后 close；断线/连接关闭也结束流。切换主机通过 SessionId key 销毁原日志组件。认证后的运维租约可跨页面保留，ops_connections 用于健康同步；关闭运维连接只清理自身日志和租约，不关已有容器 PTY/SSH/SFTP。容器 Shell 是确认后的 docker exec -it /bin/sh 或 /bin/bash，独立 PTY 进入原终端体系；不持久化 ContainerShell 动作，恢复布局仍是 idle。

WebView 重载先关闭所有日志；应用退出先取消运维流/请求并排空槽，再停止 Monitor、SFTP、SSH/转发及数据库。操作反馈只保留本进程内最多 100 条 HostId/目标/动作/结果，不存敏感输出，不宣称提供持久审计或事务回滚。运维模块本身不新增数据库表；当前 schema v5 的新增表属于自动化。

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

退出评审把诊断/批量和原 SFTP 未完成任务共同计入，确认退出先取消并等待 tasks，再关闭 Operations、Monitor、SFTP 和 SSH。Network/Batch 仍只保留内存历史，不将其命令及输出写入 SQLite（当前 schema v5 仅为自动化新增持久记录），不默认修改系统配置；复制和导出可能包含用户命令中的敏感信息，由用户主动触发。

## 可复用运维任务与本地计划

新增依赖为 `desktop → application → automation → storage/tasks/ssh/core/Tokio`。automation 不依赖 Tauri；复用 tasks 的全局执行槽和 SSH 非 PTY Channel，不向已有交互 Shell 注入命令。Vue 的 AutomationView、三个条目/执行/计划对话框、类型化 IPC 服务与状态提示接入当前 HostId；主机详情、右键、终端均有入口。不是独立演示页面，也不增加 DAG、Agent 或云端调度服务。

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

## 产品整合：统一工作区、全局偏好与备份

前端新增 workspace Pinia 状态，用 `(module, HostId)` 标识最多 24 个导航标签。当前标签是操作上下文，顶部选择器和地址/账号条显示同一目标；模块内部选择主机通过 context 事件回到统一导航。终端保留既有独立标签/分屏，并在焦点切换时同步实际窗格 HostId。全局设置、备份和多目标批量页不冒充单主机操作：全局页为本地设置，批量页明确以完整目标预览为准。关闭导航标签不等于关闭 SSH Channel，不取消后台任务。

OperationsView 的连接按自己的 chosen HostId 取值，不再借用会被批量连接器改变的全局 ops.active。信任和关闭操作也显式传 HostId；确认仍绑定原 SessionId，真正切换目标后旧确认不可执行。Files/Monitor/Operations 切换目标通过组件 key 隔离旧页面请求；原后台传输保留、监控隐藏暂停、日志离页结束，生命周期沿用原有所有权。Engine 只新增只读连接状态摘要，包含 SessionId/HostId/TransportId/租约类型/状态，不返回凭据。连接树、状态条和后台面板据真实注册表同步，Monitor 单独连接也能正确显示在线。

跨模块入口保留原 SFTP/文件终端/tail、Docker 日志/Shell；新增 Monitor→Processes、进程详情→明确 PID 对应 ss 监听信息、连接异常→预填目标地址和 SSH 端口的本机 TCP 诊断。端口关联只匹配 ss 显式报告的完整 pid，权限不足保留未知，不根据端口或进程名称猜测。常用命令搜索打开当前主机的预览，意图消费后清空，不因再次进入页面而重复弹出或执行。

全局搜索由可配置快捷键或按钮打开，查询主机、模块和命令/脚本名称/说明，最多显示 50 项，支持方向键/Enter/Esc，不检索远端输出。快捷键只接收 Ctrl（macOS 同时接收 Command）及可选 Shift；后端拒绝重复组合及常见终端控制键，模态对话框中不触发全局导航。全局通知最多 5 条，普通通知 6 秒消失、错误手动关闭；任务失败仅提示元数据和查看入口，不把任务输出放入通知/日志。后台任务摘要不复制命令或 stdout/stderr，面板复用传输管理并列出批量任务全部 HostId 对应端点。

主机树按组一次计算，初始最多渲染 200 个主机，可继续加载，方向键和 Home/End 移动焦点；主机表初始 100 行。已有文件/运维分页保持。侧栏分隔条可拖动或键盘调整，完成后保存 200–400 逻辑像素偏好。窗口宽高/最大化状态由 Rust 原生事件获取，按 DPI 转为逻辑尺寸，单 watch 通道去抖 500ms，退出前刷新；独立 application_settings.window_geometry，不把最大化尺寸覆盖普通窗口尺寸，不保存可能跨屏失效的位置。恢复时按当前屏幕尺寸约束，窗口最小 900×600；不是跨平台/物理混合 DPI 验收的替代。

2026-11-02 布局调整：应用壳使用独立功能栏、通高主机栏、中央工作区三列。`AppNavigation` 提供分组图标导航、悬浮名称、当前页和任务数量；`HostSidebar` 的标题工具、搜索/收藏筛选和底部统计不参与滚动，仅中间主机列表滚动。主机行显示名称与地址，原有分组/有界加载/连接行为继续复用。侧栏宽度仍使用既有 `sidebarWidth` 偏好，分隔条位置包含独立功能栏宽度；收起状态只在本次界面内保持。窄视口使用可展开主机抽屉，工作区表格在自身区域横向滚动。运维页采用紧凑标题、分隔状态行和下划线分类标签。无 IPC、数据库或连接所有权变化；浏览器预览仍明确显示后端未连接。布局验证见 `VALIDATION_LAYOUT.md`。

AppConfig 保持 version=1，新增 serde(default) product 偏好，旧数据可直接读取，不新增数据库表或重置配置。内容为当前支持的 zh-CN 语言标识、下载目录、新建主机默认 SshOptions（不设置全局跳板）、全局快捷键。语言字典先覆盖工作区/搜索导航，当前完整 UI 仍仅简体中文，不宣称已完成英文翻译。现有主题、终端字体/字号/快捷键、监控间隔、传输并发及日志等级继续真实生效。默认连接超时、认证超时、Keepalive、代理仅复制到新建主机，不改写已有主机或在途连接。默认下载目录用于新下载任务的预选目标，仍可选择其他目录。代理密码只引用原生凭据库；不存在/类型不匹配拒绝保存，删除仍被全局默认代理引用的凭据会被拒绝，要求先修改设置。

备份为严格 `format=serverdeck-backup, version=1` JSON，最多 8 MiB、5000 主机、512 主机分组、256 条目、64 命令分组。导出在只读事务中取得一致快照：主机/分组/标签/说明/收藏/连接参数、命令/脚本定义及非敏感 AppConfig；不包含凭据 ID/秘密引用、私钥路径/正文、秘密参数值、信任、执行历史、调度计划或窗口位置。用户自己写进脚本、说明、普通默认值的秘密无法可靠识别，界面要求审查。

恢复先用 Rust 校验格式/版本/类型/范围/ID/链接/跳板循环并生成逐项重复/阻止提示，再选择条目和 skip/copy 策略及是否替换非敏感偏好，最后明确确认。提交重新校验、在 IMMEDIATE 事务中按当前数据判断冲突：只新增或跳过，copy 使用新 UUID 和不冲突名称，不覆盖已有内容。分组按名称合并，跳板按依赖顺序重映射；缺失所选跳板则整笔回滚，不静默直连。未选/跳过跳板只允许复用同原 ID 且完整公开配置一致的本地记录。SSH 密码/私钥主机恢复后无凭据关联，需用户重新配置；认证代理主机在预览中明确阻止自动恢复，防止匿名降级。认证代理的全局默认值不导出，恢复偏好会明确替换当前默认设置。恢复不会创建连接或执行计划。

窗口关闭和应用退出统一进入确认，包括普通 SSH 会话；后端继续实时检查传输、任务及 dirty 文档。关闭主机全部连接新增明确范围确认，涉及依赖跳板及所有模块，未保存文档先处理。危险操作、断线 Unknown、未保存文件和传输提交边界均保留原保护，不为简化 UI 绕过。

整合验收补充：连接摘要同时提供 Transport 中实际的地址、端口和用户名。顶部按当前模块的真实 Session/租约显示端点，配置编辑后不把旧连接重新标成新地址；配置已变更时，原终端/文件/容器上下文不能直接新开另一个配置端点的模块，要求先从主机管理确认或重新连接。批量预览优先使用实际连接快照，诊断来源按原 Session 匹配；原会话结束后保留标识，不用当前主机地址冒充历史来源。窗口缩放后也会把活动工作区标签滚入可见区域。Toast 文本不拦截底层控件的指针事件，关闭按钮仍可操作；避免错误通知长期遮住确认按钮。

## QA 与测试版发布边界（2026-11-02）

统一版本为 0.1.0-beta.1，应用标识 io.serverdeck.desktop 保持不变；Cargo/npm/Tauri 版本一致。Release 开启 thin LTO、单 codegen-unit 和 strip，前端嵌入二进制；NSIS 采用当前用户安装，不把数据放在安装目录。多尺寸 ICO/ICNS/PNG、许可证清单及依赖通知随包，未引入更新器。

本轮修复 Unix 目录权限：仅初始化应用专属数据/日志叶目录到 0700，并在迁移前把 SQLite 文件收紧至 0600，符号链接叶目录拒绝；不修改 HOME 等父目录。Windows 保留系统用户目录 ACL，不声称与 Unix mode 等价。权限失败向上传播，不静默继续。

发布 QA 复用真实前后端代码。`native-terminal-e2e.mjs --installed-exe` 驱动 NSIS 安装出的实际程序，拒绝非空用户主机目录，不清空普通安装的数据；保存/恢复原偏好，临时凭据只进入系统凭据库。CDP 只通过 QA 子进程环境开启回环端口，包默认不启用该入口。临时容器、远端文件、主机和任务都有 UUID 所有权边界；正常退出通过实际 IPC 触发完整 shutdown。

基准输出是测量证据，不是生产指标承诺；进程树内存包含 WebView 子进程，RSS 可能含共享页，另列 private bytes。性能门禁、未支持的 SFTP 面板模式及平台风险以 TEST_REPORT/RELEASE_CHECKLIST 为准。CI 只准备 Windows x64、macOS arm64/x64、Linux x64 候选构建，RustSec 门禁故意保留失败，不把未运行 CI 写成通过。
