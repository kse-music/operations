# 实施计划中的独立验证记录归档

本文件是文档整理时从旧实施计划转存的固定历史证据：原条目没有指向独立验证报告，保留其原始环境、数量、产物路径、失败和未执行项。正文中的“当前”“本轮”仅指原记录日期，不表示当前版本支持或本次重新验证。

已有独立报告的阶段继续使用[验证索引](../README.md)，不在这里复制。此归档不再追加新开发记录；新证据按模块写入对应报告。当前需求和状态见[PRD](../../product/PRD.md)及[实施计划](../../product/IMPLEMENTATION_PLAN.md)。

## 通知文字选择与复制（2026-11-04）

- 2026-11-04：右下角提示文字支持拖选与 Ctrl+C 复制。仅在 product.css 的提示文字区域恢复鼠标命中，显式设置文本选择与光标；沿用原有通知、去重及关闭逻辑。PRD 与 ui-errors-e2e.mjs 同步，完成标准为普通页面、长中文/Unicode 换行及原生弹窗内提示均可拖选并触发正确文本的复制事件，关闭不影响弹窗。回归先复现修复前选择为空，修复后 15 组 Edge 浏览器场景、通知相关 2 文件/4 项单测、TypeScript/Vite、全项目严格 ESLint、修改文件格式/脚本语法与差异检查通过；单测首次受沙箱临时文件 EPERM 阻断，沙箱外复验通过。浏览器复制事件由测试拦截，未改写用户系统剪贴板；未运行桌面 WebView2 实际剪贴板或跨平台验收，未重打包桌面程序。证据位于 .local/error-notifications；保留既有 Monaco 大包提示，未发现新增风险，无下一阶段依赖，本阶段完成后停止。

## 13A-4 阶段验证（2026-11-04）

- 2026-11-04：13A-4 已完成。真实管理页、安装预览摘要绑定、五类贡献、声明式安全渲染器、连接/权限撤销/dirty 生命周期及插件中英/主题支持已交付。主要文件为 PluginView/PluginsView、plugins/workspace stores、PluginLog、公开 UI schema 与 host-info 示例，21 项 IPC ACL。Rust 201 项、前端 44 文件/292 项、fmt/check/标准 Clippy/ESLint、类型/Vite/Windows 构建及隔离 WebView2 + Linux 五组 UI 场景通过。任意 Web UI/签名发行/跨平台客户端未支持或未验证，详见 PLUGIN_UI_EXTENSION/DEVELOPMENT/TEST_REPORT。按授权进入 13A-5，依赖公开 SDK、受控写入/审批和日志能力。

## 欢迎页按钮居中（2026-11-02，用户追加授权）

在 `apps/desktop/src/styles/main.css` 为欢迎页的直接子级 `.action-row` 设置 `justify-content: center`，将“打开本地终端”和“新建主机”按钮作为一组水平居中，沿用原按钮事件和窄窗口换行规则。生产构建、24 项应用回归、样式格式和差异检查通过；Edge 在 1440×900 深色、900×600 浅色、390×844 浅色下验证两按钮同排、组合中心偏差为 0 且不溢出，截图和结果位于 `.local/welcome-buttons`。未执行原生或跨平台实机检查，未发现本次样式变更的剩余问题，无新增阶段依赖；本阶段完成后停止。

## 主机搜索框聚焦描边（2026-11-02，用户追加授权）

在 `apps/desktop/src/styles/hosts.css` 仅为 `.sidebar-search:focus-visible` 取消 outline，去掉主机搜索框聚焦后的额外矩形粗描边，保留搜索图标、原有 1px 容器边框和 focus-within 颜色反馈；其他控件的键盘聚焦样式继续使用原规则。生产构建、11 项主机树回归、样式格式与差异检查通过；Edge 深浅主题下鼠标和键盘聚焦均无额外描边，输入正常、布局不变，其他按钮仍有聚焦描边。截图和结果位于 `.local/host-search-focus`。未执行原生或跨平台实机检查，未发现新增问题，无新增阶段依赖，本阶段完成后停止。

## 主导航入口改名为主机管理（2026-11-02，用户追加授权）

`AppNavigation.vue` 的“主机工作区”改名为“主机管理”，同步可见名称、悬浮提示、可访问名称及主机侧栏名称，并将批量、监控、SFTP、Linux 运维的入口提示统一指向主机管理。PRD 明确主机管理入口继续打开已有主机工作区，主机配置在树内管理。同步应用与导航回归断言、共享浏览器导航及原生/布局脚本的定位名称；仍断言只存在一个主机管理入口，旧入口名称和独立配置列表页不存在。

全量前端 27 个文件、137 项测试，TypeScript/Vite 生产构建、ESLint、修改文件 Prettier 和差异检查通过，构建保留既有大块产物提示。本轮未运行浏览器、原生 E2E 和跨平台实机检查；无 Rust、IPC、数据库、配置或依赖变更，未发现新增风险，无新增阶段依赖，本阶段完成后停止。

## 自动化菜单改名为自动运维（2026-11-02，用户追加授权）

修改 `apps/desktop/src/types/product.ts` 的统一语言映射，将“运维自动化”改为“自动运维”，由既有映射同步应用到主导航、悬浮提示、可访问名称、工作区标题及全局搜索。更新导航文字与任务数量断言、`native-automation-e2e.mjs` / `native-product-e2e.mjs` / `ui-pages-e2e.mjs` 的定位文案，并同步 PRD。

导航、全局搜索、应用和工作区共 4 个测试文件、39 项测试通过；TypeScript/Vite 生产构建、修改代码 ESLint 及差异检查通过。Prettier 检查发现 product.ts、native-automation-e2e.mjs、ui-pages-e2e.mjs 的已有格式问题，对应 HEAD 版本同样未通过，未夹带整文件格式化；其余两份修改代码/脚本格式检查通过。未运行浏览器、原生 E2E 或跨平台实机检查；无接口、数据库、配置或依赖变化，无新增功能风险或阶段依赖，本阶段完成后停止。

## 修复侧栏拖动保存小数宽度报错（2026-11-02，用户反馈）

已复现：指针从 324.25 移到 375.75 时，原宽 248 计算出 sidebarWidth=299.5，Rust AppConfig 的 u16 字段拒绝该 JSON，application store 显示“操作未完成，请重试并检查本地应用日志”。修改 `App.vue`，以同一个 clampSidebarWidth 对拖动预览和保存边界取整并限制 200–400，键盘继续每次 8px；保持后端整数契约及已有保存失败提示。

`App.test.ts` 增加小数坐标、上下界及键盘回归，检查预览值、实际提交值、保存后的状态/布局和无错误提示；`crates/core/src/lib.rs` 增加真实 serde 契约测试，确认小数拒绝、整数接受。修复前回归复现同一通用报错，修复后全量前端 27 个文件、141 项测试通过，Rust 定向契约测试、TypeScript/Vite 构建、修改代码 ESLint、Prettier、Rustfmt、core 全目标 Clippy 及差异检查通过。架构文档补充取整边界，无 IPC、数据库或依赖变化。

未运行原生 WebView2、真实系统缩放/混合 DPI 和跨平台实机拖动验收；前端用实际 App/Pinia 和保存流程，在 IPC 测试边界按整数契约拒绝小数，Rust 测试单独验证真实反序列化。未发现本次修复剩余问题，无新增阶段依赖；本阶段完成后停止。

## 移除主机工具栏右侧连接信息（2026-11-02，用户追加授权）

按截图移除 `App.vue` 的 workspace-context 整个展示区：主机名称、账号/地址/端口、连接状态和“诊断连接”入口。workspace-header 仅显示 Shell、SFTP、监控和 Linux 运维工具，本地设备仅显示 Shell；实际主机信息和连接状态继续由终端窗格展示。清理 `styles/product.css` 中该区域的专用布局与响应式规则，保留配置变化、错误和信任确认等提示。

同步 App 回归与 ui-context 脚本的缺失区域/四个工具断言；native-product 脚本改用现有 Linux 运维入口和终端“诊断连接异常”入口，清理对被移除区域的依赖，实际预填目标与连接隔离断言保留。同步 PRD 和架构文档，无 Rust、IPC、数据库、配置或依赖变更。

App/HostTools 共 32 项回归、TypeScript/Vite 构建、修改代码 ESLint、Prettier、脚本 Node 语法及差异检查通过。独立 Edge 页面以只读内存夹具检查四组尺寸/主题（1440×900 深/浅、900×600 深、390×844 浅），远程和本地工具栏均不存在旧信息区，远程终端仍展示正确账号端点，无横向溢出或页面脚本错误；截图与结果位于 `.local/remove-workspace-context`。原生 WebView2、真实 SSH 和跨平台实机未复测，更新的完整原生/上下文套件未运行，不将浏览器夹具检查等同于原生验收。未发现新增问题，无新增阶段依赖；本阶段完成后停止。

## 运维任务库模板布局优化（2026-11-03，用户追加授权）

`AutomationView.vue` 将常用模板的连续纵向内容改为独立卡片，标题、完整正文预览和底部“使用模板”按钮分区显示；空结果提示单独留白。`styles/operations.css` 增加卡片内间距、20px 网格间距和 132px 可滚动正文预览，根据实际工作区宽度切换三列、两列或单列，窄窗口使用 16px 间距。保留原生模板展开/收起、模板完整内容和编辑器入口；按钮保留包含模板名称的可访问名称，正文支持键盘聚焦滚动。

完成标准为模板边界清晰、按钮不紧接下一标题、长正文不撑宽页面、深浅主题和窄窗口正常，以及使用模板只打开完整编辑草稿、不自动执行。新增模板正文/脚本类型/参数保留和不启动执行的回归，自动化定向 5 项测试、TypeScript/Vite 生产构建、修改代码 ESLint、Prettier 和差异检查通过；构建保留既有大块产物提示。Vitest 使用本项目 `.local/automation-template-layout/tmp` 临时目录，避免沙箱系统临时目录的文件重命名限制。

独立无头 Edge 使用从 Rust 定义读取的八个模板作为内存渲染夹具，验证 1680×1320 深/浅、1440×1000 深、1100×900 深、900×700 深和 390×844 浅六组：列数为 3/3/3/2/2/1，卡片等高、无重叠、无页面或正文横向溢出、Docker 长正文可滚动，模板编辑器预填正确，键盘展开/收起和筛选空结果正常，无页面脚本错误或执行/保存调用。已人工查看深浅主题和窄窗口截图，截图、脚本与结果位于 `.local/automation-template-layout`。浏览器检查未访问真实后端、持久配置或远程服务器；原生 WebView2、真实 SSH 和跨平台实机未复测。无 Rust、IPC、数据库、配置或依赖变化，未发现新增风险，无新增阶段依赖；本阶段完成后停止。

## 移除顶部品牌栏并增加关于菜单（2026-11-03，用户追加授权）

按截图删除应用内 ServerDeck 标志、名称及固定 v0.1 版本整行；应用网格取消 48px 顶部行，主导航、主机栏、工作区及侧栏拖动区域从内容区顶部开始，窄窗口浮动主机栏同步调整。保留系统标题栏。主导航底部新增“关于”，复用 Modal 展示产品说明、技术栈及既有 bootstrap 提供的实际应用版本；后端未就绪、初始化中均显示明确状态。打开弹窗不切换工作区，关闭按钮、右上角关闭和 Esc 均可关闭，关闭后焦点返回“关于”。

主要修改为 `App.vue`、`components/AppNavigation.vue`、`styles/main.css`、`styles/product.css`；同步 `App.test.ts`、`components/navigation.test.ts`、`tools/ui-layout-e2e.mjs`、`tools/native-ui-e2e.mjs` 与 PRD。完成标准为品牌栏及占位消失、关于内容与版本来源正确、未就绪状态可用、工作区不变、关闭及键盘焦点正常、深浅主题和窄窗口无溢出。

全量前端 29 文件、174 项测试通过；浏览器发现关闭后焦点未恢复，修复后 App/导航定向 47 项测试通过。独立无头 Edge 四组检查（1440×900 深/浅、900×600 深、390×844 浅）通过，检查顶部区域坐标为 0、无横向溢出或导航溢出、弹窗内容与 Esc/焦点、原主机栏收起展开及树操作，无页面脚本错误；使用只读内存渲染夹具，未连接真实后端或远程服务器。已人工查看深色、浅色及窄窗口截图，产物与结果位于 `.local/remove-brand-about`。ESLint、修改代码 Prettier、两份脚本 Node 语法检查和差异检查通过。

首次 TypeScript/Vite 生产构建通过，保留既有 Monaco 大 chunk 提示；最后复查时工作区同时出现非本任务的 `TerminalPane.vue` / `TerminalsView.vue` 改动，构建被 `TerminalsView.vue:147` 的 TS7022（size 隐式 any）阻塞。本次未修改或回退这些终端改动，不将最终工作区构建宣称为通过。未运行原生 WebView2、真实 SSH 或其他平台验收，未构建新的原生程序或安装包；原生脚本只完成同步及语法检查。无 Rust、IPC、数据库、配置或依赖变化，本次界面未发现剩余问题；后续整体打包依赖并行终端改动修复类型错误，无其他新增阶段依赖。本阶段完成后停止。

## 终端 Ctrl+鼠标滚轮缩放（2026-11-03，用户追加授权）

已在终端内容区捕获 Ctrl+纵向滚轮，向上放大、向下缩小，每次调整 1，复用原全局字号设置及 10–32 范围。设置保存后同步更新所有已挂载的终端并复用原 fit/resize 流程；连续滚动在保存期间合并目标字号，逐步限制上下界，保存失败显示既有错误气泡并保留已保存字号。达到边界时不重复写配置。普通滚动和终端鼠标协议继续由 xterm 处理；隐藏终端、打开的弹窗、终端内容区外和纯横向滚轮不触发字号调整。底部操作提示补充 Ctrl+滚轮入口。

主要修改 `apps/desktop/src/components/TerminalPane.vue`、`apps/desktop/src/views/TerminalsView.vue`，新增 `apps/desktop/src/views/terminal-zoom.test.ts`，同步 PRD §7.3。本轮同时解决上节所记录的终端队列局部变量 TS7022，最终工作区 TypeScript/Vite 生产构建已通过。

验证：全量前端 30 文件、182 项测试通过，新增 8 项覆盖缩放方向、全局同步及 fit、普通/横向/区域外滚动、隐藏/弹窗保护、上下边界、保存中的连续操作与方向切换、原键盘快捷键、保存失败及重试；生产构建包含 vue-tsc 检查，ESLint 和三个修改代码文件的 Prettier 检查通过。独立无头 Edge 使用真实 xterm 与隔离的内存会话/保存夹具，验证两窗格渲染字号同步、resize 调用、页面及设备缩放比例不变、普通滚轮确实滚动历史，以及鼠标上报模式下普通滚轮产生终端输入而 Ctrl+滚轮不产生输入，未出现页面脚本错误。脚本、截图和结果位于 `.local/terminal-zoom/`。Vitest 初次受沙箱临时文件重命名权限影响，进程 TEMP/TMP 指向该任务目录后通过；Edge 沙箱内启动失败，隔离测试在获批的沙箱外环境通过，测试服务与浏览器均已退出。

未执行原生 WebView2、真实 SSH/本地 PTY、设置落盘重启和其他平台验收，未构建原生程序或安装包；浏览器夹具不作为这些验证的替代。已知保留原有 Monaco 大 chunk 构建提示；本次未发现其他剩余问题。无 Rust、IPC、数据库、配置结构或依赖变化，无新增阶段依赖，本阶段完成后停止。

## 设备工具区固定在全部主机下方（2026-11-03，用户追加授权）

将截图中的设备名称与工具区从主机管理标题下方移至“全部主机 / 收藏”筛选栏下方、主机分组列表上方。`App.vue` 改为向 `HostSidebar.vue` 提供 tools 插槽，插槽位于固定筛选控件之后、`.host-tree-scroll` 之外，复用原有不收缩的工具区样式；`AppNavigation.vue` 删除不再使用的 tools 插槽。沿用当前设备上下文和原导航事件，本地显示“本地设备 / 本地终端”，远程显示当前主机及对应工具，不改变连接行为或新增持久化状态。搜索无结果或切换收藏筛选不会移除设备工具区。

完成标准为设备工具位于筛选栏与分组列表之间、实际滚动长列表后坐标不变、过滤空结果时仍可使用，且本地与远程入口继续作用于原目标。主要修改 `App.vue`、`components/HostSidebar.vue`、`components/AppNavigation.vue`；同步 App 回归、`tools/ui-layout-e2e.mjs`、原生脚本位置断言和 PRD。

验证：App 与主机树共 64 项测试通过，新增本地/远程位置、过滤空结果及点击目标回归；TypeScript/Vite 生产构建、ESLint、修改代码 Prettier、脚本 Node 语法及差异检查通过。独立无头 Edge 在 1440×900 深/浅、900×600 深、390×844 浅四组通过：实际滚动非空长主机列表后工具区矩形保持不变，搜索与收藏过滤后仍可见，无页面脚本错误或横向溢出。浏览器使用内存布局夹具，不连接真实后端或远程服务器，预览中的未连接提示不作为正式功能；已人工查看深色及窄窗口截图，产物位于 `.local/device-tools-pinned`，临时浏览器与服务均已结束。

未运行原生 WebView2、真实本地/远程连接或跨平台验收，未构建新的原生程序或安装包；原生脚本仅同步断言并完成语法检查。保留既有 Monaco 大 chunk 构建提示，本次未发现新增风险。无 Rust、IPC、数据库、配置或依赖变化，无新增阶段依赖，本阶段完成后停止。

## 纠正启动行为、常驻本地菜单和主机管理标题（2026-11-03，用户纠正）

替代上一节将本地区域视作当前设备上下文的实现。启动只显示欢迎页，不自动打开终端；保留布局恢复，但恢复的本地与远端窗格均为 idle，不请求连接。“本地设备 / 本地终端”是 HostSidebar 内置的常驻菜单，固定在全部主机筛选栏之后、滚动列表之前，不依赖当前主机、工作区是否打开或搜索/收藏结果。点击本地终端显式使用空 HostId 打开或复用本地 Shell；远端工具使用独立插槽，切换远端不会替换本地入口。“主机管理”改成无图标的静态 strong 标题，移除 workspace 事件和对应导航处理，收起按钮继续可用。

主要修改 `App.vue`、`components/HostSidebar.vue`、`components/AppNavigation.vue`、`styles/product.css`；同步 App/导航回归、共享 UI 导航、浏览器布局及原生 UI/终端/基础脚本，更新 PRD、ARCHITECTURE、DECISIONS 和 USER_GUIDE。完成标准为冷启动及已有布局重启均只显示欢迎页、无已连接终端，本地菜单在欢迎页/本地/远端和筛选空结果下常驻且滚动固定，点击后打开本地会话并可复用，静态标题不响应点击或键盘导航。

验证：全量前端 32 文件、205 项测试通过；包含真实 App/Pinia 的后端就绪初始化流程、空布局与已保存本地布局、连接请求状态、本地菜单目标和重复点击、静态标题及原主机导航回归。TypeScript/Vite 生产构建、ESLint、修改代码 Prettier、五份脚本 Node 语法和差异检查通过。独立 Edge 四组尺寸/主题（1440×900 深/浅、900×600 深、390×844 浅）通过，覆盖欢迎页、静态标题、远端时本地菜单仍可见、实际滚动位置固定、搜索/收藏空结果与显式点击打开。首次浏览器检查暴露验收脚本仍依赖旧标题点击选中主机，改为显式点击主机树后四组通过。浏览器仅为内存渲染检查，不作为真实后端验收证据，产物位于 `.local/welcome-local-menu`。

Windows 两种配置 Tauri debug 构建及独立 WebView2 的 16 项原生场景通过，包含每次冷启动/重启先等待欢迎页并断言无导航标签、无已连接终端，再显式点击本地菜单运行真实 PowerShell，保留远程恢复 idle、标签/主机配置及模块切换断言。测试使用独立 identifier、核对过的专用数据目录，不修改正式配置；产物为 `.local/native-ui-e2e/bcaf3164-003e-40d8-a81f-561b773fb888`。另外实际拍摄启动欢迎页及点击后的本地终端截图，并验证标题点击不产生标签，位于 `.local/welcome-local-menu/native-welcome.png` 和 `native-local-terminal.png`，测试程序均正常关闭。

普通配置调试程序已复制为 `.local/welcome-local-menu/ServerDeck.exe`，与本轮默认配置构建输出核对 SHA256 一致。未安装或替换用户程序；未构建 Release 安装包，未重跑真实远程 SSH/SFTP 全套或 macOS/Linux 验收。保留既有 Monaco 大 chunk 提示；未发现本次修改新增风险。无 Rust、IPC、数据库、配置结构或依赖变化，无新增阶段依赖，本阶段完成后停止。

## 顶部模块切换保留中央当前页面（2026-11-03，用户澄清）

点击顶部模块只改变顶部高亮和左侧菜单，中央保留当前页面：原终端继续可见和交互，设置、文件、诊断等页面同样保留；没有活动页面时仍显示欢迎页。不显示“请选择功能”卡片，不清空中央页面，不自动选择默认页或恢复另一个模块的最近页面。只有明确点击左侧功能、页面标签或其他导航入口才更换中央内容。此前启动欢迎页、常驻本地入口、静态主机管理标题及连接保护继续有效。

`stores/workspace.ts` 将 module 改为独立的运行内状态，selectModule 不改 active/current/hostId；移除最近模块标签 Map，navigate/activate 继续同步功能归属。`App.vue` 删除功能选择卡片，无活动页时统一显示欢迎页。同步 `App.test.ts`、`stores/workspace.test.ts`、共享 UI 导航、浏览器上下文与原生 UI 脚本，以及 PRD、ARCHITECTURE、DECISIONS、USER_GUIDE。完成标准为切换顶部后原页面和活动标签不变，终端组件/Session/连接请求不变，页面仍可交互，显式导航继续正常，欢迎页不被空白或提示卡替换。

验证：全量前端 32 文件、205 项通过，覆盖欢迎页、终端可见性及组件标识/Session 保留、设置与诊断页面保持、显式菜单/标签跳转、文件面板上下文、关闭标签及不自动建立连接。TypeScript/Vite 生产构建、ESLint、修改代码 Prettier、三份脚本 Node 语法及差异检查通过。独立 Edge 的四组上下文与布局检查通过（1440×900 深/浅、900×600 深、390×844 浅），检查顶部模块切换后原终端保持可见，原文件/诊断草稿和显式切换可用；浏览器夹具仅用于渲染验收，产物位于 `.local/preserve-workspace`。

Windows 测试配置及普通配置的 Tauri debug 构建成功，隔离 WebView2 的 16 个原生场景通过。真实 PowerShell 在工具、资产、系统三个顶部模块下仍可见并继续执行命令，变量 `$sdValue` 保持为 323；显式打开设置后再切顶部仍显示设置，点击本地入口后返回同一 Shell。原生数据目录为 `.local/native-ui-e2e/9ae74e6d-64cd-4818-9011-56402c4f6b67`，已核对 bootstrap 路径，未修改正式数据；`module-without-default.png` 展示系统设置菜单下仍显示终端。临时程序、浏览器与服务均已退出。

普通配置调试程序为 `.local/preserve-workspace/ServerDeck.exe`，与本轮构建输出 SHA256 一致：`B9B1F30AEA61972789386785C3826249D778B73D9AD506583E9D009206BEEE0F`。未安装、替换正在运行的版本或生成 Release 安装包；未复测真实远程 SSH/SFTP 全套及其他平台。保留既有 Monaco 大 chunk 提示，未发现本次修改新增风险。无 Rust、IPC、数据库、配置或依赖变化，无新增阶段依赖，本阶段完成后停止。

## 会话编号在本次打开期间持续递增（2026-11-03，用户追加授权）

终端默认名称不再由当前标签索引生成。`stores/terminals.ts` 按 HostId 在运行内维护递增计数，在创建或恢复标签时分配固定 sessionNumber；本地设备独立计数，关闭单个、最后一个或全部标签不回收编号。`views/TerminalsView.vue` 使用固定编号显示默认名称和关闭按钮的可访问名称，拖动和切换页面不改号，重命名仍沿用原标题逻辑；加号、复制和快捷键统一复用 open。编号不写入 workspace v1，重启时按恢复顺序重新计数，不增加 IPC、数据库迁移、配置项或依赖。

完成标准：打开 1、2、3，关闭 2 后仍为 1、3，新增为 1、3、4；重排后名称固定，自定义名称不变，复制获得新编号，关闭全部后再打开继续递增，各主机互不影响，数量限制拒绝创建不消耗编号。主要修改 `stores/terminals.ts`、`views/TerminalsView.vue`、`stores/terminals.test.ts` 和 `App.test.ts`，同步 PRD 与 ARCHITECTURE。

验证：先添加真实 App/Pinia 渲染回归，在原实现中复现远端和本地删除 2 后错误显示 1、2。修复后两份测试文件共 75 项通过，覆盖上述 UI 操作、主机计数隔离、关闭最后一个窗格、创建超限及布局恢复。TypeScript/Vite 生产构建、全量 ESLint、修改文件 Prettier 和差异检查通过。Vitest 初次被沙箱临时目录重命名权限阻止，进程 TEMP/TMP 改为 `.local/session-numbering/temp` 后正常运行。

未运行原生 WebView2、真实 SSH/本地 PTY 或其他平台验收，未构建原生程序或安装包。保留既有 Monaco 大 chunk 构建提示，未发现本次修改新增风险；无新增阶段依赖，本阶段完成后停止。

## 退出结束会话并取消跨重启终端布局恢复（2026-11-03，用户追加授权）

移除 App 启动的 terminals.restore 调用，以及 terminals store 的 snapshot、restore、saveLayout、initialized 和自动保存计时器。终端标签、名称和分屏只存在于本次运行内，启动与 WebView 重载从空列表开始，用户主动选择本地设备或主机时创建一个新 Shell；本次运行内切换和重复点击继续复用已有会话。确认退出仍走原有应用 shutdown，关闭本地 PTY、SSH 会话和转发；取消退出、传输和未保存文件保护保持原行为。旧版布局记录及底层 IPC 保留兼容，产品不再读写，不删除配置或增加数据库迁移、设置和依赖。

主要修改 `apps/desktop/src/stores/terminals.ts`、`apps/desktop/src/App.vue`、对应 store/App 测试和 `tools/native-ui-e2e.mjs`，同步 PRD、ARCHITECTURE、DECISIONS、USER_GUIDE。完成标准为旧版保存的五个本地/远端标签不再恢复，冷启动无终端，显式打开只有一个新会话且编号从 1 开始；本次运行内会话切换、分屏、重命名和关闭失败处理不回归，主机、分组及设置继续保留。

验证：先补充 App/Pinia 回归，在原实现复现旧版五个本地或远端标签被恢复。修复后全量前端 32 文件、216 项测试通过；TypeScript/Vite 生产构建、全量 ESLint、修改文件 Prettier、原生脚本 Node 语法和差异检查通过。Windows 测试配置和普通配置的 Tauri debug 构建均通过；初次构建因 PATH 缺少 cargo 失败，指定本机既有 D:/rust 工具链后完成。沙箱内无法访问 WebView2 CDP，改用获批的沙箱外隔离程序后 17 个原生场景通过，产物位于 `.local/native-ui-e2e/dce81f2a-63df-48f1-98da-759c7efc10e4`。

原生场景实际打开四个本地 PowerShell 会话及一个远端失败标签，退出前写入旧版五标签布局夹具；经原生窗口关闭和退出确认后进程正常结束，重启先断言无导航标签及无终端窗格，点击本地菜单后只有一个新 Shell，旧变量为空。旧版布局记录仍与夹具一致，远端窗格在显式选择主机前不存在；重复选择不增建，主机/分组的 SQLite 数据保留。沿用隔离 identifier，bootstrap 数据目录与测试目录核对一致，不修改正式配置。测试程序和浏览器均正常结束。

普通配置调试程序为 `.local/terminal-no-restore/ServerDeck.exe`，与构建输出 SHA256 一致：`8F8883CDC508C9DE15392CB07559C092F81AE8B502E60F369E19F8103BAEE825`。未安装、替换正在运行的版本或生成 Release 安装包；未复测真实远程 SSH/SFTP 及其他平台。保留已有 Monaco 大 chunk 提示，本轮原生增量缓存硬链接失败时自动改用复制，构建均完成；未发现本次修改新增风险。无新增阶段依赖，本阶段完成后停止。

## 关闭工作区结束全部会话并在空设备重置编号（2026-11-03，用户追加授权）

一级设备工作区的关闭按钮、中键及右键关闭范围统一进入异步 workspace.close：按目标设备逐个复用 terminals.closeAll/closePane，结束全部终端会话及分屏后移除导航。关闭失败时保留失败窗格、工作区和错误反馈，其他目标继续关闭；关闭期间按 key 去重并禁用对应关闭按钮，零窗格导航清理暂停，避免误删范围外的空工作区。全局功能页关闭、其他设备、SFTP、传输及后台任务保持各自生命周期。

会话仍存在时保留固定编号和该设备的递增计数，中间关闭、重排和重命名不改号；最后一个标签成功移除时清除该 HostId 的计数及最近会话记录，再打开从会话 1 开始。分屏部分关闭失败时只保留失败窗格，成功窗格从布局移除；失败不会重置编号。此行为替代前述导航关闭不结束终端、关闭全部后继续计数的约定。

主要修改 stores/workspace.ts、stores/terminals.ts、App.vue、对应三份测试，更新 tools/native-ui-e2e.mjs 和 ui-layout-e2e.mjs；同步 PRD、ARCHITECTURE、DECISIONS、USER_GUIDE。完成标准为三个关闭入口和全部关闭范围都清理目标设备的所有会话及分屏，保留其他设备和关闭失败项，等待清理结束再移除导航，编号仅在目标设备全部成功关闭后重置。

验证：最终合并状态的前端全量 32 文件、216 项通过，覆盖关闭按钮/中键/菜单、范围和其他设备隔离、局部关闭失败及重试、分屏失败保留、等待关闭完成和重复提交、编号连续/重置/主机隔离。TypeScript/Vite 生产构建、ESLint、修改代码 Prettier、两份脚本 Node 语法和差异检查通过。独立无头 Edge 的四组窗口/主题布局检查通过，产物为 .local/workspace-close；浏览器仅使用内存渲染夹具。

Windows 两种配置的 Tauri debug 构建成功。共享工作区同时进行了取消启动会话恢复的修改，本阶段保留并验证其合并状态；最终独立 WebView2 的 17 项原生套件结果位于 .local/native-ui-e2e/dce81f2a-63df-48f1-98da-759c7efc10e4/results.json。原生检查验证仍有会话时编号从 4 继续到 5，关闭设备标签后全部三个本地 PTY 的旧 ID 调用 terminal_resize 均返回 NOT_FOUND，再打开显示会话 1，且新 PowerShell 不保留旧变量；保留原主机、模块及启动回归。测试先核对专用数据目录，不操作正式配置，测试程序已退出。此前一次资源断言因 Playwright 包装 IPC 错误对象失败，改为在页面内提取错误码；另一次新建 Shell 后发送输入过早，测试现等待真实 sessionId 就绪后再输入，最终套件通过。

普通配置调试程序已保存为 .local/workspace-close/ServerDeck.exe，与本轮默认配置输出 SHA256 一致：8F8883CDC508C9DE15392CB07559C092F81AE8B502E60F369E19F8103BAEE825。未安装或替换用户运行版本；未构建 Release 安装包，未重跑真实远程 SSH/SFTP 全套、Rust 全量测试或 macOS/Linux 客户端验收。保留既有 Monaco 大 chunk 提示，未发现本次修改新增风险。无新增后端接口、迁移、配置或依赖，无新增阶段依赖，本阶段完成后停止。

## 运维工具下的任务中心（2026-11-03，用户选定方案）

将底部“未完成传输”和“后台任务”这两个共用弹窗的入口合并为“运维工具 → 任务中心”。原 BackgroundTasks 内容迁移为 views/TaskCenterView.vue 页面，移除旧组件、taskPanel 状态、底部两个按钮和失效的窄屏按钮样式。新增 tasks 工作区类型、菜单与模块归属，菜单、全局搜索、已打开标签和原 tasks 快捷键统一 navigate，重复打开复用 tasks:；快捷键设置名称同步为“任务中心”，原用户键位不变。

继续复用真实 TransferPanel、files/background/automation store，统一显示文件传输、网络与批量任务、自动化状态，首次读取、空列表及不可用状态明确区分。取消传输沿用 TaskId，查看结果和重试保留原 HostId，停止命令保留目标确认和失败气泡，关闭页面不取消后台任务、停止轮询或关闭已有终端。不新增顶层模块、配置、依赖、IPC、权限或数据库迁移。主要修改 App.vue、AppNavigation.vue、ProductSettings.vue、types/navigation.ts、types/product.ts、TaskCenterView.vue、product.css；同步 App/导航测试、新增 task-center.test.ts、共享导航、浏览器/原生脚本与产品文档。

验证：先以 App 回归复现原底部仍存在两个入口，修改后全量前端 33 文件、222 项通过；覆盖任务菜单、快捷键去重与终端隔离、读取/失败/空状态、指定诊断/批量任务停止确认及失败重试、传输取消/重试目标与结果跳转。TypeScript/Vite 生产构建、ESLint、修改文件 Prettier、四份脚本 Node 语法与差异检查通过。Windows 测试与普通配置的 Tauri debug 构建通过；沙箱内 WebView2 调试连接不可达，使用获批的沙箱外专用测试程序后 18 个原生场景通过，结果与截图位于 `.local/native-ui-e2e/b68b93d7-a7bf-4a17-b96d-59a7f2fd1ce7`。原生实际验证菜单/快捷键打开同一任务中心、底部按钮消失、关闭页面后原 PowerShell 会话及变量继续可用；测试核对专用数据目录，未使用正式配置。

独立无头 Edge 四组上下文与布局场景通过，覆盖 1440×900 深/浅、900×600 深、390×844 浅，任务中心截图位于 `.local/task-center/browser`，已查看原生深色与窄屏浅色截图。初次 Edge 访问沙箱内服务超时，将服务与浏览器放到同一获批环境的回环地址后通过。浏览器使用内存渲染夹具，无真实 Rust 连接或远程操作，不能作为真实传输/远端命令验收；此限制不影响上述独立原生检查。测试程序、浏览器与两个临时服务均已退出。

普通配置调试程序为 `.local/task-center/ServerDeck.exe`，与本轮构建输出 SHA256 一致：`C735B10E41452009B5622F61A9E50F33DFEDFC452FD88D2FA5B92E1470BBCDFD`。未安装或替换正在运行的版本，未生成 Release 安装包；未重跑真实远程 SSH/SFTP、网络批量和自动化全链路或 macOS/Linux 验收，native-product-e2e 仅同步新导航并检查语法。保留既有 Monaco 大 chunk 提示及原生增量缓存硬链接回退复制提示，未发现本次修改新增风险。无新增阶段依赖，本阶段完成后停止。

## 关于入口移入系统设置（2026-11-03，用户确认）

将关于入口从所有模块侧栏底部移入系统设置的 module-menu，固定排在“全局设置、本地环境”之后，名称为“关于 ServerDeck”。AppNavigation 仅在 system 模块显示该按钮，保留原 about 事件及 App 弹窗，不新增工作区视图或标签、不切换当前页面。closeAbout 的焦点目标更新为新菜单按钮，Esc、关闭按钮和版本加载/不可用状态保留；移除未使用的 activity-about 专用样式。主要修改 AppNavigation.vue、App.vue、styles/product.css 及 App/导航测试，更新三份浏览器/原生脚本和 PRD、ARCHITECTURE、DECISIONS、USER_GUIDE。

完成标准为系统设置菜单顺序正确，主机/工具/资产模块不显示关于，侧栏底部无旧入口；弹窗继续显示真实后端版本，打开/关闭不改工作区或会话，关闭后焦点返回新菜单。先以导航回归复现原实现的四模块常驻旧入口，修改后 App 与导航两份测试共 67 项通过，覆盖菜单归属、顺序、版本成功/读取/不可用、Esc 和两个关闭入口、焦点及工作区保持。TypeScript/Vite 生产构建、全量 ESLint、修改代码与文档 Prettier、三份脚本 Node 语法和差异检查通过。

Windows 测试配置与普通配置 Tauri debug 构建通过，隔离 WebView2 的 18 项原生场景通过，产物位于 `.local/native-ui-e2e/7995c416-0542-43d3-b037-1de2a43b24ec`。原生检查确认主机模块无关于入口，切到系统后可打开显示实际 app_bootstrap 版本的弹窗，Esc 后焦点回到新按钮，原 PowerShell 及其他导航回归继续通过。数据目录经 bootstrap 核对，不修改正式配置。独立无头 Edge 四组布局检查通过，覆盖 1440×900 深/浅、900×600 深、390×844 浅，检查系统菜单顺序、弹窗和焦点、返回主机及侧栏布局；产物位于 `.local/about-system-menu/browser`，浏览器仅使用内存渲染夹具。已查看原生关于截图，测试程序、浏览器和临时服务均已退出。

普通配置调试程序为 `.local/about-system-menu/ServerDeck.exe`，与本轮构建输出 SHA256 一致：`6BAB998A831224AB63AC8CD158E7EF88BBB3D1CC6B47E22905E0CB0C3B08D276`。未安装或替换正在运行的版本，未生成 Release 安装包；未重跑前端其余测试、Rust 全量测试、真实远程 SSH/SFTP 或其他平台。保留既有 Monaco 大 chunk 构建提示，未发现本次修改新增风险。无后端接口、数据库、权限、配置或依赖变化，无新增阶段依赖，本阶段完成后停止。

## 关于从弹窗改为独立页面（2026-11-03，用户追加要求）

新增 views/AboutView.vue，在中央工作区展示原产品说明、真实 application.state.appVersion 和技术栈，沿用 page-view、work-section 与 system-details 样式。about 纳入 WorkspaceView 消息字典和 system 模块映射，AppNavigation 系统菜单的最后一项改用普通 navigate；全局搜索沿字典自动提供关于入口。workspace 复用唯一 about: 标签，支持重复进入、切换、关闭和菜单选中状态。移除特殊 about 事件、aboutOpen、closeAbout 及 App 关于 Modal，不再使用弹窗或弹窗关闭按钮；页面关闭沿用工作区规则，保留原终端和后台任务。版本读取中及后端未就绪提示继续保留。

主要修改 AboutView.vue、App.vue、AppNavigation.vue、types/product.ts、types/navigation.ts 和 App/导航测试，同步共享导航、浏览器布局、原生 UI 脚本和 PRD、ARCHITECTURE、DECISIONS、USER_GUIDE。本阶段替代上一阶段保留弹窗的展示约定，不新增后端接口、数据库迁移、配置、权限或依赖。

验证：先以 App 回归复现原实现只打开弹窗、中央无关于页面。修改后 App/导航定向 67 项和全量前端 33 文件、222 项通过，覆盖真实版本/读取中/不可用、无关于 dialog、菜单选中、重复打开去重、标签切换归属、关闭关于恢复终端且不调用 terminal_close。TypeScript/Vite 生产构建、全量 ESLint、修改文件 Prettier、三份脚本 Node 语法与差异检查通过。

Windows 测试及普通配置的 Tauri debug 构建均通过，隔离 WebView2 的 18 个原生场景通过，产物位于 `.local/native-ui-e2e/79a7bf05-1c70-461d-91e3-111c7c74f66a`。原生核对真实 app_bootstrap 版本在关于 region 中显示、无关于 dialog、菜单选中、重复点击只有一个标签、关闭后回到原本地终端；其余主机与任务中心回归保留。bootstrap 核对专用数据目录，不修改正式配置。

独立无头 Edge 四组布局检查通过，覆盖 1440×900 深/浅、900×600 深、390×844 浅，产物为 `.local/about-page/browser`。首次窄屏检查被打开的菜单抽屉挡住页签，脚本调整为按实际交互先收起抽屉、关闭关于页签后再展开侧栏，四组复验通过；未强制穿透点击或修改产品的抽屉规则。浏览器仅使用内存渲染夹具，不作为远程连接验收。已查看原生深色和窄屏浅色关于页面截图，临时程序、浏览器及服务均已退出。

普通配置调试程序为 `.local/about-page/ServerDeck.exe`，与本轮构建输出 SHA256 一致：`6D435F837A85A369E562AFCB60E6507E2AC867054EC9DA9B6B3ACF8068D512D5`。未安装或替换正在运行的版本，未生成 Release 安装包；未重跑 Rust 全量测试、真实远程 SSH/SFTP 或其他平台。保留既有 Monaco 大 chunk 提示，未发现本次修改新增风险。无新增阶段依赖，本阶段完成后停止。

## 页面统一铺满中央显示区域（2026-11-03，用户更正）

移除 styles/main.css 中 .workspace-view 与 .settings-panel 共用的 max-width: 1080px 和 margin: auto，使本地环境、全局设置与关于等其他页面一样铺满中央内容区。保留原 content-scroll 响应式内边距、表单分栏及控件宽度规则，不修改页面文字、导航或业务行为。核查其余样式中的最大宽度均用于控件、提示或弹窗，不属于页面容器，保持原样。主要修改 main.css，同步 PRD 与本计划；不新增抽象、配置、后端接口或依赖。

验证：TypeScript/Vite 生产构建及普通配置 Tauri debug 构建通过，样式/文档 Prettier、临时验收脚本 Node 语法与差异检查通过。独立 Edge 在 2560×1000 深/浅、1440×900 深、900×600 浅、390×844 浅五组下，对全局设置、本地环境、关于三页共 15 项实际几何检查通过：页面左边界和宽度与内容区扣除内边距后的可用范围相等，无横向溢出；2560 宽屏下三页宽度均为 2264px，已超过旧 1080px 限制。结果、截图及临时脚本位于 `.local/full-width-pages`，已查看宽屏设置截图。浏览器仅使用内存渲染夹具，不写入正式配置或发起远程操作；浏览器和临时服务均已退出。

普通配置调试程序为 `.local/full-width-pages/ServerDeck.exe`，与构建输出 SHA256 一致：`5E189E42EF11C6199615F7ABCFFE72DC13131731B4DBEF601AF55D4D01D393EE`。仅修改样式，未重跑功能单测、原生 WebView2 实机、真实远程操作或其他平台验收；未安装、替换用户运行版本或生成 Release 安装包。保留既有 Monaco 大 chunk 提示和原生增量缓存硬链接回退复制提示，未发现本次样式变更新增风险。无新增阶段依赖，本阶段完成后停止。

## 主机工具菜单迁移与文件面板移除（2026-11-03）

按截图将 SSH 终端、SFTP 文件、服务器监控、Linux 运维四项菜单从左侧主机栏移至中央工具栏右侧，替代原文件面板按钮。四个远程主机页面均保留菜单及当前项高亮，本地与全局页面不显示远程工具。继续复用 HostTools、workspace.navigate 和既有主机上下文；终端会话标签与新建按钮仍在左侧，宽屏同排，窄窗口菜单换行并可内部横向滚动。

移除文件面板入口、开合状态、伴随视图及专用样式，FilesView 不再提供 compact 模式。独立 SFTP 文件页保留；终端文件事件改为进入完整文件页，继续传递目录和来源窗格，并保留配置一致性检查。切换工具和主机不关闭已有终端、SFTP 或传输，沿用原指纹验证、上传覆盖与危险操作确认。主要修改 App.vue、HostSidebar.vue、workspace.ts、FilesView.vue 和 product/terminal/files 样式；更新 App/workspace 回归，将原 files-panel.test.ts 转为完整文件页测试 files-view.test.ts，同步共享导航及布局/原生脚本、PRD、ARCHITECTURE、DECISIONS、USER_GUIDE。

完成标准为菜单出现在原文件面板位置、侧栏无重复菜单、四个主机页面可相互切换、文件面板无入口和挂载、既有连接与每主机路径保留。验证：全量前端 33 文件、222 项通过，覆盖四菜单导航、高亮、主机切换与路径、会话不关闭、本地/全局页面无远程菜单、终端文件事件目录与来源窗格、配置变更拦截、完整文件页导航/上传确认/失败重试和卸载清理。首轮 Vitest 因系统临时缓存 rename 权限失败未执行测试，改用 .local/host-toolbar/tmp 后恢复；新增错误气泡断言改为检查全部气泡，最终全量通过。TypeScript/Vite 生产构建、全量 ESLint、修改文件 Prettier、三份脚本 Node 语法及差异检查通过。

独立无头 Edge 四组布局与上下文场景通过：1440×900 深/浅、900×600 深、390×844 浅。宽屏菜单与会话/新建按钮同排且在其右侧，工具栏高 42px；390px 下换行为 73px，终端紧接工具栏，无横向页面溢出。检查完整 SFTP 页切换、路径/连接保留、设备标签及全局工具草稿等原有回归，结果与截图位于 .local/host-toolbar/browser；已查看深色桌面及浅色窄屏截图。浏览器仅使用内存渲染夹具，不用于宣称远程功能验收；沙箱内浏览器及跨沙箱服务不可达，改为获批的同一沙箱外临时服务与独立浏览器后通过，测试结束均已关闭。

未执行原生 WebView2 实机、Tauri/Rust 构建与测试、真实 SSH/SFTP 或其他平台验收；未生成安装包。生产构建保留已有 Monaco 大 chunk 提示，未发现本次变更新增风险；无后端接口、权限、数据库迁移、配置或依赖变化，无新增阶段依赖。本阶段完成后停止。

## 关于菜单名称简化（2026-11-03）

按用户截图将菜单“关于 ServerDeck”改为“关于”，修改 types/product.ts 的共享消息字典，菜单可见名称、无障碍标签、提示、工作区标签和搜索入口同步使用简称。保留独立关于页及页面内产品说明。更新 App/navigation 既有回归、四份浏览器/原生导航脚本和 PRD、ARCHITECTURE、USER_GUIDE；其余未提交修改保留。

验证：App 与 navigation 两份测试共 67 项通过，覆盖新菜单名称、关于标签名称、单例页面、实际版本状态及终端保留；TypeScript/Vite 生产构建、全量 ESLint、修改文件 Prettier、四份脚本 Node 语法及差异检查通过。本轮仅改名称，未重跑其他单测、浏览器布局、原生 WebView2、Rust 或真实远程验收。保留既有 Monaco 大 chunk 提示，未发现新增风险，无新增配置或后续阶段依赖。本阶段完成后停止。

## 原生文本剪贴板（2026-11-03）

按用户要求移除网页剪贴板授权来源，新增 services/clipboard.ts，统一通过官方 Tauri clipboard-manager 2.5.0 的 readText/writeText 操作系统文本剪贴板。终端菜单、右键快捷粘贴、快捷键和选中复制，以及文件路径、日志、网络/批量结果、自动化输出复制均接入同一服务，不再使用 navigator.clipboard 或网页接口回退。保留原 2 MiB 粘贴上限、大文本/多行确认、Bracketed Paste、连接 generation 校验和安全错误提示；浏览器原生 paste 事件仍从 clipboardData 读取用户已粘贴的文本。只在用户交互后读写，纯浏览器预览明确拒绝原生调用。

主要修改桌面 Cargo/package 清单与锁文件、lib.rs 插件注册、main capability、clipboard 服务、六个复制/粘贴组件及相关测试；同步 PRD、ARCHITECTURE、DECISIONS、USER_GUIDE。仅 main 本地窗口增加 allow-read-text/allow-write-text，不开放远程来源、其他窗口、图片、HTML、清空或秘密剪贴板命令。依赖清单和第三方通知补充本次新增的 36 个 Cargo 与 1 个 npm 包及对应许可；不改变数据库或持久配置。

完成标准为 Windows 桌面端正常读写文本且不调用网页 Clipboard API，同时保留粘贴确认及权限边界。验证：全量前端 34 文件、225 项通过，最终剪贴板定向 2 文件、15 项通过；真实 Rust IPC 2 项通过，验证其他窗口、远程来源和未授权剪贴板命令均因 ACL 拒绝。TypeScript/Vite 生产构建、测试及普通配置 Tauri debug 构建、全量 ESLint、修改文件 Prettier、IPC rustfmt 与两份 Node 脚本语法检查通过。桌面自身 Clippy（--no-deps -- -D warnings）通过；包含依赖的 Clippy 被原有 crates/core/src/openssh.rs:290 单元素循环触发的 single_element_loop 阻断，未修改该无关实现或降低警告等级。

隔离 WebView2 的 19 项原生场景通过，结果位于 .local/native-ui-e2e/e54f0674-6b5e-48e0-8e7f-2f30fd16d95b/results.json。新增场景将网页剪贴板读写替换为抛错陷阱，核对实际调用次数为零；通过真实系统剪贴板和本地 PowerShell 验证中文、emoji、CRLF、菜单/右键/快捷键粘贴、选中/快捷键复制及大文本确认。辅助程序独立读取 Windows 剪贴板，原始各格式只在内存备份并在测试结束恢复；若用户期间复制新内容则不覆盖。首轮中文比对失败源于辅助 PowerShell 的输出编码，改为 UTF-8 后复验通过。测试数据目录独立，原生程序、浏览器与剪贴板辅助进程均已退出，不修改正式配置。

普通配置调试程序为 .local/native-clipboard/ServerDeck.exe，与构建输出 SHA256 一致：C26E36F85E945151F35960B34900F0C583FE0543553774E787BB3451443C7A78。未安装或替换运行版本，未生成 Release 安装包，未重跑真实远程 SSH/SFTP、Rust 全量测试或 macOS/Linux 验收。保留既有 Monaco 大 chunk 与增量缓存硬链接回退提示；系统剪贴板被其他程序占用时仍可能读写失败，并沿用明确失败提示，未发现其他新增风险。无新增阶段依赖，本阶段完成后停止。

## NSIS Release 构建恢复（2026-11-03）

复现用户原命令 `node tools/tauri.mjs build --bundles nsis`，前端构建成功，Rust 在 window_state.rs 导入 serverdeck_application 时发生 E0463。检查确认依赖已声明，Rust 为 stable 1.99.1 / x86_64-pc-windows-msvc，原 Release 依赖产物存在。单独重新生成 application 缓存后错误转移至 serverdeck_ssh，仅重新生成项目自身 Release 缓存后继续转移至 russh/tokio_util，局部清理不能恢复。只读检查显示内存和磁盘仍有余量。

核实 target/release 的绝对路径及非目录链接属性后，执行 `cargo clean --release --target-dir D:/CodexProjects/operations/target --offline`，重新生成完整 Release 编译缓存；Debug、源码、Cargo.lock、用户配置和应用数据均保留。随后原 NSIS 命令完整构建成功，Rust Release 耗时 4m44s；继续复跑同一命令、复用新依赖缓存，再次成功，Rust Release 耗时 3m04s。两轮均包含 TypeScript/Vite 生产构建、优化 Rust 编译/链接和实际 makensis 打包。Vite 的既有 500kB chunk 体积警告保留，不影响两次构建成功。该结果确认重新生成 Release 缓存后恢复，但未定位旧缓存加载异常的最初触发原因，不宣称已证明某个依赖文件损坏。

主要修改文件仅 docs/release/RELEASE_CHECKLIST.md 和本计划，补充 E0463 排查、清理范围及原命令复建方法；不增加自动清理或重试逻辑，不变更业务代码、权限、依赖版本或数据库。修改文档 Prettier 与差异检查通过。原始失败、局部重建、完整重建及复跑日志保存在 .local/nsis-build-fix，产物大小、版本、签名和 SHA256 见同目录 artifacts.json 与 SHA256SUMS。

最终安装包为 target/release/bundle/nsis/ServerDeck_0.1.0-beta.1_x64-setup.exe，7,303,285 字节，SHA256 为 812F6E81AC3F26FABBDA2406E279ACF69B92B9C34C612592742C92EECC19F242；Release 程序为 target/release/serverdeck-desktop.exe，26,402,304 字节，SHA256 为 CE83117D3BB5D2FA544AB9F2D2D5D7473E77B17C49A9FF6B2FEFD3A653C03962。两者版本均为 0.1.0-beta.1，Authenticode 状态均为 NotSigned。未执行安装、替换运行程序或复测原生功能、真实远程操作、Rust/前端功能单测及其他平台，本轮没有业务源码变更。现有测试版发布阻断项保持，成功打包不等于稳定版验收；无新增下一阶段依赖，本阶段完成后停止。

## 移除模块与工作区标签选中横线（2026-11-03）

按用户截图移除 styles/product.css 中顶部模块选中项的 border-bottom-color 和工作区活动标签的 border-top-color，保留原有透明边框占位、文字及背景高亮，避免控件尺寸变化。同步 PRD 的选中态约定，其他已有与并行修改保持原样。

验证：TypeScript/Vite 生产构建通过，既有 Monaco 大 chunk 提示保留。独立无头 Edge 在 1440×900 深/浅、900×600 深、390×844 浅四组下，完成 16 次模块选中和 12 次设备/全局工作区标签切换的真实计算样式检查：选中边框均透明，文字或背景区分保留，工作区标签高度仍为 41px。已查看深浅主题截图；脚本、结果及截图位于 .local/selection-lines，测试仅使用内存布局数据，不连接远程主机或写正式配置，结束已关闭浏览器与临时服务。修改文件 Prettier 和限定本次文件的差异检查通过；全库差异检查曾发现并行修改的 crates/core/src/terminal.rs:257 有末尾多余空行，未修改该任务外文件。

本轮仅改样式，未执行功能单测、原生 WebView2、Rust 或真实远程验收；未生成安装包。未发现本次变更新增风险，无新增下一阶段依赖。本阶段完成后停止。

## Windows 构建的监控与运维采集脚本换行修复（2026-11-03）

复现截图中的 Bash else 语法错误：Windows core.autocrlf=true 将 monitor.sh 和 ops_capabilities.sh 检出为 CRLF，include_str! 又把回车原样编入远端 exec 命令。两个原脚本均在本机 WSL 的 Bash/sh 语法检查中失败，运维错误与截图的 else printf 分支一致。core::ops::Request::Capabilities 与 SSH collector_command 在发送前将 CRLF 转为 LF；新增 .gitattributes 的 *.sh text eol=lf，并规范本地两份脚本。保留采集内容、协议、权限、取消及连接所有权。

主要修改 .gitattributes、crates/core/src/ops.rs、crates/ssh/src/monitor.rs，新增 crates/core/tests/ops.rs 并补充 crates/monitor/tests/engine.rs 的实际 SSH exec 换行断言；同步 ARCHITECTURE 和本计划。原有 monitor 精确载荷比对改为 Unix 换行后的完整脚本比对，仍验证所有采集内容，不删除有效断言。保留工作区原有及其他任务修改。

验证：先运行新能力命令回归，原 CRLF 版本失败；仅修复命令生成、仍保留 CRLF 源文件时，能力命令和监控命令回归均通过。最终 Core/SSH/Monitor/Ops 共 66 项测试通过，1 项依赖授权远端的 live 测试按原规则忽略；覆盖真实本机 SSH 通道、凭据与主机密钥、监控暂停/恢复、超时、权限、断线、输出上限、运维确认及日志取消。SSH 单元测试初次受沙箱回环套接字 10013 限制，获批后全量通过。SSH/Monitor/Ops 的 Clippy --all-targets --no-deps -- -D warnings 通过；含 Core 的严格检查被原有 openssh.rs:290 single_element_loop 告警阻断，未修改无关实现。

本机 Linux 实测：修复后两脚本均通过 Bash/sh 语法检查，并实际执行只读采集。运维使用 Rust Request::Capabilities.command() 导出的完整命令；监控使用规范后的固定脚本。输出分别符合 SDOPS1/SDMON1，并由项目现有 Rust 解析器成功解析，断言 CPU、内存与 uptime 有效、能力响应成功。未连接用户服务器。原失败脚本、临时验证工具与结果位于 .local/collector-lf-fix；linux-results.json 记录原版失败与修复后通过，原始采集输出仅保留在该忽略目录，不进入业务日志。

TypeScript/Vite 生产构建和普通配置 Windows Tauri debug 构建通过。默认 target/debug 输出首次因覆盖现有 serverdeck-desktop.exe 被系统拒绝（os error 5）而失败，随后使用 .local/native-ui-build 构建目录完成编译；未结束用户进程或删除原程序。修复版保存为 .local/collector-lf-fix/ServerDeck.exe，42,745,856 字节，与本轮输出 SHA256 一致：A34B2A1146E4E1B0567E838914C63C5ADE4236FC0369A5047B5AD4E6B2E2517E。build.json 记录构建来源与校验值，两个构建日志保留。修改 Rust 文件 rustfmt、文档 Prettier 及限定本次文件的差异检查通过。

未执行用户服务器连接与原生界面点击到实际远端的验收，未重跑前端功能单测或其他平台验收；未安装、替换正在运行的程序或生成 Release 安装包。保留已有 Monaco 大 chunk 和增量缓存硬链接回退复制提示，Core 严格 Clippy 的原有告警仍待独立处理；未发现本次修复新增风险，无新增阶段依赖。本阶段完成后停止。

## 2026-11-03：移除 SSH 终端启动提示文案

已按截图移除 TerminalPane.vue 在远程连接/重连开始时写入的“── 新的 SSH Shell ──”及附带空行，不过滤远端登录信息或命令输出。新建/重连 SSH 会话生效，已有终端滚动历史不做清除。仅修改该连接处的提示写入条件。

执行终端剪贴板与 ZMODEM 两个现有测试文件，共 14 项通过；该组件严格 ESLint、Prettier 与限定差异检查通过。TypeScript/Vite 及 Windows Tauri debug 构建通过，产物 .local/remove-ssh-banner/ServerDeck.exe 与构建来源 SHA256 一致，清单和日志位于同目录。未新增文案实现镜像测试，未执行真实远端/原生界面验收或跨平台测试，未替换用户运行中的程序。保留既有 Monaco 大包与缓存硬链接回退提示，未发现新增风险，无新增阶段依赖。本阶段完成后停止。

## 2026-11-03：一并移除本地 Shell 启动提示

按用户补充要求，删除 TerminalPane.vue 中剩余的本地 Shell 提示写入；本地与 SSH 新建/重连均不再由应用插入 Shell 分隔文案或附带空行。原始终端输出及连接流程保留，已有滚动历史不清除。

现有终端组件测试 12 项通过（使用本地终端挂载并覆盖剪贴板、连接与菜单流程），该文件严格 ESLint、Prettier 和限定差异检查通过；TypeScript/Vite 与 Windows Tauri debug 构建通过。新版 .local/remove-local-banner/ServerDeck.exe 已与构建来源校验 SHA256 一致，日志和清单位于同目录。未执行原生界面实机或跨平台验收；保留既有大包和缓存硬链接回退警告，未发现新增风险，无新增阶段依赖。本阶段完成后停止。

## 2026-11-03：主机行编辑和删除统一使用右键菜单

按用户截图移除主机行内编辑/删除图标，删除图标导入、按钮容器、悬停/焦点显隐样式及绝对定位；主机行右侧内边距从两个按钮的 57px 预留恢复为 10px。HostTreeControls 继续提供原编辑表单和确认删除弹窗，由 HostSidebar 右键菜单调用，不改主机数据、连接或后端接口。

主要修改 HostTreeControls.vue、hosts.css、host-tree-controls.test.ts；更新共享 E2E 主机菜单操作、浏览器布局及原生 UI 脚本。PRD、架构、技术决策和使用说明同步。原编辑/删除回归改为从真实右键菜单进入，保留对准确主机、当前会话、保存、确认、取消及失败提示的断言，没有用删除有效断言代替功能验证。

验证：四个相关测试文件共 90 项通过；TypeScript/Vite 生产构建、全项目严格 ESLint、修改文件 Prettier、三个工具 node --check 和限定 git diff --check 通过。四组浏览器尺寸/主题（1440×900 深/浅色、900×600 深色、390×844 浅色）回归通过：主机行只有一个按钮，默认/悬停/键盘焦点都没有行内编辑删除图标，名称布局稳定，右侧预留已释放，Shift+F10 与方向键可进入编辑；原文件夹/主机菜单、列表滚动和定位正常。已查看桌面及窄屏截图，产物和 results.json 位于 .local/host-row-context-only/layout。浏览器仅使用内存夹具，实际修改/删除的成功、取消及失败由现有服务边界测试验证。

未重跑全量前端/Rust/IPC、完整原生 UI、远端及跨平台验收，未重建安装包；本次无后端或数据结构修改。保留既有 Monaco 大 chunk 提示，未发现新增风险，无新增阶段依赖。本阶段完成后停止。
