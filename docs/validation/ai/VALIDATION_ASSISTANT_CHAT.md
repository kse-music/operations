# 助手直接对话验证

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
