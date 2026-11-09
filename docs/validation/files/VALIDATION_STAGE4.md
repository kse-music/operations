# SFTP 文件管理阶段验收

## 2026-11-09 SFTP 切换用户

- 远程文件栏新增确认式用户切换、当前身份显示及切回原登录用户。默认 root，支持临时 sudo 密码或免密；浏览与传输分别启动该身份的无 PTY sftp-server。新目录读取成功才替换原连接，失败关闭候选并保留原连接；有编辑文档或未完成传输时拒绝。插件只选择原登录身份，不继承桌面 sudo 授权。主机配置和持久格式未变更。
- 前端全量 Vitest：54 文件、505 项通过，含切换确认、密码立即清空、切回、失败保留连接、旧事件/导航/轮询隔离及主机关闭等待。随后补充文件选择器旧结果隔离、插件拒绝继承 sudo/切换中身份，4 个相关文件 78 项通过。桌面及插件 SDK TypeScript、相关 ESLint、Prettier 和 Vite 生产构建通过；保留既有 Monaco 大 chunk 提示，构建位于 `.local/qa/sftp-user/frontend/`。
- SSH/SFTP 单元与本机回环协议：34 项通过，1 项既有真实主机测试按默认忽略。覆盖密码错误/免密/无需密码时不发送多余内容、分块认证提示和就绪标记、独立传输通道、普通租约不复用 sudo、清洁文档仍阻止切换及既有文件安全回归。通过 `cargo test -p serverdeck-ssh -p serverdeck-sftp --no-run` 构建，再复制至 `.local/qa/sftp-user/rust/` 执行。首次沙箱阻止套接字绑定（Windows 10013），获准在沙箱外运行回环测试后通过。
- Windows → WSL Ubuntu 24.04 的隔离真实 OpenSSH/sudo 应用服务测试通过：使用自建回环 sshd 和临时 Ed25519 密钥，验证 sudo root 上传及 UID=0、读取内容、编辑保护、未知用户/服务路径失败后保留原连接、候选释放、切到 nobody 后新目录 UID=65534、切回原登录用户及插件候选隔离。临时服务已停止，Linux 测试目录已清理；脚本、结果及日志在 `.local/qa/sftp-user/live/` 和 `.local/qa/sftp-user/real-sudo.mjs`。夹具首次因公钥注释与 StrictModes 目录校验失败，修正夹具后通过，未放宽生产主机密钥或服务器安全校验。
- `cargo check -p serverdeck-application -p serverdeck-desktop`、Cargo 格式和差异检查通过。严格 Clippy 因既有 `crates/core/src/openssh.rs:289` 的 `single_element_loop` 告警失败；未修改无关逻辑，使用 `-D warnings -A clippy::single_element_loop` 检查四个受影响包及所有 target 后通过，不等同零告警全量检查。Tauri IPC 回归从 QA 副本执行通过，验证新命令到达后端且未登记会话被拒绝，其他窗口/远程来源不能调用；首次沙箱阻止其既有回环模型夹具，沙箱外重跑通过。新增“活动传输阻止身份切换”断言所在集成测试单独重跑通过。
- 密码分支使用本机真实 SSH/SFTP 协议夹具验证，真实 sudo 测试使用 root 的免密授权；未验证真实密码型 sudo、requiretty、PAM 多轮认证、用户生产主机、原生 WebView2 鼠标操作、桌面安装包或非 Windows 客户端。仅 internal-sftp、要求 PTY 或未授权执行固定 Shell/外部 sftp-server 的服务器明确不支持此方式。断开后需重新授权；连接存续期间密码保留在 Rust 受保护内存用于新传输通道，JS/SSH 库内部副本不承诺绝对清零。

## 2026-11-08 右键复制本地路径

- 本地文件右键的“复制绝对路径”复用地址栏的路径格式化，盘符路径移除 Windows 扩展前缀，共享路径显示为标准 UNC 形式。远程路径按原值复制，文件操作保留后端原始路径。
- 新增回归先复现盘符和 UNC 两项失败，修复后文件视图 23 项测试通过。相关 ESLint、代码格式和差异检查通过。未执行原生剪贴板、真实 SFTP 或桌面构建验证。

## 2026-11-07 SFTP 目录加载状态

- `FilePane.vue` 将加载提示改为列表中央的绝对定位图标与文字，表头始终保留，加载期间隐藏旧条目和分页并禁用全选。兼顾首次读取、空目录和系统减少动态效果的设置。`files.css` 保留原列表独立滚动区域，加载提示不占用布局高度。
- 文件 Store 单独保存本地与各远程连接的待访问路径。`FilesView.vue` 立即显示目标，成功后采用后端实际路径；失败时恢复已确认的目录与路径并沿用错误提示。原有请求代次校验保护最新目标和加载状态，目录历史仍只记录成功访问。
- 新增回归先在旧实现中复现 5 项失败，覆盖首次读取无表头、加载时残留旧条目及两栏目标路径更新滞后。修复后文件组件、视图和 Store 的 55 项相关测试通过，覆盖加载失败、连续切换和后端路径规范化。全量前端测试 465 项通过，1 项既有终端剪贴板测试失败：`drops an asynchronous clipboard read if the pane reconnects before it finishes`，未修改该模块。
- 隔离无头 Edge 对宽屏、窄屏、大字号和浅色主题执行 8 组双栏检查：加载前后表头纵坐标完全相同，图标和文字居中且位于表头下方；核对成功、空目录、刷新、从滚动位置切换、失败恢复、首次加载和减少动态效果。已检查大字号截图。浏览器使用受控目录响应验证真实前端组件，不代表真实远程 SFTP 验收。脚本、截图、测量结果和前端构建在 `.local/sftp-loading/`。
- TypeScript（桌面与插件 SDK）、相关 ESLint、Prettier、Git 差异检查和独立 Vite 生产构建通过。保留已有 Monaco 大 chunk 提示。首次 Vitest 执行遇到沙箱临时目录改名权限错误，改用本任务 `.local/sftp-loading/tmp` 后正常执行。浏览器和本机 Vite 在同一获准进程内验证，退出时已关闭。
- 未重建 Windows 桌面程序或安装包，未执行真实 SSH/SFTP、Rust 或其他平台测试。没有新增运行时依赖或本次已知功能风险；在桌面应用中查看效果需重新构建并启动。本阶段结束，无后续实现依赖。

## 2026-11-07 SFTP 拖到 Windows 桌面和文件夹

- `FilesView.vue` 把离开 Windows 窗口的文件拖动交给 `files_drag_download`。IPC 只允许本地主窗口和已连接的 SFTP 会话。`crates/windows-file-drag` 提供 OLE 文件描述符和文件流，`transfer.rs` 复用原队列校验暂存内容。
- 433 项前端测试通过，覆盖 Windows 边界、选区交接、单次触发及拒绝目录。SFTP 单元和本机真实协议测试 11 项通过，覆盖普通文件、文件链接、拒绝目录和清理临时记录。IPC 权限回归 1 项通过。
- Windows 原生测试 2 项通过。第一项核对取消、长 Unicode 名称、流内容与临时目录清理。第二项让 Windows Shell 的真实文件夹落点处理程序复制文件，并核对落盘字节。
- 类型、ESLint、Clippy、格式和差异检查通过。Windows 调试构建含 Vite 生产构建，试用副本位于 `.local/qa/windows-file-drag/ServerDeck.exe`。
- 手动验收时让 Explorer 目标窗口露出一部分，从 ServerDeck 远程栏拖出测试文件，在目标处松手并核对内容。在桌面重复操作，再验证按 Esc 取消。上述 Windows Shell 测试覆盖落点处理，鼠标从 WebView2 跨到桌面或 Explorer 的整条手势、实际远程主机及安装包尚未验收。

## 2026-11-07 SFTP 文件链接下载、拖放与删除确认

- `transfer.rs` 下载显式选择的普通文件链接目标，使用链接名保存。两项新增本机 SFTP 协议测试覆盖正确内容、目录链接、断链、目录内链接及链接目标变化。SFTP 单元和集成测试共 10 项通过，运行自隔离 QA 副本。
- `FilePane.vue` 与 `FilesView.vue` 增加远程到本地的拖放入口，沿用传输确认。删除框由 `FilesView.vue` 和 `files.css` 收紧，取消默认聚焦。仅所选项目含目录时显示递归选项，提交仍逐次确认。
- 432 项前端测试、Vite 生产构建、类型、ESLint、Clippy 和格式检查通过。Edge 使用内存夹具验证已选及未选条目拖放、取消、实际传输参数、删除确认和递归勾选，并检查超大字号。截图位于 `.local/qa/sftp-transfer-polish/pages/`。原生 WebView2 拖放、真实远端操作与安装包尚未验收。
- 后续移除递归复选框，目录确认框改为显示删除范围。436 项前端测试通过，覆盖目录、文件与目录混选、仅文件、取消和实际提交的参数。Vite 生产构建、类型、相关 ESLint 和格式检查通过。隔离 Edge 的 10 项 SFTP 页面及弹窗检查通过，截图位于 `.local/qa/sftp-delete-confirmation/pages/`。本轮未验收真实远端删除或安装包。
- 删除确认框随后去掉主机、当前路径和目录内容说明，保留待删除对象及确认操作。436 项前端测试和 Edge 的 10 项页面及弹窗检查通过，核对弹窗正文、取消和递归删除请求参数。Vite 生产构建、类型、相关 ESLint 和格式检查通过。截图位于 `.local/qa/sftp-delete-confirmation/compact-pages/`。本轮未验收真实远端删除或安装包。

## 2026-11-07 SFTP 鼠标侧键

- `FilesView.vue` 将侧键释放路由到鼠标所在文件栏。文件 Store 记录成功访问的目录。本地历史随本地栏共享，远程按连接隔离。刷新、失败、历史边界和过期请求不会写入历史，访问新目录后清除前进项。
- 54 个文件、432 项前端测试通过。覆盖两栏路由、连接替换、刷新、失败后重试、新分支及过期响应。类型、ESLint、格式、差异及 Vite 生产构建通过。
- 隔离 Edge 使用 CDP 发送实际的鼠标后退和前进事件，核对两栏路径、历史边界和页面 URL。五组 SFTP 浏览器布局检查通过，产物位于 `.local/qa/sftp-mouse-history/pages/`。原生窗口、实体鼠标和安装包尚未验收。

## 2026-11-07 SFTP 文件列表图标

普通文件图标按扩展名细分为脚本、压缩包和图片，其他文件显示通用图标。两栏组件测试覆盖大小写、`.tar.gz`、无扩展名及目录和链接优先。428 项前端测试、类型、ESLint、生产构建及五组 Edge 布局检查通过。复验截图位于 `.local/qa/sftp-file-type-icons/pages/`。

- `FilePane.vue` 在本地和远程名称列复用 Lucide 图标，区分黄色文件夹、文件、符号链接和特殊条目。图标不计入无障碍名称，点击图标沿用原选择与双击打开行为。`styles/files.css` 保留长名称省略与悬停全名，图标随字号缩放。
- 54 个文件、428 项前端测试通过。类型、ESLint、格式和 Vite 生产构建通过。隔离 Edge 五组窗口验证标准和超大字号的图标缩放、双栏对齐与表格滚动。截图和结果位于 `.local/qa/sftp-entry-icons/pages/`。
- 本轮验收使用浏览器目录夹具，未重建安装包或复验原生窗口与真实远程传输。

## 2026-11-07 SFTP 列表高度与传输面板

- `styles/files.css` 移除表格的固定高度上限，按工作区计算可用高度。本地和远程表格独立滚动。活动任务由底部有高度上限的 `TransferPanel.vue` 展示，含源项目、进度和取消入口。`FilesView.vue` 将完成、失败和取消的记录放在页头“传输记录”对话框，并保留原重试流程。
- Edge 在 2048×1233 的窗口复现旧表格高 420px 和约 332px 的底部空白。修复后四组尺寸通过。大窗空闲时底部空白为 0，上传时列表让出约 173px，结束后回到原高度。两组窄窗口可滚动查看底部任务，文件表仍可独立滚动。验证使用浏览器传输状态夹具，截图与结果在 `.local/sftp-layout-qa/edge/`。
- Vitest 54 文件、425 项通过，含当前主机过滤、活动与历史分离、取消和重试。前端生产构建、TypeScript、ESLint、脚本语法和差异检查通过。当前运行的 Windows 调试程序占用构建输出，尚未重建桌面版或进行 WebView2 原生验收。本轮未运行真实远程上传或安装包验证。

## 2026-11-06 SFTP 本地路径显示与表头排序

- `FilesView.vue` 将扩展盘符和 UNC 路径格式化为常用写法。后端原始路径继续用于父目录、刷新、打开和传输。直接提交当前显示地址时也沿用原始路径，手动输入的新地址交给原有导航流程处理。
- `FilePane.vue` 和 `styles/files.css` 将排序入口移到表头。切换列时默认升序，再点同一列切换方向。两栏独立排序，目录优先和分页规则延续原有行为。当前列使用方向图标及 `aria-sort`。
- 前端文件视图、文件状态和应用入口共 101 项测试通过，覆盖扩展盘符、UNC、其他 Windows 命名空间、POSIX 路径、长路径提交和双栏排序。Windows Edge 在 1440×900 与 900×600 使用隔离数据验证地址显示、原始路径提交、鼠标点击和键盘回车排序。`npm run build`、`npm run typecheck`、修改文件的 ESLint、Prettier 及 Git 差异检查通过。
- 未重建桌面程序或安装包，未运行真实 SSH/SFTP 远程传输。
- 补充验证「复制本地路径」传给剪贴板的盘符和 UNC 文本与地址栏一致，并核对两栏的大小、类型和修改时间表头及单元格顺序。101 项相关测试、类型、ESLint 和格式检查通过。
- 补充验证上传确认框的盘符及 UNC 源路径显示、三项同名文件选项、覆盖确认和提交时保留原始路径。103 项相关测试、类型、ESLint 和格式检查通过。未执行真实远程传输。
- 远程工具栏「显示隐藏项」默认关闭。列表在排序和分页前过滤点开头的条目，关闭显示后将隐藏项移出选区。114 项相关测试通过，覆盖隐藏文件与文件夹、仅含隐藏项的目录、条目数和批量下载确认。Windows Edge 使用隔离目录数据验证鼠标和键盘切换及删除按钮状态。`npm run build`、ESLint 和格式检查通过。本次未执行真实远程操作。
- 隐藏项开关改为与工具栏一致的纯图标按钮，悬停提示和无障碍名称为「显示隐藏项」。文件视图的 10 项测试、ESLint 和格式检查通过。

## 2026-11-05：移除任务中心与主机临时传输记录

按用户确认移除全局任务中心、底部按钮、弹窗、搜索和快捷键设置。SFTP 只显示当前主机记录；切换主机、SSH/SFTP 或设置时保留，关闭该主机成功后清空，重开为空。关闭存在未完成传输的主机时先确认取消；取消确认不关闭连接或终端。确认后复用原生安全提交/排空，保留已完成文件。未保存文档及关闭/清理失败阻止移除工作区；其他主机不受影响。

主要修改：

- `apps/desktop/src/App.vue`、`components/GlobalSearch.vue`、`ProductSettings.vue`、`types/product.ts`：删除任务中心界面及入口，移除专用视图、测试脚本与样式；旧快捷键不再截获终端输入。
- `stores/workspace.ts`、`stores/files.ts`、`views/FilesView.vue`、`components/TransferPanel.vue` 及对应测试：主机范围的确认、关闭、临时记录、关闭期间的操作保护、迟到轮询隔离、主机切换与失败边界。批量关闭逐台完成移除，避免已经关闭的主机在等待其他确认时又提交传输。
- `services/files.ts`、Tauri 命令/注册/权限、`crates/application/src/files.rs`、`crates/sftp/src/transfer.rs`：新增 `transfer_clear_host`，只移除指定主机已结束的内存记录，队列锁内拒绝活动任务；不删除文件，无数据库迁移。
- `crates/core/src/product.rs` 与测试：旧配置/备份的 tasks 快捷键退出当前偏好，保留其他值，旧组合可以重新分配；未知配置键与终端控制键校验保留。
- 回归发现插件页嵌套响应式元数据变化未重新发送上下文，`PluginFrame.vue` 在已有深度监听中补入 page；保留并通过既有可克隆及错误来源检查断言。

验收结果：

- 前端全量 55 文件、373 项通过；包含当前主机记录与计数隔离、切换保留、原取消/重试目标、关闭确认接受/拒绝、dirty 文档、关闭和清理失败、正在建立的连接、过期快照不复活记录、批量关闭与重新打开，以及插件草稿和终端既有回归。
- `cargo test -p serverdeck-core -p serverdeck-sftp`：31 项通过，含 6 项本机真实 SSH/SFTP 协议集成。新增场景实际上传文件、使用两台配置主机身份、拒绝活动记录清理、确认取消并排空、按主机移除记录、已完成文件与本地来源保留；原 CRUD、递归/大文件/哈希、冲突、取消、断线/重试、编辑保护与退出排空继续通过。
- Windows 独立 QA 目录中真实 WebView2 四组检查通过：底部/快捷键移除、搜索与 Esc、旧配置通过真实 IPC 兼容保存及旧组合复用、新命令权限可用。测试先核验 app_bootstrap 数据目录与 QA 目录完全相等，未使用正式用户配置或远程主机。
- TypeScript、ESLint、相关 Rust 文件格式、变更文件 Prettier、脚本语法及 Git 差异检查通过。默认 Windows 调试无安装器构建通过，生成 `.local/remove-task-center/ServerDeck.exe`；保留既有 Monaco 大 chunk 提示，未替换或重启用户程序。

日志、原生检查脚本和基线快照在 `.local/remove-task-center`。独立 WebView2 结果/截图及构建缓存在当前会话获准的 C 盘目录 `remove-task-center/native` 与 `remove-task-center/target`。D 盘满曾导致缓存写入失败；仅清理本次新增且无编译器使用的增量缓存，后续缓存改放 C 盘后完成检查。本机协议服务在受限环境被阻止连接，按授权提升运行后通过。

限制：本次没有执行真实远程主机上的图形上传全链路，也没有重跑 macOS/Linux、安装器或整个 Rust 工作区；原生 UI 冒烟与本机真实协议集成分别验证界面/IPC 和传输保护。整个工作区格式检查曾在其他未提交修改 `crates/application/src/plugins/tools.rs` 发现差异，本次相关 Rust 文件独立检查通过。没有新增运行时依赖或本次已知功能回归。取消仍保留已完成文件且不支持断点续传；无本阶段剩余依赖，本阶段结束。

## 2026-11-05：SFTP 仅提示异常

移除 SFTP 正常完成的错误气泡和完成横幅，上传/下载完成的 SHA-256、空目录、跳过统计等说明不再进入错误通知。任务记录、校验/跳过统计和完成后目录自动刷新保留。只按任务失败状态或非空恢复路径生成传输异常提示，不通过中文消息内容判断成败；用户正常取消不当作错误，临时文件清理失败仍提示路径。

主要文件：`apps/desktop/src/stores/files.ts`、`files.test.ts`；同步 PRD §9.3、使用说明与实施计划。没有修改后端传输、SHA-256 校验、IPC、权限、配置或数据库。

先用新回归复现：原实现把成功/取消消息当作错误气泡，完成后又写入成功横幅，定向 11 项中 6 项失败。修复后前端全量 56 文件、369 项通过，其中文件 Store 11 项覆盖 SHA-256 完成、空目录、跳过、下载、正常取消、失败和恢复路径，以及错误去重、任务记录保留和完成后刷新目录。ESLint、变更文件格式/差异检查及默认 Windows 调试构建通过；构建包含前端 TypeScript/Vite 检查。既有 Monaco 大 chunk 与缓存硬链接回退提示保留。

日志、复现结果和程序摘要位于 `.local/sftp-notifications`，程序为 `ServerDeck.exe`。只构建，未替换正在运行的应用。本次使用真实 Store/通知/轮询逻辑和受控 IPC 测试数据验证消息行为，未重跑真实远端 SFTP、Rust 单元、原生交互、跨平台或安装器验收；不将前端测试表述为真实上传验证。无新增运行时依赖或已知功能风险，无下一阶段依赖，本阶段完成。

下文为最初 SFTP 阶段的历史记录。

2026-11-01。基于已有 SSH 工作区扩展，保留 PRD 和已有数据；仓库没有 Git 元数据，未初始化 Git、未创建提交。验证平台为 Windows x64、Rust 1.97.1、Tauri 2/WebView2、Vue 3/TypeScript。协议实现为 russh 0.65.0 + russh-sftp 3.0.1，编辑器 Monaco 0.57.0。

## 已实现行为

- 复用已认证 Transport 的独立 Files 租约和 SFTP Channel，沿用密码、私钥、Agent、严格主机密钥验证及既有代理/跳板路线；关闭单个终端不关闭 SFTP。
- 真实本地/远程双栏目录：路径导航、父目录、大小/时间/类型、排序、分页、多选、右键、复制路径、刷新、空态/错误态；原生文件/目录选择和拖放上传入口。远端 mkdir、rename、删除、递归删除及权限/属主属性均调用 SFTP，不用 Shell 替代。
- Rust 后台传输队列：上传/下载、多文件/递归目录、SHA-256 校验、进度/速度/剩余量、取消、同主机重新连接后从头重试，以及失败/跳过/重命名/显式覆盖策略。默认每主机 3 个活动任务，可设 1–6；页面切换不取消任务。
- 同目录独占临时文件与安全提交。覆盖远端已有文件和文本保存要求 posix-rename 扩展；可用时 fsync。权限/属主不能保留或目标变化时拒绝覆盖；失败尽量清理临时文件，清理失败明确显示恢复路径。
- Monaco UTF-8 文本编辑、基础语法高亮、dirty、保存/重载、未保存关闭确认；保留 UTF-8 BOM。普通文件最大 2 MiB；二进制和无效 UTF-8 明确拒绝。保存前比较内容 SHA-256 和属性，最后重新检查后替换。
- 主机终端一键打开 SFTP；固定、经 POSIX 转义的目录/less/tail 操作在新 PTY 执行，保留其他终端。目录跟随只接收经验证的 OSC 7 报告，不从任意 Shell 输出猜测 pwd。
- 任务和文件连接由后端持有；WebView 重载保留已认证文件租约及传输。断开文件连接须处理未保存内容和传输；应用退出实时检查未完成任务/dirty，确认后依次排空文件操作、SSH/转发和数据库。

本轮同时修复了实际原生验收发现的两个问题：同步 Tauri 命令提交传输时缺少 Tokio 上下文导致崩溃；PTY 进程以退出信号结束时被误判为网络断线。对应增加运行时入口、IPC 和 ExitSignal 回归断言。最终资源复查另复现并修复编辑器写入被拒绝后句柄未关闭的问题，验证原件保留、暂存清理和服务端句柄归零。

## 主要修改文件

| 文件                                                                                                                                                                  | 变化                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Cargo.toml、Cargo.lock、package.json、package-lock.json                                                                                                               | 新增 SFTP crate、Tokio fs、Monaco 和窄选择器依赖；修复 Monaco 传递 DOMPurify 生产漏洞 |
| crates/core/src/files.rs、lib.rs                                                                                                                                      | 文件/传输/编辑 DTO、路径和固定命令校验、兼容旧配置的传输并发默认值                    |
| crates/sftp/Cargo.toml、src/lib.rs、remote.rs、local.rs、transfer.rs、editor.rs                                                                                       | 真实 SFTP、本地文件系统、有界后台队列、取消清理、哈希和文本保存                       |
| crates/sftp/tests/files.rs、tests/support/mod.rs                                                                                                                      | 临时文件系统上的真实 SSH/SFTP 协议环境、硬 TCP 中断和文件断言                         |
| crates/ssh/src/lib.rs、subsystem.rs、tests/engine.rs                                                                                                                  | Files 租约、Transport 复用、独立子系统 Channel、固定 exec PTY、信号退出识别           |
| crates/application/Cargo.toml、src/lib.rs、files.rs、terminal.rs                                                                                                      | 用例、原认证计划复用、配置应用和退出顺序                                              |
| apps/desktop/src-tauri/Cargo.toml、src/file_commands.rs、lib.rs、build.rs、capabilities/main.json、permissions/autogenerated/*.toml、tests/ipc.rs                     | 最小权限文件 IPC、原生选择器、退出评审、真实 IPC 回归；未授权通用 fs/shell 命令       |
| apps/desktop/src/views/FilesView.vue、components/FilePane.vue、TransferPanel.vue、RemoteEditor.vue                                                                    | 双栏、传输队列、确认/错误反馈、Monaco 编辑器                                          |
| apps/desktop/src/services/files.ts、osc7.ts、stores/files.ts、types/files.ts 及对应测试                                                                               | 类型一致的真实后端调用、主机文件状态、可靠目录报告和状态竞争测试                      |
| apps/desktop/src/App.vue、views/HostsView.vue、TerminalsView.vue、components/HostSidebar.vue、TerminalPane.vue、SettingsPanel.vue                                     | 文件入口、共享主机状态、终端联动、退出确认、并发设置                                  |
| apps/desktop/src/stores/terminals.ts、types/ipc.ts、terminal.ts、styles/files.css、styles/main.css                                                                    | 独立文件动作/cwd、配置契约、文件界面样式                                              |
| tools/native-terminal-e2e.mjs、native-sftp-e2e.mjs                                                                                                                    | 隔离应用/凭据/远端目录上的原生 WebView2 + Linux 验收                                  |
| README.md、docs/architecture/ARCHITECTURE.md、[IMPLEMENTATION_PLAN.md](../../product/IMPLEMENTATION_PLAN.md)、[DECISIONS.md](../../architecture/DECISIONS.md)、本文件 | 用法、生命周期、任务结果、ADR 0007 和交付限制                                         |

数据库保持 schema v4；本阶段没有新增持久业务表。并发参数通过带默认值的原有配置保存，旧 JSON 兼容。传输队列和编辑内容不写 SQLite。

## 构建、自动化与安全检查

| 检查                                                            | 本轮结果                                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| cargo test --workspace --offline                                | 61 passed，2 ignored；含应用 6、core 14、IPC 2、SFTP 1+5、Agent 1、SSH engine 17、probe 3、storage 12 |
| 原生 Windows 凭据库显式测试                                     | 单独执行被默认忽略的 native_store_roundtrip_update_and_delete，1 passed；随机测试条目已删除           |
| npm test                                                        | 8 个文件、23 项通过                                                                                   |
| cargo fmt --all -- --check                                      | 通过                                                                                                  |
| cargo clippy --workspace --all-targets --offline -- -D warnings | 通过；环境存在增量缓存 hardlink 失败改用复制的提示，没有代码诊断                                      |
| npm run typecheck / lint / format:check                         | 通过                                                                                                  |
| node tools/tauri.mjs build --debug --no-bundle                  | 通过，前端产物嵌入真实 Windows EXE                                                                    |
| npm audit --omit=dev                                            | 生产依赖 0 漏洞；全依赖另有 14 项 moderate 开发工具链告警，不描述为全部审计通过                       |
| cargo-audit                                                     | 非零：原有 RUSTSEC-2023-0071（rsa）仍存在；4 项 unmaintained、1 项 glib unsound 警告，无 ignore       |

全工作区默认另一个 ignored 是交互式真实 SSH 探针；本轮使用下面的原生 Linux 套件验证，没有把 ignored 计为通过。OS 凭据测试已另外执行。

Rust 审计结果保留在 `.local/sftp-cargo-audit.json`，npm 结果在 `.local/sftp-npm-audit.json` / `sftp-npm-audit-all.json`。本地 RSA 私钥签名继续拒绝；本轮未绕过安全门禁。glib/部分 D-Bus 警告属于非 Windows 目标依赖，不能据此宣称其他平台已验收。

SFTP 集成测试使用真正的 russh TCP 连接、握手、认证和 SFTP v3 编解码，服务端隔离到临时文件系统；测试服务器不等同于 Linux 兼容性证明。覆盖：

- 中文/空格/引号/特殊字符目录 CRUD、属性、删除确认/根目录拒绝、关闭终端保留文件连接及资源归零。
- 8 MiB 变化字节内容、多文件/递归树上传下载 SHA-256、四种冲突策略及重试；已完成任务速度不随时间衰减。
- 7 项排队时最多 3 活动、排队/活动取消、临时文件清理、硬 TCP 中断、新连接重试、传输期间关闭连接。
- 文本读写、权限/属主保留、只读拒绝、写入中途被拒绝后句柄归零和原件保留、同大小同 mtime 的外部内容冲突、二进制拒绝、不支持原子扩展时保留原件。
- 应用关闭等待在途编辑提交、取消后台任务、停止后拒绝新文件操作；IPC 从正确运行时提交，错误会话返回错误而不崩溃。

## 原生应用与真实 Linux

Windows WebView2 中运行构建后的隔离 EXE，连接用户授权的 Ubuntu 24.04.4 / OpenSSH 9.6p1 Linux 主机。沿用已通过可信渠道核对的 Ed25519 指纹；密码仅由安全提示输入并在测试进程内短暂传递，不写源文件、参数、日志或数据库。OS 凭据库条目为隔离测试引用，结束后删除。

`--sftp`：17 项通过（原有真实终端 11 项 + SFTP 6 组），实际验证：

1. 从活动终端打开同主机 SFTP，创建唯一测试根；中文/特殊字符路径，切换到主机页面后递归上传仍继续。
2. 多文件/文件夹下载；16 MiB 随机内容与子文件 Node SHA-256 完全一致。
3. 重命名、0600 属性、实际 Monaco 输入和保存，UTF-8/BOM 保留，未保存关闭确认、重新加载、外部修改冲突、Linux 权限拒绝。
4. Shell 主动 OSC 7 报告后跟随目录；特殊字符日志通过独立 tail -f PTY 打开，Ctrl+C 正常关闭该 Channel。
5. 128 MiB 实际本地文件在传输中触发退出提示，选择继续保留应用；取消后状态 cancelled，远端目标/临时文件均不存在，恢复路径为空。
6. UI 明确确认递归删除本轮唯一远端测试目录。

`--advanced`：26 项通过（11 项终端基线 + 15 项增强），回归 vim 中文、top/htop/less、Ctrl+C/Z、2 MiB 输出、重连、双向分屏/拖动 resize、标签操作、偏好/搜索快捷键、Bracketed Paste、导出、两类代理、真实跳板路线、三类转发与监听清理、布局重载不自动登录。

跳板使用授权 Linux 的 loopback SSH，并非第二台物理机器。htop 沿用可信 apt 源临时下载/解包并用 trap 清理，未安装系统软件。8 MiB 连续输出的短时 renderer 堆从 7,497,536 到 7,810,584 字节；这不是整进程内存或长期负载验收。

证据目录：`.local/terminal-e2e/1793537103134-3c31540a-2261-41b0-b584-0b600c6aedaf`。`result-sftp.json` / `result.json` 保存 17 项，`result-advanced.json` 保存 26 项，另含 sftp.png、sftp-transfers.png、splits.png、terminal.png、memory.json；截图已检查。结束后只读检查隔离 SQLite：user_version=4，hosts、credentials、secret_gc 均为 0；远端本轮自建树已清理。

早期失败验收曾留下一个空的隔离远端目录，已依据原测试时间窗口、严格 UUID 名称和空目录检查定向清理；没有枚举后批量删除用户目录。后续测试在创建测试根后立即登记 cleanup，以便失败恢复。

## 复现

```powershell
cargo test --workspace --offline
cargo test -p serverdeck-security native_store_roundtrip_update_and_delete --offline -- --ignored
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --offline -- -D warnings
npm run typecheck
npm run lint
npm run format:check
npm test
node tools/tauri.mjs build --debug --no-bundle
```

原生测试先设置 SERVERDECK_TEST_HOST、SERVERDECK_TEST_USER 和已可信核对的 SERVERDECK_TEST_PIN，再安全读取测试密码：

```powershell
$testSecret = Read-Host 'SSH test password' -AsSecureString
$env:SERVERDECK_TEST_PASSWORD = [System.Net.NetworkCredential]::new('', $testSecret).Password
try { npm run test:terminal -- --sftp }
finally { Remove-Item Env:SERVERDECK_TEST_PASSWORD }
```

`--advanced` 另起一轮运行，不与 `--sftp` 合并。工具只使用独立 bootstrap、用户数据、测试 EXE 和唯一远端目录，并恢复正常 Debug 构建；正常应用不开 CDP。受限沙箱阻断 loopback/Vitest 缓存时，上述网络/原生测试需在正常本地执行权限下运行。

## 限制与后续依赖

- 仅验证 Windows 客户端与该 Linux/OpenSSH；macOS/Linux 客户端、其他服务器/发行版、长期重协商、20 会话及整进程性能尚未验收。原生选择器、系统拖放、剪贴板和输入法完整矩阵尚未自动化；入口接真实 Tauri。
- 任务只在本次应用进程内保留，不支持断点续传、跨重启任务恢复。默认队列有界；服务器 MaxSessions 可能限制附加 Channel，失败会提示，不自动创建额外 Transport。
- 上传与递归扫描不跟随 symlink/junction。显式选择的远程文件符号链接可下载目标普通文件。设备和 socket 等特殊文件、非 Unicode 或 Windows 不可表示的下载文件名明确失败。单目录最多 20,000 项，递归传输最多 100,000 项/64 层，路径预算 8 MiB。
- SFTP v3 没有服务端 CAS、openat/O_NOFOLLOW 或完整 ACL/xattr 协议。保存重检与 rename 之间仍有竞态；原子替换改变 inode，不能完整保留 ACL/xattr/硬链接关系，UI 要求明确确认。缺少所需扩展时不伪装成原子覆盖；网络故障可能留有 0600 暂存文件，显示恢复路径供核对。
- 保存和传输校验会增加一次远端回读，不以未测的吞吐数字承诺性能。Monaco 按需加载，但编辑器 chunk 约 2.79 MB（gzip 715 kB），保留 Vite 大 chunk 提示。
- OSC 7 需要远端 Shell/程序主动报告；本轮不自动改写 Shell 启动文件。目录/less/tail 联动面向 POSIX Shell 和相应可执行程序；报告是导航信息，不是权限授权。
- 系统 Agent 服务/实际身份、硬件令牌及其他平台未新增实测；既有隔离 Agent 签名测试通过。RSA 及开发依赖审计风险仍须在发布前跟进。

本阶段后停止，不开始监控、Docker 或完整 IDE。发布前优先补齐其他客户端/服务端矩阵、原生拖放选择器验收、长期资源测试和依赖安全门禁；下一业务阶段仍按 PRD/实施计划单独启动。
