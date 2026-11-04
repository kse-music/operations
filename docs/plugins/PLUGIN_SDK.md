# Plugin SDK 1.2.0

## SDK 1.2 工作区工具

新增 tools::Tool / tools::Operation、四个领域权限和 Capability::ToolInvoke；UI v3 允许 tool 贡献。输入为可信 Host 冻结的单次票据，Guest 自行限制可转发的领域，Host 仍复验所有范围；返回值沿用受限结构化结果资源。独立源码见 plugins/system/{assistant,batch,automation,network}；上传包可使用相同契约。模型设置与凭据、可信连接、任务引擎/调度器和任务中心保留在宿主。准确配额、撤销及生命周期见 [内置插件](BUILTIN_PLUGINS.md) 和 [安全边界](PLUGIN_SECURITY.md)。

公开 crate 为 `crates/plugin-sdk`，只依赖 serde/serde_json，不引用 ServerDeck 私有 crate、Tauri、SSH 或秘密库。Guest 以稳定版 Rust 的 `wasm32-unknown-unknown` 编译 cdylib；不需要 WASI。主机 API 版本 1，宿主语义 API 为 1.2.0，wire version 仍为 1；manifest 使用 ^1.2.0 可使用工具能力，^1.1.0 可使用服务器能力，^1.0.0 插件继续兼容。

`export_plugin!(handle)` 导出经过缓冲区长度/指针检查的 ABI，不解引用任意原始指针。仅导出符号使用 Rust 要求的 unsafe(no_mangle) 属性，没有 unsafe 内存访问块。不能在 Guest 中使用宿主文件、网络、环境或其他原生导入。

后端 handle 收到操作码 6 时处理 UI 的业务输入；可返回 `json_reply(host_call(id, Capability::...))`。Host 逐请求授权和执行，然后只用操作码 7 resume 回传 `{hostResponse: Response}`。普通 UI 调用不能选择 resume；不要把操作码 6 的任意 payload 当作 Host 返回值。每次调用最多八次 Host 请求，错误需显式处理；完成可返回 `{"kind":"done","value":...}`。激活/停用等生命周期应返回短诊断并释放 Guest 自有状态，不在激活回复中请求能力。

所有 Request 都包含 apiVersion、requestId、operation，没有 pluginId、hostId、Session 或凭据字段。身份由 Host 安装实例绑定，目标由主界面设置的上下文决定。Response 包含 requestId、result、error；先检查 error。高风险操作返回 PLUGIN_CONFIRMATION_REQUIRED，result.confirmationRequired 是由 Host 生成的审批信息；仅主界面可确认，然后以相同请求重试。不能把等待确认当作执行成功。主界面批准 IPC 的确认过期或失效错误为 `PLUGIN_CONFIRMATION_EXPIRED`，须由用户重新发起原操作取得新确认，不能自动批准或复用旧确认。

| Capability kind                 | 内容/返回                                           | 权限与操作范围                                                          |
| ------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| hosts_read                      | 当前主机 id/name/hostname/port/username（HostInfo） | hosts.read / hosts.read，必须有当前主机上下文                           |
| execute                         | command、timeoutSecs(1–30)；CommandResult           | ssh.execute / ssh.read_only 或 ssh.execute；后者独立确认                |
| read_file                       | path；FileDocument                                  | sftp.read / sftp.read；授权规范路径                                     |
| save_file                       | documentId、content；SaveResult                     | sftp.write / sftp.write；独立确认并按原摘要检查冲突                     |
| close_file / file_dirty         | documentId、discard 或 dirty                        | 仅本插件/上下文文档；dirty 需要 sftp.write                              |
| settings_read / settings_write  | 本插件 JSON 设置（16 KiB）                          | settings.read / settings.write，不读取主应用配置                        |
| notify                          | 1–1024 字节文本通知                                 | ui.contribute / ui.notify                                               |
| task_create                     | command、timeoutSecs；任务句柄                      | tasks.create 且 ssh.execute；tasks.read_only 或 tasks.execute，后者确认 |
| task_read / task_cancel         | taskId；状态/有限输出/取消                          | tasks.create / tasks.manage；仅自有任务                                 |
| log_start                       | path、lines(1–200)；日志句柄                        | sftp.read / logs.read；规范路径范围，现有 SSH/SFTP 连接                 |
| log_poll / log_pause / log_stop | logId；events / paused / 停止                       | 仅本插件/上下文日志句柄                                                 |

命令 Host 只将精确的 `uname -a`、`uname -s`、`nginx -v`、`nginx -V`、`systemctl is-active nginx`、`systemctl status nginx --no-pager`、`command -v nginx` 归为只读，任何额外参数、管道、换行或变量赋值都不在此名单；Guest 不能自己声明只读。其他命令需要允许 ssh.execute 操作范围与本次确认。不会自动提权或拼接本地 Shell。

CommandResult 的 state 可能 completed/failed/uncertain；exitCode 非零是真实失败，null 表示没有确认退出码。stdout/stderr 各最多 4 KiB，超限会取消并设置 truncated，不能把部分输出视为完整。取消/断线/超时通过既有 SSH 执行器发 TERM/关闭 Channel，不保证远端程序已经终止；检查 state/message 后决定是否需要人工核对，不盲目重试。

FileDocument 最多 32 KiB UTF-8，返回插件专属 id，不返回内部 SFTP Session 或编辑器 token。读写均校验规范路径，保存复用现有原子替换/属性保留/冲突与恢复策略。SaveResult.saved=false 时必须保留草稿并展示 message/recoveryPath。file_dirty 关联主应用退出保护；close_file(discard=false) 不丢弃未保存编辑。已确认写入开始后等待安全收尾；停止遇到收尾超过 40 秒会明确报 COMMIT_PENDING，不能宣称未写入。

日志使用既有有界 ACK 流：log_poll 返回状态事件或 dataBase64（原始字节）、sequence、stream、at，Host 消费后 ACK，未轮询不持续堆积。可以暂停、搜索本地有限缓存并显式停止。每插件最多两个日志，主应用现有总量八个仍生效。任务复用任务中心，最多四个活动任务/插件，最多保留十六个 SDK 句柄；已回收句柄可到任务中心查看历史。

总消息 64 KiB，API 负载安全预算 60 KiB；四个 Host 能力调用并发槽、每插件一个在途请求、每秒二十次准入，无无界请求队列。所有文档/任务/日志都绑定上下文代；切换主机、撤销授权、禁用、升级和卸载撤销句柄并取消/排空相应资源。

可运行源码与命令见 `tests/fixtures/plugins/diagnostics/README.md`。13A-4 的公开 ui 模块定义声明式 JSON；Host Info 展示五类贡献。旧 Nginx 测试插件已删除，历史配置/验证/重载/日志验收证据保留于[插件验证记录](../validation/plugins/PLUGIN_TEST_REPORT.md)。见 [PLUGIN_UI_EXTENSION.md](PLUGIN_UI_EXTENSION.md)、[PLUGIN_DEVELOPMENT.md](PLUGIN_DEVELOPMENT.md)；SDK 不授予原生 UI API。

## 1.1 标准服务器能力

新增权限 `metrics.read`、`system.read`、`system.manage`、`logs.read`。上传包默认拒绝，系统分发包预先授予声明范围，仍通过同一逐请求授权检查；全部插件不再有主机白名单，调用绑定当前主机上下文。公开强类型位于 `server.rs`，操作名为 snake_case、字段 camelCase。SystemQuery 包含 capabilities、containers/images/container_details/container_stats/container_action/image_remove、processes/process_details/signal、ports、services/service_details/service_action、probe；参数与既有封闭请求一致，不接受任意命令或 Guest confirmed。

| Capability                      | 参数和结果                                                 | 范围                                                     |
| ------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| system_query                    | request: Query；结构化 success/code/message/records/detail | 读取 system.read，修改/明文环境 system.manage 并逐次批准 |
| system_feedback                 | 当前主机反馈                                               | system.read                                              |
| metrics_open                    | intervalSecs=3/5/10/30；返回 id                            | metrics.read                                             |
| metrics_snapshot                | monitorId、afterRevision；快照或 null                      | 仅自有采样器；sessionId 为公开句柄                       |
| metrics_visible / metrics_close | monitorId、visible / 关闭                                  | 仅自有采样器                                             |
| system_log_start                | source=file/container/service、lines、follow；返回 id      | logs.read，文件额外需 sftp.read/可读根                   |
| system_log_poll/pause/stop      | logId、paused；有界 events                                 | 仅自有日志，dataBase64 保留原字节                        |
| container_shell                 | id、bash；返回 shellTicket                                 | system.manage / system.shell，逐次批准                   |
| result_read / result_close      | resultId、chunk；chunk/dataBase64 / 关闭                   | ui.contribute；绑定原插件/上下文                         |

业务结果超过 1 KiB 返回 `{__pluginResult:{id,bytes,chunks}}`，由标准可信渲染器用公开 result_read 验证完整分块后释放；单结果 4 MiB、总量 8 MiB、八项/每插件两项、TTL 60 秒、每块 32 KiB。不能跨插件或上下文代读取；不放宽 WASM 的 64 KiB 消息和 200 万 fuel 限额。

`server::SurfaceState` 只复用 bridge 协议收发/hostResponse 匹配，各独立包提供自己的 Capability 允许列表；普通 invoke 不能伪造 Resume。UI v2 的共享可信服务器组件也适用于用户上传包。容器票据只授权一次精确目标交接；终端事件通道由主窗口 plugin_terminal_open 复验 host/target/安装代/连接配置后建立，Guest 不得到终端 Session。详见 [系统插件与资源限制](BUILTIN_PLUGINS.md)。
