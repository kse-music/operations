# AI 运维助手验证记录

日期：2026-11-03。范围为本次追加授权的 AI 辅助诊断，生产功能均连接实际 Rust/HTTP/SSH 能力，测试夹具只出现在测试和验收工具中。

## 完成标准与实现

| 完成标准               | 实现与检查                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 真实模型调用和适配接口 | serverdeck-ai 的 OpenAiCompatible/ModelProvider；用用户授权的局域网服务实测                                           |
| 秘密不落明文配置/日志  | SecretStore 不可变引用/GC、ConfigInput 不实现 Debug/Serialize、临时表单清空；检查 SQLite/备份和 OS 临时凭据清除       |
| 授权当前主机上下文     | 同一 SSH Session/Transport，独立 server/metrics/processes/docker/日志选择；实际 loopback SSH 采集与 HTTP 发送集成验证 |
| 分析、建议、命令与界面 | 运维工具入口、自然语言、预览、纯文本回答及建议审核，Vitest 与原生 WebView2 验收                                       |
| 禁止自动执行/批量变更  | 无模型工具；固定命令后端映射，单条、单次审批，变更额外确认，未知命令仅展示                                            |
| 提示注入与输出处理     | 恶意日志留在 user 数据、秘密脱敏；工具调用拒绝，HTML 转义，Shell 拼接和未知命令无执行权限                             |
| Token/费用与故障隔离   | UTF-8 保守估算、手填单价、真实 usage，缺失明确未知；401/429/503/重定向/超限/取消测试                                  |

主要文件：`crates/ai`、`core/src/ai.rs`、`application/src/ai.rs`、`storage/src/ai.rs`、受控 ops Diagnostic/日志快照、`src-tauri/src/ai_commands.rs` 及 main ACL/manifest、前端 AssistantView/AiSettings/assistant composable、types/services/ai。同步 PRD、ARCHITECTURE、DECISIONS、IMPLEMENTATION_PLAN、使用/安全/质量报告和依赖许可；无数据库版本、迁移或用户已有配置改写。

## 已执行验证

- `npm test`：40 个文件、266 项通过，包含 5 项 AI 界面/生命周期/确认回归。首次沙箱临时缓存 rename 被拒，改用本任务 `.local/ai-assistant/tmp` 后运行；修复新增导航断言和 jsdom showModal 测试环境后全量通过。
- `cargo test --offline --locked -p serverdeck-ai -p serverdeck-core -p serverdeck-storage -p serverdeck-application`：82 项通过。包含真实本机 HTTP/SSH 协议、完整预览与实际发送相等、授权数据/空上下文、秘密脱敏、单次诊断/独立变更确认、断线拒绝、API 失败/取消、凭据故障不影响其他功能、备份/重启及既有回归。日志 `.local/ai-assistant/rust-tests.log`。
- `cargo test --offline -p serverdeck-ops`：协议 3 项、安全 5 项，共 8 项通过，包含权限失败、输出限制、超时和断线取消。首次沙箱 socket/日志轮转被系统限制，同代码在允许本机网络的测试环境复验通过；未删除或放宽有效断言。
- `cargo test --offline -p serverdeck-desktop --test ipc`：2 项通过，使用真实 Tauri dispatcher 检查新增六项接口、本地主窗口 ACL、无秘密读回和伪造批准拒绝。
- `npm run build`（TypeScript/Vite）、`npm run lint`、`cargo fmt --all -- --check` 通过。严格 Clippy 被既有 `core/src/openssh.rs` single_element_loop 告警阻断；仅在命令行豁免该既有告警后，AI/Application/Storage/Ops 全 targets 的 `-D warnings` 通过，未修改无关实现或全局 lint 配置。
- 真实联调示例的最后清理调整经 `cargo check --offline --locked -p serverdeck-application --example ai_live_probe` 验证：模型失败也先检查凭据清理结果，清理异常时保留 GC 元数据供恢复。该异常分支未对真实系统凭据库注入失败，未为示例调整重复计费调用。
- `node tools/native-ai-e2e.mjs`：隔离 Windows 应用目录、真实 WebView2/Rust/SQLite/OS 凭据、本机 HTTP 夹具通过。确认批准前零请求、Key 无回显、输出不解释 HTML、无服务器时无执行入口、503 后主机/本地文件/启动接口可用、临时 Key 清理。1440×900 深/浅、900×600 深/浅四组截图无横向页面溢出；已审阅桌面深色及小窗口浅色截图。
- Windows Tauri debug 构建成功。独立启动复验后，最终 `.local/ai-assistant/ServerDeck.exe` 与 `target/debug/serverdeck-desktop.exe` SHA256 相同：`028E50AAA1F07BDE8842C90AFA9B74014418E208BB5832DECE2570017099CADB`。

2026-11-03 独立启动复验：此前最后一次普通 `cargo build` 覆盖了 Tauri CLI 产物，使交付副本指向开发服务器。已通过 `node tools/tauri.mjs build --debug --no-bundle` 重建并更新副本，实机确认使用 `http://tauri.localhost/` 内置前端、本地后端就绪、已有主机数据保留。按用户追加授权在正式应用界面保存兼容服务配置与 OS Key，关闭再打开助手页仍显示“已保存 Key”；程序保持运行供用户测试。没有向文档或明文配置写入 Key，也没有执行模型命令。

原生证据：`.local/ai-assistant/native/6bee9639-d286-4dca-9a77-954d5670c07d/result.json` 与四张 PNG；结果记录 2 次模型夹具请求、API 故障隔离成功、没有自动执行、没有秘密读回。截图使用测试问题及测试数据，不能作为真实服务器兼容性证据。最后的自定义脱敏值数量边界修正已由 Rust 测试、Clippy 和最终 debug 构建验证，未重复整套原生截图验收。

## 真实兼容模型联调

通过用户提供的局域网地址读取 `/v1/models` 成功。`ai_live_probe` 使用临时应用目录、真实 OS 凭据、应用 ai_configure/ai_prepare/ai_send 调用链，只发送“真实接口联调，不含服务器数据”的问题。

- `gpt-5.6-sol` 返回有效非空分析、1 条命令建议，usage 为输入 319 / 输出 63 Token。无 SSH 目标，因此命令仅供审阅，未执行。
- `gpt-5.4-mini` 返回 HTTP 429，应用显示限流/额度错误且不自动重试。此结果不被计为模型调用成功。
- Key 从关闭回显的交互输入进入测试进程及临时 OS 凭据，不写源代码、配置或日志；测试完成已清除 OS 条目。一次包装器采用 Windows 默认 GBK 读取 UTF-8 输出失败，改用 UTF-8 后完成联调，没有将该失败计为成功。

## 未验证、风险与后续依赖

未连接用户服务器，未在真实服务器执行 AI 生成的诊断或变更；执行边界由本机真实协议集成测试验证。未验证 macOS/Linux 客户端、其他模型协议、全部兼容服务、Release/安装器或长期运行。保留既有 Monaco 大 chunk、增量缓存硬链接回退提示及发布安全风险，未宣称稳定版或全平台支持。

自动脱敏可能遗漏业务秘密，模型建议可能错误，HTTP 为明文，取消后仍可能计费，费用仅估算；界面与使用说明明确这些限制。下一阶段若需更多可执行命令，应逐项设计类型化目标/权限/审批和测试；其他协议、流式/持久对话及跨平台发布另行授权和验收。本阶段完成后停止。
