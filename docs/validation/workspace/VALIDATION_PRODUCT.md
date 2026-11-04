# 产品整合与交互验收

## 2026-11-04：任务中心恢复底部弹窗

按本轮要求替代 2026-11-03 的任务工作区入口：运维工具只显示插件，底部状态栏提供单个“任务中心”。原 tasks 快捷键保留用户配置，全局搜索独立打开同一弹窗，不创建标签或切换当前模块、页面与终端。关闭按钮与 Esc 关闭弹窗并恢复底部按钮焦点；停止确认继续绑定具体任务/计划，查看结果和传输重试关闭弹窗后进入原工具。

主要修改：App.vue、AppNavigation.vue、GlobalSearch.vue、types/{product,navigation}.ts、TaskCenterView.vue 及状态栏样式；更新 App/导航回归、共享 UI 导航、原生/浏览器原有任务入口断言，新增 tools/ui-task-center-e2e.mjs。同轮同步 PRD、架构、决策、使用指南及插件入口文档。原 store、业务服务、Rust、IPC、数据库与权限保持原有契约，不新增依赖。

| 检查            | 实际结果                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改前复现      | 新增两项 App 回归先失败：任务中心仍在运维工具菜单，快捷键创建 tasks 页面；随后完成实现                                                                                                                        |
| `npm test`      | 49 文件、319 项通过；覆盖底部入口、单实例、关闭/Esc、焦点恢复、自定义快捷键、搜索、无标签及页面/终端隔离、结果跳转；原 task-center 测试继续验证读取/空/失败状态、取消与原 HostId、停止/暂停精确确认及失败重试 |
| `npm run build` | 九个标准插件构建、vue-tsc 与 Vite 生产构建通过；保留既有 Monaco 大 chunk 提示                                                                                                                                 |
| `npm run lint`  | ESLint 通过                                                                                                                                                                                                   |
| 无头 Edge       | 1440×900 深/浅、900×600 深、390×844 浅四组通过；验证真实原生 dialog、嵌套停止确认的 Esc 层级、关闭后焦点恢复、页面/终端状态及无根页面/弹窗横向溢出，未捕获 pageerror                                          |

本轮修改文件的 Prettier 检查、四份修改/新增 UI 脚本的 `node --check` 及 `git diff --check` 通过。

浏览器命令为设置 SERVERDECK_BROWSER、SERVERDECK_TASK_CENTER_URL 后执行 `node tools/ui-task-center-e2e.mjs`。本轮结果与截图位于 `.local/task-center-footer/browser`，已查看桌面深色及窄屏浅色截图。夹具只在独立浏览器内存中提供状态和只读 API，不写正式配置、不连接服务器，不能替代真实传输/远端命令验收。

初次 Vitest 受沙箱临时缓存重命名权限限制，改用项目 `.local/task-center-footer/tmp` 后通过；初次沙箱内 Edge 启动失败，改用获批沙箱外的同环境回环服务与独立无头浏览器后通过。浏览器首次发现关闭弹窗未恢复焦点，已修复并通过相同断言。测试服务与浏览器均已退出。

未重跑原生 Tauri UI、真实 SSH/SFTP/网络批量/自动化全链路及 macOS/Linux；相关原有脚本只同步入口并完成语法检查。未生成或替换安装包。本轮无新增已知风险，无新增下一阶段依赖，当前阶段结束。

## 2026-11-02：产品整合历史验收

日期：2026-11-02。按本轮用户授权整合已有主机、SSH、SFTP、Monitor、Linux 运维、Network/Batch 和 Automation；未修改 PRD、初始化 Git、清除正式配置或开始其他产品阶段。目录仍无 Git，交付为当前工作区代码和可执行文件。

## 完成行为

- 模块+HostId 工作区标签、顶部主机选择器、账号/地址/端口和实际连接状态；主机树、模块内选择和终端焦点同步。关闭导航标签保留独立终端及 Rust 后台任务，不把导航当作连接所有权。
- 同主机合理复用完整配置匹配的 SSH Transport，终端、文件、监控、运维保持独立租约。后端提供不含输出/凭据的连接和任务摘要，单独监控连接也能显示在线。Operations 按页面自己的 HostId 取连接，批量连接器改变 ops.active 不会改变当前操作对象；确认仍绑定原 SessionId。
- 保留终端→文件、文件→独立终端/安全 tail、Docker→日志/容器 Shell。新增 Monitor→进程、进程详情→明确 PID 的 ss 监听信息、连接异常→预填地址/SSH 端口的本机 TCP 诊断。无权限的进程归属保留未知。
- 当前任务搜索、确认执行、真实输出及导出沿用 Automation；全部批量目标在既有预览和新后台面板可查看。后台任务独立停止需确认；在途结果未确认的语义不变。
- 全局搜索支持主机/工作区/命令与脚本、方向键/Enter/Esc，最多 50 结果；搜索任务只打开确认预览，不执行。默认 Ctrl+K / Ctrl+, / Ctrl+Shift+J，可配置，常见远端控制键受保护；对话框不触发全局导航。
- Toast 最多 5 条，普通消息自动消失、错误手动关闭，不把敏感输出放入通知。通知文本不拦截底层按钮，关闭按钮仍可用；去掉旧成功横幅在其他页面长期残留的问题。后台面板复用真实传输列表和操作入口。
- 主机树按组一次计算、初始 200 项、继续加载；主机表初始 100 项，保留全部资产的加载入口。树支持方向键/Home/End；顶部标签支持方向键/Home/End，缩窄窗口后活动标签保持可见。已有文件/进程分页保留。
- 主题、终端字体字号/快捷键、采样、传输并发和日志等级保留真实生效。新增新建主机默认 Keepalive/认证超时/代理、SFTP 下载目录及全局快捷键。SSH 默认不改写已有主机或连接；日志等级重启生效。代理秘密仍仅在系统凭据库，默认引用有效性检查、删除引用保护均有测试。
- 侧栏可拖动/键盘调整并保存；窗口逻辑宽高/最大化状态原生去抖保存，重启恢复并约束到当前显示器。旧 AppConfig 无 product 字段时补默认值，SQLite 仍为 v5，不重置或新增业务表。语言字典与语言标识已接入，当前完整 UI 仅简体中文。
- 非敏感备份 v1 JSON：主机、分组、标签、命令/脚本定义和偏好；严格版本/大小/类型/链接/范围校验、逐项预览、选择性恢复、冲突 skip/copy、可选替换偏好，IMMEDIATE 事务保证失败整体回滚。不覆盖既有主机/脚本，不恢复信任、历史或计划，不自动连接。
- 运行中修改主机地址/账号后，顶部继续显示实际会话端点并提示差异；旧上下文跨模块新建连接被阻止，避免悄悄操作新地址。批量预览、诊断来源使用匹配会话信息，连接结束后不冒充当前配置端点。
- 普通应用退出、原生窗口关闭也进入确认；未完成任务、未保存编辑和既有危险操作保护保持。全主机断开说明所有模块及依赖跳板范围，未保存文档先处理。进程在列表读取后退出时，详情请求明确失败并提示刷新，不再误报输出格式不兼容。

## 主要修改文件

| 文件                                                                                                                                                                                            | 变化                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| crates/core/src/product.rs、backup.rs、lib.rs，tests/product.rs                                                                                                                                 | 非敏感产品偏好、真实连接/任务摘要、逻辑窗口尺寸、备份 DTO/校验及兼容；快捷键/代理/路径测试 |
| crates/core/src/ops.rs                                                                                                                                                                          | 短生命周期进程的 stat/status 读取失败返回明确失败，避免最后 printf 掩盖错误                |
| crates/storage/src/backup.rs、lib.rs、hosts.rs，tests/product.rs                                                                                                                                | 一致导出、预览、原子新增恢复、跳板映射、窗口设置、默认代理引用保护；7 项存储测试           |
| crates/ssh/src/lib.rs、crates/tasks/src/lib.rs                                                                                                                                                  | 从真实注册表读取租约端点/状态、轻量任务元数据，保留原连接和队列生命周期                    |
| crates/application/src/product.rs、lib.rs                                                                                                                                                       | 备份/窗口用例和后台摘要，恢复设置后应用传输/监控参数                                       |
| apps/desktop/src-tauri/Cargo.toml、Cargo.lock                                                                                                                                                   | 直接使用已锁定 Tokio，未引入新 UI/路由/窗口或国际化依赖                                    |
| apps/desktop/src-tauri/src/product_commands.rs、window_state.rs、lib.rs、build.rs、capabilities/main.json、permissions/autogenerated/{backup_*,background_tasks}.toml                           | 四项显式 IPC、Rust 原生窗口持久化，保持本地 main 最小权限，无通用文件/本地 Shell API       |
| apps/desktop/src/types/product.ts、ipc.ts、services/product.ts、product-links.ts                                                                                                                | 类型契约、zh-CN 字典、真实 API、连接身份比较/精确 PID 关联                                 |
| apps/desktop/src/stores/workspace.ts、background.ts、notifications.ts、ops.ts、files.ts、terminals.ts                                                                                           | 主机绑定导航、状态摘要、Toast、显式连接目标和错误反馈                                      |
| apps/desktop/src/components/GlobalSearch.vue、BackgroundTasks.vue、ProductSettings.vue                                                                                                          | 全局搜索、后台任务/传输、实际偏好表单                                                      |
| apps/desktop/src/views/BackupView.vue                                                                                                                                                           | 文件选择/JSON 输入、格式校验、预览、选择、冲突策略、单独偏好授权、恢复结果                 |
| apps/desktop/src/App.vue、views/{Hosts,Files,Monitor,Operations,Network,Batch,Automation,Terminals}View.vue、components/{HostSidebar,HostDialog,SettingsPanel,TerminalPane,TaskConnections}.vue | 完整导航与上下文、跨模块联动、可见性、设置、退出与错误链路，保留既有真实功能               |
| apps/desktop/src/styles/product.css、main.ts                                                                                                                                                    | 深浅主题共用变量、响应布局、标签/侧栏、通知和焦点                                          |
| apps/desktop/src/stores/product.test.ts、components/host-tree.test.ts、views/backup.test.ts、operations.test.ts、tasks.test.ts                                                                  | 确认/实际来源/身份变化、备份、键盘与初始渲染上限；原断言保持并适配真实 UI 选择             |
| tools/native-product-e2e.mjs、native-terminal-e2e.mjs、native-ops-e2e.mjs                                                                                                                       | 完整真实流程与针对性 UI 验收；原脚本显式区分新增工作区标签、终端标签和保留的 Docker 子页   |
| README.md、docs/architecture/ARCHITECTURE.md、[IMPLEMENTATION_PLAN.md](../../product/IMPLEMENTATION_PLAN.md)、[DECISIONS.md](../../architecture/DECISIONS.md)、本文件                           | 使用方式、I1 计划、ADR 0012、证据和边界；PRD 保持原样                                      |

## 已执行检查

| 检查                                                             | 结果                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `cargo test --workspace --locked`                                | **119 通过，0 失败，2 个原有显式集成测试 ignored**；新增 core 2、storage 7 项                       |
| `npm test`                                                       | **16 个文件、45 项通过**；新增工作区/身份/键盘/备份等 9 项，并保留原测试关键安全断言                |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过                                                                                                |
| `cargo fmt --all -- --check`                                     | 通过                                                                                                |
| `npm run typecheck`、`npm run lint`、`npm run format:check`      | 通过                                                                                                |
| `node tools/tauri.mjs build --debug --no-bundle`                 | 通过，包含 TypeScript 与 Vite 生产资源，恢复普通配置独立 EXE；既有按需加载 Monaco 大 chunk 提示保留 |
| `npm audit --omit=dev --json`                                    | 0 漏洞                                                                                              |
| 本地库 `cargo audit --no-fetch`                                  | 非零：既有 rsa RUSTSEC-2023-0071，另有 4 unmaintained / 1 glib unsound 提示；未新增忽略             |
| `node --check` 原生测试脚本                                      | 通过                                                                                                |

Rust 的两个 ignored 仍是需显式原生凭据库/授权服务器环境的原有测试，不称为默认测试通过；本次原生流程实际经过 Windows 凭据库和真实 SSH。安全审计使用已有本地通告库，不能称为最新在线通告或发布安全门禁通过。本地 RSA 私钥签名拒绝策略保留。

## 真实产品流程证据

环境：Windows x64 / WebView2 → 用户已授权 Ubuntu 24.04 / OpenSSH 9.6 / Docker 测试环境，普通账号已由用户授权 Docker，不使用 sudo/su/root 登录。密码仅从隐藏输入进入测试进程，不进源码、文档、日志或 argv。主机指纹与已带外核验的 Ed25519 一致，首次确认后才发送认证。

入口 `npm run test:terminal -- --product`：独立复制的 EXE、identifier、数据库、日志、WebView profile，以及仅测试进程 loopback CDP；启动即核对 bootstrap 实际数据目录。UI、Rust IPC、SQLite、OS 凭据库、SSH/SFTP/远程进程均真实执行，没有 IPC mock。只创建/删除已记录 UUID 所属目录、文件、容器、镜像、用户单元和进程，不拉取镜像或修改宿主 sshd。

产物目录：`.local/terminal-e2e/1793557028948-8a9db574-a3dd-4330-b0db-55899c80c817/`。

完整流程 **40 项通过**，记录在 `result-full-product.json`：

1. UI 新建主机，只填写一次端点和账号，复用受保护凭据引用；SSH 首次指纹、独立标签、单 Channel 关闭、vim/top/htop/less、Ctrl+C/Z、2 MiB 背压、搜索、手动重连共 12 项。
2. Monitor 与 top/free/df/proc 交叉核对、趋势节点连续更新、间隔保存、页面暂停/恢复和任务释放，随后从 Monitor 打开同主机进程共 6 项。
3. SFTP 双栏真实目录、中文/特殊字符、后台递归上传、多文件/文件夹下载、16 MiB SHA-256 往返、Monaco 保存/未保存确认/外部冲突/权限拒绝、OSC 7 与独立 tail PTY、退出/取消/临时文件清理、确认递归删除共 6 项。
4. Docker 容器状态/确认操作/环境遮蔽和授权显示、实时日志/暂停/查找/关闭、独立容器 Shell；普通文件日志/导出/流释放、真实 pidfd 信号、TCP/UDP 端口、用户级 systemd 和完整自有资源清理共 7 项。
5. 新整合 9 项：共享 Transport 且各租约独立；编辑主机不重标旧会话或静默换地址；切故障目标/TCP 失败/后台入口不影响原 SSH；常用命令创建、当前目标确认、真实 Linux 输出和 JSON 导出；搜索只打开预览；备份校验/跳过/副本恢复原配置保留；配置下载目录用于真实 SFTP UI 传输且内容一致、默认代理只复制到新表单；主题/Keepalive/侧栏/窗口重启；原生及应用退出确认、重启无自动连接、清理后重新连接真实 Shell。

最终截图复查发现缩窄窗口后活动标签可能在水平滚动区外，补充 resize 时滚入可见区的处理；随后使用 `--product-core` 对最终 UI 构建做 **21 项针对性复测**（与完整流程有重叠，不合计为 61 个独立用例），结果保存在 `result.json` / `result-product-ui.json`。这次还检查活动标签在 900×650 视口内可见。

`product-window.json` 记录 Win32 所报窗口矩形重启前后保持一致；工具先核对 PID 对应 EXE 完全在该隔离目录，再调整/读取窗口。用真实 WM_CLOSE 请求验证关闭确认并选择继续，未发送强制终止冒充正常关闭；另一次自行终止测试进程再启动用于恢复验证。CDP 请求 900×650、2 倍 DPR 以检查布局，实际报告密度另记；这不等同于物理混合 DPI/多显示器矩阵。

人工检查 `product-dark.png`、`product-light.png`、`product-dpi.png`、`product-close-review.png`，以及真实 SFTP/Monitor/Docker/日志截图：账号端点、标签、表单、通知、状态可读；旧成功横幅不跨页长期保留，通知不拦截确认按钮。普通通知在快速自动化流程中可暂时堆叠，随后消失或手动关闭。

`product-export-result.json` 包含真实成功任务的 HostId、RunId、Linux stdout；`product-backup-metadata.json` 只记格式/条目计数和恢复 ID，不记秘密。`product-scope.json`、`ops-scope.json` 记录清理所有权；`product-cleanup.json`、`ops-cleanup.json` 为 cleaned=true。最终隔离 DB schema=5，hosts/credentials/secret_gc 及自动化条目/分组/计划/历史为 0，正式用户数据目录未改动。

期间修正了旧脚本把顶层工作区标签当作终端标签、未显式选择已保留的 Docker 子页、列表中短生命周期 ps 进程已退出、通知自动消失后的动态定位，以及 Windows 测试驱动的 stdin 多行执行问题。产品侧对应修复进程失败语义、Toast 拦截和窗口活动标签可见性；没有删除业务断言或用模拟数据绕过。

## 已知限制和下一阶段依赖

- 当前仅 Windows 客户端与该 Ubuntu 测试环境实测。macOS/Linux、物理混合 DPI/多屏、最大化完整矩阵、万台资产、长时间压力、20 会话/内存/冷启动指标和签名安装包仍未完成，不宣称跨平台或发布性能达标。
- 语言架构有 zh-CN 字典入口，但完整 UI 仅简体中文；未宣称已完成其他语言翻译。
- 备份不是加密保险库：正文、说明、普通参数默认值及非敏感偏好以明文 JSON/SQLite 保存，用户自行避免写秘密。不导出秘密参数值、私钥路径/内容、凭据或其引用、信任、执行历史和计划。SSH 密码/私钥主机恢复后需重新关联凭据。
- 认证代理主机可导出公开配置，但恢复预览明确阻止自动恢复，需手动重新配置；不匿名降级。认证代理全局默认值不导出，是否替换偏好由用户单独选择。复杂备份不兼容时拒绝而不有损覆盖。
- 全局连接默认只影响新主机，已有会话保持原连接；需要新配置时先明确停止对应模块再连接。历史会话结束后，批量/诊断以 HostId/SessionId 和原预览为准，不能用最新资产地址推断旧执行来源。
- 原有 SSH/SFTP/计划安全边界不变：超时/断线/取消不能证明远端停止，秘密脚本不采集输出、不定时；本地计划依赖应用运行和已认证连接，睡眠/关机/退出不保证执行。
- 高级代理/跳板/转发、完整多主机自动化定时矩阵未在本轮全部重做原生测试，保留既有阶段实机记录和本轮全 Rust/前端回归证据。
- 下一步建议聚焦其他平台/真实多显示器、长期负载、依赖安全通告和签名发布门禁；本轮至此停止，不提前扩展新模块。
