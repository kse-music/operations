# 阶段一交付与验证记录

日期：2026-11-01（Asia/Shanghai）。范围为 PRD §19 阶段一与 SSH 前置技术验证，未进入业务开发阶段二。

## 仓库检查

- 开始时目录不是 Git 仓库，只有 `docs/PRD.md`，不存在已有业务代码或 AGENTS.md。未执行 git init、reset 或覆盖既有代码。
- 首次读取 PRD 时为空，随后用户说明已就绪，重新读取到完整 31,350 字节文档，之后才按完整需求设计和实施。
- PRD 未修改，最终 SHA256：`58A3650F717DFEF522017D19BD1EA0C01B95D677CC3C11C41D76615520446B82`。
- node_modules、target、运行数据和一次性审计工具不作为源码交付；均加入忽略规则。

## 本轮实现

| 能力                   | 交付                                                   | 实际验证与限制                                                                                  |
| ---------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Cargo/npm workspace    | core / storage / application / desktop / 隔离 SSH 探针 | Rust/前端均可构建，依赖锁定                                                                     |
| Tauri 2 + Vue/TS/Pinia | 系统标题栏、顶栏、侧栏、工作区、底栏、设置页           | 独立桌面进程启动；尚未完成自动截图/窗口交互验收                                                 |
| IPC                    | app_bootstrap / config_save                            | Tauri dispatcher、序列化、错误、窗口与远程 origin ACL 通过；真实 WebView bootstrap 已由日志确认 |
| SQLite                 | v1 迁移、settings 表、参数化 upsert、标准目录          | 初始化、重复打开、重启持久、坏配置/未来版本拒绝通过                                             |
| 配置                   | 版本化非敏感偏好、Rust 校验、深浅/系统主题、侧栏宽度   | 后端与 IPC 测试通过；UI 操作保存/主题/系统变更需手动验收                                        |
| 日志                   | tracing、512 条有界队列、1MiB×4 文件、退出显式 flush   | Windows 轮转测试与真实启动日志通过；无认证/终端/文件正文日志                                    |
| 生命周期               | 单实例、关闭退出、拒绝新工作、等待在途 SQLite 写入     | 真实第二实例退出，原实例保留；在途写入退出等待自动测试通过；原生关闭交互仍待验收                |
| SSH 技术探针           | 密码/合成私钥、指纹 pin、PTY、exec、多 Channel、SFTP   | 真实 loopback 协议测试通过；外部 RSA 私钥模式因安全审计被禁止；真实 OpenSSH/Agent 待测          |

没有主机列表假数据、假连接、假 CPU/内存、假传输任务。业务入口禁用并说明对应阶段。
配置中的终端/连接/采样默认值仅供后续模块读取，不表示这些模块已经实现。

## 检查结果

环境：Windows x64；rustc 1.97.1、cargo 1.97.1、Node 22.17.0；MSVC Build Tools 14.44。
实际锁定 Tauri 2.12.5 / CLI 2.12.4、Vue 3.5.44、Vite 8.3.5、russh 0.65.0、russh-sftp 3.0.1。
未用其他平台验证，也未验证项目声明的最低 Rust 1.94。

| 命令 / 检查                                                    | 结果                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| npm ci --no-audit --no-fund                                    | 成功，从锁文件重新安装                                               |
| cargo fmt --all -- --check                                     | 通过                                                                 |
| cargo clippy --workspace --all-targets --locked -- -D warnings | 通过                                                                 |
| cargo test --workspace --locked                                | **13 passed，0 failed，0 ignored**                                   |
| npm run format:check                                           | 通过（PRD 不参与自动改写）                                           |
| npm run lint                                                   | 通过，--max-warnings 0                                               |
| npm run typecheck                                              | 通过，严格 TypeScript                                                |
| npm test                                                       | **4 passed，0 failed**                                               |
| npm run build                                                  | 通过，生成静态前端资源                                               |
| node tools/tauri.mjs build --debug --no-bundle                 | 通过，生成嵌入生产前端的 Windows EXE                                 |
| 真实桌面启动                                                   | 成功；日志确认 frontend bootstrap completed / ipc_bootstrap          |
| 真实单实例                                                     | 启动前 1 实例，第二进程 exit code 0，之后仍为 1 实例                 |
| npm audit --omit=dev                                           | 0 vulnerabilities                                                    |
| npm audit（全部依赖）                                          | **未通过：14 moderate，0 high / critical**；开发工具间接依赖，见 ADR |
| cargo-audit 0.22.2（完整锁文件）                               | **未通过：1 漏洞，另有 5 个信息警告**；未屏蔽，见 ADR                |

Rust 测试组成：core 3、storage 3、application 3、Tauri IPC integration 1、SSH protocol integration 3。
应用启动日志中 `ipc_bootstrap` 仅在前端命令成功派发后记录，setup 自身不会写该事件。

可运行产物：`target/debug/serverdeck-desktop.exe`。这是 Debug 二进制，不是签名发布包；无 Vite 服务也能启动。
由于源码测试随后可能重建 debug EXE，交付前已重新执行 Tauri build，确保最终产物嵌入前端资源。

## 修复的可确认问题

- npm 10 初次安装出现 Arborist edgesOut 异常，使用临时 npm 11 生成锁文件后，已用正常 npm ci 成功复现。
- Windows Rust 原生测试程序缺少 Common Controls v6 manifest，导致入口点错误；改为显式 integration target 并仅为测试链接所需 manifest。
- 桌面库与 bin 的 PDB 名称冲突；采用独立 `_lib` 名称且只输出桌面所需 rlib。
- Vue ESLint 格式规则与 Prettier 冲突；增加兼容配置并启用零警告门禁，升级受支持的 ESLint 10。
- 移除未使用的 Vue test-utils，消除其 Node 版本不兼容的间接依赖。
- npm workspace 入口丢失 Tauri CLI 参数；加入 Node launcher，构建使用直接入口确保参数完整传递。
- 退出期间二次关闭可能抢先退出；加入独立 drained 状态，保证在途写入结束再退出，并显式 flush 日志。
- RSA 上游无修复安全问题：隔离于开发探针，禁止外部 key 模式使用真实 RSA 私钥；不假称“升级已解决”。
- 存储/后台故障保留 Rust source 原因链，日志记录安全分类与错误码；IPC 错误回归测试证明不会带出内部敏感载荷。

Windows 受限执行环境不允许 Vitest 临时缓存 rename 和 loopback TCP；相关验证在正常本地权限下执行后通过。
Cargo 增量缓存曾报告无法建立硬链接并自动复制，属于本机文件系统限制；严格 Clippy 通过，没有以 allow lint 隐藏源码问题。
GUI 验收使用 computer-use，但应用访问授权超时，未读取到窗口截图，也未点击设置或关闭窗口。已通过进程、实际 IPC 日志、第二实例与自动化契约测试取得独立证据；视觉/交互验收仍明确待完成。
结束时已停止本轮测试进程，不留开发服务器和测试连接。

## 新增文件清单

除保留的 PRD 外，以下是本轮新增源码/配置/文档；没有先前业务代码修改。

```text
.editorconfig
.gitignore
.prettierignore
.prettierrc.json
Cargo.toml
Cargo.lock
package.json
package-lock.json
rustfmt.toml
eslint.config.js
README.md
docs/ARCHITECTURE.md
docs/IMPLEMENTATION_PLAN.md
docs/SSH_TECH_VALIDATION.md
docs/VALIDATION.md
docs/decisions/0001-ssh-crypto-gate.md
crates/core/Cargo.toml
crates/core/src/lib.rs
crates/storage/Cargo.toml
crates/storage/src/lib.rs
crates/storage/migrations/001_settings.sql
crates/application/Cargo.toml
crates/application/src/lib.rs
crates/application/src/logging.rs
apps/desktop/package.json
apps/desktop/tsconfig.json
apps/desktop/vite.config.ts
apps/desktop/index.html
apps/desktop/src/main.ts
apps/desktop/src/App.vue
apps/desktop/src/components/SettingsPanel.vue
apps/desktop/src/views/WorkspaceView.vue
apps/desktop/src/stores/application.ts
apps/desktop/src/services/ipc.ts
apps/desktop/src/services/ipc.test.ts
apps/desktop/src/composables/theme.ts
apps/desktop/src/types/ipc.ts
apps/desktop/src/styles/main.css
apps/desktop/src/styles/theme.css
apps/desktop/src-tauri/Cargo.toml
apps/desktop/src-tauri/build.rs
apps/desktop/src-tauri/tauri.conf.json
apps/desktop/src-tauri/capabilities/main.json
apps/desktop/src-tauri/permissions/autogenerated/app_bootstrap.toml
apps/desktop/src-tauri/permissions/autogenerated/config_save.toml
apps/desktop/src-tauri/src/main.rs
apps/desktop/src-tauri/src/lib.rs
apps/desktop/src-tauri/src/commands.rs
apps/desktop/src-tauri/tests/ipc.rs
apps/desktop/src-tauri/icons/icon.ico
apps/desktop/src-tauri/icons/icon.png
tools/tauri.mjs
tools/generate-icon.mjs
tools/ssh-probe/Cargo.toml
tools/ssh-probe/src/lib.rs
tools/ssh-probe/src/main.rs
tools/ssh-probe/tests/protocol.rs
```

permissions/autogenerated 由 Tauri AppManifest 构建生成；图标由仓库内确定性脚本生成，无外部图片依赖。

## 尚未完成与下一步

1. 完成原生窗口下的主题、配置保存/重启、系统主题变化、最小尺寸布局、单实例聚焦及关闭行为人工验收。
2. 按 S2 实施真实 Host/Group/Tag/CredentialReference 迁移与主机 CRUD/搜索/收藏/删除确认，保持 SSH 未通过门禁时不建立真实连接。
3. 阶段三前处理 [ADR 0001](decisions/0001-ssh-crypto-gate.md)：RSA 时序漏洞、预发布密码学依赖、真实 Linux/OpenSSH 与系统 Agent 矩阵；不把本轮协议 fixture 当作跨平台验证。
4. 之后按依赖实现安全凭据/主机信任、xterm 终端、SFTP/Monaco 和 Agentless 监控；常用命令、导入备份、布局持久化及完整设置按计划补齐。
5. 安装包、签名、macOS/Linux 测试、性能目标、20 终端压测均未验收。Linux 发布还需处理 GTK/glib 等上游警告。

无需扩大 PRD 范围。仅 PRD 的 M09/M10 编号有文内不一致，实施计划按功能名及 §3 编号跟踪，建议以后统一文档编号。
