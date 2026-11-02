# 移除主机栏标题文字验收

日期：2026-11-03。

## 已完成与主要文件

- `apps/desktop/src/components/HostSidebar.vue` 删除顶部“主机”文字；原收缩图标自然左移，保留按钮名称、提示和展开状态。
- `apps/desktop/src/styles/hosts.css` 移除不再使用的标题样式。
- `apps/desktop/src/App.test.ts` 更新为无标题文字并验证收起、展开、焦点交接及筛选保留。
- `tools/ui-layout-e2e.mjs`、`tools/native-ui-e2e.mjs` 移除对旧 h2 的定位依赖，移出主机行时点击工具栏空白处；同步 PRD、架构说明及实施计划。

## 实际验证

- App 与主机树相关测试：2 文件、53 项通过。
- Vue/TypeScript 检查、Vite 生产构建、ESLint、修改代码的 Prettier、两份脚本语法检查及差异检查通过。
- 浏览器布局套件四组通过：1440×900 深/浅主题、900×600 深色、390×844 浅色。检查顶部没有文字、图标靠左居中、鼠标收起和 Enter 展开、键盘焦点、搜索及主机操作。已查看桌面和窄屏截图，结果位于 `.local/remove-host-heading/layout/`。
- Windows Tauri debug 测试配置与普通配置构建通过；真实 WebView2 中顶部文字已消失，收起、Enter 展开和焦点交接已通过。完整原生套件未通过：停在旧的“关闭其他标签”按钮定位，当前会话栏已改为菜单操作。本次不将完整套件计为通过。原生截图示例位于 `.local/native-ui-e2e/4fe46209-0b60-4eb6-b889-cf2edd6ea2dd/header-host-toggle.png`。

普通配置程序：`.local/remove-host-heading/ServerDeck.exe`，与构建输出 SHA256 一致：`28ADDFEEF32E08A333FFA878C86EA1E4309827AA2BCBF27954DDA8746057DB7A`。未安装或替换用户正在运行的程序；原生验证只使用隔离测试数据。

## 限制与依赖

本次为标题文字删除，未重跑 Rust 单元测试、真实远端连接、其他平台或 Release 安装包；Vite 仍有既有 Monaco 大 chunk 提示。未发现本次变更新增的功能风险，无后续实现依赖。完整原生套件需使用与当前会话菜单一致的验收脚本重跑。本阶段完成后停止。
