# 终端顶部紧凑布局验收

日期：2026-11-02。范围为优化截图红框中的层级与留白，移除“已恢复布局……”提示。

## 已完成行为与主要文件

- `apps/desktop/src/App.vue`：用 workspace-header 将主机工具与连接信息组合到同一行；保留目标主机、账号/端点、实际状态和诊断入口，窄窗口按空间换行。
- `apps/desktop/src/views/TerminalsView.vue`：用 terminal-session-header 将会话标签与操作合为一行。新建、上下/左右分屏、重命名、关闭其他/右侧标签和保存布局均保留，使用统一图标按钮，每项都有完整 title 和可访问名称；会话标签继续可关闭、拖动及打开右键菜单。
- `apps/desktop/src/styles/product.css`、`styles/terminal.css`：收紧高度、内边距和边框层级，会话标签可独立横向滚动；窄窗口将会话操作换至下一行，终端区域紧邻顶部操作，不留空白分隔区。
- `apps/desktop/src/stores/terminals.ts`：删除仅用于恢复提示的 restored 展示状态。restore 继续创建 idle、connectRequested=false、无 SessionId 的窗格，没有改为自动连接。错误、主机信任及连接配置变化提示保留。
- `App.test.ts`、`tools/ui-context-e2e.mjs`、`tools/native-ui-e2e.mjs`：覆盖组合布局、提示移除、原操作绑定、恢复状态及实际高度；同步 PRD、架构、设计决策与实施计划。本次无 Rust、IPC、数据库、配置或依赖变更。

## 完成标准与实际验证

1. 宽窗口顶部形成两行：浏览器检查主机信息/工具和会话标签/操作的组合与相对位置，终端区域紧接操作栏；实际截图已人工核对。
2. 无恢复提示但仍需手动连接：应用和 store 回归通过实际元数据恢复检查 idle/connectRequested 状态，页面不存在旧提示；没有修改连接创建、主机密钥确认或取消流程。
3. 原功能可操作：应用回归实际触发新建、两种分屏、关闭右侧/其他会话、重命名和保存，检查对应模型/保存调用；原会话、文件连接和导航隔离检查保留。
4. 窄窗口不溢出：四组尺寸/主题下主机工具可访问、会话栏可滚动或换行，页面没有横向溢出，切换主机继续恢复各自工具和会话。

浏览器实测顶部高度（不含一级工作区标签和单个窗格工具栏）：

| 场景          | 主机信息与工具 | 会话标签与操作 |   合计 | 操作栏与终端间隙 |
| ------------- | -------------: | -------------: | -----: | ---------------: |
| 1440×900 深色 |          36 px |          36 px |  72 px |             0 px |
| 1440×900 浅色 |          36 px |          36 px |  72 px |             0 px |
| 900×600 深色  |          69 px |          36 px | 105 px |             0 px |
| 390×844 浅色  |          69 px |          69 px | 138 px |             0 px |

实际执行结果：

- 相关应用、终端 store 和主机工具回归 43 项通过；前端全量 Vitest 27 文件、142 项通过。
- Vue/TypeScript、Vite 生产构建、ESLint、修改文件 Prettier、相关脚本 Node 语法检查及 `git diff --check` 通过。
- 浏览器上下文及工作区布局各四组通过，共八组，包含上述几何断言和既有主机树、导航、筛选、编辑及终端入口检查。页面内夹具不计为真实远端验收。
- Windows Tauri debug 测试/普通配置构建通过，原生 WebView2 套件 13 组通过；包括七个会话操作图标、无恢复提示、本地 PowerShell、实际新建/关闭标签、重启与主机配置回归。两种分屏、重命名和保存按钮的实际绑定由应用回归验证，本轮没有重复执行其完整原生流程。

## 产物、未验证内容与风险

浏览器产物位于 `.local/compact-terminal-header/{context,layout}/`，主要截图为 `context/desktop-dark-compact-header.png` 和 `context/mobile-compact-header.png`。原生产物位于 `.local/native-ui-e2e/1afcce47-d355-4e3f-81d8-4cb90b2bf5ba/`，results.json 记录 13 组通过。原生使用专属程序/标识与 UUID 数据目录，核对 app_bootstrap.dataDirectory 后才修改脚本自己的数据，没有修改用户主机、凭据或窗口。临时本机预览服务已停止。

普通配置程序为 `.local/compact-terminal-header/ServerDeck.exe`，已与普通构建输出核对 SHA256 一致：`161226FF1C6E37B26C7F2644F8A0E1B70D97350FE815E6C1682D1921B91390C6`。未安装或替换正在运行的客户端。

本次未重跑真实远端 SSH/SFTP/监控、系统凭据操作及 Linux/macOS 原生验收；Rust 未修改，未重复执行 Rust 单元测试，也未构建 Release 安装包。390px 检查为浏览器布局/鼠标键盘验收，不作为真实触屏验收。构建保留既有 Monaco 大 chunk 提示；未发现本次变更新增的功能风险。

当前需求已完成，无后续实现依赖，其他平台及真实远端验收依赖对应环境和授权主机；本阶段结束后停止。
