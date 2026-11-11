# 终端会话标签菜单验证（2026-11-03）

菜单已移除“关闭其它”（见 [对应记录](VALIDATION_REMOVE_CLOSE_OTHERS.md)），并新增重新连接、断开连接及断线图标，见本文[连接操作验证](#2026-11-11-会话重连断开与断线图标)。当前重连清空旧显示与滚动历史，见[重连清屏验证](#2026-11-11-重连清空终端历史)。以下保留各阶段的实施与验收记录。

## 已完成行为与主要文件

- `apps/desktop/src/views/TerminalsView.vue`：菜单从上到下固定为“复制、重命名、关闭其它、关闭所有、关闭”，关闭所有替换原关闭右侧入口。
- `apps/desktop/src/stores/terminals.ts`：关闭其它按右键目标 ID 保留并激活该标签，已是当前标签时保留原分屏焦点；新增 closeAll，按目标所属主机生成标签快照，逐一复用已有 close，关闭全部会话及分屏。本地设备单独成组，其他主机不受影响。
- `apps/desktop/src/App.test.ts`、`stores/terminals.test.ts`：覆盖菜单顺序、本地和远端未选中右键目标、跨主机隔离、分屏关闭、关闭失败保留与提示、失效菜单目标、分屏焦点及空布局自动保存。
- `tools/ui-context-e2e.mjs` 和四个相关原生验收脚本：同步菜单文案与操作，补充关闭所有与跨主机保留断言，删除关闭右侧验收步骤。PRD、架构、实施计划和决策同步更新。

## 完成标准与实际验证

1. 右键未选中的中间标签，菜单顺序与要求一致；关闭其它只保留并选中该目标，同主机原活动标签关闭，其他主机会话保留。
2. 右键未选中的标签执行关闭所有，关闭同主机全部会话及分屏；成功后清空该主机当前标签和焦点，显示没有打开终端的状态。
3. 关闭失败时保留失败标签并显示错误，继续处理其他目标；关闭其它仍以右键目标为当前标签。所有标签关闭后自动保存空布局。

执行结果：

- 新增回归先在旧实现上失败，确认缺少 closeAll，以及原活动标签关闭失败时没有切换到右键目标的问题；实现后相关应用和 store 回归通过。
- 最终 `npm test`：当前工作区 27 个文件、167 项测试全部通过。测试缓存使用项目内 `.local/session-tab-menu-tmp/`。
- `npm run build`：Vue/TypeScript 检查和 Vite 生产构建通过。
- 全量 `npm run lint`、最终改动的 store 文件 ESLint、九个修改代码文件 Prettier、五个验收脚本 Node 语法检查和相关文件 `git diff --check` 通过。
- 使用隔离无头 Edge 执行浏览器上下文验收：深色 1440×900、浅色 1440×900、深色 900×600、浅色 390×844 四组通过。检查菜单完整顺序、非选中右键目标、关闭所有后目标主机为空且其他主机会话保留，已人工复核菜单与关闭后空状态截图。
- 浏览器结果和截图位于 `.local/session-tab-menu/`；夹具只存在于浏览器内存，不代表真实 SSH 连接验收。临时 Vite 服务与浏览器均已停止。

## 未验证内容、风险与下一阶段依赖

本轮未运行原生 WebView2、真实远端 SSH 或 Linux/macOS 验收，未重新打包桌面可执行文件。原生验收脚本仅通过语法检查，不能视为原生功能已验收。没有修改 Rust、IPC、数据库、权限或依赖，保留工作区已有其他修改。

构建仍有既有 Monaco 大分块警告；本轮没有发现新增功能风险。当前阶段无新增依赖，完成后停止。

## 2026-11-11 会话重命名弹窗布局

- `apps/desktop/src/views/TerminalsView.vue` 为重命名弹窗和表单添加专用样式入口；`apps/desktop/src/styles/terminal.css` 将面板限制为 420px 宽，名称标签与输入框上下排列，输入框铺满正文，底部移除分隔线并缩减留白。输入框沿用主题键盘焦点提示，保存、取消和名称校验沿用原逻辑。
- 标准字号深浅主题实测弹窗为 420×209 逻辑像素；超大字号下高度随文字增长，窄窗口按可用空间收缩，短窗口可滚动访问操作。
- `npm run typecheck`、修改 Vue 文件的 ESLint、Vue/CSS 的 Prettier 检查和 `git diff --check` 通过。`node ../../node_modules/vite/bin/vite.js build`（`apps/desktop` 目录）前端生产构建通过，保留既有编辑器大分块提示；未运行包含系统插件构建的完整桌面构建。
- `node ../../node_modules/vitest/vitest.mjs run --maxWorkers=2 src/App.test.ts src/stores/terminals.test.ts`（`apps/desktop` 目录）：2 文件、98 项通过。首次沙箱内测试在缓存重命名时出现 EPERM，未执行用例；获准在沙箱外重试后通过。
- 隔离无头 Edge 检查 1440×900 深浅主题标准字号、960×600 深色超大字号、390×844 浅色超大字号和 390×280 深色超大字号，共 5 组通过。检查面板宽度与视口边界、无横向溢出、标签位于输入框上方、输入框全宽及自动聚焦；验证 128 字符名称按 Enter 保存、纯空白提交保留原名和弹窗、取消/Esc/关闭按钮均可关闭且保留原名。无未捕获页面异常，已人工检查标准深色和窄窗口超大字号截图。
- 测试脚本、截图和几何结果位于 `.local/qa/terminal-rename/`；首次沙箱内 Edge 启动失败，获准在沙箱外运行后通过。夹具只在浏览器内存中创建未连接会话，不执行真实 PTY/SSH，不写用户配置；临时 Vite 与 Edge 已退出。
- 未重建原生桌面 EXE/安装包，未验证 WebView2 或其他操作系统；原生字体度量仍需实机复核。本次不涉及 Rust、IPC、SDK、数据库、权限、依赖或持久配置变化，未发现新增业务风险，当前阶段无新增后续依赖。

## 2026-11-11 会话重连断开与断线图标

完成标准与实现：

- 会话菜单为“复制、重命名、重新连接、断开连接、关闭所有、关闭”。操作绑定右键目标，不切换活动标签；重连和断开作用于目标标签的全部窗格，其他标签及主机不受影响。
- 断开保留标签、名称、分屏和本地终端历史；任一窗格处于 closed/failed/disconnected，名称前显示红色圆形白横杠图标。重连创建新 Shell，不重放输入或恢复远端进程，继续核验指纹；文件/容器动作与一次性插件终端不可在此重放，主机连接配置变化明确拒绝。
- `stores/terminals.ts` 协调已挂载窗格的连接回调、上传确认/排空及重复操作与关闭互斥；`components/TerminalPane.vue` 复用原连接入口，断开成功清理运行期标识并隔离迟到事件，失败保留原状态并报告原因。`views/TerminalsView.vue`、`styles/terminal.css` 和终端状态/英文词典维护菜单、图标、键盘导航与视口限位。
- 左侧主机树改为单击选中、双击打开，Enter/空格及右键“连接”仍可打开；拖动不触发连接。详见[主机双击验证](../hosts/VALIDATION_HOST_CLICK_CONNECT.md#2026-11-11-主机树双击打开)。

实际检查与结果：

- 首轮针对性回归修正后：5 文件、155 项通过；补充指纹、禁用项导航和断开后的迟到 input/resize/ACK 回归后，完整 `node ../../node_modules/vitest/vitest.mjs run --maxWorkers=2`（`apps/desktop` 目录）64 文件、727 项通过。覆盖本地/SSH、主动断开与自然断线/失败、原窗格重连与失败重试、分屏/跨标签隔离、上传取消/拒绝/失败、禁止动作和票据重放、主机配置变更拒绝、旧代次事件丢弃及断开失败状态恢复。测试服务/xterm 边界使用夹具，不代表真实 SSH 验收。
- `npm run typecheck`、全量 `npm run lint` 通过；前端 `node ../../node_modules/vite/bin/vite.js build` 通过，保留既有编辑器大分块警告。完整测试有既有 jsdom Canvas 未实现提示，未造成测试失败。
- 隔离无头 Edge 的 1440×900 深/浅主题、960×600 深色超大字号、390×844 浅色超大字号及 390×280 深色超大字号共五组通过。检查单击不打开、双击仅打开一个会话、菜单顺序/禁用项、Shift+F10、图标颜色与名称左侧位置、断开保留历史、原标签重连后图标消失、旧事件隔离及自然关闭图标恢复；短窗口菜单可滚动到“关闭”，无页面异常。人工复核标准深色和短窗口截图。
- 浏览器脚本、截图及几何/会话调用结果位于 `.local/qa/terminal-session-connection/`，夹具仅在浏览器内存运行，不调用原生 IPC、连接用户主机或持久化配置；临时服务与浏览器已退出。首次沙箱内 Vitest 缓存重命名 EPERM、Edge 启动失败，均在获准沙箱外运行后通过。
- 最后补充拖动后双击抑制断言，单独重跑 `src/components/host-tree.test.ts` 的 14 项全部通过。修改代码、脚本及相关说明的 Prettier 检查、七个调整脚本的 Node 语法检查、受影响文档相对路径/锚点和 `git diff --check` 均通过；PRD/实施计划保留既有排版，仅修改对应正文。

限制与后续依赖：未重建 EXE/安装包，未执行原生 WebView2、真实 SSH/SFTP 或 Linux/macOS 验收，也未运行 Rust 测试（本次未改 Rust）。当时重连保留历史的行为已由[重连清空终端历史](#2026-11-11-重连清空终端历史)调整；此处保留当时的执行证据。没有新增依赖、数据库/配置迁移或已知新增缺陷；真实远端和跨平台验收依赖授权测试主机及对应运行环境。

## 2026-11-11 断开后光标停止闪烁

- 完成行为：本地/SSH 终端在非 connected 状态停止光标闪烁，xterm 输入控件切为只读，历史仍可查看和复制。重连成功后恢复原闪烁偏好与输入；保持关闭闪烁的用户设置，不写回偏好配置。使用静态光标保留光标所在字符，避免隐藏历史正文。
- `TerminalPane.vue` 在构建显示选项和连接状态同步时统一设置 cursorBlink/disableStdin；`terminal.css` 按状态停止 xterm 光标动画，覆盖远端 DECSCUSR 指令优先于本地选项的情况。相关测试位于 `terminal-lifecycle.test.ts` 和 `terminal-actions.test.ts`。
- 新增回归在修复前 10 项失败，复现断开后仍保留闪烁选项。修复后运行 `node ../../node_modules/vitest/vitest.mjs run --maxWorkers=2 src/components/terminal-lifecycle.test.ts src/views/terminal-actions.test.ts src/components/terminal-clipboard.test.ts src/components/terminal-drop-focus.test.ts src/views/terminal-zoom.test.ts`（`apps/desktop` 目录）：5 文件、98 项通过；独立运行 `src/components/plugin-terminal-dialog.test.ts`：7 项通过。共 105 项，覆盖关闭中/断开/关闭/失败、主动断开重连、闪烁偏好开/关、断线期间更改主题、剪贴板、焦点及插件独立终端。
- `npm run typecheck`、三个修改 Vue/TS 文件的 ESLint、相关修改文件的 Prettier 和 `git diff --check` 通过。`node ../../node_modules/vite/bin/vite.js build`（`apps/desktop` 目录）前端生产构建通过，保留既有编辑器大分块提示。
- 隔离无头 Edge 在 1440×900 深/浅主题和 390×844 浅色超大字号三组通过。真实 xterm DOM 检查连接时 readOnly=false、存在闪烁动画；主动断开/自然关闭后聚焦仍 readOnly=true、animationName=none；重连恢复输入和动画。额外发送远端闪烁竖线 DECSCUSR 指令后再断开，仍不闪烁且光标所在 `X` 字符可见；历史保留、旧代次隔离及会话菜单检查通过。人工复核深色断开截图，无页面异常。
- 脚本、截图及结果位于 `.local/qa/terminal-disconnected-cursor/`，沿用已确认的沙箱外测试方式；浏览器仅使用内存夹具，无真实 SSH/PTY、原生 IPC 或用户配置写入，临时浏览器与服务已退出。
- 本轮未重建桌面 EXE/安装包、未运行全量前端或 Rust 测试，未执行真实 SSH/原生 WebView2/其他平台验收；本次未改 Rust、IPC、持久数据或依赖，保留工作区其他修改。未发现新增缺陷，当前阶段无新增实现依赖；原生验收需对应运行环境。

## 2026-11-11 重连清空终端历史

完成行为与主要文件：

- 本地/SSH 会话重连在新 Shell 输出前清除旧画面、滚动历史、正常/备用屏幕缓冲、选区和控制模式，并关闭查找、清空查询与装饰；保留同一标签、名称、分屏、xterm 实例、尺寸和显示偏好。目标标签的全部窗格独立重置，其他标签及主机不受影响。
- 主动断开仍保留历史供查看/复制；关闭旧连接失败不重置画面或替换连接。重连的新连接失败保持标签和错误供重试。重置只写入本地 xterm，不向远端 Shell 发送控制命令。
- 原因是既有 connect 只替换 Session，未重置复用的 xterm。实现采用输出队列中的 CAN + RIS：先取消可能未完成的控制序列，再执行完整重置；排在已接收旧输出之后、新连接输出之前，避免直接同步 reset 后旧排队输出再次出现。旧代次接收事件继续由 generation 丢弃。
- 主要修改为 `apps/desktop/src/components/TerminalPane.vue`、三个组件/视图测试文件和 `tools/ui-terminal-reconnect-e2e.mjs`；同步 PRD、架构、使用说明、实施计划及验证索引，保留工作区既有修改。

实际验证：

- 修复前运行 `src/views/terminal-actions.test.ts`，23 项中三项失败：本地/SSH 重连及目标分屏均未重置输出。修复后相关八文件、191 项通过：`npm run test -w @serverdeck/desktop -- --maxWorkers=2 src/views/terminal-actions.test.ts src/components/terminal-lifecycle.test.ts src/components/terminal-clipboard.test.ts src/components/plugin-terminal-dialog.test.ts src/components/terminal-drop-focus.test.ts src/components/terminal-zmodem.test.ts src/stores/terminals.test.ts src/App.test.ts`。使用根目录 `.local/qa/terminal-reconnect-reset/tmp` 的 TEMP/TMP；覆盖断开保留、重连清屏、旧代次数据隔离、同实例/标签保留、分屏目标隔离、关闭失败保留原画面、连接失败/重试、光标/剪贴板/上传及动作/票据重放限制。
- `npm run typecheck`、`npm run lint` 和 `npx vite build`（apps/desktop）均通过。前端构建仍有既有 Monaco 大分块提示；未执行 Cargo/原生 EXE/安装器构建，本轮未改 Rust、IPC、SDK、数据库或配置格式。
- `node tools/ui-terminal-reconnect-e2e.mjs` 在沙箱外独立 Vite + 无头 Edge 中三组通过：深色本地正常屏幕、浅色 SSH 正常屏幕、深色 SSH 备用屏幕。使用真实 xterm 及其公开 buffer API，预置 150 行旧历史、选区、应用光标/Bracketed Paste 模式、排队旧输出及未完成 OSC；断开后历史和选区保留，重连后两个缓冲无旧标记、正常屏幕激活、baseY=0、选区为空、控制模式复位，新提示符正常显示。再由连接状态下的会话菜单直接重连，上一连接的提示符同样清除，标签仍只有一个。重置过程中 transport input 调用为零。
- 浏览器仅用内存传输夹具，不连接真实 SSH/PTY、不访问用户配置；结果和三张截图位于 `.local/qa/terminal-reconnect-reset/`。人工复核备用屏幕重连截图，新提示符从首行开始，未显示旧历史；浏览器及临时服务已退出。
- 本轮代码/测试/脚本和相关正文的 Prettier 检查、脚本 Node 语法检查、350 个相关本地文档链接及新增锚点、`git diff --check` 通过；实施计划沿用原有表格排版，仅修改对应状态和证据链接。

未验证、风险与依赖：未执行原生 WebView2、真实本地 PTY/SSH、macOS/Linux 或安装器验收，未运行本轮全量前端/Rust 测试。已知剩余风险是原生运行环境差异；重连清屏是本轮明确的产品行为，旧显示不会保留到新连接。后续实机复核依赖重建并启动新版原生客户端和授权测试环境；无新增实现依赖，本阶段完成后停止。

## 2026-11-11 重连操作仅对已结束会话可用

- `stores/terminals.ts` 的 `canReconnect` 改为 closed/failed/disconnected 白名单；目标标签全部窗格都满足才允许重连。已连接、未连接、准备/连接/认证中、等待指纹确认、关闭中及未知状态均拒绝，混合状态分屏也拒绝。菜单沿用该判断显示置灰，store 执行入口也校验，无法通过直接调用绕过。文件/容器动作及插件票据仍禁止重放。
- `stores/terminals.test.ts` 与 `views/terminal-actions.test.ts` 新增状态表、混合分屏和禁用项点击/直接调用断言；同步既有重连回归先进入断开状态，保留上传保护、清屏、失败重试、指纹及配置变更校验。`tools/ui-terminal-reconnect-e2e.mjs` 同步验证已连接时禁止重连、断开后恢复；上一节直接从已连接状态重连的证据属于此前实现。
- 新回归先在旧实现失败四项，复现 connected/idle/未知状态及混合分屏被放行。修复后在 `apps/desktop` 运行 `node ../../node_modules/vitest/vitest.mjs run --maxWorkers=2 src/stores/terminals.test.ts src/views/terminal-actions.test.ts src/components/terminal-lifecycle.test.ts src/App.test.ts`：4 文件、180 项全部通过。最后加强一次性动作在断开状态下仍被拒绝的断言，单独重跑 `src/views/terminal-actions.test.ts`：30 项通过。
- `npm run typecheck`、三个修改 TS 文件的 ESLint、修改代码/脚本及相关说明的 Prettier、脚本 Node 语法、受影响文档链接/锚点和 `git diff --check` 通过。前端 `node ../../node_modules/vite/bin/vite.js build` 通过，保留既有编辑器大分块提示；构建前 D 盘约 145.6 GiB 空闲。
- 隔离无头 Edge 三组通过：深色本地正常屏幕、浅色 SSH 正常屏幕、深色 SSH 备用屏幕。真实 xterm 检查已连接菜单项 disabled，原生按钮 click 和直接 store 调用均不增加连接或关闭调用；打开菜单后注入远端断开事件，菜单自动恢复可用，重连正常清屏。结果、截图和执行脚本位于 `.local/qa/terminal-reconnect-gate/`，旧清屏证据目录未覆盖；已人工复核置灰截图。仅用浏览器内存夹具，不访问用户配置、真实 SSH 或 PTY；浏览器和临时服务已退出。
- 本次未改 Rust、IPC、SDK、数据库、配置格式或依赖；保留其他已有修改。未重建 EXE/安装包、未执行真实 SSH/原生 WebView2/跨平台或全量前端/Rust 测试。未发现新增缺陷，无新增实现依赖；原生复核需对应客户端与测试环境。
