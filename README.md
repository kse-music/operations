# ServerDeck

**当前版本：0.1.0-beta.1（测试版，未签名）。** Windows x64 安装包位于 `target/release/bundle/nsis/ServerDeck_0.1.0-beta.1_x64-setup.exe`。不宣称 macOS/Linux 已构建或通过兼容性验证。

[使用说明](docs/USER_GUIDE.md) · [功能矩阵与测试](docs/TEST_REPORT.md) · [安全与限制](docs/SECURITY.md) · [发布门禁](docs/RELEASE_CHECKLIST.md) · [变更记录](CHANGELOG.md)

Rust + Tauri 2 + Vue 3 + TypeScript 的 Local-First、Agentless 运维客户端。
当前交付包含主机/凭据管理和 **真实 SSH 多标签/分屏终端**：密码、普通/加密私钥、系统 Agent、主机密钥验证、PTY/resize、可配置终端、输出背压、手动重连、ProxyJump、SOCKS5/HTTP CONNECT，以及 Local/Remote/Dynamic 转发。
主机配置来自 SQLite，密码/口令来自系统凭据库，终端连接真实 Linux；没有演示资产。SFTP 双栏文件管理、后台传输和 Monaco 编辑已接入；Agentless Linux 监控已接入；Docker、日志、进程、端口和 systemd 运维已接入同一主机工作区。
Network 本机/远端诊断及多服务器批量命令/单文件分发已接入，保留严格主机信任和逐次操作确认。命令/脚本库、持久任务历史与本地计划已接入同一主机上下文。

## 开发

Windows 优先；安装 Rust stable（项目最低版本声明 1.94）、MSVC C++ Build Tools、Windows SDK、WebView2 和 Node.js 22.13+。
macOS/Linux 需要各自的 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)，尚未经本项目实机验证。

在项目根目录运行：

```powershell
npm ci
npm run tauri -- dev
```

本机 npm 10.5.2 首次解析依赖曾出现 Arborist 异常，若遇同样问题，可临时使用 `npx --yes npm@11 ci`；无需改全局 npm。
`npm run dev` 只启动浏览器前端，会明确提示缺少 Rust 后端。

嵌入生产前端资源、无需 Vite 服务的本地调试二进制：

```powershell
node tools/tauri.mjs build --debug --no-bundle
```

Windows 产物：`target/debug/serverdeck-desktop.exe`。Release 二进制：`node tools/tauri.mjs build --no-bundle`。
本轮已生成 NSIS Release 安装器；运行 `node tools/tauri.mjs build --bundles nsis` 可重建。签名证书未提供，当前是未签名测试包。SHA256 清单位于 `.local/release-qa/SHA256SUMS`，不是发布者身份签名。

## 验证

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
# Windows 实际打包应用 + SQLite + 系统凭据库的隔离端到端验收
npm run test:native
# 显式运行原生凭据库集成测试（只操作随机测试条目）
cargo test -p serverdeck-security native_store_roundtrip_update_and_delete -- --ignored
```

Windows 受限执行环境可能禁止 Vitest 临时缓存重命名或 loopback TCP；这些测试需要正常本地进程权限。
运行桌面应用时 Windows 会锁定其 EXE；重新构建前先关闭该程序。

配置与数据库通过 Tauri 标准用户目录持久化，日志大小有界并轮转。数据目录和日志目录显示在工作区。
默认深色，可保存浅色或跟随系统；日志等级在重启后生效。
秘密通过系统凭据库管理：Windows Credential Manager、macOS Keychain、Linux Secret Service；只有 Windows 已验证。系统服务不可用时明确失败，无明文 fallback。主机只关联凭据 ID，私钥仅保存路径引用，密码和私钥口令不会回读到 UI。

OpenSSH 导入只读原文件，支持常见字段及明确 Host 别名；复杂或不支持的语义会提示/阻止导入。重复主机跳过，绝不覆盖已有配置。JSON 导出排除全部凭据及私钥路径。
详细范围、秘密更新/删除和兼容性取舍见 [DECISIONS](docs/DECISIONS.md)。

连接流程：先配置安全凭据并关联主机，再从详情、右键菜单或主机树双击打开终端。首次连接必须带外核对 SHA256 指纹，变化密钥直接阻断。每个窗格是独立 Shell，标签可上下/左右分屏并拖动尺寸，支持标签重排、改名和批量关闭；重连创建新 Shell，不恢复旧进程。Ctrl+Shift+C/V 复制粘贴、Ctrl+Shift+F 查找，Ctrl+C/Z 发往远端。
本地 RSA 私钥签名因上游安全通告被拒绝，请用 Ed25519/ECDSA 或系统 Agent；系统 Agent 必须由用户预先启动并加载身份。详情与尚未验证的矩阵见 [SSH 增强验收](docs/VALIDATION_SSH_USABILITY.md)。

全局设置可保存字体、字号、行高、历史行数、终端主题、光标和快捷键。大文本粘贴会先确认，Bracketed Paste 依赖远端应用启用；“导出内容”仅在确认后下载文本，默认没有会话录制。布局自动保存并可手动保存，恢复后保持未连接，逐个点击连接打开新 Shell，不自动执行命令。

主机编辑的“高级连接设置”可设认证超时、Keepalive、受管跳板及代理安全凭据。SSH Config 导入支持 Keepalive 与单个受管 ProxyJump 别名；不执行 ProxyCommand，不支持的语义会阻止导入。HTTP CONNECT 只支持 HTTP/1.x + 可选 Basic，代理通道本身无 TLS。终端“端口转发”可显式启动/停止三类转发；默认回环，公共绑定须确认，Remote 实际绑定受服务器策略约束。转发归属于窗格，关窗格/断线会清理，不自动恢复。

Windows 原生 SSH 扩展验收入口为 `npm run test:terminal -- --advanced`；需要先设置已授权目标、带外验证指纹和只存本次进程的密码环境变量，安全启动示例见验收文档。它验证实际 Linux Shell、交互程序、分屏、代理/跳板、端口转发、粘贴和恢复。测试输出与下载仅在 `.local/terminal-e2e` 的隔离目录，正常构建不开放调试端口。

原生 E2E 使用 `.local/native-e2e` 下独立数据库、复制的测试 EXE 和仅测试进程的 loopback CDP，不改变正式应用权限。它通过真实 UI 与 Rust IPC 执行 CRUD/凭据/导入流程；测试结束清理随机凭据并恢复正常构建，产物目录保留作诊断。

## SFTP 文件管理

从主机详情、主机右键或终端中的“SFTP 文件”打开同一主机工作区。左栏本地、右栏远程，支持路径导航、父目录、排序/多选/右键、创建/改名/确认删除、属性、上传/下载/递归目录。可使用原生路径选择器或将本地文件拖到远程栏；中文、空格和 Shell 特殊字符按路径处理。

传输在 Rust 后台继续，默认每主机 3 个活动任务，可在全局设置改为 1–6；显示进度/速度/剩余/取消/失败重试和冲突策略。任务从头重传，不宣称断点续传或进程重启恢复。先写同目录临时文件并做 SHA-256 校验再提交；跳过不会冒充已校验文件。未完成传输或未保存编辑时退出须确认。

远程普通 UTF-8 文本（最大 2 MiB）用 Monaco 打开。保存前检测外部修改，使用 OpenSSH 原子替换并保留基础 owner/mode；缺少扩展、权限不足或冲突会拒绝保存。原子替换会改变 inode，ACL、扩展属性和硬链接关系不保证保留，编辑器明确确认这一限制。网络故障可能留下临时文件，查看任务/编辑器中的恢复路径。

终端目录联动只使用 OSC 7。未报告时显示手动导航；Shell 没有集成时可在自己的交互环境配置符合规范的报告，本工具不修改远端启动文件。右键目录/文件可经确认打开独立 Shell、less 或 tail -f，路径在后端转义，不向现有 Shell 注入输入。

原生验收：`npm run test:terminal -- --sftp`，授权目标和密码的隐藏输入方式沿用验收文档。测试只操作随机创建并记录的远程测试目录。完整实现、测试和边界见 [阶段四验收](docs/VALIDATION_STAGE4.md)。

## 文档

- [PRD](docs/PRD.md)：未修改的产品需求基线。
- [架构](docs/ARCHITECTURE.md)：模块、IPC、数据流和生命周期。
- [实施计划](docs/IMPLEMENTATION_PLAN.md)：依赖、可执行任务和完成标准。
- [SSH 技术验证](docs/SSH_TECH_VALIDATION.md)：隔离探针、当前证据、兼容性门禁。
- [阶段一验证记录](docs/VALIDATION.md)：原始基础阶段证据。
- [阶段二验证记录](docs/VALIDATION_STAGE2.md)：主机/凭据结果。
- [SSH 基础验证](docs/VALIDATION_STAGE3.md)：前一阶段真实 SSH 核心证据。
- [SSH 增强验证](docs/VALIDATION_SSH_USABILITY.md)：终端增强、路由和转发证据。
- [当前验证记录](docs/VALIDATION_STAGE4.md)：SFTP 文件管理、后台传输、编辑和剩余限制。

## Agentless Linux 监控

从主机详情/右键菜单或终端“监控”打开工作区，沿用主机凭据、严格指纹验证和已有 SSH 路由。每主机只有一个采样任务，页面隐藏后暂停；再次打开可继续，停止监控只释放自身租约，不关闭已有 Shell/SFTP。

全局设置支持 3/5/10/30 秒。CPU 使用 /proc/stat 差值，内存优先 MemAvailable，网络按远端 uptime 差值计算；首次/重置显示待计算。系统、每核、内存/Swap、负载、磁盘、接口和趋势均来自 SSH 只读采集，失败保留错误和明确过期值。默认隐藏伪文件系统、只读镜像和重复挂载，可显示全部；持久磁盘达到 90% 标示高占用。

趋势在内存中保留最多 600 点且不超过 30 分钟，不写时序数据库、不跨重启恢复。固定命令依赖 Linux procfs、POSIX Shell 和常见 GNU coreutils；iproute2 缺失会明确提示地址不可用。不安装远程 Agent，也不自动修改远端配置。

原生验证：`npm run test:terminal -- --monitor`，使用与 SSH 验收相同的安全目标/指纹/临时密码输入方式。指标口径、实际结果和兼容性限制见 [监控阶段验收](docs/VALIDATION_STAGE5.md)。

## Linux 运维

从主机详情、主机右键或终端“运维”进入；沿用所选 HostId、凭据、严格主机密钥校验、代理/跳板和 SSH Transport。查看 Docker 版本/状态、容器/镜像、资源/端口/挂载，执行启动/停止/重启/删除，或打开独立容器 Shell。默认连接远端 Docker Unix Socket，不读取远程 Docker context，不启用明文 TCP API。

所有状态修改均须输入完整目标确认；删除不使用 force 或删除卷参数。容器环境的所有值默认遮蔽，显式确认后才显示；进程默认只读取命令名称和状态，不抓取参数/环境。TERM/KILL 等信号使用启动标识和 Linux pidfd 校验，缺少 Python/pidfd 时明确失败，不退化为有 PID 复用风险的盲目 kill。systemd 支持系统和当前用户范围，不自动 sudo/su。

Docker、指定文件和服务 journal 可在日志标签实时查看、暂停/继续、过滤、复制与导出可见内容。每标签限制 1 MiB / 5000 行，最多 8 个；关闭标签、换主机或离开运维页面会停止对应流。输出不自动持久化，操作反馈只在本次应用内保留最多 100 条目标/结果元数据。

列表支持进程 CPU/内存排序、搜索，TCP/UDP 监听与权限允许的关联进程，以及明确选择从本地/远端执行的 TCP 连通性检测。运行账号必须已有目标操作权限；权限不足或工具不支持会明确反馈。完整验证及限制见 [Linux 运维验收](docs/VALIDATION_OPERATIONS.md)。原生验收入口为 `npm run test:terminal -- --ops`，只操作唯一命名的隔离测试资源。

## 网络与多服务器批量运维

Network 提供本机/远端 Ping、TCP、DNS、Traceroute、MTR（远端已安装）、接口、连接状态和 SSH exec 延迟。来源、实时结果、错误/退出码明确显示，独立开始/停止、超时、复制/导出；Ping 不通不直接判断服务器宕机。本机不执行任意 Shell，不自动安装工具或申请提权。

批量运维先选择主机并连接/核对指纹，再预览全部目标及统一命令或分发文件，输入目标数量确认。默认并发 3、最大 8、最多 32 目标；逐台显示进度、stdout/stderr、退出码及失败，排队目标可取消。命令不自动重试，超时/断线标为结果未确认，远端进程可能仍在运行。单文件分发复用 SFTP 哈希和安全提交，提供冲突/覆盖确认及失败单目标预览重试；重试沿用原冲突策略，需要改变策略时创建新批次。

离页后任务继续至完成/超时，退出提示未完成任务并请求取消；任务及输出只在本次进程内有界保留，重启不恢复执行。诊断最多 16 条、每条 256 KiB；批量最多 8 条历史，每目标 stdout/stderr 各 32 KiB。导出可能含用户命令/输出中的敏感信息，只由用户主动触发。

验证入口 `npm run test:terminal -- --network-batch`：使用两台独立 Linux SSH 测试容器，测试工具只创建和清理 UUID 所属临时资源，不拉取镜像或修改宿主 sshd。具体结果与限制见 [网络/批量验收](docs/VALIDATION_NETWORK_BATCH.md)。

## 运维自动化

从主机详情、右键或终端“自动化任务”进入命令/脚本库，当前主机自动关联。支持分组、收藏、搜索、说明、风险和八项可查看/编辑的模板。执行前连接并核验目标主机，预览全部目标、真实正文及参数，输入目标数量确认；危险任务另行确认。默认并发 3、可设 1–8、最多 32 台，每台超时 1–3600 秒。单台输出、退出码、错误和状态独立，超时/断线/在途取消为 Unknown，远端进程可能仍在运行，不自动重试。

脚本以 POSIX `/bin/sh` 执行，参数按定义顺序对应 `"$1"`、`"$2"` 等，通过 SSH stdin 与脚本文本分离传递，不进行模板替换。远端需 Python 3，不自动安装。脚本本身由用户审查，勿对参数使用 eval；远端同账号/管理员仍可能观察进程参数。正文、普通参数和描述是本地明文数据，不应包含秘密。秘密参数不能有默认值，该任务不展示/缓存/保存任何输出，也不能保存为本地计划。

任务状态和历史保存在 SQLite v5，重启后可查询；输出默认只在本次进程的最近任务中有界显示，明确选择“保存输出”后每流最多保存 8 KiB。秘密参数不会落盘；历史不会自动清理，可确认删除已结束记录。重启时中断的在途任务改为 Unknown，排队任务取消，不重新执行。

本地计划支持每日、每周、五字段 Cron 和下次时间，固定 UTC 偏移不跟随系统时区或夏令时。**应用退出、计算机关机或休眠时不保证执行**；计划只使用已有已认证运维连接，未连接就明确失败。普通计划需明确授权当前内容/目标，危险计划每次等待人工确认。错过计划选择跳过或生成待确认任务，不自动补跑；正文、参数定义、执行选项或目标路由变化后需重新授权。全局提示显示失败/未知和待确认任务。

原生验收入口：`npm run test:terminal -- --automation`。需要已授权 SSH/Docker 测试账号、带外核验指纹和仅本次进程的密码环境变量；沿用网络/批量验收的隐藏密码启动方式。测试只创建/清理 UUID 所属资源，包含两台独立 SSH 容器、真实 Cron 和自身测试进程的重启恢复。完整文件清单、测试证据和限制见 [自动化验收](docs/VALIDATION_AUTOMATION.md)。

## 统一主机工作区与备份

顶部工作区标签按模块和主机区分，地址/端口/账号始终可见；从主机树或顶部选择器切换目标。终端、SFTP、Monitor、Docker/日志/进程/服务、Network 和 Automation 共享主机配置及严格信任，保留独立生命周期。关闭导航标签保留后台任务和独立终端。全主机断开及应用退出另行确认；未保存文本先处理。

Ctrl+K 打开全局主机/模块/命令搜索，Ctrl+, 打开设置，Ctrl+Shift+J 查看后台任务与传输，可在设置修改（macOS 可用 Command）。搜索任务打开预览，不自动执行。后台面板可查看全部批量目标、任务结果入口、传输进度和独立停止。监控可跳转进程，进程详情可查询明确关联 PID 的监听端口，连接异常可快速打开预填目标的本机诊断。

全局设置新增新建主机默认 Keepalive/认证超时/代理、默认下载目录和全局快捷键；已有主题、字体字号、终端快捷键、监控间隔、传输并发和日志级别保持生效。连接默认值不修改已有主机或在途连接，日志级别仍重启生效。侧栏可拖动/键盘调整并保存，窗口逻辑尺寸和最大化状态重启保持。语言字典已提供，当前完整 UI 仅简体中文。

“备份恢复”导出 v1 JSON：主机/分组/标签、命令/脚本定义、非敏感偏好；不含凭据、私钥路径、秘密参数值、信任、历史或自动计划。导入须校验并预览选择，冲突跳过或新建副本，不覆盖已有数据。恢复后重新关联密码/私钥凭据；认证代理主机明确阻止自动恢复，需手动配置。请检查脚本、说明及普通默认值中自行填写的秘密，备份不是加密保险库。

完整真实产品流程验收入口为 `npm run test:terminal -- --product`，沿用已有授权 SSH/Docker 隐藏密码启动方式，仅使用 UUID/独立目录所属资源。证据、修改清单及发布前限制见 [产品整合验收](docs/VALIDATION_PRODUCT.md)。

## 发布复验

```powershell
node tools/tauri.mjs build --bundles nsis
node tools/release-manifest.mjs
# 安装到专属 QA 目录后测试真实启动；不会清除用户数据，要求空主机目录
node tools/release-startup-bench.mjs <installed-serverdeck-desktop.exe> <artifact-directory>
# 设置已授权 SERVERDECK_TEST_HOST/USER/PIN，密码由安全提示或进程环境传入
node tools/native-terminal-e2e.mjs --release --installed-exe <installed-serverdeck-desktop.exe> --release-qa
```

`--advanced` 覆盖分屏、标签、代理、跳板和转发；`--automation --network-batch --ops --monitor --sftp` 覆盖真实模块；`--soak --ops` 增加五分钟同时监控/Docker 日志；`--exit-transfer` 验证真实上传中确认退出与重启清理；`--modules-only` 用于独立复测模块，不算作完整终端回归。工具必须在授权测试服务器运行，远端夹具只按 UUID/标签回收，安装版验收拒绝已有主机/凭据的目录，结束后恢复原偏好。

功能证据、失败重跑、性能口径和未完成门禁详见测试报告。当前空闲整进程树内存超过 PRD 约 150 MB 目标；RustSec 通告未全部关闭、长期压力和跨平台实测未完成，保持测试版。CI 手动生成四类候选产物，不自动创建 Release、上传用户数据或引入自动更新。
