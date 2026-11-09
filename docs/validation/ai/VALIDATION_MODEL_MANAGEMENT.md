# 模型管理验证记录

本文件保留模型管理各阶段记录；初版之后的连接测试与表单布局验证见 [VALIDATION_MODEL_TEST.md](VALIDATION_MODEL_TEST.md)，当前 Tab 布局验证见[本地来源与远程模型 Tab](#2026-11-09-本地来源与远程模型-tab)。历史产物和通过记录不代表当前版本的完整验收。

日期：2026-11-03。范围：资产管理中的模型注册/查看/编辑/删除，以及 AI 助手直接选择注册模型。

## 完成功能与主要文件

新增“资产管理 → 模型管理”工作区与列表、注册/编辑弹窗及独立删除确认。模型具有稳定 UUID、名称、配置、编辑版本和 hasKey；名称 1–120 字符且不重复，最多 100 项。地址、模型 ID、输出上限和单价随各模型保存；Key 独立存于 OS 凭据库，编辑留空保留，无读取回显。接口校验 expectedRevision，删除必须明确批准，秘密清理失败返回警告及持久 GC 待办。

助手移除单模型配置表单，只选择已注册模型，可跳转管理和刷新列表。初次仅有一个模型时选中，删除当前模型后不自动切换服务。预览冻结 modelId 和版本；编辑/删除撤销本模型的预览、在途 API 请求及未消费命令建议，其他模型不受影响。模型切换、配置版本变化与删除也清除 UI 旧预览/结果。原授权上下文、脱敏预览、逐条执行审批保持。

复用已有 application_settings 的 ai_models 行，格式 version=1，不改 schema 或数据库版本。首次读取在 IMMEDIATE 事务内将旧 ai_config 转换为“默认模型”，原配置/版本/OS 引用保持，成功才移除旧行。解析或版本错误明确失败、保留数据；AI 不进入启动依赖。模型与 Key 不进入非敏感备份。旧版不识别新列表，避免混用旧 AI 配置界面。

主要修改：

- `core/src/ai.rs`：Model/ModelInput/ModelDeleteInput、名称/版本校验、PrepareInput/Preview.modelId。
- `storage/src/ai.rs`：模型注册表、旧格式转换、事务 CRUD、版本冲突与秘密 GC。
- `application/src/ai.rs`、`ai/src/lib.rs`：指定模型取凭据、预览绑定、模型更新/删除的定向撤销。
- `src-tauri/src/ai_commands.rs`、manifest/ACL/dispatcher：ai_models/ai_model_save/ai_model_delete，移除旧 ai_settings/ai_configure，共七项 AI 命令。
- `ModelsView.vue`、`ModelDialog.vue`、`stores/models.ts`、`AssistantView.vue`、types/services 与导航：共享列表及选择、临时 Key、CRUD 和助手选择。移除 AiSettings 及废弃样式。
- 相关 Rust/Vue/IPC 测试、`ai_live_probe` 与 `native-ai-e2e.mjs` 同步契约。PRD/架构/决策/使用/安全/计划及质量报告已更新，无新增依赖。

## 实际验证

| 检查                                                                                                                | 结果与关键断言                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                                                          | 41 个文件、271 项通过；包括 5 项模型页面测试和 5 项助手测试、导航与既有回归                                                                                     |
| 最后相关前端复验                                                                                                    | Models/Assistant 10 项通过；覆盖同步抛错后刷新重试、注册与空/错误状态、编辑保留 Key、失败不制造记录、删除取消/失败/成功、选择/编辑/删除撤销预览                 |
| `cargo test --offline --locked -p serverdeck-ai -p serverdeck-application -p serverdeck-storage -p serverdeck-core` | 86 项通过；旧配置/Key 引用保留、重启/备份、独立 Key 轮换/清理、版本冲突、不可信输出、双模型隔离、在途请求/命令审批撤销、真实 loopback SSH 上下文与执行授权      |
| `cargo test --offline --locked -p serverdeck-desktop --test ipc`                                                    | 2 项通过；真实 dispatcher CRUD、无 Key/secretRef 返回、未确认删除/陈旧版本拒绝，七项 AI 接口限制本地主窗口                                                      |
| TypeScript/Vite、ESLint、Rust fmt                                                                                   | 通过                                                                                                                                                            |
| Clippy                                                                                                              | AI/Storage/Application 全 targets 的 `-D warnings` 通过，命令仅用 `-A clippy::single_element_loop` 豁免已知旧 openssh 告警；未宣称无豁免的全 workspace 检查通过 |
| Windows Tauri debug                                                                                                 | 经 Tauri CLI 内置前端构建；原生隔离程序正常运行，最终交付副本与正常标识构建来源哈希一致                                                                         |

Rust 日志 `.local/model-management/rust-tests.log`，IPC 日志 `ipc-tests.log`。前端使用本任务 `.local/model-management/tmp` 避免系统沙箱临时缓存 rename 限制；本机 HTTP/SSH/原生测试在允许 loopback 和系统凭据库的环境中执行，只用临时夹具数据。

`node tools/native-ai-e2e.mjs` 原生验收通过：

1. 隔离 UUID 应用目录与测试 Key，真实注册模型 A；在该测试数据库重建旧单模型格式，刷新后转换，再在不重输 Key 的情况下编辑保留配置。
2. 注册模型 B；助手不再含 Key 输入框，明确选择模型。生成预览前/批准前没有请求，切换模型清除旧预览；A/B 各自使用正确模型 ID 与 OS Key 发出请求。
3. 两次成功响应和一次 503，共 3 次本机模型请求。输出 HTML 作为文本显示，未关联服务器无执行入口；模型失败后主机、本地文件与启动接口正常。
4. 修改 A 后旧预览发送返回 NOT_FOUND，未产生额外请求；B 删除必须确认，取消保留，确认只删除 B。最终清理所有临时模型与 OS Key，无清理警告。
5. 1440×900 深/浅、900×600 深/浅四组助手截图，以及模型列表截图；无横向页面溢出，已审阅模型列表和小窗口浅色截图。

首次原生定位模型选择器失败，已补充明确无障碍名称。随后脚本在 Node 侧读取跨进程异常码丢失，改为在 WebView 内捕获，保留 NOT_FOUND 和请求计数断言后完整复验通过，没有删除有效断言或把失败记为成功。

原生证据：`.local/model-management/native/203564c7-1bc3-48f2-894d-61fcd372595a/result.json` 与 PNG。最终 `.local/model-management/ServerDeck.exe` SHA256：`A93312766EBE5C6FD0A2D24D199BE7598B4D48446DEA0351621A3FBF1D2C1230`。程序由 `node tools/tauri.mjs build --debug --no-bundle` 构建，避免普通 cargo build 指向开发服务器；未替换或关闭用户运行中的旧版。

## 未验证、风险与下一阶段依赖

本次没有连接用户服务器、执行远程模型命令或新增真实外部计费调用。没有重建 Release 安装包、验证 macOS/Linux 客户端、全部提供商或长期运行；模型 HTTP 协议未改变，原真实服务调用记录见 [VALIDATION_AI_ASSISTANT.md](VALIDATION_AI_ASSISTANT.md)。当前用户正式配置的转换将在新版首次访问模型列表时执行，原生迁移验证使用隔离夹具。

HTTP 明文、脱敏可能遗漏、费用只是估算及服务端取消后可能计费等原有限制保留。凭据清理失败会登记待办并提示；旧版不识别新模型列表，更新时应先退出旧版。保留既有 Monaco 大 chunk、缓存硬链接回退和 Clippy 基线告警。未发现本阶段新增阻断风险，无新增开发依赖；跨平台/安装包与更多模型协议需另行验收。本阶段完成后停止。

## 2026-11-09 本地来源与远程模型 Tab

模型管理改为「本地来源」和「远程模型」两个 Tab，每次进入默认打开远程模型。远程模型数量放在对应 Tab 标签，刷新/注册按钮、列表加载/错误/成功反馈、空状态和 Key 保存/插件绑定提示归入远程页；本地工具状态、安装、授权和凭据说明归入本地页。使用 `v-show` 保留组件及在途下载，切换不会撤销授权或取消下载。Tab 使用关联的 tabpanel、单一 Tab 键停靠点，并支持左右方向键和 Home/End。

主要文件：`apps/desktop/src/views/ModelsView.vue`、`styles/models.css`、`components/LocalModelSources.vue`、`views/models.test.ts` 和 `tools/ui-assets-e2e.mjs`；PRD、使用指南及实施计划对应章节已同步。本轮未修改 Native、IPC、数据库或认证契约，无新增依赖。

### 执行结果

| 检查                                                                                    | 结果                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test -- --run src/views/models.test.ts src/components/local-model-sources.test.ts` | 2 文件、16 项通过。覆盖默认远程、数量/按钮/提示/错误归属、独立刷新、键盘与焦点、切页期间下载完成及不自动授权；保留注册测试门禁、编辑保留 Key、删除确认/失败重试、本地授权/安装取消等回归。                                                                      |
| `npm run typecheck`、`npm run lint`                                                     | 桌面与 SDK TypeScript、项目 ESLint 通过。                                                                                                                                                                                                                       |
| `npm run build`                                                                         | 前端生产构建与现有内置插件构建通过；保留已有 Monaco 大 chunk 提醒。构建前 D 盘约 165 GiB 可用，沿用已有插件缓存。                                                                                                                                               |
| `node .local/qa/model-tabs/run-browser.mjs`                                             | 同环境启动 Vite 和隔离 Edge，执行 `tools/ui-assets-e2e.mjs`，6 组通过：1440×900 深/浅、2400×1000 深、900×600 浅（标准/145% 字号）、390×844 深。检查默认 Tab、互斥面板、按钮/数量/提示、键盘焦点、布局响应、无横向溢出及模型编辑/测试/保存；没有未捕获脚本异常。 |
| Prettier、`git diff --check`                                                            | 本次修改的 Vue/TS/CSS/JS 和指南格式、差异空白检查通过。                                                                                                                                                                                                         |

浏览器使用明确标注的内存 API 夹具，只验证界面与调用参数，不代表真实模型/本地 CLI 集成验收。证据为 `.local/qa/model-tabs/browser/results.json` 及同目录 `*-models.png`、`*-local-sources.png`、`*-model-context.png`，测试服务日志为 `.local/qa/model-tabs/vite.log`。已人工查看深色桌面两页、小窗口超大字号远程页与窄窗口本地页截图。

初次 Vitest 因沙箱临时目录 rename 返回 EPERM，在导入前失败；将本次进程 TEMP/TMP 指向工作区 QA 临时目录后 16 项通过。初次沙箱 Edge 启动退出，沙箱外浏览器又无法连接沙箱服务；改为同一环境启动测试服务与浏览器。旧浏览器脚本未关闭设置弹窗就操作后方主机树，补用现有关闭辅助函数后通过。补拍无遮挡截图时，通知移除导致旧索引失效，修正为逐个关闭当前首项。

### 限制、风险与后续依赖

未重建或验收桌面 EXE/安装包，未运行 Rust 测试、跨平台和屏幕阅读器验收，也未调用真实外部计费模型或下载安装本地 CLI。本轮没有发现新增阻断风险；长列表和大字号沿用设置内容区滚动。无新增开发依赖，桌面分发仍需正常构建并在原生环境验收；既有发布门禁保持。本阶段完成后停止。
