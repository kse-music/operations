# 主机总数徽标位置验收

日期：2026-11-02。将主机数量移到主机树“全部主机”文字后。

## 已完成行为与主要文件

- `components/AppNavigation.vue`、`App.vue`：移除“主机管理”上的终端数量徽标及不再使用的 terminals 传参。自动运维任务徽标保持原有行为。
- `components/HostSidebar.vue`、`styles/hosts.css`：在“全部主机”后同排显示数量徽标，直接使用已保存的 `catalog.hosts.length`；新增/删除后随目录刷新更新，搜索及收藏筛选不改变总数。已加载空目录显示 0，未读取到目录时不显示数字。
- `components/navigation.test.ts`、`components/host-tree.test.ts`：验证导航徽标移除、任务徽标保留、总数随新增/删除变化、筛选无匹配仍保留总数及空/未加载状态。
- `tools/ui-layout-e2e.mjs`、`tools/native-ui-e2e.mjs`：增加实际位置、筛选与真实 IPC/SQLite 变更后数量检查；同步 PRD 和实施计划。本次没有 Rust、IPC、数据库、配置或依赖变化。

## 完成标准与实际验证

1. 数字位于“全部主机”右侧同排，左侧“主机管理”不显示数量：组件测试、浏览器相对坐标检查和原生 DOM 检查通过，已人工核对浏览器截图。
2. 统计已保存主机总数，独立于筛选和终端会话：组件检查 2→3→1→0 及未加载状态；浏览器目录 60 台、搜索无匹配及仅收藏时徽标仍为 60；原生默认已有本地终端但主机数为 0。
3. 真实配置变更后数量正确：原生创建后显示 2，删除后显示 1，导入后显示 2，清理后显示 0；导航、搜索、编辑/删除、分组、工作区和空名称主机回归继续通过。

执行结果：

- 相关应用、主机树和导航测试 38 项通过；前端全量 Vitest 27 文件、137 项通过。
- Vue/TypeScript、Vite 生产构建、ESLint、修改文件 Prettier、两份脚本 Node 语法检查和 `git diff --check` 通过。
- 浏览器布局检查四组通过：1440×900 深/浅、900×600 深、390×844 浅；验证数量位置、筛选与原布局无溢出。页面内夹具不计为真实远端验收。
- Windows Tauri debug 测试/普通配置构建通过；原生 WebView2 完整套件 13 组场景通过，包含新增主机数量断言。

## 产物与边界

浏览器截图/结果位于 `.local/host-count/layout/`，原生结果位于 `.local/native-ui-e2e/821d8d3c-a8c1-4021-8c6f-22b07bef105e/`。原生使用专属测试程序、应用标识及 UUID 数据目录，修改前核对 app_bootstrap.dataDirectory，只操作脚本自己的数据；未修改用户已有主机或凭据。临时本机预览服务已停止。

普通配置程序为 `.local/host-count/ServerDeck.exe`，已与普通构建输出核对 SHA256 一致：`F95A1BD2DB26D07CBF81C6812705A2868372574FC1819BEE1246CD9D0B823C84`。未安装或替换正在运行的客户端。

本次未重跑真实远端和 Linux/macOS 原生验收；Rust 未修改，未重复执行 Rust 单元测试，也未构建 Release 安装包。构建保留既有 Monaco 大 chunk 提示。未发现本次变更新增风险，无后续实现依赖，本阶段完成后停止。
