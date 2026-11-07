# AI 运维助手验证记录

## 2026-11-07 本地工具下载安装

助手包 1.9.0。完成标准：缺失与未授权/未登录分开显示；设置页和已绑定本地来源的聊天页均提供安装提示；点击下载后可取消、失败可重试；完整校验后才发布运行时；重新检测保留当前草稿；安装不自动授权或覆盖用户安装。Windows 内置下载使用应用数据目录，其他平台显示手动安装命令。

- 相关 Vitest 3 文件 64 项通过，覆盖两种来源的缺失提示、下载中禁止保存、成功后检测、未自动授权、网络错误重试、取消、手动安装重检、未保存选择保留、聊天提示，以及第三方/上传同 ID 插件禁止安装和关闭页面取消自己的请求。TypeScript、ESLint、相关源文件 Prettier 与 diff whitespace 通过。
- Core 18、AI 35、Application 80、桌面 IPC 6，共 139 项默认测试通过，5 项按既有规则默认忽略。原生测试通过 Cargo --no-run 构建后复制到 QA 运行。Rust fmt 和 AI/Application all-targets 严格 Clippy 通过。下载测试覆盖固定 HTTPS 域名、路径与元数据验证、已有安装优先、缺失文件可重装、拒绝覆盖、文件大小/散列错误、提前取消、关闭取消及取消记录有界；登录命令覆盖单引号与 UNC 引用。
- 实机 Windows x64：在子进程中屏蔽 CLI PATH，常用原生目录也确认没有两种 CLI；使用独立应用数据目录。界面从“未安装”开始，先验证取消没有发布运行时或残留下载目录，再从官方源下载 Codex 0.167.0（369062704 字节）及 Claude Code 2.1.319（344807072 字节），完整 SHA-256 校验、--version 启动检查、安装后状态和独立宿主授权均通过。未依赖 Node/npm 执行下载的 CLI，未修改系统 PATH 或已有安装。
- 下载后的两个原生二进制分别复用已有配置和登录，完成固定普通问题 OK 对话，无用户服务器连接。停止隔离程序后将其自身 Codex 运行时暂存到同一 QA 目录，重启保留来源但真实缺失，聊天区显示安装提示；恢复文件后点击重新检测，提示消失。所有目录移动先校验绝对路径、所有权与非链接，未操作用户运行时。
- 另外以空的隔离 CODEX_HOME 验证未登录提示包含应用内 codex.exe 的完整 PowerShell 登录命令，无需全局 PATH；撤销授权成功。最终 QA 构建再次通过该验证。下载完成仍未自动授予本地访问权，原注册模型和系统 CLI 优先级保持。
- 前端生产、助手 WASM、Windows Tauri debug 无安装包构建通过。默认交付为 target/debug/serverdeck-desktop.exe；复用根 target，构建入口磁盘余量检查通过（首次约 251 GiB）。用户按 AGENTS 要求退出占用构建输出的正式程序后才重建，仅关闭本任务 QA 副本。无新增依赖、数据库迁移、凭据复制或生产环境写入。

本机访问 GitHub 网页发行下载入口超时，改用已验证可达的官方发行资产 API，仍按官方元数据散列验证。首次 QA 试图用空 USERPROFILE 模拟缺失导致 WebView2 不启动；修正为保留系统用户目录、仅屏蔽 CLI PATH 后全流程通过。Clippy 初次指出条件、测试模块位置与测试读取量检查问题，修正后严格检查通过。沙箱单独运行已下载 Codex 的 --version 会提示其自身临时目录访问受限，正常权限原生验收已成功，无安装假成功。

证据：`.local/qa/local-tool-install/native-result.json`、`login-hint-result.json`、`missing-codex.png`、`chat-missing-codex.png`、`codex-installed.png`、`claude-installed.png`、`installed-small.png`、`managed-login-hint.png` 与 `deliver-build.log`。已审阅缺失提示的设置页与聊天页截图。

范围限制：Windows ARM64 仅实现架构选择，尚未实机验收；macOS/Linux 为手动安装引导，未验收本轮界面。未构建安装包或测试真实生产主机变更。下载仍取决于官方源与用户网络，失败保留重试；供应商后续版本的协议兼容性需继续验收。当前无新增阻断风险；后续发布依赖安装包、ARM64/其他平台及目标发行场景的供应商认证条件确认。

## 2026-11-07 本地 Claude Code

完成标准：三种来源可选；本地 Claude Code 经宿主授权后复用已有配置和登录；取消授权不写入；保存/重启保留；撤销停止对应来源，原 Codex 与注册模型不受影响；沿用原 SSH 审批流程。助手包 1.8.0。

- 相关 Vitest 3 文件 64 项通过，包含两种本地来源的绑定/重挂载/未授权阻止/撤销、原注册模型、上传同 ID 插件拒绝和宿主取消/确认。TypeScript、ESLint、相关 TS/Vue/JS 的 Prettier 检查通过。
- Core 18、AI 31、Application 79、Storage AI 6、桌面 IPC 6 项默认测试共 140 项通过。默认忽略 5 项；本轮另显式执行两种来源的适配与应用层真实联调 4 项，均成功。Rust fmt、AI/Application/Storage all-targets 严格 Clippy 通过。所有原生测试从根 target 构建后复制至 QA 运行。
- 进程夹具验证正常成功、用量与缓存 token、未登录、工具/MCP 泄漏、tool_use、权限拒绝、重复/缺失 result、缺失 init、无效 JSON、崩溃、输出超限及取消后进程结束。配置/账户变化使快照失效，凭据文件刷新不复制 token 或改变账户身份。
- Windows Claude Code 2.1.270 实际使用本机既有配置与登录完成固定 OK 请求；应用层完成授权、状态、prepare/send、无注册模型回答、撤销后拒绝。Codex 0.167.0-alpha.3.2 也在本轮应用层与原生切换中实测成功。无生产服务器连接。
- 真实 WebView2 + iframe/WASM + Rust + SQLite：先授权 Codex，取消 Claude 授权后确认仍未授权，再明确授权 Claude、保存并回答；重启保留所选来源和授权，撤销 Claude 后 Codex 授权仍有效，切回 Codex 保存后继续回答。使用独立应用数据目录和 QA EXE，结果与截图在 `.local/qa/local-claude-code/native-result.json`、`native-consent.png`、`native-settings.png`、`native-settings-small.png`、`native-answer.png`。检查 1280×820 与 900×600 逻辑窗口，没有选项与状态重叠。
- 前端生产构建、助手 WASM 和 Windows Tauri debug 无安装包构建通过。默认输出 `target/debug/serverdeck-desktop.exe`，构建前 D 盘余量超过 251 GiB，复用根 target，无新增 Cargo 缓存。

最初沙箱内 Claude 推理超时，正常用户权限下 5.6 秒完成；loopback 网络测试在沙箱受限后改用正常本机权限运行隔离 QA 副本通过。未关闭正式应用或修改正式应用授权。

尚未验收其他 Claude Code 版本、macOS/Linux、安装包或真实生产主机运维变更。未知/不兼容 CLI 参数或协议按错误处理；发布仍需确认两家供应商对目标发行场景的认证适用条件。

## 2026-11-07 本地 Codex

已实现内置助手选择本地 Codex、可信宿主授权、复用用户级配置和登录、授权持久化及撤销；原注册模型绑定和 HTTP Provider 继续可用。助手包 1.7.0，来源通过 `local-codex` 保留 ID 进入原主机匹配、上下文脱敏、受控查询、冻结计划和 SSH 执行链路。

- 相关前端 3 个测试文件共 60 项通过，覆盖授权拒绝/确认、绑定持久化、撤销、未就绪禁止发送、原注册模型及上传同 ID 插件拒绝；样式修正后助手 33 项再次通过。TypeScript、ESLint、相关文件 Prettier、Rust fmt 和 AI/Application/Storage all-targets 严格 Clippy 通过。
- Core、Storage、AI、Application 和桌面 IPC 共 162 项默认测试通过；3 项默认忽略，其中本地 Codex 的两个真实账号测试已显式执行通过，已有的 Linux SDK roundtrip 忽略测试未在 Windows 运行。通过 Cargo `--no-run` 构建后，将 EXE 复制到 `.local/qa/local-codex` 再运行，复用根 `target/`。
- Windows 原生 Codex `0.167.0-alpha.3.2` 实际使用本机已有配置和登录，完成固定 OK 请求；独立临时应用数据库完成授权 → 状态 → prepare/send → 回答 → 撤销 → 再次拒绝，注册模型表保持为空。请求不连接用户服务器。
- 真实 WebView2、iframe/WASM、Rust、SQLite 与本机 Codex 完成取消授权、明确授权、保存来源、固定普通问题回答、重启保留和撤销。结果见 `.local/qa/local-codex/native-result.json`，授权、设置和回答截图在同目录。使用隔离应用目录与 QA EXE，没有修改正式应用绑定或授权。
- RPC 子进程夹具覆盖未登录、工具审批请求、仍启用 MCP、响应超限、失败回合、回答后提前退出，以及停止后子进程终止。额外回归确认丢弃主机匹配 future 会清理活动状态和模型并发槽。配置/账户变化使摘要失效，ChatGPT token 刷新保持账户身份。
- 前端生产构建、助手 WASM 包和 Windows Tauri debug 无安装包构建通过，默认桌面输出为 `target/debug/serverdeck-desktop.exe`。构建前磁盘空闲超过 250 GiB，未启用增量编译或新增 Cargo 缓存。

初次原生回归的 loopback HTTP/SSH 被沙箱限制，失败后停止本任务 QA 测试进程，以正常本机权限复验通过。Codex 初次启动也被沙箱拒绝写入自身状态库，真实联调在正常用户权限下完成。CLI 的 MCP 配置覆盖方式经实测修正为逐项禁用，并在推理前核对线程状态。一次直接覆盖已有插件包被打包器 EEXIST 保护拒绝，随后使用正常生产构建的暂存/原子替换入口成功。原生 QA 窗口配置漏掉 `create:false` 导致重复建窗空白页，修正隔离验收配置后全流程通过。截图复查发现模型列表与新增状态重叠，已修正 fieldset 高度与状态分组，并补做宽窄窗口检查。

尚未验证 macOS/Linux、其他 CLI 版本、真实生产服务器上的 Codex 运维变更或安装包；本轮真实模型仅发送固定测试文本。MCP 名称中的特殊字符无法安全覆盖时停止。供应商对商业发行使用订阅认证的适用条件需在发布前确认，应用本地授权不代表供应商对发行场景的许可。

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
