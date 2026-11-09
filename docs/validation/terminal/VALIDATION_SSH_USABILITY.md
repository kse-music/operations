# SSH 日常使用增强验收

## 2026-11-09 窗口缩放滚动与末行裁切修复

### 复现与实现

在本机独立 Edge 中使用真实 Vue/TerminalsView/xterm 和应用样式、隔离内存 API，写入长行输出与末尾提示符；先手动滚动到底部，再在 1200×800 与最大尺寸之间往返。显示条件为 1920×1080、DPR 1，以及 2560×1440 CSS 视口、DPR 1.5（模拟 3840×2160 屏幕 150% 缩放），不连接 SSH 或读取用户配置。

- 旧实现还原后缓冲的 `viewportY` 仍等于 `baseY`，滚动条却离底部约 241 / 373 CSS px。随后向上滚动 60 行实际跳回 555 / 813 行，复现用户无法留在最新位置的问题。xterm 6 的滚动条在重排后保留旧像素位置，单看缓冲坐标或提示符是否可见无法发现。
- 全局 border-box 使 FitAddon 读取的父容器高度包含上下 12px 内边距；插件没有扣除父容器内边距，特定尺寸会多分配一行。DPR 1.5 的初始末行超出内容区约 4.69px，最大尺寸超出 3px；DPR 1 的另一个窗口高度超出 9px。
- `styles/terminal.css` 仅对 `.xterm-container` 改用 content-box，保留原内边距，让 FitAddon 使用内容尺寸。`TerminalPane.vue` 在 fit 前记录普通缓冲是否在底部，下一渲染帧仍为同一活动缓冲且没有用户滚离底部时，调用公开 `scrollLines(buffer.length)` 同步实际滚动条位置；不用 xterm 私有字段，不重建终端或会话。连续 fit 合并回调，隐藏/备用缓冲不滚动，卸载取消待执行回调。
- `terminal-zoom.test.ts` 补充底部同步、连续 fit 合并、历史/备用缓冲保护、排队期间用户滚动/切换缓冲、隐藏和卸载回归；其他四个终端组件测试仅补齐新增读取所需的公开缓冲夹具字段。

### 实际验证

| 检查 | 结果 |
| --- | --- |
| 终端组件定向测试 | 5 个文件、39 项通过 |
| 全量 `npm test` | 54 个文件、513 项通过；保留既有 jsdom Canvas 未实现提示 |
| `npm run build` | 插件准备、桌面 TypeScript 严格检查和 Vite 生产构建通过；保留既有 Monaco 大 chunk 提示 |
| 全量 `npm run lint` | 通过 |
| 修改源码/测试 Prettier、`git diff --check` | 通过 |
| 真实 Vue/xterm 浏览器回归 | 两种显示条件共 78 组观测通过：各三次最大化/还原、24 个连续高度、10/14/18/32 字号、历史阅读及备用屏幕往返。底部滚动条间隙为 0，最后一行没有越过内容区，提示符和原 Session ID 保留；历史滚动保持原有距底部偏移，未被拉到底部 |

已查看修复前后截图及两种显示条件的末行裁图，中文、下划线和 p/g/y 下伸字符均完整可见。证据位于 `.local/qa/terminal-resize/`：`browser-check.mjs`、`before.json`、`after.json`、`before-*.png`、`after-*.png`、`before.log`、`after-final.log`、`targeted-tests-final.log`、`frontend-tests.log`、`build.log`、`lint.log`、`format-check.log`。浏览器夹具曾因缺少应用的侧栏宽度 CSS 变量产生不正确的网格，补齐后重新记录复现；第一轮新增单测等待可见性监听的时机过早，补齐 Vue 更新等待后通过；最初历史检查要求绝对行号不变，调整为验证 xterm 原有的距底部偏移保持，未修改生产行为来满足该检查。

### 底部黑条补充修复

用户继续指出终端底部的黑色长条。上一轮截图确实已有该黑条，但检查只覆盖末行边界和滚动条位置，视觉验收漏掉了旧控件背景及原生箭头；原 78 组通过不能作为“没有黑条”的证据。

隔离浏览器通过底部命中测试定位到空的 `.xterm-viewport`：默认背景为 `rgb(0, 0, 0)`，`overflow` 为 `auto scroll`，高度比实际整数终端行区域更大，露出黑色余带和系统滚动条。xterm 6 实际滚动由相邻的 `.xterm-scrollable-element` 处理。`terminal.css` 使用更高优先级的局部选择器将旧视口背景设为透明、overflow 设为 hidden，保留其 DOM；`TerminalPane.vue` 将容器内边距和末行余白的背景同步为当前终端主题，避免浅色/Nord/Solarized 仍露出深色带。没有隐藏实际的纵向滚动条或更改前述尺寸、滚动逻辑。

补充验证：

- 扩展同一真实 Vue/xterm 浏览器夹具，在每组观测检查旧视口透明且不产生原生滚动条、容器与实际终端背景相同；两种显示条件、四种终端主题及原窗口/字号/历史/备用屏幕回归共 86 组通过。已查看深色 DPR 1.5 和浅色 DPR 1 末行截图，黑带及旧箭头消失，中文/下划线/下伸字符完整可见。
- `npm run test -w @serverdeck/desktop -- src/views/terminal-zoom.test.ts src/components/terminal-clipboard.test.ts`：2 个文件、28 项通过。
- `npm run build`、本次组件 ESLint、两项生产文件 Prettier 及 `git diff --check` 通过；构建保留既有大 chunk 提示。本次样式补充未重复全量业务测试，前述 513 项记录属于此前窗口滚动修复的检查。
- 同目录补充证据为 `probe-black-bar.mjs`、`black-bar-probe.json`、`black-bar-check.log`、更新后的 `after.json`、`black-bar-fixed-*.png`、`black-bar-tests.log`、`black-bar-build.log`、`black-bar-lint.log`、`black-bar-format.log`。仍未进行原生窗口/实际 DPI 切换或跨平台验收，未重建 EXE/安装器。

### 移除终端绿色焦点边框

用户要求移除终端内容区的绿色外框。仅删除 `styles/terminal.css` 中 `.split-pane.focused` 的 inset box-shadow；保留 focused 类及 store 的输入目标管理、会话标签选中样式和分屏分隔条，不调整布局尺寸。

实际检查：独立 Edge 中真实 Vue/xterm 夹具，1280×820/DPR 1 深色、2560×1440/DPR 1.5 浅色，各检查单窗格和两个分屏的焦点切换，共 6 组通过。计算样式确认无 box-shadow、outline 或边框；点击两个窗格后分别成为真实 focused 目标，会话标签保留 aria-selected。已查看深色单窗格和浅色分屏截图。CSS Prettier 与 `git diff --check` 通过。

本次仅删除样式，没有新增单元测试，也未重复业务构建、原生程序或真实 SSH 验收。分屏不再用绿色外框指示焦点，焦点管理行为已用浏览器验证；无其他已知阻断。证据为 `.local/qa/terminal-resize/no-border-check.mjs`、`no-border-check.log` 以及 `.local/qa/terminal-no-border/result.json` 和六张 PNG。开发模式加载新样式后生效，安装版依赖重新构建 EXE；本阶段结束后停止。

### 窗口最大化/还原强制到底部

用户进一步明确：即使先手动向上翻阅历史，每次最大化或还原窗口都应主动回到最新内容。此需求将窗口尺寸变化从原来的“仅在原本处于底部时跟随”改为强制滚到底部；仅侧栏、分屏、字体或字号变化继续保持原有历史阅读行为。

修改前用真实鼠标滚轮向上翻阅，再扩大浏览器窗口，稳定复现 `viewportY=567`、`baseY=970`，新要求的底部断言失败。`TerminalPane.vue` 将窗口 resize 监听改为 `resizeTerminal`，先关闭菜单再 `fitTerminal(true)`；显式强制标记保留到滚动回调执行，随后 ResizeObserver 的普通 fit 不会丢掉该标记。只处理当前可见的同一普通缓冲，不切换备用屏幕、重建 xterm 或更换 Session，卸载移除窗口监听并取消回调。

`terminal-zoom.test.ts` 增加手动历史位置下的最大化/还原、两个可见窗格均回到底部、后续布局 fit 保留强制请求、切换缓冲和卸载清理回归；保留普通布局 fit、字号调整、历史阅读及用户主动滚动的原断言。

实际验证：

- 定向终端测试 2 个文件、30 项通过；全量 `npm test` 54 个文件、515 项通过，保留既有 jsdom Canvas 提示。
- `npm run build`、全量 `npm run lint`、修改组件/测试 Prettier、`git diff --check` 通过；生产构建保留既有 Monaco 大 chunk 提示。
- 独立 Edge 中实际 Vue/xterm、鼠标滚轮及窗口 resize，1920×1080/DPR 1 与 2560×1440/DPR 1.5 两种显示条件，各进行三轮“滚到历史 → 最大化 → 再滚到历史 → 还原”。共 12 次窗口切换均满足缓冲在底部、滚动条间隙为 0、原 Session 和单个 xterm 实例保留；加入每次切换前历史位置、侧栏/字号仅布局变化、备用屏幕观测，共 30 组通过。已查看还原后的截图。

证据：`.local/qa/terminal-resize/force-bottom-check.mjs`、`force-bottom-before.log`、`force-bottom-after.log`、`force-bottom-tests.log`、`force-bottom-full-tests.log`、`force-bottom-build.log`、`force-bottom-lint.log`、`force-bottom-format.log`；原始结果与截图位于 `.local/qa/terminal-window-bottom/before.json`、`after.json`、`after-*.png`。该夹具仅使用隔离的内存 API，没有连接 SSH 或修改用户配置。

未重建 EXE/安装器，未做原生窗口按钮、真实显示器 DPI 切换或跨平台复验。窗口 resize 同时覆盖拖动调整窗口尺寸，这些动作会主动结束历史阅读位置并滚到底部，符合更新后的需求；无其他已知阻断。开发模式重载前端后生效，安装版依赖重新构建桌面程序，本阶段结束后停止。

### 边界、风险与依赖

没有修改 Rust、依赖、数据库或持久配置。浏览器验证模拟两种目标显示条件，不等同于用户原生窗口、实际显示器 DPI 切换、真实 SSH 全屏应用或 Linux/macOS 验收；未重建 EXE/安装器。整数终端行数下，底部可留不足一行的空白，以保证整行完整显示。当前无其他已知阻断，原生复验依赖新版桌面程序；开发模式重新加载前端后生效，本阶段结束后停止。

## 2026-11-06 Linux 终端下划线裁切修复

### 复现与实现

用户截图显示 Windows 中 `knowledge_base` 的下划线可见，本机 Linux 同一文本下划线消失。本机 WebKitGTK 2.52.6、系统 `monospace`（DejaVu Sans Mono）、14px 下，xterm 6 DOM 行高为 16px 并逐行裁切，缓冲中的 `_` 保留，但三个下划线对应区域的可见像素为零。提高有效行高到 110% 后行高为 17px，相同区域有 25 个前景像素，复现了字形下沿被裁切的原因。

`services/terminal-font.ts` 增加 `resolveTerminalLineHeight`，Linux 渲染时采用至少 110% 行高，Windows/macOS 保持配置百分比。`TerminalPane.vue` 在初始化和显示偏好变化时统一调用；保留既有隐藏更新延迟、字体回退、xterm 实例和缓冲，不修改已保存配置。相关测试覆盖 Linux 两种平台标识、低行高保护、较大行高、Windows/macOS 原值，以及隐藏期间修改行高后恢复显示。

### 本次验证

- `npm run test -w @serverdeck/desktop -- src/services/terminal-font.test.ts src/views/terminal-zoom.test.ts`：2 个文件、19 项通过。
- `.local/terminal-font-qa/glyph-verify.mjs` 使用实际 Vue TerminalPane、xterm、应用样式及仅内存中的独立测试配置。WebKitGTK 宽窄窗口、DPR 1/2 四组各验证 10–32px 全部 23 种字号及 150% 行高，96 项通过；Chromium 156.0.8078.79 同样四组验证 10/14/18/32px，16 项通过，共 112 项。
- 每项检查截图中下划线区域的前景像素、缓冲和选择文本中的 `knowledge_base/`、等宽测量及更新后仍为同一 xterm 实例。包含隐藏后改变字号/行高再显示；WebKit 最少 18 个下划线像素，DPR 2 最少 36 个，均非空。保存的 150% 行高仍得到 1.5 的有效值。
- 证据位于 `.local/terminal-font-qa/glyphs/verification.json` 及 `fixed-webkit-*.png`、`fixed-chromium-*.png`，已查看 WebKit 常规与高 DPI 窄窗口截图；复现脚本为同目录上一级的 `glyph-probe.mjs`。
- `npm run typecheck`、四个修改源码/测试文件 ESLint 及 Prettier、文档格式、`git diff --check`：通过。
- `npm run build`：内置插件生成、Vue 类型检查和 Vite 生产前端构建通过，保留既有大 chunk 提醒。构建前磁盘约 811 GiB 可用，WASM 沿用已有输出目录，无 Rust 代码修改。

### 边界、风险与依赖

以上为本机真实渲染引擎及组件测试，测试文本未连接远程主机、调用替代产品 IPC 或改写用户配置。未复验用户原 SSH 会话、原生 Tauri 窗口、Windows/macOS 实机、全量业务单测或安装包；未重建桌面可执行文件。Linux 紧凑配置的有效行高变大会略减窗口内可见行数，用户自定义字体仍取决于本机字形度量。当前无剩余实现依赖，开发应用重新加载前端后生效，发行版需重新构建；本阶段完成后停止。

## 2026-11-06 Linux 默认字体回退修复

用户再次通过 `npm run tauri -- dev` 启动后，普通 `ls` 仍呈现明显字距。核对实际进程位于当前仓库 `target/debug/`，1420 开发服务提供的终端组件包含隐藏初始化修复，因此不能将本次现象归因于旧 Release。通过临时模板热更新读取用户实际窗口的字体与几何指标，没有读取终端文本或重建 SSH 会话；原始指标保存在 `.local/terminal-font-qa/actual/before.json`。

实际窗口 DPR 1、14px、旧默认 `Cascadia Mono, Consolas, monospace` 下，Canvas/OffscreenCanvas 的 W 为 12.291946px、i 为 3.849991px，DOM 的 W 为 12.291992px。字体实际为比例字体，xterm 按 W 的 12.29px 固定列宽为其他字符逐个补间距，文本 span 出现约 3.76–9.16px 的补偿。仅检查行容器的 `letter-spacing`（当时约 0.00625px）无法发现这类异常。此前独立测试环境的 W/i 均为 8.4287px，未覆盖用户原配置环境中的这条字体回退路径；隐藏初始化缺陷仍有效，但不是此次截图问题的完整解释。

新增 `services/terminal-font.ts`，仅在 Linux 将旧默认栈解析为系统 `monospace`，由 `TerminalPane.vue` 在初始渲染及偏好更新时统一使用；保留已保存配置、用户自定义字体及其他平台原行为。新增五项回归覆盖 Linux x86_64/aarch64 的旧默认配置、Windows/macOS 原配置和 Linux 自定义字体，既有隐藏字体更新断言同步使用实际解析结果。没有 Rust、IPC、权限或数据库结构变更。

用户明确正常退出后，运行 `.local/terminal-font-qa/actual-profile-qa.mjs`：将根目录正常开发构建复制到 QA 目录，使用原有应用配置、WebView 目录和正常 1420 Vite 页面，实际连接既有 `192.168.4.64` 主机，仅执行只读 `ls`。修复后的渲染字体为 `monospace`，14px 的 W/i 均为 8.4287109375px，行补偿 -0.0125px，文本片段最大补偿绝对值 0.007036px；切到设置再返回仍通过，保留同一 xterm DOM 节点、SSH Session ID 及已连接状态。`actual/after.json` 和 `actual/after.png` 已生成并查看，实际 `ls` 字符紧凑、列布局正常。测试程序通过原应用退出 IPC 正常关闭 SSH 和进程；临时模板诊断代码撤回，临时本地存储诊断键已清除，不改写字体设置或重置用户数据。

`npm test` 54 个文件、406 项通过；`npm run typecheck`、`npm run lint`、修改文件 Prettier 与 `git diff --check` 通过；`npm run build` 通过，保留既有 Monaco 大包提示。输出盘空闲 812 GiB。原生脚本先后遇到早于 Vue 启动读取状态、WebKit 自动移除空本地存储表两项脚本前置条件问题，补齐启动等待与表存在检查后重跑通过，未据失败结果宣称成功。

本轮未重新编译桌面 Rust、未生成安装包或进行 Windows/macOS 实机回归。自定义字体仍由用户配置决定；本修复针对 Linux 旧默认栈，无新增依赖或配置迁移。用户可正常运行原 `npm run tauri -- dev` 命令，无下一阶段实现依赖；本阶段结束。

## 2026-11-06 终端隐藏初始化字距修复

用户反馈 Windows 与本机 Linux 终端字符间距不同。隔离测量确认本机默认字体的 Canvas、OffscreenCanvas 与可见 DOM 字宽均为 8.4287109375px，并确认一条可触发异常字距的路径：xterm 6 的 DOM 渲染器在隐藏容器中打开时，将隐藏宽度缓存元素的零宽度用于字距补偿；显示后仅 resize 不会刷新默认补偿。本机 WebKitGTK 与 Chromium 均复现额外 8.425px 字距，替换 Linux 字体仍可触发。这证明存在渲染初始化缺陷，但尚未在用户原 SSH 会话中复现，不能据此认定截图差异的唯一原因。

修改 `TerminalPane.vue`：保留 xterm 缓冲和原有输入输出生命周期，只有活动容器宽高均非零时才打开渲染器；隐藏期间记录显示偏好和字号更新，显示后应用并适配尺寸。首次可见打开恢复正常聚焦；重复切页不重新创建终端或 Shell。`terminal-zoom.test.ts` 增加零宽/零高延迟打开、可见后只打开一次及后台字体更新回归。

本机验证脚本和证据位于 `.local/terminal-font-qa/`：`probe.mjs` 对比字体测量与隐藏打开路径；`verify.mjs` 使用实际 Vue TerminalPane、xterm、样式及仅内存中的隔离配置，在 WebKitGTK 2.52.6 和 Chromium 156.0.8078.79 中分别验证 1440×900、390×844。覆盖隐藏挂载后显示、隐藏期间改变字体/字号、反复切页保持同一实例和输出、终端宽度不越界，并在同页复现未保护的上游路径。四组均通过，修复后字距误差绝对值小于 0.013px；`results.json` 与四张截图已生成并查看 WebKit 宽窄截图。内容为明确的渲染测试文本，未连接远程主机、替换产品 IPC 或修改用户配置。

`npm test`：53 个文件、401 项通过（含相关 26 项）；`npm run typecheck`、`npm run lint`、修改文件的 Prettier 检查及 `git diff --check` 通过。`npm run build` 完成内置插件生成、类型检查和生产前端构建，保留既有 Monaco 大包提示。构建前输出盘空闲 813 GiB。没有 Rust、接口、权限或数据库变更。

### 原生开发模式复测

用户反馈仍无变化，并确认使用 `npm run tauri -- dev`。补测使用 Linux 原生 Tauri 开发构建加载 Vite 页面，测试副本从根目录 `target/` 复制到 QA 目录运行；通过临时独立应用标识和数据目录隔离，未修改正式配置。开发页面使用空闲的 1421 端口，不占用正常开发入口 1420。终端通过实际 Tauri IPC 创建本地 PTY 并执行只读 `top`，没有替换产品 IPC。补充验证了原生开发模式 DPR 1、DPR 2，以及内嵌前端的 Debug 构建 DPR 2。

默认字体 `Cascadia Mono, Consolas, monospace`、14px 下，原生开发窗口 Canvas、OffscreenCanvas 和 DOM 的 W/i 字宽均为 8.4287109375px，行字距为 -0.0125px，实际文本 span 字距为 -0.010671px。DPR 2 下切到设置保存 18px、恢复 14px，再返回原终端，以及 Ctrl+滚轮 14→15→14px 均通过；字距绝对值小于 0.013px，xterm DOM 节点和后端 Session ID 始终相同。已查看实际 `top` 截图，字符没有异常拉开。脚本为 `.local/terminal-font-qa/native-probe.mjs`、`native-check.mjs`，最新测量、循环结果及截图位于同目录 `native/metrics.json`、`native/cycles.json`、`native/native-dev.png`。

`node tools/tauri.mjs build --debug --no-bundle` 通过。首次链接因既有 `tauri-utils` 缓存归档损坏失败；核实根目录输出路径和构建锁后，仅清理该包的 dev 缓存再重建成功。测试完成后通过 `cargo build -p serverdeck-desktop --offline --locked` 恢复常规开发构建，未将 QA 标识或配置写入产品源码。构建前空闲空间超过 800 GiB。

原生开发模式的以上场景未复现用户图 2，因此不能宣称用户原会话已验收通过。未连接用户 SSH 主机，未复测 Windows/macOS，未生成安装包；两平台字体外观是否一致也未经对照实测。当前无新增实现依赖，进一步定位依赖用户原会话的实际渲染测量；桌面发行仍依赖正常打包及对应平台验收。本阶段不开始其他终端功能。

## 早期阶段记录

2026-11-01。Windows x64、Rust 1.97.1、Tauri 2、Vue 3/TypeScript、russh 0.65.0、xterm.js 6。基于现有仓库直接扩展，未修改 PRD；目录没有 Git 元数据，未初始化或提交 Git。没有产品 SFTP、Docker 或监控实现。

## 已实现行为

- 左右/上下分屏、鼠标拖动和键盘调整比例，每标签最多 8 窗格、全应用 32；各窗格独立 Shell，移动/关闭其他窗格不会重建存活 Shell。
- 标签拖动、改名、关闭其他/右侧；连接状态来自后端事件，包含跳板链的主机状态，手动重连创建新 Shell、不回放输入。
- 可保存字体、字号、行高、滚动历史、四种终端主题、光标和 11 个快捷键；后端拒绝非法范围、重复或非规范键位，保留 Ctrl+C/Z。
- 终端搜索、系统剪贴板复制粘贴、远端 Bracketed Paste；大于阈值或 50 行先确认，单次粘贴最多 2 MiB；主动确认后导出 UTF-8 文本，不自动录制。
- SSH Keepalive、独立 TCP/握手与认证超时；受管多层 ProxyJump、SOCKS5 和 HTTP CONNECT，可引用 OS 安全库的代理密码。所有跳板/目标均验证主机密钥，未知先确认，变化阻断，不执行 ProxyCommand。
- OpenSSH 常见字段、Keepalive 和受限跳板别名预览/导入；依赖拓扑排序，缺失、循环、重名或同名端点冲突拒绝；不写回原配置。
- Local、Remote、Dynamic 转发启停、状态、活动流数和冲突提示；默认回环，非回环要求明确确认。Session 关闭、断线及应用关闭路径清理监听和任务。
- SQLite v4 迁移保存 SSH 选项；布局只保存 HostId、名称、顺序和比例，恢复为未连接状态。WebView 重载清理旧 Session，布局不包含命令、输出、凭据正文或运行时句柄。

## 主要修改文件

| 文件                                                                                                                                                                                                                                        | 变化                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| crates/core/src/connection.rs、terminal.rs、workspace.rs、hosts.rs、openssh.rs、lib.rs、Cargo.toml                                                                                                                                          | 连接/代理/转发、终端偏好、布局 DTO 和校验，兼容默认值与 v4 schema           |
| crates/storage/migrations/004_terminal_workspace.sql、src/lib.rs、hosts.rs、hosts/tests.rs、workspace.rs、trust.rs（迁移测试）                                                                                                              | 顺序迁移、SSH 设置、跳板依赖、代理凭据关联、布局和迁移测试                  |
| crates/ssh/src/connect.rs、proxy.rs、forward.rs、lib.rs、trust.rs、Cargo.toml、tests/engine.rs                                                                                                                                              | 多跳 Transport、两类代理、转发、超时/Keepalive/取消、共享句柄及真实协议回归 |
| crates/application/src/terminal.rs、lib.rs                                                                                                                                                                                                  | 后端解析路线和 OS 凭据；布局/转发用例；最多 16 个请求、3 秒等待的元数据队列 |
| apps/desktop/src-tauri/src/commands.rs、lib.rs、build.rs、capabilities/main.json、permissions/autogenerated/*.toml                                                                                                                          | 5 个新增最小权限 IPC，WebView 重载和正常退出清理                            |
| apps/desktop/src/components/TerminalPane.vue、ForwardDialog.vue、HostDialog.vue、SettingsPanel.vue                                                                                                                                          | 终端交互、搜索焦点、偏好、粘贴/导出确认、转发及高级连接表单                 |
| apps/desktop/src/views/TerminalsView.vue、App.vue、styles/terminal.css                                                                                                                                                                      | 分屏几何、拖动、标签菜单、按需加载终端模块，跨视图保持组件                  |
| apps/desktop/src/services/layout.ts、terminal-input.ts、terminal.ts 及对应测试                                                                                                                                                              | 分屏树计算、有界输入和代际隔离、每次 BUSY 重试创建新 IPC Channel            |
| apps/desktop/src/stores/terminals.ts、terminals.test.ts、types/connection.ts、preferences.ts、workspace.ts、hosts.ts、ipc.ts、terminal.ts                                                                                                   | Tab/Pane/Session 分离、恢复/自动保存和同步类型                              |
| Cargo.lock、tools/native-terminal-e2e.mjs、native-terminal-advanced.mjs                                                                                                                                                                     | 锁定依赖和真实原生 Linux 验收工具                                           |
| README.md、[ARCHITECTURE.md](../../architecture/ARCHITECTURE.md)、[IMPLEMENTATION_PLAN.md](../../product/IMPLEMENTATION_PLAN.md)、[DECISIONS.md](../../architecture/DECISIONS.md)、[SSH_TECH_VALIDATION.md](SSH_TECH_VALIDATION.md)、本文件 | 当前架构、使用方式、决策、门禁与证据                                        |

临时测试、下载、截图、数据库和审计结果仅在已忽略的 .local 目录；正式数据目录未重置。测试秘密只由隐藏提示传入本次进程环境，应用仍从 OS 库读取，未写入脚本、数据库、文档或日志。

## 自动化结果

| 检查                                                                     | 实际结果                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| cargo test --workspace --locked --offline                                | 52 通过，2 个依赖实机环境的用例默认 ignored                                    |
| 系统凭据库测试显式 --ignored                                             | 另 1 项通过，随机条目写入/更新/删除                                            |
| cargo fmt --all -- --check                                               | 通过                                                                           |
| cargo clippy --workspace --all-targets --locked --offline -- -D warnings | 通过；本机增量缓存硬链接失败时复制的环境警告仍存在                             |
| npm test                                                                 | 19 通过，6 个文件                                                              |
| npm run format:check、lint、typecheck                                    | 通过；首次格式检查发现两个新增测试文件，已格式化并重跑通过                     |
| Vite 生产构建、Tauri Debug 嵌入前端构建                                  | 通过；终端按需加载，主 JS 约 142 kB、终端模块约 386 kB                         |
| npm audit --omit=dev                                                     | 0 漏洞                                                                         |
| cargo-audit 0.22.2                                                       | 退出 1：RSA RUSTSEC-2023-0071，另 4 个 unmaintained、1 个 unsound 警告；未忽略 |

Rust 覆盖既有 CRUD/分组/凭据/敏感信息保护、v1/v2/v3 数据迁移、布局约束、旧配置默认兼容、跳板循环与错误路由保护；应用元数据排队与退出等待。SSH 用例使用随机密钥/凭据、真实回环 TCP 与 SSH 协议帧，覆盖密码、明文/加密私钥、错误认证、Agent 实际签名、未知密钥认证前阻止、密钥改变、PTY resize、多终端、断网、重连、输出 ACK 和资源归零。

新增网络断言包含：SOCKS5/HTTP CONNECT 无认证及代理认证、多跳分别认证、TCP/握手与认证超时分离、Keepalive 发现未关闭 TCP 的静默黑洞；Local/Remote/Dynamic 256 KiB 双向校验，远程端口重复请求不撤销已有路由，公共绑定未确认拒绝；停止/Session 关闭/SSH 断线后监听不可连接且计数归零。前端验证几何无重叠、关闭范围、旧输入不进入新 Session、BUSY 不丢数据/不重试认证、恢复 idle，以及最后标签关闭后仍保存空布局。

这些协议服务端不运行 Shell；以下原生测试才证明 Linux 交互程序和产品链路可用。

## 真实原生 Linux 验收

授权目标运行 Ubuntu 24.04.4 / OpenSSH 9.6p1。使用实际打包 WebView2 → Vue/xterm → Tauri ACL → Rust → SQLite/Windows 凭据库 → Linux PTY，没有替换 IPC 或终端。

26 项通过，覆盖：带外核对指纹、双标签/关闭一个保留另一个、vim 中文、top、htop、less、Ctrl+C/Z、2 MiB 输出、滚动查找、正常退出/新 Shell；左右/上下分屏、独立 Shell 变量、拖动后 stty 列数真实变化、关一个窗格不重启其他窗格；标签重排/改名/关闭其他/右侧；主题/快捷键；5000 字符大粘贴确认及 Bash Bracketed Paste 在 Enter 前不执行；手动导出实际文本。

真实网络路径还覆盖：Local Forward 到 Linux SSH banner、冲突保留原监听、Dynamic SOCKS5、经 SOCKS5/HTTP CONNECT 的新 Linux Shell、通过同一授权 Linux 作为跳板再连接其 loopback SSH（逐跳密钥验证）、Remote Forward 经配对 Channel 回传 128 KiB、停止后本地/Dynamic 监听释放。跳板案例没有声称使用了第二台物理服务器。

布局重载恢复两个 idle 窗格，不自动登录；重载前留下的活动监听在重载后不可连接，验证旧会话清理。测试结束确认隔离目录的主机、凭据和 secret_gc 均为空；系统测试凭据已删除。htop 不在服务器原安装中，沿用受信 apt 源临时下载/解包运行并用 trap 清理，不安装系统软件。

最终证据目录：`.local/terminal-e2e/1793534100678-6d539e47-27df-4e3a-b707-59171508b6fd`，包含 result.json、memory.json、splits.png、terminal.png、last-state.png 和主动导出的测试文本。截图已检查。

内存观测对第二窗格连续输入 4×2 MiB 真实输出，滚动缓冲 1024 行，分别执行 renderer GC 后读取 CDP usedSize，本次从 7,269,608 增至 7,585,684 字节，增量 316,076 字节（约 0.30 MiB），原始数字见 memory.json。这只是短时渲染堆观测，不能证明整进程内存、恶意服务器上限或 PRD 的 20 会话长期目标。

## 复现与边界

```powershell
cargo test --workspace --locked
cargo test -p serverdeck-security native_store_roundtrip_update_and_delete -- --ignored
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run format:check
npm run lint
npm run typecheck
npm test
node tools/tauri.mjs build --debug --no-bundle
```

原生 Linux 验收需先设置 SERVERDECK_TEST_HOST、SERVERDECK_TEST_USER、SERVERDECK_TEST_PIN（从可信渠道核对），再仅在本次进程里提供密码：

```powershell
$testSecret = Read-Host 'SSH test password' -AsSecureString
$env:SERVERDECK_TEST_PASSWORD = [System.Net.NetworkCredential]::new('', $testSecret).Password
try { npm run test:terminal -- --advanced }
finally { Remove-Item Env:SERVERDECK_TEST_PASSWORD }
```

不要把密码写入命令行、环境文件或脚本。工具检查独立 bootstrap 目录，复制测试 EXE，并恢复正常 Debug 产物；正常构建不开放 CDP。受限沙箱会拦截 loopback 和 Vitest 缓存重命名，网络验收在正常本地进程权限下执行。

尚未验证/不支持：

- 系统 SSH Agent 服务当前 Stopped，未启动/修改用户服务或添加真实身份。隔离 Windows Agent 实际签名通过，真实系统身份、硬件令牌和其他平台仍待验收。
- macOS/Linux 客户端、其他发行版、跨多台物理服务器/4 层长链、长期重协商、20 会话并发、整个进程内存及吞吐基准；完整鼠标/剪贴板/输入法矩阵未完成。
- ProxyCommand 禁用；OpenSSH Include/Match、多 IdentityFile、复杂内联 ProxyJump 和 token 展开不支持，均明确提示或阻止。系统 known_hosts 的哈希/CA/撤销互操作未实现。
- HTTP 代理只支持 HTTP/1.x CONNECT 和可选 Basic，没有 HTTPS 代理、NTLM/Kerberos。SOCKS5 用户名密码和 Basic 仅用于可信代理网络；秘密不落地不等于代理认证链路加密。
- Dynamic 只支持无认证 SOCKS5 CONNECT，不支持 UDP/BIND；Remote 需非零端口，实际公开范围受服务器 GatewayPorts 配置约束。转发不保存、不自动恢复；远程取消未确认时断开所属共享 Transport，界面说明其他窗格也会断线。
- Rust 上游 RSA 时序漏洞仍未修复，本地 RSA 私钥签名保持拒绝，无 audit ignore。Ed25519/ECDSA、密码和 Agent 入口保留；未把功能通过描述为安全审计全绿。
- 独立探针保留既有 SFTP 测试，没有把 SFTP 接入产品。

下一步依赖是上述 SSH 发布矩阵和长期稳定性验证；本阶段停止，不自动启动 SFTP 开发。
