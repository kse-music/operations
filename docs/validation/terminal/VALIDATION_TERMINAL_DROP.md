# 终端拖放上传验证

## 2026-11-10：当前 Shell 文件与目录上传

本阶段已接通原生拖放授权、窗格命中、上传前确认、Rust 目录打包、原 PTY 接收、哈希校验、同名保护、进度/取消及关闭协调。接收进程直接继承当前 Shell 的有效 UID 和目录，不读取 sudo 密码、不另开提权 SFTP，不安装远端软件。原有 rz 契约保留。

### 主要实现

- 桌面 TerminalPane、TerminalDropUpload 和 services/terminal-drop：确认、协议解析、输入隔离、原 Session 绑定及接收状态不明时的关闭提示。
- Application terminal_upload/drop.rs 与 receiver.sh：一次性拖放授权、可取消归档、源变化校验、原 PTY 流式接收及不覆盖提交；core terminal 和 Tauri 命令/权限同步。
- terminals/workspace Store：无上传时保留原关闭行为；有上传时先确认、等待取消，再关闭所属 Channel。取消关闭主机不会先关闭文件连接。
- PRD、架构、使用指南、实施计划及 ADR 0033 同步；tar 0.4.46、filetime 0.2.29 的声明与完整许可加入分发资源。

### 已执行检查

| 检查                                                                                                                                 | 结果及范围                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm test                                                                                                                             | 58 文件、595 项通过。包括协议分包/错误任务标识、最终 ACK 与完成帧同包、提前假完成、FAIL 隔离、校验阶段取消、终端恢复失败、超时、断线迟到准备、真实坐标换算、确认前不准备/发送、关闭确认与等待，以及原有剪贴板/rz/工作区回归 |
| npm run typecheck                                                                                                                    | 桌面和当前 SDK 类型检查通过                                                                                                                                                                                                 |
| npm run lint                                                                                                                         | 全量 ESLint 通过                                                                                                                                                                                                            |
| cargo test -p serverdeck-application terminal_upload --offline --no-run，复制生成的测试 EXE 到 QA 后运行 terminal_upload --nocapture | 上传相关 6 项通过，验证二进制分块、令牌隔离、原选择器限制与源变化、一次性/过期授权、目录/中文/隐藏/空目录归档和取消                                                                                                         |
| cargo test -p serverdeck-desktop --test ipc --offline --no-run，复制 IPC EXE 到 QA 后执行                                            | 8 项通过。新增 claim/prepare 和原读取/释放命令拒绝其他窗口、远程来源和无效会话；保留有效业务断言                                                                                                                            |
| cargo clippy -p serverdeck-application -p serverdeck-desktop --all-targets --no-deps --offline -- -D warnings                        | 通过                                                                                                                                                                                                                        |
| cargo fmt --all -- --check、修改文件 Prettier、git diff --check                                                                      | 通过                                                                                                                                                                                                                        |
| node tools/tauri.mjs build --debug --no-bundle                                                                                       | Windows 普通 Debug 构建通过，输出 target/debug/serverdeck-desktop.exe；未生成安装包或替换运行程序                                                                                                                           |

构建使用既有根 target 和关闭增量的配置，构建前 D 盘约 159 GiB 空闲。原生测试使用 .local/terminal-drop/ 下的 EXE 副本。沙箱系统临时目录最初导致 Vitest 缓存 rename EPERM，改用本任务 .local/terminal-drop/tmp 后通过；IPC 首次因本机 HTTP 夹具网络权限失败，获准本机套接字访问后 8 项通过。未通过减少断言或更改产品行为绕过这些环境问题。

扩大到 core 的严格 Clippy 被既有 crates/core/src/openssh.rs 的 single_element_loop 阻断；未改动该无关实现或降低警告等级。保留已有 Monaco 大 chunk 提示和 JSDOM Canvas 未实现提示，均未作为功能通过依据。

### 真实 Linux PTY

使用现有 Ubuntu-24.04 WSL、真实交互 Bash、GNU tar 1.34/coreutils 8.32 和生产 TypeScript 协议服务。命令：

```powershell
node tools/terminal-drop-e2e.mjs
```

八项全部通过：

1. 预存 nobody 用户在有权限的目录上传 1 MiB 全字节二进制、中文/空格/引号/分号/命令替换字符名称、隐藏文件及空目录；校验 SHA-256、实际 UID、层级和暂存清理。
2. root 运行真实 sudo -i 登录 Shell，再切换到隔离目标目录上传；文件 UID 为当前 root，目标目录正确。
3. nobody 向 root 的 0700 目录上传失败，未读取/发送文件内容，未创建目标文件。
4. 同名普通文件完整保留，整批未提交。
5. 同名文件夹不合并，已有目录保留。
6. 悬空目标链接被视为冲突，未跟随或覆盖。
7. 故意错误 SHA-256：失败隔离并恢复，未提交文件。
8. 第一块后取消：停止发送、无正式目标文件，清理暂存并恢复 Shell。

每项都断言本地授权只释放一次、结束后输入恢复，交互 Shell 退出后的 stty 标志与初始状态一致。FAIL 后接收端保持隔离，客户端停止发送并中断后才清理/恢复，不把排队的 Base64 数据交给 Shell。

最终证据：[协议结果](../../../.local/terminal-drop/protocol-e325dd71-76a4-4942-9eea-9ea9aa8ebecc/results.json)。这不是普通用户通过密码/MFA 完成 sudo 身份认证的验收；应用不实现该认证，身份切换由用户在已有终端中完成。测试未连接用户服务器、安装系统软件、创建账户或修改 sudo/SSH 系统配置。

### 未完成检查与原始失败

Windows 隔离原生 EXE 能启动并连通真实回环 OpenSSH，主机密钥经过核对；但合成 OLE 手势返回 None，没有完成系统拖放到 Rust 授权、确认界面、最终文件的整条验收。失败证据保留于 [.local 原生记录](../../../.local/terminal-drop/native-5cffd99d-ea60-41b9-9511-a887104dacff/failure.json) 与同目录截图/日志，不将其计为拖放通过。

临时合成测试曾遇到 OpenSSH 严格检查拒绝共享 /tmp 祖先和 Windows PowerShell 中文 JSON 编码问题，修正后 SSH 已连通，但 OLE 手势仍失败；未通过关闭主机密钥验证或服务端严格权限检查解决。未通过的临时自动化工具已移除，保留生产实现、可重复运行的 PTY 工具和原始证据。

本轮没有切换到 computer-use 追加系统手势验证：其 guidance 要求 “Do not mix direct PowerShell UI Automation code in the same turn as Computer Use.”。因此真实资源管理器拖放、分屏精确命中与物理高 DPI 仍待人工验证；组件测试的 2 倍坐标换算不替代物理系统验收。

### 风险及下一阶段依赖

- 首版仅普通 Linux SSH Shell；用户须先回到空白提示符，无法从 SSH 字节流通用证明任意前台程序已退出。备用屏幕和特殊会话拒绝拖放，嵌套 tmux/SSH 未验收。
- 要求已有兼容 GNU 基础命令，最小发行版或受限 Shell 可能拒绝；Base64 约增加三分之一传输量，归档和解包需要额外空间。
- 本地文件/目录变化会停止打包，但不是文件系统快照；不承诺特殊权限、ACL/xattr 或硬链接语义。无断点续传、大文件/磁盘不足/并发提交竞态的完整真实故障矩阵未验收。
- 批次不是整体事务，后期冲突或断线可能已有项目提交；取消不删除已提交文件。无法确认恢复时保持输入隔离并要求关闭会话；异常断线可能留下远端暂存。
- 下一阶段依赖：人工 Windows 系统拖放、分屏及物理缩放验收；若需发布，再补真实服务器发行版、大文件/故障与跨平台矩阵。当前不生成 Release/安装器，不主动进入该阶段。

## 2026-11-10 静默上传与弹窗进度

### 问题及当前行为

此前接收脚本关闭 echo 之前，交互 Shell 已回显整段启动命令和 PS2 续行提示；服务将这些普通字节写进了 xterm。确认后又清除了选择状态，导致确认弹窗关闭，进度及成功提示显示在终端底部。

现改为同一 Modal 从确认直接进入准备、传输、校验和提交，实际接收结果、本地授权释放成功后自动关闭。取消等待接收进程结束后关闭，失败保留原因与关闭按钮；恢复状态不明时提供明确关闭此会话的入口。上传过程中关闭按钮和 Esc 不会绕过取消处理。会话断开移除进度并显示失败，旧上传的迟到输出不能泄漏回终端。

从启动命令首字节到父 Shell 的 RETURN 帧，普通回显、续行提示、协议和接收诊断均不送入 xterm。DONE/ERROR 只确认接收结果，再等待父 Shell 返回，防止最后一包输出泄漏或提前成功关闭。返回后的正常提示符在旧空白输入行原地刷新，不追加上传脚本或状态，不清屏、不删除已有滚动历史。准备阶段和返回边界之后的普通输出继续显示。

### 执行证据

- 全量 npm test：58 文件、601 项通过；桌面及 SDK typecheck、全量 ESLint、相关文件 Prettier 和 rustfmt 检查通过。
- 组件与协议、剪贴板/rz 定向回归：4 文件、35 项通过。新增断言验证同一弹窗实例、确认前不发送、进度出现在弹窗、进行中 Esc/关闭不能跳过取消、DONE 未收到 RETURN 不关闭、完成后无终端成功栏、失败保留、取消关闭、断线及迟到回显隔离。
- Rust 上传相关 6 项通过，测试 EXE 从根 target 复制到 QA 目录运行。应用/桌面严格 Clippy 通过；core 原有 single_element_loop 限制沿用上一节记录。
- node tools/terminal-drop-e2e.mjs：真实 Linux PTY 八项通过，保留权限、SHA-256、特殊文件名、冲突、清理、取消及 stty 恢复断言。新增断言先证明原始 Shell 确实回显了 sd_nonce=$1，再验证终端输出中没有启动命令、脚本或 SDU 协议，结束后仍能正常执行命令。
- [本次 PTY 结果](../../../.local/terminal-drop/protocol-1d465fef-23a5-4f48-b4fd-dac57b5c2c83/results.json)；[全量前端记录](../../../.local/terminal-drop/modal-frontend-tests.log)；构建记录位于 .local/terminal-drop/modal-build.log。

本次未重做原生窗口中实际拖放、弹窗截图、物理高 DPI 或跨平台验收。当前 Shell 的用户、目录、权限和同名保护机制不变，不涉及数据库、配置格式或插件 SDK 变更。前后端采用同一当前运行期协议，需要正常退出旧程序后使用新构建；下一步仅依赖原生交互复验，不主动生成安装器或继续后续阶段。

## 2026-11-10 上传弹窗关闭后恢复终端焦点

### 问题与修复

弹窗关闭时未调用 xterm 的聚焦入口，焦点可能停在被移除的按钮或回到 body，导致光标呈失焦状态，必须再次点击终端才能输入。分屏下，拖入文件也不会触发普通鼠标点击的窗格激活逻辑，可能保留另一个窗格作为焦点目标。

TerminalDropUpload 接受拖放时携带原 SessionId 通知父窗格激活并聚焦目标，再展示确认弹窗。弹窗完全移除后，经过 Vue DOM 更新边界通知父窗格复用 focusTerminal 恢复输入。恢复前复验会话、连接代次、可见性、关闭状态及其他弹窗，不向隐藏、失效会话或其他弹窗抢焦点。成功、正常取消及关闭失败提示均通过同一生命周期处理，不更改光标闪烁设置，不重建终端或重连 SSH。

主要修改：TerminalDropUpload.vue 的 activate/closed 事件和弹窗可见性监听、TerminalPane.vue 的会话检查及焦点恢复；新增 terminal-drop-focus.test.ts 集成回归，需求/架构/使用指南同步。

### 已执行验证

- 新增 5 项焦点集成回归，连同现有弹窗 8 项共 13 项通过。挂载真实 Vue 终端窗格/上传组件/Modal，使用带真实 DOM textarea 的 xterm 替身验证 activeElement，并检查键盘事件进入正确 Session 的输入 API。
- 覆盖原来未聚焦的第二个分屏窗格完成上传后直接输入、取消后恢复、工作区已隐藏不抢焦点、另有新弹窗不抢焦点、断开会话的失败提示关闭后不主动聚焦旧会话。
- 全量 npm test：59 文件、606 项通过；桌面与 SDK typecheck、全量 ESLint、修改组件/测试 Prettier 和 git diff --check 通过。
- node tools/tauri.mjs build --debug --no-bundle：Windows Debug 构建通过，生成 target/debug/serverdeck-desktop.exe；构建前 D 盘约 158 GiB 空闲，复用根 target，未替换或强杀运行中的程序。
- 原始记录：[前端回归](../../../.local/terminal-drop/focus-frontend-tests.log)、[构建](../../../.local/terminal-drop/focus-build.log)。

### 限制与下一步

本次为前端焦点生命周期修复，未修改接收协议、权限或持久数据，未重复执行 Rust/SSH/PTY 传输验收。JSDOM 回归证明焦点与输入路由，原生桌面中的光标闪烁及实际拖放仍未人工复验，不据此声明所有平台通过。保留已有 Canvas 未实现和 Monaco 大 chunk 提示。

下一步依赖正常退出旧版后用新构建进行原生交互复验；本阶段不生成安装器或继续跨平台验收。
