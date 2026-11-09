# 助手直接对话验证

## 2026-11-09 上下文脱敏范围与预算修复

范围为当前 SDK5 助手插件，标准包 2.0.3；补齐 ADR 0027 已有要求，不恢复旧 Native 助手业务接口或扩大工具权限。

主要修改：`backend/src/summary.rs`、`workflow.rs` 先在完整原值上脱敏，再截短选定明细；统计仍使用完整成功查询。诊断只附命中主机，普通知识不附目录，只有明确资产清单问题携带目录。新增 `budget.rs` 复用模型配置，在准备和每轮补全按 JSON 编码后完整请求估算输入、预留最大输出；先削减可选明细，再删除最早完整历史，保留当前问题、主机归属、完整统计、工具/采集失败及省略标记，仍不足明确拒绝。

前端 `assistant.ts` 按实际准备请求编码大小限制历史，包含匹配后的目标参数；删除完整旧轮次，不在脱敏前截断回答。准备和补全的省略警告显示在回答中。预算只改变模型所见副本，不改变插件保留的完整执行证据、冻结目标、单次确认、owner/修订、取消及复查边界。

实际验证：

| 检查               | 结果                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修复前新增原生回归 | 长敏感值摘要、8 主机/满历史预算、必需问题超出模型窗口三项真实失败                                                                                                                       |
| 助手 Rust 测试     | 14 项全部通过；`cargo test --manifest-path plugins/system/assistant/backend/Cargo.toml --target-dir target --offline --locked --no-run --message-format=json` 后复制 EXE 至 QA 目录运行 |
| 隐私与范围断言     | 超过明细截断长度的完整自定义秘密被移除；诊断无无关资产，普通知识无目录，明确资产清单仍有总数和资产 ID                                                                                   |
| 预算断言           | 8 主机、完整统计、单主机失败原因及成对历史保留；预算包含转义并预留输出；可选明细先于历史压缩，旧 JSON 对话不改写/不误作当前问题，工具失败证据不丢失，必需问题过大时未调用模型           |
| 原计划安全回归     | 完整清单冻结、确认防重放、owner 隔离、拒绝模型变更工具/改标签、取消后保留部分报告并停止后续步骤继续通过                                                                                 |
| 前端               | 全量 54 文件 497 项通过；覆盖多字节/大量 JSON 转义历史，整轮保留或省略及实际编码不超过 48 KiB；原模型切换/停止/后台归属断言保留                                                         |
| 静态与构建         | 桌面/SDK TypeScript、ESLint、Rust fmt、助手 Clippy `--all-targets --offline --locked -- -D warnings`、WASM 及 `npm run build` 通过                                                      |
| 打包界面           | `node tools/plugin-handshake-e2e.mjs`：真实打包助手 2.0.3、Docker 2.0.4 各两次 iframe 挂载通过，无真实模型或 SSH 调用                                                                   |

原生构建复用根 `target/`，构建前 D 盘空闲大于 10 GiB，未启用增量/全量调试或新建桌面 Cargo 缓存；WASM 沿用现有插件缓存。证据及基线快照在 `.local/terminal-context-fix/`，测试程序为 `.local/qa/terminal-context-fix/assistant-tests.exe`；原生最终日志 `assistant-tests.log`，前端完整日志 `frontend-tests-final.log`，最终构建日志 `production-build-final.log`，包握手日志 `plugin-handshake.log`。浏览器沙箱启动失败后以隔离配置复验通过，详见[同阶段终端记录](../terminal/VALIDATION_TERMINAL_CONTEXT_MENU.md#2026-11-09-终端入口补齐)。

收尾复核保留跨准备/补全阶段累计的历史省略轮数，14 项 Rust 测试、Clippy 和最终 WASM/生产构建再次通过。修改文件 Prettier 与按仓库换行约定执行的 `git diff --check` 通过；文档路径/锚点检查覆盖 42 份文档、407 个本地链接和 57 个入站引用，修正三处失效引用后无错误，结果见 `documentation-check.json`。四份总览按模块原位修订，其余未关闭发布门禁保留，其他任务改动未回退。

本次无外部真实账号、计费请求、真实 SSH/原生 WebView2、EXE/安装器或 macOS/Linux 验收。UTF-8 字节估算有意保守，不等于提供方分词；脱敏不能保证覆盖未声明的业务秘密，必需信息仍可能超预算并明确失败。无本阶段已知阻断；完整端到端依赖授权主机、真实模型账号及当前原生包，本阶段后停止。

## 2026-11-05：主机工作区后台回答

完成标准：从主机打开的内置助手在切换工具、设置或另一主机后继续已开始的处理；返回显示完整结果和仍有效的计划。关闭所属主机仅取消本页请求和计划；全局助手随自己的标签关闭。手动停止、模型/授权变化、超时和变更确认保持有效。

主要实现：

- `PluginView.vue`、`PluginFrame.vue`：以所属工作区是否存在决定保留请求，隐藏状态仍为真实 visible:false/inert。`stores/plugins.ts` 为精确内置 system 助手维护多个 owner 和稳定空原生上下文，切换设置或其他主机不增加上下文代，最后 owner 释放实例；实际 SSH Binding 仍由请求冻结并复验。
- `plugin-ui-bridge.ts`、`plugin-server.ts`：每个 iframe 跟踪自有根请求和控制器，关闭时仅撤销本页资源；可见页面 begin 后才允许隐藏期间续接目录、连接、匹配、准备和发送，end 后不能后台开始新工作。后台新执行请求拒绝，可信审批展示和批准后均核对可见性，已批准调用可完成并回传结果。
- SDK AI 服务增加可选 begin/end，经现有 MessageChannel 传输；助手 `assistant.ts` 保留在途对话版本、结果和计划，卸载仍清理。助手标准包1.5.1。没有新增原生 IPC、权限、依赖或数据库迁移；上传同 ID 包保持原隐藏取消规则，任务开始已有修改未回退。
- `tools/assistant-agent-native-e2e.mjs --background` 复用原智能体真实 SSH/Docker 夹具，增加多 owner 导航与关闭验证；`assistant-agent-test-host.sh` 为交互 PTY/登录审计补充 FOWNER 与 AUDIT_WRITE，并增加有所有权校验的失败诊断日志，仅作用于临时测试容器。

实际验证：

| 检查                      | 结果与关键断言                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端全量                  | 56文件397项通过。新增九项覆盖共享 owner/安装来源隔离、隐藏请求与结果、关闭时仅取消自有根、排队审批隐藏后拒绝、缓存 frame 不重建、迟到 prepare 续接及卸载撤销；并验证已确认执行在隐藏后仍保留结果。既有 JSDOM Canvas 提示保留                                                                                           |
| 类型、静态与格式          | desktop/SDK typecheck、ESLint 0 warnings、修改文件 Prettier、Node 脚本语法与 diff whitespace 通过                                                                                                                                                                                                                      |
| 标准包与 Windows 调试构建 | 三个标准包、兼容资源、生产前端、隔离 QA 与默认配置 EXE 构建通过；沿用根 target，默认配置已恢复，保留既有 chunk 大小提示                                                                                                                                                                                                |
| Application Rust          | `cargo test -p serverdeck-application --offline`：53通过、1失败、1既有 ignored。失败为 `identity::tests::junction_profiles_are_rejected_without_touching_their_target` 的 Windows New-Item Junction Access is denied；D/C 临时目录及允许本任务执行后仍失败。没有删除或弱化断言，本次未修改 Rust 源码，不宣称 Rust 全绿 |
| Windows 原生后台回归      | 五组通过：真实 SSH 终端连接后，原回答跨设置、另一主机助手及关闭另一主机继续完成，返回计划可审核执行；关闭所属主机取消请求并移除 frame，无迟到计划，设置 owner/上下文代保持。真实镜像删除与复查保持通过                                                                                                                 |

过程与边界：首次构建遇到用户正常运行的根 EXE 占用，按开发约定请用户从界面退出，收到“已正常退出”后成功构建，没有强杀用户进程。原生新用例先修正终端指纹弹窗名称，再发现仅命令查询夹具缺少 PTY/登录审计所需权限，日志明确 linux_audit_write_entry Operation not permitted，补齐 FOWNER/AUDIT_WRITE 后终端连接及五组验收通过；复用临时配置重试时，端口复用触发密钥变化保护，改为重建全新隔离配置，未覆盖信任或关闭指纹验证。所有远端变更只针对独立 daemon 中本任务创建的镜像，不使用用户 Docker socket 或生产模型/主机。

证据在 `.local/assistant-background-20261105/`：`frontend-tests.log`、`typecheck.log`、`lint.log`、`application-tests.log`、`native-build.log`、`native-e2e.log`、`native-results.json` 与计划/结果截图，已查看宿主确认和深色结果。模型使用确定性本机 HTTP 协议夹具，本轮五次智能体调用；测试删除两张本任务无标签镜像，保留有标签镜像。应用、模型服务、临时 SSH 容器和独立 daemon 已结束并清理。默认 EXE 与 `.local/assistant-background-20261105/ServerDeck-preview.exe` SHA-256 一致（`delivery.json`），QA EXE 仅供隔离测试。复现：先 `node tools/assistant-agent-native-e2e.mjs --background --build`，再执行 `node tools/assistant-agent-native-e2e.mjs --background`；每轮使用新构建配置，避免端口复用时继承上一轮 SSH 信任。依赖 Windows WebView2、WSL Ubuntu-24.04、dockerd/docker/unshare 和既有测试基础镜像；不创建另一套桌面 Cargo 缓存。

未验证/风险：未新增生产模型质量、跨平台、Release/安装器及长期压力验收；模型/SSH 原有预算和计划过期时间继续生效，切页不延长时限。关闭已批准且在途的变更不承诺回滚，按原规则收尾并停止后续项。此前已停止的旧回答不会自动重启，需重新发送。本阶段实现完成，无剩余实现依赖；Rust Junction 环境失败仍保留，发布与其他平台验证依赖对应环境，当前阶段结束。

## 2026-11-05：SSH 运维智能体

完成标准：内置助手能够通过有界只读工具连续查询，生成由宿主冻结的单主机计划，在一次可信宿主确认后通过 SSH 执行并逐项复查；能够清理 tag 为 `<none>` 的 Docker 镜像。未确认不变更，未知/失败停止后续项，不能扩大目标或执行任意模型 Shell，原有绑定/指纹/权限/脱敏和兼容调用继续有效。

已完成及主要文件：

- `crates/ai/src/agent.rs` 和 `agent/tests.rs`：严格 query/plan/answer 协议、只读 allowlist、完整查询证据选目标、摘要/轮次/字节/时限预算、单次过期计划及模型/取消生命周期。容器和服务目标必须来自成功查询，再冻结详情；无标签镜像按完整 ID 去重，排除带标签别名，超过32项拒绝。
- `crates/application/src/ai/agent.rs`：复用已验证 SSH/Operations，变更前重查身份/模型/前置状态，变更后重新查询验证删除、状态、重启时间与启用状态；逐项完成/失败/未知/跳过结果。取消不承诺撤销在途变更，仍允许安全收尾并停止后续项。`plugins/tools.rs` 将内置助手接入编排，执行票据 abort 关联根请求；`plugins/review.rs` 从保存清单生成易读宿主审批，只需一次计划确认。上传与旧原生 IPC 保留原合同。
- `crates/core/src/ops.rs` 将镜像列表改为 `image ls --all`，覆盖默认列表可能隐藏的无标签中间镜像；`crates/ops/src/lib.rs` 增加内部完整 ID/RepoTags 再验和 `image rm --no-prune`，不 force、不清理卷或额外父镜像，复用原变更锁、反馈与错误链。
- Core/SDK Answer 和 Execution 增加可选 agent 结果；`AssistantAgent.vue` 展示查询、完整计划和逐项目标结果，`assistant.ts` 复用既有服务并保留停止后的结果；`assistant-hosts.ts` 保留等待指纹事件的连接。助手标准包1.5.0；无新 IPC、权限、依赖或数据库迁移，旧安装启停/绑定设置继续正常升级。
- README、PRD、架构/决策、使用指南、内置插件、SDK、安全与实施计划同步。任务开始已有的按需上下文、资源日志/容器终端弹窗等修改保留，未回退其他工作。

实际验证：

最后复核增加同一目标只允许一项操作的校验，拒绝 stop/start 链并要求使用 restart，避免先停机再因冻结状态变化而中断；AI 21项在该修改后再次通过。

最终原生复验同样通过三组；脚本显式核对首次 SSH 指纹的可信宿主弹窗，并等待认证完成后重新发送任务，保留原有安全确认。

| 检查                                               | 结果与关键断言                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                                         | 56文件、388项通过。计划不会自动执行，点击审核走可信宿主 API，显示逐项目标与复查失败，停止后保留结果；新增“awaiting_trust 先于指纹事件”回归，原聊天/模型绑定/会话/SSH/SFTP/插件测试保持。JSDOM 保留既有 Canvas 未实现提示                                                                   |
| `cargo test --workspace --offline`                 | 230项通过、0失败、4项既有 ignored。新增模型 HTTP 工具循环、完整证据中摘要外目标、带标签别名排除、缺失依据/未知目标/超量/非法变更工具/轮次上限、审批防重放/过期/模型撤销、容器与服务复查，以及有状态真实 SSH 协议的成功删除/新目标不扩容/重新打标签/部分失败/取消/断连/在途取消后未知及跳过 |
| `npm run typecheck`、`npm run lint`                | desktop/SDK 类型检查通过，ESLint 0 warnings                                                                                                                                                                                                                                                |
| `cargo clippy --workspace --all-targets --offline` | 通过；只有原有 `core/src/openssh.rs` single_element_loop 提示，无本次新增提示                                                                                                                                                                                                              |
| `npm run build`、原生构建                          | 三个标准包、兼容资源及生产前端通过，保留既有大 chunk 提示。最终 QA 副本和默认配置 Windows 调试 EXE 均构建成功，根 target 默认配置已恢复；未构建安装器                                                                                                                                      |
| `node tools/assistant-agent-native-e2e.mjs`        | WebView2 → 包内 iframe/实际 WASM → 本地模型 HTTP 协议夹具 → 已核验 SSH → 独立真实 Docker 守护进程，三组通过，详见下述实测                                                                                                                                                                  |
| 格式/语法                                          | Cargo fmt、相关 Prettier、Node 脚本语法及 diff whitespace 检查通过；PRD 沿用既有格式忽略规则，Shell 夹具通过真实执行验证                                                                                                                                                                   |

原生实测使用全新隔离应用目录、临时系统凭据及本任务 SSH 容器。独立 dockerd 使用独立配置、数据/执行目录和网络命名空间，只含新导入的两张无标签镜像与一张有标签镜像；SSH 容器只能访问该测试 socket，不挂载用户 Docker socket。先核对本次生成的 SSH 公钥指纹，再执行以下检查：

1. 模型协议经过两轮调用查询真实镜像并生成两个固定目标；查询、计划和宿主确认前，独立 daemon 仍有三张镜像。宿主弹窗包含完整目标 ID，未填确认文字时按钮禁用；错误确认文字由后端单测验证拒绝。
2. 一次正确宿主确认后，经 SSH 真实删除两张 `<none>` 镜像，逐项重新查询确认消失；有标签镜像保留。执行没有再调用模型，输出仅本地复查。确认页、深浅主题结果截图已查看。
3. 新对话再次查询真实状态，显示“没有符合条件的目标”，不生成删除按钮。共四次智能体模型协议调用，不包含连接测试；没有调用生产模型或用户服务器。

证据位于 `.local/assistant-agent-20261105/`：`workspace-tests.log`、`frontend-tests.log`、`typecheck.log`、`lint.log`、`clippy.log`、`native-build.log`、`native-run.log`、`native-results.json` 和 `agent-*.png`。可复现入口为 `node tools/assistant-agent-native-e2e.mjs --build` 后运行同脚本；前提为 Windows WebView2、WSL Ubuntu-24.04、dockerd/docker/unshare 及现有 `serverdeck-plugin13a-test:13a` 镜像。复用根 target 构建缓存，构建前剩余空间超过10GiB。

默认配置调试版副本为 `.local/assistant-agent-20261105/ServerDeck-preview.exe`，与根 `target/debug/serverdeck-desktop.exe` 的 SHA-256 一致（`delivery.json`）。`AssistantAgentQa.exe` 是绑定隔离目录的测试程序，不用于正常使用。

过程发现和修复：沙箱内回环 HTTP 被拒绝，允许本任务隔离测试后完成；Vitest 指定外部插件文件时需以 desktop 为工作目录。Docker 夹具先遇到默认配置继承/网络冲突，改用独立配置和网络命名空间，失败创建的容器经标签/名称核对后清理。真实 Docker 显示无标签中间镜像需要 `--all`，已修复正式查询；原生首次 SSH 状态/指纹事件分开到达导致待信任连接误清理，已修复并通过回归及原生复验。未关闭指纹验证或放宽生产权限。

限制/风险/依赖：真实 Docker 删除和原生审批已验证，模型使用确定性 HTTP 协议夹具，未验收生产模型的计划质量、完整真实 systemd/容器变更图形流程、跨平台、Release/安装器或长期压力。工具协议不合规时明确降回原有建议；当前不是任意 Shell 或多主机自主执行。镜像标签检查到删除间仍存在外部并发变更窗口，部分执行没有事务回滚；失败/未知停止后续并保留结果。测试应用/模型服务/SSH 容器/独立 daemon 及其数据已结束并清理，用户既有 Docker 镜像未操作。本阶段无剩余实现依赖，发布及其他平台验收需相应环境，完成后停止。

## 2026-11-05：按问题采集与上下文预算

修复首次询问“当前运行了多少个docker服务”也被 96 KiB 限制拒绝的问题。旧内置入口固定采集全套运维数据并附带全资产目录；当前仅按问题选择只读来源，成功查询先统计全部结果再限制明细。以下固定全量上下文的早期说明仅保留为历史。

### 真实功能和主要文件

- `crates/application/src/ai.rs`、`ai/context.rs`、`ai/context/summary.rs`：按问题规划指标/进程/容器/systemd 系统服务/端口/journal；只关联命中资产。模糊追问参考最近明确的用户领域，明确新话题重新选择，模型回答及远端指令不决定范围。首问容器数量不读监控、进程或日志。
- 完整结果先统计，容器包含 total/running/各状态和统计口径；未知状态独立统计，失败明确 available=false。列表白名单字段最多 12 条/4 KiB；聚合 CPU、前 8 项磁盘/网卡；journal 脱敏后末尾最多 4 KiB；字段截短和 omitted 数量明确标注。所有截短前先脱敏。
- `crates/ai/src/lib.rs`、`provider.rs`：统一构造和计算脱敏请求的实际 JSON wire 字节。96 KiB 上限保持；内置请求超预算先省略明细、保留每台主机统计与失败，再省略最旧成对历史，仍超限则明确报错。系统提示要求区分总数与样本、未读取与零、容器与 Compose/Swarm 服务。
- `plugins/system/assistant/frontend/assistant.ts`、`AssistantView.vue`：合并去重准备阶段与响应阶段提示，让用户能在“上下文与响应提示”查看省略和读取失败。前端不再声明全部来源开启，内置范围由宿主选择。助手 manifest/标准包为 1.3.4，原权限、绑定、SSH 身份和命令审核保持。
- `ai/context/tests.rs`、`ai/protocol_tests.rs`、`crates/ai/src/tests.rs` 和助手前端测试：本地选择、精确计数、预算、错误语义、真实协议和提示呈现回归。使用指南、PRD、架构、决策、实施计划及内置包说明同步更新。

### 实际执行与结果

| 检查                                                                         | 结果                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 根 target 编译 AI/应用测试，复制 EXE 到 `.local/assistant-demand-qa/` 后运行 | AI 16 项通过；应用 49 项通过、1 项既有 Linux SDK 测试忽略；未运行 target 内测试 EXE                                                                                                  |
| 真实 loopback SSH/HTTP 首问回归                                              | 1500 容器/750 running/750 exited，只有一次容器查询，明细 12 条、omittedRecords=1488，实际请求小于 12 KiB；HTTP 收到内容与预览严格相等，无无关资产、Labels、进程/指标/journal         |
| 同一真实 SSH fixture 的其他问题                                              | CPU 只触发两次监控采样，systemd/端口各一次对应读取；问候不触发运维读取，无后台监控                                                                                                   |
| 汇总与异常回归                                                               | 5000 容器精确统计；长 UTF-8 字段有界；CPU 排序保留最高项；8 主机超预算仍保留全部统计和失败；JSON 转义历史按完整轮次省略；失败不伪造 0；脱敏、取消、连接/模型绑定与命令权限原回归保持 |
| 最终请求上限                                                                 | 实际 JSON 恰好 96 KiB 可准备，超过 1 字节拒绝；预览格式缩进不计入 wire 上限；多层 JSON 转义按实际体积检查                                                                            |
| 前端 Vitest                                                                  | 56 文件、385 项通过，含准备提示保留及去重；JSDOM 既有 canvas 未实现提示保持                                                                                                          |
| 类型、格式与静态检查                                                         | 两前端工程 typecheck、助手 ESLint、Prettier、cargo fmt、git diff --check 通过；普通 Clippy 完成，本次无新增警告                                                                      |
| 插件与桌面重建                                                               | 三个标准包和桌面前端生产构建成功；`node tools/tauri.mjs build --debug --no-bundle` 成功，根 target/debug EXE 已更新，包含助手 1.3.4                                                  |

初次沙箱内 HTTP 测试受本机回环网络限制，单项移到沙箱外后立即通过；最终整套测试均在隔离 QA 副本、隔离临时数据及 loopback 协议上运行。前端首次测试遇沙箱临时目录 rename EPERM，改为本任务 `.local/assistant-demand-qa/tmp` 后通过。Clippy `-D warnings` 被既有 `crates/core/src/openssh.rs:290` single_element_loop 警告阻止，普通 Clippy 通过，未夹带修改该文件。npm 未转发调试构建参数的尝试已停止，最终直接调用项目入口生成调试版。构建前输出盘约 175 GiB 空闲；用户已正常退出 target 中运行的 ServerDeck，未强杀用户应用。

证据目录 `.local/assistant-demand-qa/` 含编译元数据、最终 AI/应用测试输出、Clippy、Windows 构建日志和 `build-artifact.json`。交付副本 `ServerDeck-preview.exe` 为 55,987,200 字节，SHA-256 `3D0C2DCD6FF0D4B3319F621B0AA83FD401A278007B4A843935038E328BDCCC61`，与根 target/debug 产物严格一致。

本阶段未调用真实模型、用户生产服务器或重新执行原生 WebView2 图形验收，未验证安装器、macOS/Linux。本地领域规则不能覆盖所有复杂问法；证据不足时明确说明，不回退全量采集。systemd 为 system 作用域；容器日志不自动猜测目标，只附容器状态并提示缺少日志。无新增依赖、数据库或未完成实现，本阶段结束。

## 2026-11-05：删除模型栏，模型统一在插件设置绑定

按用户追加要求删除聊天页整个模型栏（选择、Key 状态、刷新和模型管理），复用插件标准设置页持久保存绑定，以下先前界面描述保留为历史。

### 真实功能和主要文件

- `plugins/system/assistant/frontend/App.vue`、`SettingsView.vue`、`model-binding.ts`、`main.ts`、`AssistantView.vue`、`assistant.css`：贡献分别渲染聊天/模型设置，设置选择并保存 modelId，合并保留其他插件设置。聊天只保留对话/输入，统一使用绑定模型；无绑定、已删除、配置/模型读取失败或无 Key 时禁用发送。可见性恢复重新读配置，绑定/模型版本变化使旧对话失效。设置有保存失败及重试状态，没有把未成功写入当作完成。
- `manifest.json`、`ui.json`、`backend/src/lib.rs`：增加 settings 贡献及既有 settings.read/write 能力，后端只接受本插件配置能力和 assistant 工具域；助手标准包更新为 1.3.2。设置过程不连接远端主机。
- `apps/desktop/src/services/plugin-ui-bridge.ts`：具有 assistant.use 的设置页可获取公开模型元数据，未授权页面仍拒绝；不传 Key。
- `crates/application/src/plugins/tools.rs`、`capabilities.rs`：系统来源助手在 stage/执行前核对持久绑定，拒绝未绑定/已删除/伪造其他模型；配置保存验证模型，更改/解除绑定撤销原有工具票据、AI 预览和建议，仅限当前插件。
- Vue、真实 WASM/配置持久化及插件升级测试同步；`tools/ui-navigation.mjs` 提供从插件设置绑定的测试步骤，相关三个原生图形脚本移除聊天页选择器与内置发送批准步骤。原生图形脚本本轮仅语法/格式检查，未宣称完成运行。
- 使用说明、PRD、架构、决策、内置插件说明和安全文档同步。无新依赖、IPC 或数据库迁移，不重置现有配置/模型/凭据；原生 AI IPC 和上传插件不强制使用系统助手绑定。

### 实际验证

| 检查                                                                                               | 结果及目标行为                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                                                                                         | 55 文件、377 项通过；包含助手设置保存/失败重试/重挂载后使用绑定、可见性恢复/重新绑定、删除/未绑定/读取失败不回退及权限边界                                                                                                                                                     |
| `npm run typecheck`                                                                                | desktop 与公开 SDK 均通过                                                                                                                                                                                                                                                      |
| `npm run build`                                                                                    | 标准 WASM/前端包及桌面生产前端通过；保留原有编辑器大 chunk 提示                                                                                                                                                                                                                |
| `npm run lint`                                                                                     | 通过；首次因桥接原 surface 变量不再使用失败，删除该无用变量后通过                                                                                                                                                                                                              |
| Rust no-run / QA EXE                                                                               | 根 target 编译，复制到 `.local/assistant-model-binding-qa/` 运行：插件工具 5 项、标准分发/升级/权限 5 项、AI 9 项、助手 Guest 白名单 1 项，共 20 项通过。包含真实 WASM 读写配置、应用重新初始化后绑定保留、未知模型拒绝、绑定改变撤销旧预览/票据及未绑定拒绝，不只验证内存状态 |
| `cargo clippy -p serverdeck-application --lib --tests --no-deps --offline --locked -- -D warnings` | 通过                                                                                                                                                                                                                                                                           |
| 实际插件包浏览器检查                                                                               | 设置与聊天分别在 1280×800、680×600、390×720 深浅主题，共 12 组布局通过。断言聊天顶端直接为对话、无模型栏/选择器/管理入口/发送 dialog、使用保存模型、未绑定/删除时阻止发送、保留其余配置，无横向溢出或脚本错误；截图目视检查。宿主/模型返回明确为测试夹具                       |
| 格式与静态                                                                                         | 相关 Prettier、Rustfmt、Git diff whitespace 与四个图形脚本语法检查通过                                                                                                                                                                                                         |

证据：`.local/assistant-model-binding-qa/` 内的 UI 检查脚本、JSON、12 张截图和 Rust 输出；两个 `.local/assistant-model-binding*-build.jsonl` 保存编译元数据。前端重绑定测试最初沿用旧选择器路径的“必须主动 cancel”断言失败；实际离页时宿主已经撤销句柄，改为验证返回后旧消息/建议不存在，后端另行验证旧预览/票据实际失效。

### 未验证与限制

本阶段未运行正式模型、用户生产主机、完整原生 WebView2 图形脚本、macOS/Linux 或安装器；未生成/替换新桌面 EXE。首次升级需要在插件设置明确保存模型绑定；旧页面内临时选中的模型没有被静默迁移成持久绑定。只有模型 ID 落插件配置，清除插件数据会清除绑定。原有上下文大小、远端权限和模型网络限制保留。当前阶段无新增依赖或未完成项，后续桌面交付/正式环境验收独立进行，本阶段完成后停止。

## 2026-11-05：移除发送弹窗及上下文侧栏

本阶段完成用户指定的使用界面调整，后文保留历史记录。当前内置助手点击发送直接完成主机匹配、上下文准备和模型请求，右侧整个面板及展开按钮、读取开关、日志选择、自定义脱敏输入均移除。所有已登记主机默认参与匹配；入口主机是“当前主机”的初始线索，后续沿用命中主机。仅按问题连接命中项。

### 主要文件与实际行为

- `plugins/system/assistant/frontend/AssistantView.vue`、`assistant.css`、`assistant.ts`、`assistant-hosts.ts`：全宽对话及固定输入区，默认完整上下文、地址脱敏、全资产匹配；首次指纹核验移至聊天区，保留错误和清理失败。删除只服务于侧栏的状态、监听和样式，保留快捷问题仅填草稿、停止、连续追问及命令审核。
- `crates/application/src/plugins/review.rs`、`tools.rs`：真实系统来源与助手 ID 共同限定匹配/发送免审及默认采集；上传插件包括同 ID 身份继续原审核，原票据所有权/安装代/TTL/单次消费/取消检查仍生效。执行命令仍独立审核。
- `crates/application/src/ai.rs`、`ai/context.rs`：内置入口固定启用服务器/指标/进程/Docker/系统日志和地址脱敏；读取失败以真实错误进入上下文与脱敏提示，连接身份变化仍拒绝。旧原生 IPC 与上传插件的 selection 合同不变。
- `crates/ssh/src/monitor.rs`、`crates/monitor/src/lib.rs`：复用固定采集脚本，在同一已验证运维连接上临时读取两次，间隔 250ms，支持取消，不启动后台监控。`crates/ops/src/lib.rs`：固定无 follow 的 system journal 最近 100 行/32 KiB，不提权。
- `crates/ai/src/routing.rs` 及 Vue/Rust 回归：当前主机线索、多主机匹配、默认完整采集、无监控启动、可选工具缺失、日志/错误脱敏、取消、同 ID 上传身份及命令审批均有断言。
- `tools/native-ai-e2e.mjs` 同步全宽、无侧栏/配置开关、发送无 dialog 的断言；脚本语法和格式通过，本轮未运行完整原生图形脚本。
- 助手清单和内置 `assistant.sdplugin` 更新到 1.3.1；产品、架构、决策、使用说明与安全文档同步。保留已有其他工作区修改，无新依赖、存储或数据库迁移。

### 执行过的检查

| 检查                                                                         | 实际结果                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完整 `npm test`                                                              | 55 文件、373 项通过；先行定向助手/插件桥接 3 文件 37 项通过                                                                                                                                                                   |
| `npm run typecheck`                                                          | desktop 与公开 SDK 均通过                                                                                                                                                                                                     |
| `npm run lint`                                                               | 通过                                                                                                                                                                                                                          |
| `npm run build`                                                              | 内置包 WASM/前端及桌面生产前端通过；保留原有编辑器大 chunk 提示                                                                                                                                                               |
| Rust 测试构建                                                                | application/ai/monitor/ops lib 测试通过编译；统一使用根 `target/`，运行前复制到本任务 QA 目录                                                                                                                                 |
| QA Rust EXE                                                                  | application AI 9 项、插件工具 4 项、ai 15 项、monitor 1 项，共 29 项通过；ops lib 无单元测试，实际查询由 application 的本机 SSH 协议测试覆盖                                                                                  |
| `cargo clippy ... --lib --tests --no-deps --offline --locked -- -D warnings` | application/ai/monitor/ops/ssh 五个修改涉及 crate 通过；不修改其他 crate 的既有代码                                                                                                                                           |
| `cargo fmt --all -- --check`、相关 Prettier、`git diff --check`              | 通过                                                                                                                                                                                                                          |
| 独立插件包浏览器检查                                                         | 使用实际包内 JS/CSS 与测试宿主响应；1280×800、680×600、390×720 的深浅主题共 6 组通过：聊天填满宽度、无侧栏、无横向溢出、发送按钮在首屏。直接发送、完整请求选项、消息内失败、无 dialog、无浏览器脚本错误均通过；截图已目视检查 |

证据目录：`.local/assistant-context-qa/`，含 `ui-check.mjs`、`ui-result.json`、6 张截图及 Rust 测试输出；编译元数据在 `.local/assistant-context-build.jsonl`。浏览器响应明确使用测试夹具，不作为真实模型输出验收。

环境失败如实保留：首次 Vitest 因沙箱 TEMP rename EPERM 未运行测试，改用任务目录 TEMP 后通过；首次无头浏览器因沙箱管道退出，受控放开后通过；首次 Rust 协议测试受回环网络 10013 阻止，运行同一 QA EXE 并仅开放本机网络后通过。首次 Clippy 带依赖严格检查被未修改的 `crates/core/src/openssh.rs:290` 的 `single_element_loop` 既有告警阻止，随后对五个相关 crate 使用 `--no-deps` 的严格检查通过，未更改依赖代码或添加 lint 豁免。

### 未验证、已知限制与后续依赖

未运行正式模型、用户生产主机、完整原生 WebView2 图形流程、macOS/Linux 或安装器；未替换正式运行程序，未生成新桌面 EXE。系统 journal 取决于远端 systemd/权限；缺失时明确不可用，不扫描其他文件。原有每次最多八台与 96 KiB 请求限制、模型/网络超时仍保留，自动脱敏不能保证覆盖全部业务秘密。当前阶段无新增依赖或未完成项，构建新桌面交付及正式环境验收为后续工作，本阶段结束。

日期：2026-11-03。范围：按最新用户要求，将助手主区改为直接发送、连续对话和 Markdown 渲染，取消发送预览、费用批准与二次发送。

## 完成功能与主要文件

- `apps/desktop/src/views/AssistantView.vue`、`styles/assistant.css`：消息列表与底部输入区、Enter 发送/Shift+Enter 换行、输入法组词保护、停止、新对话、消息内错误和重新编辑、Token 合计、命令建议折叠区。宽工作区旁置上下文，窄工作区压紧顶部并将上下文放到聊天下方。没有发送/扣费确认控件；代码和命令不会自动执行。
- `composables/assistant.ts`：一次发送动作串联原 prepare→send，confirmed 表示用户点击发送，非预览审批。保留请求冻结、模型/连接版本与系统凭据校验，等待时可停止。草稿不撤销已完成对话；失败/取消的轮次不进入追问历史。模型/服务器/版本/授权/脱敏变化、新对话和离页撤销旧请求及审批。
- `components/AssistantMarkdown.ts`：使用已有 marked 14.0.0 lexer，固定 Vue 节点渲染标题、列表、表格、引用、代码、强调等；没有 v-html。HTML 字面展示，图片只显示替代文本且不联网，链接仅允许解码后 HTTP(S)，危险协议无 href，属性和标签不取自模型 HTML。解析异常明确回退文本。
- `types/ai.ts`、`crates/core/src/ai.rs`、`crates/ai/src/lib.rs/provider.rs`、`crates/application/src/ai.rs`：PrepareInput/PreparedContext 增加缺省为空的 history，最多六轮/十二条、48 KiB，只允许成对 user/assistant；再次脱敏后放在固定系统规则与当前问题/上下文之间，历史不能授予工具权限。模型输出保留 JSON answer/commands 契约，answer 支持 Markdown。当前问题、上下文和历史总请求仍限 96 KiB。
- Vue/Rust/原生测试、示例和相关架构/使用/安全/决策/计划文档同步。marked 从已有传递依赖声明为直接依赖，无新包；原许可已列于依赖清单和 notices。没有新增 IPC、存储或权限。

界面最多保留二十轮；追问携带最近六轮成功问题/回答，48 KiB 内从新到旧选择，过大的旧回答截短并附说明。丢弃旧轮时撤销其命令建议和本地执行反馈。不携带命令审批对象、原始服务器上下文或执行输出；历史只在当前页面内存中，不落数据库、备份、localStorage 或日志。

## 实际验证

| 检查                                                                                                                | 结果与关键行为                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                                                          | 41 文件、278 项通过；最终助手 10 项单独复验通过                                                                                                           |
| 对话交互                                                                                                            | 一次点击直接请求、无预览/批准按钮，草稿保留历史，追问携带 user/assistant，失败恢复，停止/离页拒绝晚到结果，模型切换及新对话清历史                         |
| 执行边界                                                                                                            | 保留只读建议单次批准、系统变更独立输入确认、手动命令无执行入口、执行输出不进入历史；丢弃旧轮撤销请求建议                                                  |
| Markdown                                                                                                            | 标题、强调、列表、表格、代码块真实 DOM，脚本/图片/iframe 无节点，javascript/file 链接不生成 href，HTTP(S) 链接安全属性                                    |
| 历史限量                                                                                                            | 二十二轮测试界面仅保留二十轮，发出历史不超过十二条和 48 KiB，大回答裁剪保留 Unicode 字符边界并带省略标记                                                  |
| `cargo test --offline --locked -p serverdeck-ai -p serverdeck-application -p serverdeck-storage -p serverdeck-core` | 91 项通过；新历史越权角色/额外字段/不配对/过大拒绝，历史凭据脱敏，固定系统规则保持，无工具或自动执行；原模型 CRUD、迁移、真实 loopback SSH 授权等回归保持 |
| `cargo test --offline --locked -p serverdeck-desktop --test ipc`                                                    | 2 项通过，旧输入缺省 history 保持兼容，真实 dispatcher/OS 凭据及本地主窗口 ACL                                                                            |
| ESLint / TypeScript / Vite / Rust fmt                                                                               | 通过；新增测试复用单一状态组件以满足 Vue 静态检查                                                                                                         |
| Clippy                                                                                                              | AI/Application 全 targets `-D warnings` 通过，保留原 openssh `-A clippy::single_element_loop` 豁免；新增整除写法告警已修复                                |
| Windows Tauri                                                                                                       | 内置前端的 debug 构建成功，原生完整流程通过；最终移除无效旧样式与修正内部提示后再次构建成功                                                               |

原生测试真实运行 WebView2、IPC、SQLite、系统凭据库及 reqwest，本机 HTTP 返回明确的协议夹具。共 4 次固定模型测试及 4 次聊天请求，首次点击立即产生一次聊天 HTTP 请求，没有批准发送步骤；Enter 追问包含前两条历史，敏感字面值在传输前移除，切换模型的首次请求没有旧历史。Markdown DOM 检查通过；无脚本、远程图片、危险协议或自动命令执行。一次 503 显示在消息内，主机/文件/启动接口继续可用。模型 CRUD、旧 Key 迁移、过时内部快照拒绝和删除确认回归保持，最后删除所有测试模型及 OS Key，无清理警告。

空状态、回答、追问、错误各四组截图：1440×900 和 900×600 深/浅主题，共 16 张助手截图。原生断言宽窗口侧栏位于聊天旁，窄窗口在聊天后，页面/助手无横向溢出，发送操作首屏可见。已审阅桌面空状态/Markdown 回答及窄窗口追问；窄窗口顶部已压紧，消息独立滚动，输入区固定在聊天卡片底部。

最终原生证据：`.local/assistant-chat/native/99c53ce9-a1fb-4b66-b387-00bbf81895d6/result.json` 及 PNG。
日志：`.local/assistant-chat/frontend.log`、`rust.log`、`ipc.log`、`clippy.log`、`native.log`、`build.log`。

交付程序：`.local/assistant-chat/ServerDeck.exe`，来自成功的 `node tools/tauri.mjs build --debug --no-bundle` 正常应用标识构建，内置前端。最终 SHA-256：`8ECBFDEC7F8A1C0BA817F25178E5DABAACC42FA45DEFF6BAD6AD21945610B2E8`。

部分构建因用户运行 target 程序被 Windows 占用失败；在 target/debug 同目录改名保留后复验通过，未结束用户进程或改动正式配置/Key。保留的 serverdeck-preserved 文件可能仍被运行实例使用，不自动清理。新增测试字符串/集合写法及静态检查问题已修正，最终相关检查通过，未删除有效断言。

## 未验证、风险与下一阶段依赖

没有新增到用户提供服务的外部计费调用、连接用户服务器或执行远程模型命令。未验证 Release 安装包、macOS/Linux、全部兼容服务和长期运行。完整回答返回后才渲染，当前无流式输出；历史有六轮/48 KiB 上限，二十轮以外不在本次界面继续保留。

直接点击发送会将当前问题、已授权上下文和本会话限量历史发往所选服务，不再人工审阅完整请求。自动脱敏仍可能遗漏秘密，HTTP 明文、第三方留存政策和取消后服务端可能继续处理的限制保持。模型文本及历史不能提升工具权限，命令仍单条确认。已有 Monaco chunk 和增量缓存硬链接回退告警保持。

没有新增依赖包或未完成阻断项。启动交付新版前先退出当前实例，以避免单实例机制聚焦旧程序。本阶段完成后停止。
