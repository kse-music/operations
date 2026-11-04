# 服务器管理整合验证（2026-11-03）

## 2026-11-04：统一为五个标准插件

原生提供者方案已被五个独立 .sdplugin/WASM 替代。ServerView 只列出标准 server 贡献，实际功能在普通插件工作区中，通过公开 UI v2/SDK 进入本包 WASM，再调用受控 Host。系统和上传同一管理列表、来源标签、初始禁用/未授权、统一启停与卸载；标准进程/日志联动查找已授权提供者。资源分类复用同一采样器，详情晚到/失败、日志离页关闭、表格滚动及危险确认继续回归。上传资源包也在相同菜单打开同样的监控视图。

四组 Edge 浏览器及真实 Linux 标准 WASM 数据链路通过；全部证据、编译、单测、真实 IPC 和未验证范围见 [插件验证记录](../plugins/PLUGIN_TEST_REPORT.md)。下文为早期统一视图历史，当前实现以标准插件设计为准。

## 完成功能与主要文件

- `ServerView.vue` 与 `types/server.ts`：统一服务器管理入口，九个分类 Tab，仅显示当前内容，支持键盘导航和每台主机独立保存运行内分类。
- `App.vue`、`HostTools.vue`、`TerminalPane.vue`、`TerminalsView.vue`、workspace/product/navigation：接通主机工具栏、终端右键与全局搜索；保留实际连接端点提示。
- `MonitorView.vue`：概览、磁盘、网络分开；系统信息、每核心 CPU 与警告使用 Modal；资源 Tab 复用采样，进入运维暂停。
- `OperationsView.vue`、`OpsDetails.vue`、`OpsTable.vue`：详情、能力、探测和反馈弹窗；进程常用字段与折叠完整状态；详情关闭后忽略晚到结果；离开日志分类关闭流；表格限制高度并恢复分类各自的排序默认值。
- `styles/server.css`：分类条、紧凑指标与趋势、固定高度列表及响应式布局。危险操作输入确认、稳定进程身份、主机指纹和环境变量遮蔽继续保留。

## 实际验证

1. `npm test`：37 个测试文件、245 项测试全部通过。新增五项服务器管理回归覆盖资源分区与采样复用/暂停、信息弹窗和键盘、关闭后晚到详情、详情失败/分类切换清除、容器日志跳转与离开关闭；既有确认绑定会话及 PID/startTicks/bootId 断言仍通过。全量初跑发现旧菜单数量/名称的两项断言，已按新的三入口契约更新并通过。
2. 最终监控可选参数默认值修正后，重跑 monitor/server 两个文件共八项测试通过。`npm run lint` 全项目严格 ESLint 通过；首次默认值告警已修复。
3. `tools/ui-server-e2e.mjs`：使用本地 Vite、无头 Edge 和内存夹具，验证 1440×900 深色/浅色、900×600 深色、390×844 浅色。九 Tab、系统/进程弹窗、嵌套危险操作确认、磁盘和进程表格内部滚动、无页面横向溢出及零浏览器错误均通过。已查看概览和详情截图。桌面概览无纵向溢出；小窗口优化后页面溢出从 658px 降至 219px，窄屏仍按需纵向滚动，分类条可横向滚动并保持可见。
4. 修改文件的 Prettier 检查、九个新旧 E2E 工具的 `node --check`、限定差异检查通过。差异检查按 Windows CRLF 规则识别行尾；未把换行符当作尾随空格改写整个文件。
5. `node tools/tauri.mjs build --debug --no-bundle`：TypeScript/Vite 生产资源和 Windows Tauri debug 可执行文件构建通过。使用既有 `.local/native-ui-build` 缓存，产物复制到 `.local/server-management/ServerDeck.exe` 并与构建来源校验 SHA256 一致。未停止或替换用户运行中的程序。

测试使用工作区 `.local/server-management/tmp` 作为 TEMP/TMP。构建清单与哈希见 `.local/server-management/build.json`；测试、lint、原生构建日志及截图/浏览器结果 JSON 均位于 `.local/server-management`。浏览器验证启动的服务和进程已退出。

## 限制、风险与后续依赖

未连接用户远端服务器，未执行原生界面到真实 SSH 的端到端验证、破坏性远端操作、Release 安装包或其他平台验收。浏览器数据仅为测试夹具，不表示真实服务器采集结果。更新过的既有原生 E2E 脚本仅做语法检查。

保留既有 Monaco 大 chunk 警告及 Rust 增量缓存无法硬链接时回退复制的提示。未发现新增阻断风险；小窗口仍可能需要少量页面滚动，长列表在自身区域滚动。无新增生产依赖、数据库迁移或阶段依赖；真实服务器验收需用户运行新版并使用其现有连接。本阶段完成后停止。
