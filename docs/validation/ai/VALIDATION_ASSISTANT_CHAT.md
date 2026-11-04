# 助手直接对话验证

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
