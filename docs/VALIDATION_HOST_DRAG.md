# 侧栏主机跨组拖动验收

日期：2026-11-02。范围为用户截图中的主机树拖到其他分组。

## 行为和实现

- 按住主机行左键并移动至少 6px 开始拖动，展示主机名称和目标提示，目标分组高亮。组标题及组内主机行均可作为落点，支持空组、折叠组、未分组。
- 松手调用现有 `hosts.move → hostsApi.update → host_update` 持久保存；移动成功后刷新列表，失败显示原有安全错误并保持原分组。相同组、侧栏外松手或取消不写入。
- Esc、指针取消、窗口失焦均结束拖动，组件卸载移除监听。普通点击、键盘操作和右键菜单保留；拖动产生的 click 被拦截，避免误连 SSH。
- 主机行不使用 HTML draggable，保留 Tauri 原生文件拖放处理器。鼠标/笔输入可拖动，触屏保留列表滚动，不增加触屏拖组行为。

原因依据为本地 `node_modules/@tauri-apps/cli/config.schema.json` 的 `dragDropEnabled` 说明：默认启用的原生处理器替换 Windows WebView2 拖放处理，HTML 拖放需要将其关闭。SFTP 依赖原生外部文件拖入，因此侧栏改为 Pointer Events，不修改全局窗口配置。

主要修改：`components/HostSidebar.vue`、`styles/hosts.css`、`components/host-tree.test.ts`、`tools/native-ui-e2e.mjs`，以及架构、实施计划和设计决策。没有修改 Rust、IPC、数据库、依赖或用户配置，保留已有其他修改。

## 验证记录

- Vue/TypeScript 检查通过。
- 前端全量 Vitest：20 文件、82 项通过。侧栏回归包含空/折叠/未分组、目标高亮、Esc/指针取消/侧栏外/原组松手、轻微移动、右键、保存中禁止拖动、组内主机行落点，以及保存失败保留原分组。
- ESLint 通过。

- Vite 生产构建和 Windows Tauri debug 构建通过；原有 Monaco 大 chunk 提示与增量缓存硬链接回退复制提示保留。
- `tools/native-ui-e2e.mjs`：7 组真实 WebView2 场景通过。鼠标按下/移动/松开触发实际指针路径，断言拖动预览和组高亮；Esc 后分组不变，拖到折叠空组及未分组后用真实 IPC 检查 SQLite 结果，整个拖动过程不新增 SSH 会话，重启后分组仍保留。
- 修改文件的 Prettier 与 `git diff --check` 通过。

原生结果和截图位于 `.local/native-ui-e2e/c0915cb2-cc6c-463e-898a-56e394928243/`，已核对 `host-drag.png` 的预览和落点高亮。测试使用独立 UUID 数据目录和应用标识，不读写用户已有主机、凭据或当前窗口；未配置真实远端凭据。普通应用标识的新版程序为 `.local/native-ui-build/debug/serverdeck-desktop.exe`，未自动启动或替换现有窗口。

## 未验证、风险和后续依赖

本轮未验证 Linux/macOS 原生界面或触屏拖组；后续对应平台验收需要原生环境。SFTP 外部文件拖入保留原配置和实现，本轮不计作重新验收真实远端传输。当前不提供拖动时自动滚屏，可用滚轮滚动主机列表后继续放置。

本阶段结束后停止，不主动扩展到其他拖放或远端业务功能。
