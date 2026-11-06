# 主机交互与本地终端验收

## 2026-11-06 本地终端默认 Shell 修复

用户反馈本地终端仅显示 `$`，而系统终端显示 `dh@dh:~$`。代码核对确认原实现固定启动 `/bin/sh -i`；本机 `/bin/sh` 指向 dash，账户登录 Shell 为 `/bin/bash`。

`crates/application/src/local_terminal.rs` 现复用 portable-pty 0.9 的 `get_shell()`：优先使用可执行的 `$SHELL`，缺失或无效时查询系统账户配置，最终回退 `/bin/sh`。解析结果作为完整可执行路径加独立 `-i` 参数启动，不解析命令文本；采用非登录交互模式使 Bash 读取 `~/.bashrc`，并将子进程 `SHELL` 与返回的程序名同步。Windows PowerShell 启动参数不变，未新增依赖、IPC 参数或数据库迁移。

执行环境为 Linux、Rust stable 1.99.1。构建前根目录输出盘空闲约 812 GiB，沿用 `.cargo/config.toml` 和根目录 `target/`，未新建 Cargo 缓存。已检查无运行中的 ServerDeck 桌面进程，未强杀用户程序。测试二进制编译后复制至 `.local/local-shell-qa/application-tests` 执行。

| 检查                                                                                     | 实际结果                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test -p serverdeck-application --lib --no-run --locked --offline`                 | 编译通过                                                                                                                                                                                                                      |
| `.local/local-shell-qa/application-tests local_terminal::tests --nocapture`              | 5 项通过：包含空格和引号的 Shell 路径不拆分；未设、空值、不存在、不可执行和命令文本形式的 `SHELL` 回退；真实 Bash PTY 加载隔离 HOME 的自定义提示符及别名；原有输入输出、resize、非零退出、独立关闭、未 ACK 取消和非法参数保护 |
| `cargo build -p serverdeck-desktop --locked --offline`                                   | Linux 桌面开发构建通过，更新 `target/debug/serverdeck-desktop`                                                                                                                                                                |
| `cargo clippy -p serverdeck-application --all-targets --locked --offline -- -D warnings` | 既有 `crates/core/src/openssh.rs:290` 的 `single_element_loop` 告警阻止通过                                                                                                                                                   |
| 同一 Clippy 命令增加 `-A clippy::single_element_loop`                                    | 通过，未修改既有 OpenSSH 代码或全局 lint 配置                                                                                                                                                                                 |
| `cargo fmt --all -- --check`、修改文档 Prettier、`git diff --check`                      | 通过                                                                                                                                                                                                                          |

本轮未运行原生 GUI 验收、前端测试、Windows/macOS 实机或安装包构建；没有前端修改。Bash 提示符与交互行为仍由用户自身配置决定，已有会话不会自动更换 Shell。当前无剩余实现依赖；用户重启 `npm run tauri -- dev` 后新建本地会话即可使用修改。后续发行需对应平台构建和验收，本阶段不自动推进。

## 早期阶段记录

日期：2026-11-02。范围为本轮用户提出的八项调整。

## 完成标准与实现

1. 主机树、主机列表名称单击进入对应 SSH 终端；重复点击复用已有终端，显式“连接 / 新建终端”仍可新开 Shell。
2. 两层横向页签支持鼠标中键，按下时阻止自动滚屏；导航页签只关闭导航，终端页签只回收其拥有的会话，失败保留页签。
3. 右键菜单关闭区域显式透明无边框，消除系统默认按钮造成的全屏灰色背景；原有菜单动作保留。
4. 移除顶部全局设置和退出按钮；侧栏设置和快捷键保留，原生窗口关闭仍先确认。
5. SFTP 远程列表增加权限和拥有者（UID）。权限如 `0644`，保留特殊位；UID 0 正常显示，缺失属性显示 `—`，本地文件列表不增加此两列。属主来自 SFTP 返回值，不猜测用户名。
6. 默认本地设备打开真实 PowerShell / sh PTY，支持输入输出、尺寸、标签、分屏、复制粘贴/查找和资源清理；重启创建新 Shell，不重放历史命令。
7. 分组创建成功才关闭弹窗；保存失败保留输入和错误。
8. 主机可拖到其他组、空组和未分组，通过现有接口保存。失败不改变原分组，拖动不触发连接。

主要修改为 App、HostSidebar、GroupManager、FilePane、TerminalPane、TerminalsView、hosts/terminals store、终端 IPC/types、application/local_terminal、布局元数据与对应测试。新增依赖 portable-pty，权限仅授予本地主窗口的 terminal_local_open。

## 执行记录

| 检查                                       | 实际结果                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端 Vitest（项目临时目录、2 worker）      | 20 文件、62 项通过                                                                                                                                            |
| Rust core / storage / application 单元测试 | 34 项通过，含真实 PowerShell 输入输出、PTY resize、非零退出码、关闭隔离与未 ACK 取消                                                                          |
| Tauri IPC dispatcher                       | 2 项通过，新增本地 PTY 非法尺寸、本地主窗口 ACL 和远程 origin 拒绝断言                                                                                        |
| Vue/TypeScript 与 Vite 生产构建            | 通过，保留已有大 chunk 提示                                                                                                                                   |
| Windows 原生 Tauri debug 构建              | 独立构建目录通过；未覆盖占用中的原程序                                                                                                                        |
| `tools/native-ui-e2e.mjs`                  | 6 组真实 WebView2 场景通过                                                                                                                                    |
| `tools/ui-layout-e2e.mjs`                  | 4 组尺寸/深浅主题通过，实际鼠标中键与透明背景断言通过                                                                                                         |
| `tools/ui-pages-e2e.mjs`                   | 36 页面及表单状态通过，包含 SFTP 两列内容和双栏对齐                                                                                                           |
| ESLint                                     | 通过                                                                                                                                                          |
| Clippy                                     | 默认 `-D warnings` 被原有 openssh.rs:290 的 single_element_loop 告警阻止；仅对本次调用允许该既有告警后，application 及依赖库检查通过，未修改无关 OpenSSH 代码 |

原生结果与截图位于 `.local/native-ui-e2e/36c3caa0-43e1-41bb-9189-61027c194b73/`。原生测试使用专属 UUID 数据目录与不同应用标识，未创建或读取用户凭据；主机为缺少凭据的隔离配置，验证进入 SSH 与错误反馈，不进行远端连接。默认 PowerShell 实际计算 `17*19=323`，新开/中键关闭第二个本地终端后第一个变量仍保留；原生标题栏关闭确认后重启，新 Shell 不含旧变量。分组新建关闭、跨组/移到未分组、重启后 SQLite 保存均有实际断言。

浏览器布局与 SFTP 内容检查使用测试脚本内存夹具，仅作为 UI 验证，不计作真实远端 SFTP 通过。首次默认临时目录导致 Vitest 缓存/日志轮转权限错误，改用项目内临时目录后通过；默认 native build/test 输出被正在运行的程序占用，改用 `.local/native-ui-build` 后通过。

## 未验证与风险

最终 Rustfmt、修改文件的 Prettier 和 `git diff --check` 均通过。正常应用标识的新版 debug 程序位于 `.local/native-ui-build/debug/serverdeck-desktop.exe`，使用原应用数据目录；没有自动启动它、替换旧窗口或执行安装。

Linux sh、macOS 原生界面和真实远端 SSH/SFTP 跨模块回归未计入本轮通过项。WSL Ubuntu 已存在，但没有 Rust 工具链，未为本轮安装系统工具。SFTP 拥有者目前为数字 UID，不提供用户名解析。终端中用户主动脱离终端运行的进程不承诺随页签结束。

已有 Monaco 大 chunk 提示保留。当前运行的旧二进制占用默认构建输出，原生验证使用 `.local/native-ui-build` 与独立测试配置，未关闭当前用户窗口或覆盖其配置。本轮不生成或安装发布版。

下一阶段的 Linux 验收依赖 Linux Rust 和原生运行环境；本阶段完成后停止。

## 追加：无固定页签与欢迎页

按用户澄清，首次启动自动打开的本地终端可以关闭；不把它或主机管理当作常驻默认页签。导航页签清空后显示欢迎页，关闭最后一个实际终端也清除对应的空导航页签；只有用户点击欢迎页入口或左侧导航时才重新打开工作区。保留原有导航关闭与终端资源关闭的区分。

主要修改：`stores/workspace.ts`、`App.vue`、`AppNavigation.vue`，同步 store/App 回归和原生检查脚本。追加后的前端测试为 20 文件、64 项通过，TypeScript、ESLint、Prettier、`git diff --check`、Vite 和原生 debug 构建通过。真实 WebView2 共 7 组场景通过，新增断言覆盖启动仅一个本地页签、最后导航页签关闭后零页签与欢迎页、欢迎页手动重开、最后实际终端关闭后零页签与欢迎页。截图与结果位于 `.local/native-ui-e2e/679397ce-223f-49f7-b865-062810e64609/`，已核对欢迎页截图。未修改 Rust、IPC、数据库或远端执行逻辑；本轮未重跑 Linux/macOS 或真实远端回归，无新增已知功能风险，后续平台验收仍依赖相应原生环境。
