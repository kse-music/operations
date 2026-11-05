# ServerDeck 0.1.0-beta.1 质量报告

## 2026-11-05 完整移除网络诊断

系统服务只保留资源监控、进程与端口、systemd、日志四类；网络诊断界面、执行链、专属任务、IPC/ACL、SDK 权限/操作及兼容资源已删除。Host/Rust/Vue SDK 3.0.0、标准包 1.3.0；旧系统包保留状态升级，依赖已删除能力的上传包归档停用，用户数据不删除。前端最终 55 文件 373 项、Rust 工作区 210 项（4 既有 ignored）、独立 Guest 5 项、Windows 隔离原生五组通过，类型/ESLint/构建/格式检查完成；Clippy 保留既有 OpenSSH 单元素循环提示。证据和限制见[本阶段记录](plugins/PLUGIN_TEST_REPORT.md#2026-11-05完整移除网络诊断)。未重新验收完整远端图形流程、跨平台及安装器，默认 EXE 未替换。下文网络诊断能力和测试结果仅为历史记录。

## 2026-11-05 系统服务合并与界面优化

五项主机工具合并为系统服务，Docker/AI 独立优化，标准分发仅三包 1.2.0、Host/SDK 2.1。分类缓存和可见性统一，当前主机/草稿/原终端保留；旧 system 记录归档、上传源和数据不覆盖。前端 355 项、Rust 212 项（4 ignored）、独立 Guest 5 项通过；真实 SSH/三插件/四布局 14 组与隔离/上传/任务 11 组通过。类型、构建与静态检查完成，生成默认 Windows 调试程序。主要文件、截图、失败修复与限制见[本阶段记录](plugins/PLUGIN_TEST_REPORT.md#2026-11-05系统服务合并与界面优化)。跨平台、安装器和长期压力未验收；下文保留历史状态。

## 2026-11-05 移除自动运维与批量运维

已删除两个完整插件及其页面/菜单/搜索/调度/批量执行/SDK/IPC/权限和依赖。旧安装停用归档，历史数据保留；新备份 v3 仅保留主机/文件夹/偏好，旧备份明确跳过命令库。Host 与两套 SDK 为 2.0.0，保留七包为 1.1.3。前端 351 项、Rust 211 项（4 ignored）、独立 Guest 12 项、七插件真实 SSH 12 组与上传/隔离/任务/布局 11 组通过，类型/构建/静态检查完成。Windows 调试程序已生成；跨平台、Release/安装器和长期压力未验收，WSL df 警告与既有构建提示保留。主要文件、原生矩阵、失败修正及证据见[本阶段记录](plugins/PLUGIN_TEST_REPORT.md#2026-11-05移除自动运维与批量运维)。下文保留历史验收状态。

## 2026-11-04 配置入口与九插件逐项回归

修复运维工具侧栏误选主机、相同上下文造成请求循环、缓存 VM 耗尽八实例配额，以及快速切回时首次点击无效。侧栏直接打开配置，主机工具使用当前主机；系统包 1.1.2 保留配置升级。九个标准插件在 Windows WebView2 + 隔离 Linux SSH 真实逐项验收，13 组通过；原有隔离/上传权限/任务/布局回归 14 组、前端 361 项、相关 Rust 72 项（1 原有 Linux SDK ignored）及类型/构建/静态检查通过。已生成默认配置 Windows 调试程序，未替换正式应用或构建安装器；跨平台、长期压力与破坏性操作穷举未验收。构件矩阵、主要文件、失败修正及证据见[插件逐项验证](plugins/PLUGIN_TEST_REPORT.md#2026-11-04配置入口请求循环与九插件逐项验证)。

## 2026-11-04 插件使用统一

单主机插件归属当前主机工作区，去除重复目标选择；插件管理/详情单独放在设置，批量/自动化保留多目标。页面按主机保留并约束隐藏页和晚到结果，系统包 1.1.1 升级保留启停/配置/卸载记录。前端 357 项、相关 Rust 59 项（1 Linux SDK ignored）、Windows 隔离原生 14 组及构建/静态检查通过；真实远端/跨平台/安装器未验收。证据与限制见[插件验证记录](plugins/PLUGIN_TEST_REPORT.md#2026-11-04插件使用统一)。

## 2026-11-03 助手自动匹配与连接主机

前端全量 41 文件/284 项、相关 Rust 97 项和 Tauri IPC 2 项通过，覆盖名称/地址边界、同名歧义、追问、多主机真实 SSH 进程上下文、任一连接失效拒绝发送、模型版本校验、路由未知/重复 ID 与额外字段拒绝、路由取消和脱敏。前端验证命中失败不继续分析、首次指纹不自动信任、取消关闭新建待连会话、关闭失败提示、保留其他运维页面当前主机，以及异步 SSH 错误原因不丢失。ESLint、TypeScript/Vite、Rust fmt、相关 Clippy 和 Windows Tauri 内置前端构建通过；最终路由补充区分资产列表与 Docker 状态查询，并单独复验规则测试。

原生 Windows 使用真实 IPC/OS 凭据/本机 HTTP：一次语义路由、四次分析和四次模型测试请求通过，字面匹配无需路由模型，命中故障资产显示实际 SSH 错误，另一未命中测试资产未收到连接。20 张助手主题/尺寸/状态截图及原模型 CRUD、注册测试门禁、迁移、Markdown、历史和 API 故障隔离回归通过。未连接用户服务器或新增外部计费调用；Release/跨平台仍未验证。详细记录见 [VALIDATION_ASSISTANT_HOSTS.md](ai/VALIDATION_ASSISTANT_HOSTS.md)。

## 2026-11-03 助手直接对话与 Markdown

前端全量 41 文件/278 项、最终相关 10 项通过，覆盖直接发送、连续历史、草稿保持、停止/晚到结果拒绝、历史/消息限量、丢弃旧轮撤销、HTML/协议/图片限制及原命令单独确认。相关 Rust 91 项和 Tauri IPC 2 项通过，历史只允许成对 user/assistant、超限/越权角色拒绝、历史脱敏与原上下文/执行授权保持。ESLint、TypeScript/Vite、Rust fmt 与相关 Clippy（保留旧 openssh 单元素循环豁免）通过。Windows 原生一键请求、Enter 追问、模型切换清历史、Markdown、故障隔离及四组主题/尺寸通过。未对用户服务器执行命令，未新增外部真实计费调用；详见 [VALIDATION_ASSISTANT_CHAT.md](ai/VALIDATION_ASSISTANT_CHAT.md)。

## 2026-11-03 AI 助手布局优化

前端全量 41 文件/275 项通过，最终助手 7 项复验通过，包含指定日志/脱敏参数保持、连接门禁、发送批准、一次命令审核、系统变更独立输入、取消与晚到结果拒绝。ESLint、TypeScript/Vite 及 Windows Tauri 内置前端构建通过。原生验收覆盖空状态/预览/回答/错误各四组深浅与窗口尺寸，检查实际双栏/单栏关系及页面/内部无横向溢出；完整模型管理和请求路由回归保持。未修改后端，未重跑 Rust 单元测试或跨平台/安装包验证；本机 HTTP/OS 凭据测试不连接用户服务器或外部模型。见 [本次验证记录](ai/VALIDATION_ASSISTANT_LAYOUT.md)。

## 2026-11-03 注册前连接测试及界面优化

前端全量 41 文件/273 项、相关 Rust 89 项、真实 Tauri IPC 2 项通过；ESLint、TypeScript/Vite、Rust fmt 与相关 Clippy 通过（沿用 openssh 单元素循环基线豁免）。原生 Windows 验证未测试/测试失败/改配置不能保存、重试成功可保存、固定测试消息无上下文、独立 Key 路由和既有诊断授权隔离。模型列表、表单首屏/底部在 1440×900 与 900×600 深浅主题均有截图，已审阅列表、浅色表单和小窗口深色底部，无横向溢出。未新增外部真实计费调用、未连接用户服务器，Release/跨平台仍未验证。详见 [本次验证记录](ai/VALIDATION_MODEL_TEST.md)。

## 2026-11-03 模型管理追加验证

模型 CRUD、独立系统 Key、旧配置无损事务转换和助手按模型 ID 选择已实现。前端全量 271 项、最后相关 10 项、AI/Application/Core/Storage 86 项与 IPC 2 项通过；原生 Windows 真实 IPC/系统凭据/本机 HTTP 夹具验证两个模型使用各自 ID/Key、旧 Key 迁移可用、版本失效、删除确认和失败隔离。四组助手窗口主题/尺寸及模型列表截图已生成并审阅。未连接用户服务器、未新增真实外部计费调用、未验证跨平台或安装器；原发布边界不变。见 [模型管理验证记录](ai/VALIDATION_MODEL_MANAGEMENT.md)。

## 2026-11-03 AI 助手追加验证

本次实现真实模型调用、授权上下文/脱敏预览、逐条只读诊断及受控变更独立审批。前端全量 266 项、AI/Core/Storage/Application 82 项、Ops 8 项、Tauri IPC 2 项通过；Windows 原生四组主题/尺寸及服务失败后主机/文件接口可用已验证。真实兼容服务 gpt-5.6-sol 返回有效回答与 319/63 Token；gpt-5.4-mini 返回 429，未伪装成功或自动重试。未对用户服务器执行命令，未重建 Release 安装包或验证其他客户端平台；原发布风险保持，详细证据见 [AI 验证记录](ai/VALIDATION_AI_ASSISTANT.md)。

日期：2026-11-02；需求基线：PRD v1.0 + 本聊天后续 SSH 增强、SFTP、监控、运维、网络/批量、自动化及产品整合要求。审计对象为当前仓库，仓库没有 Git 元数据，不能提供提交 SHA 或完整历史 diff。本文不修改 PRD，不把代码存在等同于验收。

最终结论：Windows x64 未签名 **0.1.0-beta.1** 安装包已构建并完成真实安装/卸载保留数据。最后修订的功能 34、性能 8、自动化 10、传输中确认退出 3 套件分别通过；运维/监控/SFTP 21 项和 313 秒观察在仅 Network 分支不同的前一修订通过。Rust 常规 120 + 两个显式真实测试、前端 46、格式/Clippy/类型/静态/构建通过。普通模式 private 约 271 MiB、依赖风险和平台/签名门禁未关闭，不能发布为稳定版。

## 环境与证据口径

Windows x64 10.0.26300，Intel Core Ultra 7 265KF，20 逻辑核心，约 31.6 GiB RAM；Rust 1.97.1、Node 22.17.0。真实服务器为已获授权且已带外核对指纹的 Ubuntu 24.04/OpenSSH 9.6/Docker 29 环境。测试不用 root/sudo，不修改 sshd、Docker 权限或系统配置，不在源码/文档/日志存储认证密码。

正式 NSIS 安装到 `.local/release-install` 后，实际安装 EXE 与构建 EXE 做全字节比较，仅允许 Tauri 文档化的 bundle 标记 UNK→NSS（3 字节）差异，分别记录 SHA256；真实流程驱动该安装文件，无 IPC 替代。正式用户目录验收前为 schema 2、hosts=0、credentials=0；先备份，启动事务升级 schema 5。工具拒绝非空普通安装主机目录，创建有所有权的临时记录，结束恢复原偏好。旧 Debug 阶段证据只标为前轮；本轮独立主机 10 场景也使用隔离 Debug 嵌入资源构建，不等同于安装版。最后候选另有 Release 主机创建/编辑、备份副本、删除及 1000 条 SQLite 配置复验；不推广到其他平台。

主要证据目录：`.local/terminal-e2e/1793561199789-27db0429-cfa7-42f9-8a44-ee63f4bf597d`；启动证据：`.local/release-qa/startup`；构建/检查：`.local/release-*.log/json`。本地证据包含实际测试输出，请先检查再分享。

## 功能完成矩阵

状态限定于列出的范围；“已实现且通过测试”不意味着所有服务器/平台/边界均已验证。较大模块另列明确缺口。

| 功能 / PRD 对照                                                      | 状态             | 测试证据及实际范围                                                                                               | 剩余或限制                                                            |
| -------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 主机 CRUD/复制、分组、标签、收藏、搜索排序、校验、SQLite 持久化 / §6 | 已实现且通过测试 | Rust storage/application；前轮原生 CRUD/重启，本轮原生 10 场景、安装版 UI 新建/删除及 1000 条真实 SQLite 数据    | Windows；不是万台资产所有组合                                         |
| 凭据分离、更新/删除引用、无明文降级 / §8                             | 已实现且通过测试 | Rust 补偿/引用测试、显式 Windows 系统凭据库真实测试、原生创建/清理                                               | 其他平台凭据库未原生验收                                              |
| SSH 信任、密码、私钥/加密私钥、超时、Keepalive、断线/重连 / §7–8     | 已实现且通过测试 | loopback 真实协议与生成密钥；已授权 Linux Release Engine + 安装版 Shell、vim/top/htop/less；变化密钥在认证前阻断 | 本地 RSA 签名禁用；非 Ubuntu 兼容矩阵未完成                           |
| SSH Agent                                                            | 部分实现         | 隔离真实 Agent 协议列身份/签名并完成 SSH 认证；系统入口和不可用错误已接入                                        | 用户实际系统 Agent 已加载身份/硬件令牌未实测                          |
| 多终端、独立 ID/Transport/Channel / §7.2                             | 已实现且通过测试 | 新增 20 Channel 隔离/释放；安装版 20 xterm/PTY、3 Transport、独立输出、关 19 留 1                                | 同一服务器 3 主机配置，不是 20 台物理服务器；遵守服务器 MaxSessions   |
| 分屏、拖动、标签排序/改名/关闭、搜索、粘贴/终端导出 / §7             | 已实现且通过测试 | 本轮高级原生断言、远端 stty 实际列数、Bracketed Paste 与有界滚动历史                                             | 物理混合 DPI、平台快捷键、输入法/剪贴板完整矩阵未完成                 |
| ProxyJump                                                            | 已实现且通过测试 | 本轮真实 Linux 经受管跳板到回环目标，每跳独立校验                                                                | 无 ProxyCommand；系统 ssh_config 的任意复杂语义不执行                 |
| SOCKS5 / HTTP CONNECT 代理                                           | 已实现且通过测试 | 实际回环代理转发到授权 OpenSSH + 单元协议/错误/认证边界                                                          | HTTP CONNECT 无代理 TLS；不是所有企业代理                             |
| Local/Remote/Dynamic 端口转发                                        | 已实现且通过测试 | Rust 协议、回环 echo、真实 Linux Remote 128 KiB、停止释放监听、公共绑定确认                                      | Remote 绑定受服务端策略约束；无自动恢复                               |
| SFTP 核心/双栏导航、属性、创建/重命名/安全删除 / §9.2/9.6            | 已实现且通过测试 | 真实 SFTP、中文/特殊字符、权限与递归边界；本轮 5000 条目录                                                       | 单目录上限 20000；不跟随链接递归                                      |
| SFTP 双栏宽度调整、仅远程模式 / §9.1                                 | 未实现           | 检查当前固定双栏 grid，未把布局存在认作该能力完成                                                                | 明确 UI 缺口；本轮不伪装达成完整 §9.1                                 |
| 多文件/目录传输、并发/进度/冲突/取消/重试 / §9.3–4                   | 已实现且通过测试 | 本轮 5×8 MiB，峰值 3，40 MiB 双向 SHA256 一致；既有取消/网络/冲突回归                                            | 从头重试，不支持跨重启恢复/断点续传；吞吐含安全回读                   |
| 远程 Monaco 编辑 / §9.5                                              | 已实现且通过测试 | 真实 UTF-8 保存、外部变化、权限失败、未保存退出确认；Rust 安全替换回归                                           | 2 MiB/8 文档；需要 posix-rename，ACL/xattr/hardlink 与原子 CAS 不保证 |
| 资源监控 / §10                                                       | 已实现且通过测试 | /proc 差值/首次/重置单测；前轮 top/free/df 交叉验证；原生暂停/恢复/单采样器                                      | 5 分钟观察不代表 24 小时稳定；其他发行版/异常内核未覆盖               |
| Docker 容器/镜像/详情/环境遮蔽/资源/Shell                            | 已实现且通过测试 | 已授权非 root 账号、UUID 隔离容器/镜像，前轮与本轮运维验收                                                       | 不启用明文 API、不自动 sudo；只删除自有夹具                           |
| Docker / 通用文件日志                                                | 已实现且通过测试 | ACK/有界缓存/暂停关闭测试，真实容器和文件日志复制/导出                                                           | 无自动读取全部日志；导出可见范围可能含敏感内容                        |
| 进程与信号                                                           | 已实现且通过测试 | ps /proc、真实自有 sleep 的 pidfd 身份校验与 TERM/KILL 确认；进程已消失错误                                      | 非 pidfd 环境不承诺同等级防 PID 复用；不猜权限不足数据                |
| 监听端口与连通性                                                     | 已实现且通过测试 | TCP/UDP 自有监听、ss、进程关联与实际 TCP 检测                                                                    | 无权限进程显示未知                                                    |
| systemd 服务                                                         | 已实现且通过测试 | 自有用户级 unit 的启停/重启/自启/日志；不自动提权                                                                | 非 systemd 只提示不支持；未触碰重要系统服务                           |
| 网络诊断                                                             | 部分实现         | 本机/远端 DNS/TCP/Ping/Traceroute、接口/连接、独立取消、来源/导出                                                | MTR 缺工具时仅验证失败提示，未实测真实 MTR；ICMP 不等同宕机           |
| 批量命令与单文件分发                                                 | 已实现且通过测试 | 两个独立 SSH 容器、部分失败、超时/取消/归属、有限并发和手动重试                                                  | 不是跨地区物理网络；超时远端状态 Unknown                              |
| 命令/脚本库、参数、历史、本地计划 / §11 + 后续                       | 已实现且通过测试 | 两容器真实执行、秘密禁输出/不落库、Cron 真实分钟、重启历史/补偿、审批                                            | 依赖远端 python3/POSIX sh、应用运行和已认证连接；固定 UTC 偏移无 DST  |
| 命令直接发送到当前交互终端 / §11.3                                   | 未实现           | 当前库走独立受管执行，可复制正文                                                                                 | 当前主机上下文执行已实现，不能等同于交互 Shell 输入                   |
| 设置、主题/字体/快捷键、默认连接/代理、窗口/侧栏 / §12               | 已实现且通过测试 | 配置/前端回归及前轮原生真实生效、窗口尺寸/DPR、重启恢复                                                          | 仅完整中文；日志级别重启生效；物理多屏未验收                          |
| OpenSSH Config 预览与导入 / §6.6                                     | 已实现且通过测试 | 保守解析、重复识别、选择导入、不支持选项提示与阻止                                                               | 不覆盖原文件；Include/Match/ProxyCommand/复杂转发语义受限             |
| 公开配置备份/预览/恢复 / §13                                         | 部分实现         | 版本/校验/事务/跳板依赖测试；前轮原生 skip/copy、不覆盖                                                          | 认证代理主机恢复阻止并需手动配置；秘密/信任/计划不在备份范围          |
| 统一主机工作区与跨模块联动                                           | 已实现且通过测试 | 前轮 40 项完整产品原生 + 21 项针对性复测；本轮安装版串联                                                         | 历史证据与本轮记录分别计，不合并重复步数                              |
| 空闲整进程树内存目标 / §14                                           | 存在缺陷         | 30 秒空闲约 297 MiB private / 478 MiB RSS，超过约 150 MB 目标                                                    | 未做掩盖式工作集修剪；需要进一步剖析                                  |
| Windows 安装、默认初始化、迁移、卸载保留数据                         | 已实现且通过测试 | 构建/安装/启动/2→5 迁移已实测；最终卸载复验见下方执行记录                                                        | 未签名 beta；签名、离线缺 WebView、系统重启升级需补验                 |
| macOS arm64/x64、Linux x64 发布                                      | 部分实现         | 仅有 CI 与平台 bundle 配置                                                                                       | 没有实际构建、安装包、签名/公证或运行结果                             |

## 检查执行记录

- Rust：`.local/release-tests.log`，常规测试 120 passed / 0 failed / 2 ignored；显式真实 Windows keyring 1 passed，Release Engine live 1 passed。Unix 新增权限分支/两项测试未在 Windows 执行，等待 CI。
- Rust fmt / Clippy `--workspace --all-targets --locked -- -D warnings`：最终日志 `release-fmt.log`、`release-clippy.log`；不得沿用第一次 Clippy 模块顺序失败作为通过，已修正后重跑。
- 前端：46 passed / 16 files，类型/ESLint/生产构建通过；全依赖 npm 审计修复后 0。全仓 Prettier 检查通过（`release-format.log`）；最终修改后再次检查。
- RustSec：官方数据库提交 `2295466c4e9df26647fd67d8fa1c705ac2fc7f81`（2026-10-30），同步结果 up to date；1 个 rsa 漏洞、4 个维护告警、1 个 GLib unsound，命令退出 1。没有豁免为通过。
- 安装版原生：最后独立成功日志为 `release-functional-final.log`（34）、`release-performance-final.log`（8）、`release-automation-final.log`（10）、`release-transfer-exit-final.log`（3）；独立运维日志 `release-ops-verified.log`（21）对应前一 Network 修订。早期 `release-native*.log`、`release-validated-modules.log` 等组合失败完整保留，不能将其整体标为成功或重复累加 PASS 行。
- 主机原生回归：`release-host-native.log`，10 场景通过，证据 `.local/native-e2e/1793562247972-16d6b9cb-4c3c-42a4-a1ca-a36294da632d`。

## 真实性能基线

所有基准在优化前记录；本轮没有以单次测量实施高风险流水线/缓存改写，也没有宣称满足全部性能目标。

| 项目                        | 实测                                          | 口径 / 次数                                                                                       |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 启动至后端就绪 UI           | 761 / 485 / 461 / 455 / 451 ms                | 安装版，5 次；首次新 WebView profile，后四次 OS/profile 热缓存，不是清空 OS 缓存的五次冷启        |
| 正常退出                    | 12–204 ms                                     | 上述 5 次空闲启动；不代表进行中传输退出时延                                                       |
| 空闲内存                    | private 296.8 MiB / RSS 478.4 MiB             | 30 秒；7 个本应用/WebView 子进程，RSS 包含共享页，不当作唯一物理占用                              |
| 新 SSH Transport 到认证/PTY | 178.50 / 173.26 / 174.34 / 190.75 / 177.33 ms | 生产 Engine，Release，显式指纹确认预热后，5 次每次 registry 归零；不含用户核对时间                |
| 输入至真实屏幕回显          | median 35.1 / p95 102.0 ms                    | 12 次，含 Playwright/IPC、网络和 xterm 渲染                                                       |
| 高频终端输出                | 8 MiB / 3.30 s（2.42 MiB/s）                  | 真实 xterm ACK 路径一次；不推断 WAN 吞吐                                                          |
| 附加 Shell                  | median 33.3 / p95 218.3 ms                    | 19 次，混合复用与新 Transport，不能称为 19 次完整握手                                             |
| 20 个终端                   | private 496.9 MiB / RSS 674.0 MiB             | 3 个 Transport、20 个真实 xterm/PTY；关闭后仍有 V8/分配器保留内存，不据此判定泄漏或已释放全部 RSS |
| 大目录列表                  | median 742.3 / p95 798.9 ms                   | 5000 条，5 次，SFTP + IPC                                                                         |
| 5 文件并发上传              | 40 MiB / 23.17 s（1.73 MiB/s）                | 活动峰值 3，包含 SHA256 回读/提交                                                                 |
| 多文件下载                  | 40 MiB / 29.70 s（1.35 MiB/s）                | 5 文件同任务，包含本地落盘和双向 SHA256 核实                                                      |
| 主机列表首屏                | 97.8 ms                                       | 1000 条真实 SQLite 配置，首屏 100 DOM 行；一次，非全部 1000 行 DOM 渲染                           |
| 重复输出 renderer heap      | 7.53 → 7.86 MiB                               | 高级测试累计 8 MiB、scrollback=1024，CDP heap；不代表整个应用内存                                 |

首次原始数据保留为 `performance-baseline-initial.json`；最终候选复测为 `performance-baseline.json`、`memory.json`、`startup-baseline.json`、`release-live-bench.log`。监控/Docker 同时运行资源曲线以 `monitor-docker-soak.json` 为准，观察时间有限；没有 24 小时、100 GiB、多 WAN 或物理混合 DPI 结论。

## 失败、修复与未验证边界

确认并修复 **Network 主机选择导致来源重置** 的真实产品缺陷：App 以主机 ID 重建 NetworkView，选择远端主机后重置为本机，连接入口消失。移除该不必要的 key，并 watch 外部主机上下文更新端点，用户在表单内的来源/工具/目标保持；返回本机工作区时清除远端来源和端点，防止旧上下文残留；新增前端回归和安装后远端诊断流程验证。不是修改测试绕过该问题。

本轮第一次 Clippy 因测试模块之后出现 helper 报错，移动 helper 后重跑；一次 fmt 在并行编辑间读到多余空行，最终重新检查。没有删除断言或放宽 lint。

原生组合第一次因新增侧栏使旧 `.getByRole('separator').first()` 选错对象，改为有名称的终端分屏分隔条；下一次旧全局 tab 查询把主机工作区标签计入，限定终端 tablist 后实际 stty/拖拽/排序断言通过。高级测试留下重命名/idle 布局，现组合驱动在阶段间关闭自有标签并建立正常配置的新 Shell。

进一步重跑遇到上次失败留下的固定临时密钥名，以及安装版数据库路径仍按隔离构建目录读取；已改为每轮唯一密钥名和 app_bootstrap 实际数据路径。测试清理改为幂等，并单独按 UUID/标签恢复自有容器；`release-recovery.log` 和 `automation-cleanup.json` 记录，不触碰其他 Docker 资源。普通安装验收不再有清空全部主机的路径，退出走实际应用 shutdown，超时明确判失败。

监控/Docker 并发工具第一次错误地依赖切页后仍存在的日志 DOM；实际产品按设计关闭日志面板并暂停隐藏采样。改为保持日志 UI 并由测试持有显式监控订阅，结束 stop 释放；普通切页暂停仍另行验证。夹具准备/清理改用真实有界 SSH 批量执行 API 的独立 stdout、压缩后的明确测试脚本，不再从终端可见滚动内容解析夹具结果；没有向产品增加通用本地执行接口。重复清理仍验证 Docker 不存在/标签、PID 身份及 unit，不能忽略权限错误。

NSIS 安装版与 standalone EXE 初次严格 Hash 相等校验失败；检查本地 tauri-utils 源码确认仅 bundle 标记 UNK→NSS 的三字节差异。校验工具对整份字节只允许该唯一替换，分别记录真实 Hash，未忽略任意二进制差异。`install-uninstall.json` 记录实际卸载退出 0、数据库原字节保留、安装退出 0、NotSigned 和随包许可证资源。

当前未完成：其他客户端平台/发行版、实际系统 Agent 身份、完整原生拖放/输入法/离线安装、多物理屏幕和睡眠、连续 24 小时/数百次重连/持续高吞吐、大于本轮规模的目录/文件、完整许可证复核。源码审计和短期有界测试不能替代这些验收。

## 本轮补充验收结果

- 前一候选产品整合 `release-product-final.log`：11 项通过，真实命令执行/结果导出、备份 skip/copy、不含秘密、下载目录实际传输、主题/窗口/退出恢复。`run-1793564029080.json` 记录安装 EXE Hash，`product-cleanup.json` cleaned=true。
- 前一 Network 修订候选运维/监控/SFTP `release-ops-verified.log`：21 项通过，含五分钟并发观察；`run-1793563496311.json` 为整套成功，而非从失败运行的 PASS 行拼接。
- 五分钟真实 Monitor + Docker 日志持续 312.881 秒、31 个观察点；同一采样器 history 1→104、日志 435→53926 字符；private 范围 297.4–374.0 MiB，开始 374.0 后回落至约 298，末 310.9；RSS 491.8–513.5 MiB，句柄 3703–3752。进程树 CPU 累计增加 20.94 秒，约占一个逻辑核 6.7%（20 核机器总容量约 0.33%）。该数包含日志 UI/IPC/监控，不是单独采样器 CPU 的剖析结果。只验证本次 5 分钟，未验证 24 小时或日志达到最大缓存后的长期稳态。
- 修复后包五次启动复测：547 / 477 / 479 / 471 / 469 ms；空闲 private 292.2 MiB、RSS 434.5 MiB，Rust 主进程 private 6.2 MiB，仍不能忽略 WebView 宣称达到 150 MB。视口 1666×1103、DPR 1.5；与首次基线窗口/缓存不同，没有宣称这是优化收益。每次正常退出后全部自有原生/WebView 子进程消失，证据 `startup-final/startup-baseline.json`。
- `database-final.json`：schema=5，integrity_check=ok，外键违例 0，hosts/credentials/secret_gc/自动化库/分组/计划/历史均为 0；保留正式数据目录与已验证信任，未恢复旧 schema 或清空用户数据。

## 发布结论

保持测试版。即使 Windows 构建、安装和真实流程成功，空闲内存目标、未清除依赖风险、签名、平台兼容及上述功能缺口仍未满足稳定版标准。安装包/校验值以 `.local/release-qa/release-manifest.json`、`SHA256SUMS` 为准；不自动公开发布。

## 主要修改文件

- `apps/desktop/src/App.vue`、`views/NetworkView.vue`、`views/tasks.test.ts`：修复来源重置与上下文同步回归。
- `crates/application/src/lib.rs`、`crates/storage/src/lib.rs`：应用专属 Unix 目录/SQLite 权限及 cfg(unix) 回归。
- `crates/ssh/tests/engine.rs`、`tests/live.rs`：20 Channel 资源/归属和新建 Transport Release 基准。
- `package.json`、`package-lock.json`、`apps/desktop/package.json`、`Cargo.toml`、`Cargo.lock`、`tauri.conf.json`、`icons/*`：beta 版本、漏洞修复、安装元数据、图标和资源。
- `tools/native-terminal-e2e.mjs`、`native-terminal-advanced.mjs`、`native-automation-e2e.mjs`、`native-network-batch-e2e.mjs`、`native-ops-e2e.mjs`、`ops-fixture.py`：安装版上下文、真实验收和幂等自有夹具清理；新增 `native-release-qa.mjs`、`release-startup-bench.mjs`、`release-manifest.mjs`、`native-transfer-exit.mjs`。
- `.github/workflows/release.yml`、`tauri.macos.conf.json`、`tauri.linux.conf.json`：未执行的平台候选构建。
- `README.md`、`CHANGELOG.md`、`LICENSE`、`docs/architecture/ARCHITECTURE.md`、[IMPLEMENTATION_PLAN.md](../product/IMPLEMENTATION_PLAN.md)、[DECISIONS.md](../architecture/DECISIONS.md)、[USER_GUIDE.md](../guides/USER_GUIDE.md)、[SECURITY.md](../release/SECURITY.md)、[TEST_REPORT.md](TEST_REPORT.md)、[RELEASE_CHECKLIST.md](../release/RELEASE_CHECKLIST.md)、[DEPENDENCY_INVENTORY.md](../release/DEPENDENCY_INVENTORY.md)、`THIRD_PARTY_NOTICES.txt`：交付文档及许可信息。

## 最后候选修订的独立结果

最后候选安装 EXE SHA256 为 `5f5ac7d7eaeb643e7f70626b0c8a3d7719a579999454de27a54210ed05afa115`。它补齐返回本机上下文时清除远端来源/目标的安全边界，前端仍为 46 项通过；原生 Network 流程也实际检查该回切。未将旧修订的 Hash 当作此二进制的 Hash。

- `release-functional-final.log`：34 项通过（高级终端 + Network/批量 + 产品整合，包含两项基础连接检查），整套完成且清理成功。
- `release-performance-final.log`：8 项通过（含两项基础连接），对同一安装 EXE 重复 20 终端、5000 条目录、40 MiB 双向校验和 1000 主机首屏；每轮独立本地传输目录，避免重跑 EEXIST。
- 当前修订与前一次候选只改变 Network 上下文分支；运维/监控/SFTP 21 项在前一次候选运行，原始 Hash 和观察时长独立保留，不声称所有旧证据来自最后二进制。

复测与首次基线没有做可比优化实验，窗口尺寸/缓存/测试顺序不同：输入回显 median 82.9 / p95 87.3 ms，8 MiB 渲染 3.80 s，附加 Shell median 33.4 / p95 200.8 ms；5000 条列表 median 699.4 / p95 740.7 ms；40 MiB 上传 22.46 s（峰值 3）、下载 29.62 s；1000 主机首屏 113.3 ms / 100 行。所有数据如实保留，不只选择较好数值。尚未剖析的吞吐/内存不以主观感觉宣称优化或达标。

组合验收还修复两项工具问题：旧终端导出设置全局 CDP 下载目录，影响后续 download.saveAs，改为独立实际下载事件/保存且保留内容断言；基准下载目录改为每轮 UUID，旧结果保留。失败原始日志仍在，不删除有效断言。

最后候选补充：`release-automation-final.log` 独立套件 **10 项通过**（2 项基础连接 + 8 项自动化），包含真实 Cron 分钟与跨分钟重启，无时钟替代；`release-transfer-exit.log` **3 项通过**，256 MiB 预定上传实际发送 128 KiB 后，在真实退出对话框点击“取消任务并退出”，正常关闭/重启共 548 ms；重启连接数 0，远端目标及暂存项均 0，原始 `transfer-exit-result.json`。这不是宣称已传完 256 MiB。

`startup-candidate/startup-baseline.json` 对最终 EXE 再测：启动 538 / 569 / 470 / 521 / 483 ms，五次正常退出均等到自有原生/WebView 子进程消失。额外关闭 CDP/额外浏览器参数、使用普通用户 WebView 配置运行 30 秒：private **270.7 MiB**、RSS **432.7 MiB**、Rust 主进程 private **6.4 MiB**，仍未证明达到约 150 MB。普通模式采样后只终止自有无业务测试进程，不计作正常退出验收。没有把测试诊断开销或单个 Rust 进程当作全应用口径。

最终成功套件分别为：主机原生 10、功能 34、性能 8、自动化 10、真实传输退出 3，以及前一 Network 修订包的运维/监控/SFTP 21；套件有重复基础步骤，不相加声称独立用例数。失败的 `run-*.json` 仍标 validationSucceeded=false；成功的各套记录为 true，并记录对应 EXE Hash，所有原始失败日志保留。

退出状态再核验：`release-exit-code.log` 五次启动/正常退出成功，强制要求 child.exitCode=0 且 signalCode=null，并等待自有 WebView 子进程退出；不是只凭进程消失认定正常退出。该套用于额外的退出码断言，不与原启动次数相加宣称独立冷启动数。

最终清理：`final-uninstall.json` 确认仅卸载项目 QA 路径的安装，退出 0、用户数据库原字节保留；安装包/standalone EXE 保留。`native-shutdown.json` 最后一次为 exitCode=0、signal=null、graceful=true。最终 manifest 与文件 SHA256/大小复核一致，完整性/外键/测试记录归零再次通过。未将数据目录恢复到旧 schema，也未删用户信任。
