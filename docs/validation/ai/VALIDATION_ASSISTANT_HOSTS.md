# 助手自动关联主机验证

日期：2026-11-03。范围：按追加授权去掉主机选择，默认关联全部已登记资产，由问题匹配主机、自动连接，命中连接失败时返回具体主机及原因。保留直接对话、详细数据授权、SSH 信任核验与单条命令审批。

## 真实功能与主要文件

- `apps/desktop/src/views/AssistantView.vue`、`components/AssistantTargets.vue`、`styles/assistant.css`：去掉“当前服务器”选择框，展示全部资产数、命中主机、连接状态及首次指纹审核。消息内展示命中名称和错误，输入后直接发送。原深浅主题及宽窄布局保持。
- `composables/assistant-hosts.ts`、`assistant.ts`、`stores/ops.ts`：每次发送刷新资产目录，调用匹配后只连接命中项；有效连接复用，旧端点/账号/认证配置拒绝复用；120 秒等待及停止，关闭本次新建的未完成会话，关闭失败明确提示。AI 连接不改变其他运维页面当前主机。异步状态与错误使用 post watcher，保留具体 SSH 失败原因。多主机全部连通后才发一个分析请求，任一失败不继续分析。
- `crates/ai/src/routing.rs`、`crates/application/src/ai/routing.rs`、`crates/core/src/ai.rs`：本地字面值优先，包含地址边界、端口/用户名、同名歧义、全部资产、列表与继续追问；无法匹配时用所选模型对脱敏最小目录做语义匹配。严格仅允许已登记且不重复的 ID、最多八台、无额外字段/命令/工具调用；模型不能构造新端点。目录不含 SSH 凭据引用、私钥路径或完整配置。路由返回冻结模型版本，支持按请求 UUID 取消。
- `crates/application/src/ai.rs`、`crates/ai/src/lib.rs`：兼容单连接，支持有界多连接；核验当前登记端点，采集时按授权组织每台主机上下文，目录也整体脱敏。快照保存全部连接，发送前逐一复验。多主机建议全部降为 manual，单主机仍逐条批准；server 没有监控样本时只含端点并给出警告，metrics 仍须同一 Transport 的有效监控样本。
- `services/ai.ts`、`types/ai.ts`、Tauri command/handler/build/capability：同步 `ai_resolve_hosts` 及多连接/版本契约，共九项 AI IPC，只对本地主窗口开放。相关 Vue/Rust/IPC/原生测试与使用、安全、架构、决策和需求状态文档同步。

无数据库迁移、新依赖或配置重置。进入页面仅读取本地资产，不立即连接全部主机；详细监控、进程、Docker、选定日志默认不勾选。全部资产的最小目录随明确发送动作脱敏上传，命中主机附实际端点和已连接标记。自动命中变化保留当前资产会话历史，模型/权限/脱敏变化或新对话清空。

## 实际验证

| 检查                                                                                                                | 结果与关键断言                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端 Vitest 全量                                                                                                    | 41 文件、284 项通过，助手 16 项；自动匹配、多主机、连接失败、停止/清理失败、首次信任、其他页面目标保持，以及直接聊天/Markdown/历史/命令独立审批回归 |
| `npm run lint`（仓库根目录）                                                                                        | ESLint 通过；首次在 desktop workspace 调用因该目录没有 lint 脚本失败，改用根脚本复验通过                                                            |
| `cargo test --offline --locked -p serverdeck-ai -p serverdeck-application -p serverdeck-storage -p serverdeck-core` | 97 项通过；真实本机 HTTP、两台本机 SSH 上下文、绑定失效、路由脱敏/未知 ID/版本/取消，以及原模型管理和存储回归                                       |
| 最终路由规则复验                                                                                                    | 名称边界、同名、追问、资产列表和 Docker 状态查询断言通过；防止“列出服务器的 Docker 状态”被当作纯资产清单                                            |
| `cargo test --offline --locked -p serverdeck-desktop --test ipc`                                                    | 2 项通过，真实 dispatcher、空目录路由和模型版本返回、九项 AI 权限及非主窗口拒绝                                                                     |
| TypeScript / Vite / Rust fmt                                                                                        | 通过；最终新增规则经 rustfmt 修正后构建成功，原大型 chunk 提示仍存在                                                                                |
| Clippy                                                                                                              | AI/Application 全 targets `-D warnings` 通过，保留既有 openssh 的 `-A clippy::single_element_loop` 豁免；增量缓存 hard-link 回退复制提示不影响结果  |
| Windows Tauri                                                                                                       | `node tools/tauri.mjs build --debug --no-bundle` 成功，正常应用标识、内置前端；原生全流程通过                                                       |

原生测试使用隔离标识/SQLite、Windows 系统凭据库、WebView2、真实 Tauri IPC/reqwest 和本机 HTTP 协议夹具；不是外部服务能力或计费验收。保留原模型 CRUD、注册前连接测试、独立 Key、旧配置迁移、失效快照、503 隔离、直接发送、追问历史及安全 Markdown 检查。

自动主机验收在隔离应用登记两台测试资产：A 指向已关闭的本机端口，B 指向计数监听器。字面问题直接命中 A，不产生路由 HTTP；语义问题实际调用一次路由 HTTP 并返回 A。两次均尝试 SSH 并显示“命中主机…连接不上：SSH TCP 或代理连接超时”，不产生后续诊断调用，B 的连接计数始终为零。总计四次分析、四次注册测试、一次路由请求；未执行模型建议。退出清理测试主机、模型及系统 Key，无清理警告。

空状态、回答、追问、API 错误、命中连接错误各四组（1440×900/900×600，深/浅主题），共 20 张助手截图；另保留模型列表与表单截图。断言实际宽窄布局、无主机下拉、无横向溢出和发送入口可见；已审阅桌面和小窗口失败画面，连接错误含主机和实际原因。原有全局运维错误提示也会短暂出现。

原生证据：`.local/assistant-hosts/native/cff94b9d-d81b-4538-b39b-ecb49900a629/result.json` 及 PNG。最终规则小修在此原生验收后完成，单独复验规则测试并重新构建正式标识程序，没有重复原生全流程。

日志：`.local/assistant-hosts/frontend.log`、`rust.log`、`routing-final.log`、`ipc.log`、`clippy.log`、`clippy-final.log`、`native.log`、`build.log`、`build-final.log`。最终相关 Clippy、Rust fmt 和变更文件 Prettier 检查均通过。

交付程序：`.local/assistant-hosts/ServerDeck.exe`。最终 SHA-256：`1C1B1014D6B504623F8F44270F2147EACB06C35AB95BD594626D0899CC1761E1`。

部分构建因旧 target 程序正在运行而遇到 Windows 占用；同目录改名保留旧文件后完成构建，未结束用户进程或更改正式资产/配置/Key。保留文件可能仍被运行实例使用，不自动清理。启动新版前退出旧实例，避免单实例机制聚焦旧程序。

## 未验证、风险与下一阶段依赖

未连接用户服务器、调用用户外部计费服务或执行模型命令；成功 SSH 采集以本机真实 SSH 夹具验证。未验证 Release 安装器、macOS/Linux、长期运行及所有兼容模型。模型可错误匹配已登记资产，但不能选择未登记目标或绕过 SSH 指纹验证，命中名称在消息中可见。

每问最多八台，连接按顺序、每台最多等待 120 秒；超过范围需缩小问题。多主机命令仅人工审阅。语义路由可能额外请求并计费，聊天 Token 合计仅含分析响应，不含路由；用户填写的费用估算不能替代提供商账单。请求总量仍限 96 KiB，监控需先启动，取消不保证远端服务停止处理。自动脱敏并非完整秘密识别，HTTP 仍有明文传输限制。

无新增开发依赖或本阶段未完成阻断项。本阶段完成后停止，不扩展自主执行、后台批量连接或模型工具循环。
