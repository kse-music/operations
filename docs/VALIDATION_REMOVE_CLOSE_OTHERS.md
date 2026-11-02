# 移除会话菜单“关闭其它”验收

日期：2026-11-03。

## 完成内容与主要文件

- `apps/desktop/src/views/TerminalsView.vue`：移除“关闭其它”，菜单顺序为“复制、重命名、关闭所有、关闭”。
- `apps/desktop/src/stores/terminals.ts`：移除已无调用的 closeOthers，沿用 close/closeAll 的会话、分屏、取消和错误处理。
- `apps/desktop/src/App.test.ts`、`stores/terminals.test.ts`：验证本地/远端菜单完整顺序、非选中目标的单个关闭与全部关闭、跨主机隔离、分屏焦点、关闭失败保留和布局自动保存。
- `tools/ui-context-e2e.mjs`、`native-ui-e2e.mjs`、`native-terminal-advanced.mjs`：同步菜单断言，清理额外会话改用逐个关闭；同步 PRD、架构、实施计划和决策。

一级工作区标签的菜单保持既有契约，没有修改 Rust、IPC、数据库、权限或依赖。

## 验证结果

- `npm test`：29 个文件、172 项测试通过。
- `npm run build`：TypeScript/Vue 检查及生产构建通过。
- `npm run lint`、本次文件 Prettier 检查、三个验收脚本 Node 语法检查及 `git diff --check`：通过。

## 限制、风险与下一阶段依赖

本轮未运行浏览器及原生远端套件，脚本语法通过不代表原生链路已验证；未重新生成桌面安装包。构建仍有既有 Monaco 大分块提醒，未发现本次新增风险。当前阶段无新增依赖；发布前沿用原生打包与平台验收，本阶段完成后停止。
