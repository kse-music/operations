# 模型注册测试及界面验证

日期：2026-11-03。范围：添加模型前真实连接测试、后端保存门禁、模型表单及列表布局优化。

## 真实功能与主要修改

- `crates/core/src/ai.rs`：ModelInput 增加可选 testId，新增 ModelTest 返回测试 ID、耗时和有效秒数，秘密输入仍不实现 Debug/Serialize。
- `crates/ai/src/model_test.rs`、`lib.rs`：同一提供商适配器发出固定测试请求；无工具和服务器上下文，最多输出 256 Token。成功才签发五分钟/单次测试结果，内存上限 32 项；只保存配置、模型 ID/版本与 Key 的 SHA-256 摘要绑定，不保存响应或原 Key。HTTP/认证/协议/工具响应异常均失败，复用并发、TLS、超时与退出取消。
- `crates/application/src/ai.rs`：ai_model_test 校验输入与已有版本，必要时从系统凭据库取本模型 Key；地址变更不能隐式沿用原 Key。新建、配置修改或 Key 替换须消费匹配测试 ID 后才能保存；改名称或单独清除 Key 仍可离线完成。测试不写凭据库和数据库。
- `apps/desktop/src-tauri`：增加 ai_model_test 的 handler、manifest 与本地主窗口 ACL，共八项 AI IPC，前端 types/services 同步。
- `composables/model-form.ts`、`ModelDialog.vue`：测试与保存状态分离，展示等待/错误/成功耗时，未通过禁用保存，配置/Key 变化、结果过期或保存失败须重测。关闭表单清空 Key 并忽略晚到测试结果；已发送请求可能继续完成。保存请求完成后清空临时 Key。
- `ModelsView.vue`、`styles/models.css`：列表对齐模型/服务地址与 Key 状态/输出上限/编辑删除操作。表单使用双列与全宽字段、连接分区、可折叠输出/费用、独立测试区和固定底部操作。复用现有主题，窄窗口改两行列表与可滚动表单。
- Rust/Vue/IPC/原生测试、ai_live_probe 示例及 PRD/架构/决策/使用/安全/计划文档同步。仅增加对已在锁内的 sha2 0.10 的直接引用，无新增包、数据库迁移或新设计依赖。

## 执行验证

| 检查                                                                                                                | 结果与行为断言                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                                                                                                          | 41 文件、273 项通过；新增失败测试禁保存、重试、配置/Key 变化失效、晚到结果及过期处理；保留原 CRUD、Key 清空和助手测试                                  |
| 最初相关前端测试                                                                                                    | Models/Assistant 共 12 项通过                                                                                                                          |
| `cargo test --offline --locked -p serverdeck-ai -p serverdeck-application -p serverdeck-storage -p serverdeck-core` | 89 项通过；无测试不创建、不写 Key，改模型/Key 不能复用、一次消费/过期拒绝、编辑已有 Key 可测试、HTTP/协议/工具响应失败不签发；旧迁移及诊断授权回归保持 |
| `cargo test --offline --locked -p serverdeck-desktop --test ipc`                                                    | 2 项通过；真实 dispatcher → 本机 HTTP 测试 → 单次 ID → 系统 Key 保存 → 确认删除，未测试保存拒绝，输出无 Key/secretRef，八项 AI 接口仅本地主窗口        |
| `npm run lint`、`npm run build`                                                                                     | ESLint、TypeScript、Vite 均通过                                                                                                                        |
| Rust fmt / Clippy                                                                                                   | 格式通过；AI/Application 全 targets `-D warnings` 通过，沿用 `-A clippy::single_element_loop` 对既有 openssh 告警的豁免                                |
| 原生 Windows                                                                                                        | 完整通过，真实 WebView2/IPC/SQLite/系统凭据库及 loopback HTTP 夹具，见下方证据                                                                         |

原生验收有 4 次固定模型测试请求（含一次 503 失败及修改配置后重测）、3 次既有诊断请求。认证按各模型 ID/Key 精确核验；无工具或服务器数据。未测试、测试失败和改配置后保存禁用，失败时注册表仍为空；成功后可保存。继续验证旧 Key 迁移、双模型选择、旧预览拒绝、删除确认和 API 失败隔离。最终删除全部临时模型和测试 OS 凭据，无清理警告。

截图覆盖 1440×900、900×600 深/浅主题，每组模型列表、表单首屏与底部，加既有助手四组。校验表单/页面无横向溢出，已审阅桌面深色列表、桌面浅色表单、小窗口深色底部，固定底部操作可见。

日志：`.local/model-management/model-test-{frontend,rust,ipc,native,clippy,build}.log`。
原生证据：`.local/model-management/native/43ba729d-9122-4bfc-bf73-160a77cb034f/result.json` 及 PNG。
程序：`.local/model-management/ServerDeck.exe`，经 `node tools/tauri.mjs build --debug --no-bundle` 生成，内置前端，不依赖开发服务器。

最终交付 SHA-256：`084203A241F5192BD65A8E102E23D77F694A508C6D1ED595D1C55C2636960A25`。

IPC 构建最初因运行中的 target EXE 被 Windows 占用失败，保留进程并将该文件在 target/debug 同目录改名为 `serverdeck-preserved-20261103190239.exe` 后完整复验通过。最终构建再次遇到运行占用，同样保留为 `serverdeck-preserved-20261103190731.exe` 后成功构建并复制交付程序；未结束用户程序或重置其数据。保留文件仍可能被运行进程使用，不自动清理。

## 未验证、已知风险与下一阶段依赖

本次仅使用隔离测试 Key 和本机夹具，没有新增对用户提供服务的真实计费调用，没有连接用户服务器或执行远程命令。未验证 Release 安装包、macOS/Linux、所有兼容服务及长期运行。API 需支持既有 Chat Completions 字段；测试通过只说明该时刻的连接、模型 ID、认证及响应有效，不保证之后仍有额度或可用。

测试可能计费，窗口中明确提示；服务在断开/退出后仍可能处理或计费。已有 HTTP 明文风险、手填价格估算、凭据清理警告和脱敏限制继续保留。测试结果不持久化，重启、过期或失败保存后需重新测试。构建保留既有 Monaco 大 chunk 及增量缓存硬链接回退告警。更新测试时先退出旧版以避免单实例插件聚焦旧程序。无新增开发依赖或未完成阻断项，本阶段结束后停止。
