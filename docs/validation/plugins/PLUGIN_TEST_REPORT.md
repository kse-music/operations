# 插件阶段验证记录

## 2026-11-04：插件源码归属与 UI v4

完成目标：九个插件各自拥有 frontend/backend/清单/UI/相关测试；公开 TypeScript/Vue SDK 包含类型、客户端、状态与公共 UI。宿主移除原业务页面和固定渲染器，仅保留公共服务、插件管理/安全壳与 SDK/WASM 桥。新增 UI4 包内 JS/CSS 和通用 frontend 贡献，真实新业务插件无需修改宿主类型或路由；系统和上传共用构建/校验/加载/调用。旧 v1 表单及 v2/v3 标准视图继续兼容，既有包不强制重装，未更改数据库 schema 或用户数据。

主要文件：`plugins/system/*/frontend`、独立 backend 与重建 packages；`packages/plugin-sdk`；`plugins/compat/server`；宿主 `PluginFrame`、`PluginView`、App、`plugin-ui-bridge`、审批和类型重导出；Rust `plugin_ui_protocol`、application/plugins、bundled_plugins、plugin-sdk/ui 与 plugin-core 包/资源校验；构建器和原生 QA。产品/架构/决策/SDK/包/UI/安全/开发/AI 使用说明同步。

| 实际验证          | 结果与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 前端完整回归      | `npm test`：56 文件、339 项通过；`.local/plugin-refactor-frontend-tests.log`。既有测试随插件迁移并保留断言，补独立 Docker/systemd、SDK iframe DTO/事件回收、权限/不可变输入/不透明引用及模型刷新回归。                                                                                                                                                                                                                                                                   |
| Rust 工作区       | `cargo test --workspace --offline --locked`：228 项通过、4 项环境依赖 ignored；`.local/plugin-refactor-workspace-tests.log`。含真实桌面 IPC 5 项、安装/授权/摘要/撤销、ABI/运行时和原引擎协议回归。                                                                                                                                                                                                                                                                      |
| 独立插件          | 九个 backend 各自 `cargo fmt --check` / `cargo test --offline --locked`：共 14 项通过；`.local/plugin-refactor-independent-tests.log`。九包各自 release WASM/Vue 编译及标准打包通过；`.local/plugin-refactor-packages.log`。                                                                                                                                                                                                                                             |
| 最终 Windows 原生 | 真实 WebView2、WASM、SQLite、HTTP/TCP，12 组通过；`.local/plugin-refactor-native-final-retry.log`。最终程序先构建，再由同一独立 QA 目录 `1e3a934d-173f-41a8-9488-790b7717648a` 复用运行；结果见 `.local/plugin-ui-isolation/1e3a934d-173f-41a8-9488-790b7717648a/results.json`。                                                                                                                                                                                         |
| 原生场景与布局    | 四工具包内界面、批量草稿/自身设置往返、父 DOM/实际 native host_create 副作用拒绝、全新自带 UI+WASM 的通用插件、未声明能力拒绝、自动化保存且无执行历史、无关 ID/修改 JS 的上传包、真实本机 TCP 停用后继续并由任务中心停止、AI 真实 HTTP 回答→停止→再问。1440 暗/亮、900×600、390×844 截图及横向溢出断言通过；人工核对 dark-1440 / tools-light-390，iframe 填满工作区、无重复业务标题。                                                                                    |
| 静态检查与构建    | 桌面/插件和 SDK 各自 vue-tsc、严格 ESLint、Windows debug/no-bundle、全工作区 Clippy、Rust fmt、本次变更文件 Prettier、Git diff 空白及工具语法检查通过。实际编译器分别拒绝 desktop 私有源码和 Tauri 导入，见 `.local/plugin-refactor-boundary.log`。全库 format:check 仍有 14 个本次未修改文件的既有格式问题，未夹带格式化，见 `.local/plugin-refactor-format.log`。Clippy 保留 core 既有 single_element_loop 提示，缓存硬链接失败降级复制和原 Monaco 大 chunk 提示保留。 |

原生发现并修复的问题：Windows 资源 URL 的斜杠被 convertFileSrc 编码、Vue 独立库缺少生产环境常量、KeepAlive 移动 iframe 导致浏览上下文重建/草稿丢失、响应式 Proxy 无法经 MessagePort 克隆、模型列表相同版本快照触发深度 watcher 清空对话、重复开关事件流后未回收回调，以及 iframe 只有默认高度。新回归检查实际目标行为；相关失败保留在各 QA 子目录。最终测试脚本还修复了 CDP 端口先于 WebView 就绪的启动竞态和隐藏缓存设置页的定位范围，未放宽安全断言。

隔离依据：iframe 是 null 来源，CSP 禁止网络/表单导航/子框架，native IPC 仍限定主来源。Windows 可能注入 Tauri 全局，因此原生测试以实际 host_create 无副作用为判据，预期 CSP 拒绝日志单独记录，其他错误断言为空。UI 的批准由 Rust 冻结输入和真实预览生成的 Host 弹窗完成；WASM 不得到审批 API 或密钥。新夹具位于 `tests/fixtures/plugins/custom-ui`，不是正式功能数据。

额外执行 `tools/plugin-test-host/test.ps1 -Mode sdk`：首次误用 Windows PowerShell 5 导致 WSL 参数传递失败；使用当前 PowerShell 7 后脚本正常创建/清理专属容器，但 SDK 测试在运维/SFTP SSH 建连阶段返回 `SSH_NETWORK`（还未进入插件能力断言），本项失败，日志 `.local/plugin-refactor-linux-sdk.log`。没有改动 SSH 实现或据此宣称 Linux 长流程通过；历史记录中的 PLUGIN_SESSION_CLOSED 也未在本轮得到修复验收。

未验证与已知风险：工作区四项 ignored 分别为 Linux SDK、真实 Linux PTY 和两个显式 OS 凭据集成测试；本次没有对真实远端重跑全部插件操作，未做 macOS/Linux 原生、签名/安装器验收。Web UI 没有独立 OS/CPU/内存硬隔离，不能将其浏览器边界等同 WASM fuel 限额；取消远端进程仍可能需要人工核对实际状态。测试仅使用新建 QA 数据目录、自己的进程和本机服务，模型/凭据/测试主机均按现有脚本清理，未启动或改写用户客户端/配置。下一阶段依赖：可用的隔离 SSH 和跨平台验收环境；本阶段完成后停止。

## 2026-11-04：插件图标配置

Manifest 新增可选 icon 名称字段，九个系统插件配置各不相同的图标；上传包同样支持，缺省/null/未识别图标显示默认 boxes。统一用于运维工具侧栏、主机工具菜单、管理列表、插件页面与安装预览。旧已安装 system 记录缺字段时只读取分发配置作为显示默认值，不修改清单/摘要/安装代、启停、授权、卸载选择；同 ID 上传包不继承系统图标。Host API 1.3.0 明确新字段的兼容下限，SDK 1.2.0、包格式、ABI 与 UI 版本不变。

主要文件：crates/plugin-core/src/manifest.rs 及相关包回归；apps/desktop/src/{services/plugin-icons.ts,components/PluginIcon.vue,types/plugins.ts}，AppNavigation、HostTools、PluginsView、PluginPage 与对应测试；plugins/system 九份 manifest 及重新打包产物。新增 tools/ui-plugin-icons-e2e.mjs，同步 PRD、架构、设计决策、包格式、开发/API 文档与实施计划。没有新增依赖、权限、资源协议或数据库迁移。

| 检查                                                                                   | 结果                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                             | 50 文件、328 项通过；覆盖九图标均有效且互异、旧 system 回退、同 ID user 隔离、自选/未知/缺省图标、尺寸与更新，以及侧栏、主机工具、插件页集成                               |
| `cargo test -p serverdeck-plugin-core -p serverdeck-plugin-runtime --offline --locked` | core 20、runtime 12 项通过；图标经过预览、真实安装、仓库重开仍保留；旧包无字段可读取，非法路径/URL/标记/超长/类型被拒绝，未来合法名称可读取                                |
| `cargo test -p serverdeck-application bundled_plugins --offline --locked`              | 2 项通过；九包真实校验/实例化、系统预置权限、禁用/卸载选择与上传授权边界继续成立                                                                                           |
| `npm run build`                                                                        | 九个 WASM 标准包打包、vue-tsc 与 Vite 生产构建通过，保留既有 Monaco 大 chunk 提示                                                                                          |
| `npm run lint`、Rust 格式与 Clippy                                                     | ESLint 与本轮 Rust 文件 rustfmt 通过；core/runtime 全目标 Clippy 完成，依赖 core 既有 single_element_loop 和缓存硬链接回退提示保留                                         |
| 无头 Edge                                                                              | 1440×900 深/浅、900×600 深、390×844 浅四组通过；真实侧栏/主机菜单展示九种图标、自选 rocket、缺省及未知名称 boxes，旧系统缺字段仍显示配置图标，无根页面横向溢出与 pageerror |

本轮前端/文档 Prettier、脚本 `node --check` 及 `git diff --check` 通过；九份清单保留原有数组排版，JSON 解析、图标互异和源码/分发包 icon、apiVersion 一致性检查通过。

浏览器脚本为 `node tools/ui-plugin-icons-e2e.mjs`，通过 SERVERDECK_BROWSER、SERVERDECK_PLUGIN_ICONS_URL 指向独立浏览器和本地开发服务。结果与截图位于 `.local/plugin-icons/browser`；已查看桌面深色侧栏及窄屏浅色主机菜单。浏览器仅使用内存夹具，不写正式配置、不调用远程命令。测试服务和浏览器已退出。

首次 Rust 检查受沙箱限制，已有 junction 安全测试无法创建链接（19 项通过、1 项失败），获批沙箱外重跑 core/runtime 后 32 项全通过。首次 ESLint 提示共享组件 source 缺默认值，补上与原有行为一致的 user 默认值后通过；未删除或弱化有效断言。

未重跑完整 Tauri 原生 UI/安装包、真实远端全链路或 macOS/Linux；不宣称这些范围通过。当前支持宿主内置名称，不加载自带图片/远程 URL。未生成或替换安装包，未发现新增风险，无新增下一阶段依赖，本阶段结束。

## 2026-11-04：上传目录说明与旧 Nginx 测试插件清理

按用户要求删除仓库 plugins/upload/nginx-manager 的源码、声明与独立 Cargo 文件，以及 tools/plugin-nginx-e2e.mjs；通用原生测试移除 --nginx 分支，隔离测试入口仅保留 sdk/ui。Host Info、diagnostics 等通用协议测试继续保留，历史 Nginx 验收记录不删除。本轮不卸载客户端插件、不清理旧隔离环境或用户数据。

核对现有真实链路：管理页确认安装 .sdplugin 后，上传内容写入应用数据目录 plugins/upload/<ID>/versions/<revision>，packages/<ID>/record.json 登记当前安装；plugin_list 读取登记记录，管理页与运维工具侧栏显示全部已安装身份，包括禁用或未授权项。仓库中的 plugins/upload 不被启动扫描，不是运行时安装目录。普通 Windows 配置的应用数据根为 %APPDATA%/cn.hiboot.desktop。本轮没有改动安装、授权或导航行为。

实际验证：前端 navigation、plugin-manager、plugin-page 三个文件共 14 项通过；plugin-core 的 repository 回归 15 项通过，涵盖上传目录、注册/重启、升级回滚、数据保留及链接拒绝。首次前端临时文件 rename 和 Rust 临时目录写入受沙箱限制，改用任务内 TEMP/TMP 后前端与 14 个 Rust 用例通过；Junction 安全用例仍被沙箱阻止，沙箱外完整复验 15 项通过。Node/PowerShell 脚本语法和修改文件格式检查通过。未重新构建桌面程序或执行真实客户端上传、SSH/SFTP、跨平台验收；这些结果不计为本轮验证。无新增运行时风险，无下一阶段依赖。

## 2026-11-04：工作区工具标准插件与顶部菜单合并

按用户确认，本轮一并迁移 AI 助手、批量运维、自动运维、网络诊断，共九个独立标准内置包。每包具备 manifest/UI/Rust crate/Cargo.lock，只有公开 SDK 依赖，真实编译为 WASM/.sdplugin；SDK/API 1.2.0、UI v3 的 tool 贡献和领域能力同样对上传包开放，不按内置 ID 路由原生页面。顶部合并为“运维工具”，任务中心保留为宿主公共能力，管理仍在设置。

清理核实：旧 examples/plugins 是空目录，已删除；plugins/upload 仅保留实际 Nginx Manager。metadata、hello-world、diagnostics、host-info 是必要的生命周期/协议/权限/UI 验证夹具，移至 tests/fixtures/plugins，Cargo 相对 SDK 路径、构建及文档引用同步。不改动用户应用数据、已安装包、主机、凭据、历史和计划。

主要文件：plugins/system/{assistant,batch,automation,network}、plugin-sdk/{tools,ui,lib}、plugin-core/{manifest,package,permissions}、application/plugins/{tools,state,capabilities} 和 bundled_plugins；前端 PluginToolSurface、PluginPage/PluginView、plugin-server/plugin-tool-services、App、导航和 workspace；TaskCenterView 增加独立的自动化停止/计划暂停与活动历史分页。IPC/type、构建/QA、产品/架构/SDK/指南同步，无新增依赖或数据库结构迁移。

输入票据不可变、单次、过期且绑定插件/安装代/上下文代/精确操作；Guest 不持有密钥、私有连接或完整确认正文。AI 根请求隔离，精确取消不停止 VM，取消后可再次提问；停止排空前后撤销资源，拒绝已取消调用重新登记预览。模型命令/自动化/批量继续使用既有目标和风险确认。已经明确提交的工作/计划留在 Host，禁用或卸载不删除或悄悄终止，任务中心继续提供停止/暂停。上传相同声明仍默认禁用/未授权；内置全部声明权限固定只读。

| 实际检查            | 结果与证据（.local/ops-plugin-migration）                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端完整回归        | 49 文件 / 318 项通过，frontend-final.log。涵盖新导航、缓存草稿、确认、不可变载荷、精确取消/晚到结果/后续请求、取消错误原因链及无插件时的任务停止/计划暂停。                                                                                                                                                                                                                 |
| Rust 工作区         | cargo test --workspace --exclude serverdeck-desktop --locked --offline -j 2：214 项通过、3 ignored，rust.log；新增包类型/版本校验单独 18 项通过（其中 1 项为本次追加），core-final.log。因此本轮覆盖非桌面 215 个不同用例，桌面 IPC 另列，不叠加重复运行数。                                                                                                                |
| 最后资源撤销修复    | application plugins:: 14 项通过、1 ignored，plugin-final.log；覆盖取消旧票据不影响新请求、取消调用不能登记新预览、停止只撤销自有资源及分发默认授权。                                                                                                                                                                                                                        |
| 桌面真实 IPC        | 5 项通过，ipc.log。九包默认安装/固定授权/重启卸载墓碑；stage/cancel_request/abort_input 的其他窗口与远程来源拒绝。使用独立 target，未覆盖用户正在运行的默认程序。                                                                                                                                                                                                           |
| 独立插件编译与单测  | 新四个 Rust crate 各 1 项通过，plugin-crates.log；九包独立 --release --target wasm32-unknown-unknown --offline --locked 构建，packages.log/native-final.log。                                                                                                                                                                                                               |
| Windows 原生客户端  | 隔离 WebView2 共 9 组通过，native-result.json/native-final.log。真实九包/预置只读授权、原生注册接收器同形拖放安装、upload 落盘/卸载、四工具实际挂载/批量草稿、WASM 自动化保存真实 SQLite、AI 本机 HTTP 回答→取消→再问、真实本机 TCP→停用→任务中心停止、无关 ID 上传工具显式授权后使用同一视图/能力。截图覆盖 1440 暗/亮、900×600、390×844，窄屏收起侧栏且无根页面横向溢出。 |
| 原五个服务器插件 UI | 浏览器夹具四组主题/尺寸通过，server-browser/results.json/browser.log；真实共享组件、操作/详情/日志/上传提供者与菜单回归，pageErrors 均为空。这里只是 UI 夹具，不能代替真实远端运行验证。                                                                                                                                                                                    |
| 构建与静态检查      | Windows debug/no-bundle、TypeScript、Vite、严格 ESLint、Rust fmt、Prettier 和工具语法检查。标准全工作区 Clippy 完成；新增测试告警修复后 application 再检查通过，仍保留既有 core 的 single_element_loop 提示；首次沙箱增量缓存存在硬链接降级复制提示。原有 Monaco 大包提示保留。构建/hash 见 build.json。                                                                    |

普通应用配置的 Windows debug 程序位于 `.local/ops-plugin-migration/ServerDeck.exe`，SHA256 `8E73EC7DB0E7919BC5B5183427004AF1AB66CA88907333124B94533C00A6834E`。已核对最终程序中九个完整包字节、文件大小及 SHA256；汇总为 result.json/packages.json。没有覆盖或启动用户现有客户端，没有生成安装器。

测试只使用本轮独立数据目录、拥有的隐藏 QA 进程和回环 HTTP/TCP 服务。AI 测试 Key 随机生成，不写日志/证据；测试模型及 OS 凭据、测试主机均在 finally 清理，仅退出本轮客户端，不影响之前明确要求保留的隔离环境。

未验证及已知限制：本轮没有对真实远端重新跑新四工具的 SSH 交互流程；原任务/自动化/AI 核心的协议集成回归通过。上轮 Linux SDK 长流程存在运维租约意外关闭（PLUGIN_SESSION_CLOSED），本轮未修复或宣称通过；三个环境依赖测试仍 ignored。macOS/Linux 原生桌面、签名/安装器发行未验证。停止在途远端进程不能保证进程已退出，需核对实际状态；分发来源不是数字签名。下一阶段无新增依赖，当前阶段完成后停止。

## 2026-11-04：工具菜单、全主机适用和内置固定授权

本轮完成五项用户调整：管理列表只留卸载（名称仍打开自身页）；所有插件取消逐主机白名单，能力适用于当前及后续新增主机；五个系统分发包的声明权限、操作和必要目录默认预置且只读；终端 SFTP 文件右侧工具下拉只显示已启用插件，每插件一个入口；插件配置页与管理页移除固定最大宽度和重复内边距，铺满工作区。

内置新安装默认启用，已有 cn.hiboot 安装与旧域名迁移均保留原禁用选择；卸载墓碑不变。系统权限在可信设置中禁用编辑并隐藏保存/撤权，application 的 grant/revoke 同样拒绝，未依赖前端限制。日志可读根为 `/`，仍受远端账号和规范路径校验限制；Docker 的 system.shell 已预置，修改、敏感环境、文件写入和终端交接仍逐次确认。上传包保持默认禁用/未授权，可编辑自身能力和目录，上传同 ID 不获得系统身份/授权。旧授权文件 hostIds 兼容读取但忽略，新授权和 IPC 输出不含该字段，GrantInput 可省略；没有数据库结构迁移。

主要修改文件：`HostTools.vue`、`PluginSettings.vue`、`PluginsView.vue`、`PluginPage.vue`、`PluginView.vue`、`styles/plugins.css`、`services/server-plugins.ts`、`ServerView.vue`、`types/plugins.ts`、`crates/plugin-core/src/permissions.rs`、`crates/application/src/bundled_plugins.rs` 和 `plugins/capabilities.rs`；对应组件、应用、授权、分发和真实 IPC 断言同步。QA 工具迁移页内启停并去掉主机勾选；PRD、架构、决策、SDK/安全/开发/使用文档同步。

| 实际检查              | 结果与证据（本轮目录 `.local/plugin-tools`）                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端完整回归          | 49 文件 / 314 项通过，frontend.log；包括只卸载列表、系统只读、上传授权无 hostIds、工具菜单筛选/无 UI 包/键盘，以及切换插件保留终端与 SFTP                                                                                                                                                                                                            |
| Rust 完整工作区       | 214 项通过，3 项按既有条件 ignored；rust-workspace.log。授权测试验证任意当前主机、旧授权兼容、无上下文拒绝、摘要/安装代/能力/目录限制仍有效；实际 Tauri IPC 验证系统预授权、grant/revoke 拒绝、禁用 UI 拒绝及主窗口 ACL                                                                                                                              |
| 最终迁移增量          | 两项通过，migration.log；补齐旧系统授权、保留已有禁用/卸载和个人设置，上传相同 ID 仍无系统授权                                                                                                                                                                                                                                                       |
| Windows WebView2      | 四组通过，native-result.json 指向全新隔离数据目录、截图及结果；五个系统包真实落盘/预授权、页面只读、页内禁用确认/启用、真实 WASM health、上传预览/安装/upload 路径/卸载                                                                                                                                                                              |
| 浏览器交互与布局      | 1440×900 深/浅、900×600 深、390×844 浅共四组通过；明确使用独立 RPC 夹具。验证工具紧接 SFTP、只列启用项且含上传包、禁用取消/确认/恢复、系统全部勾选只读、配置页宽度等于可用区域、原图表/详情/危险确认/卸载；无页面异常，桌面概览无多余滚动；browser/results.json 和截图                                                                               |
| 静态与构建            | TypeScript、Vite、Windows debug/custom-protocol 构建、ESLint、Cargo fmt 和 Clippy 通过；Clippy 沿用既有 `-D warnings -A clippy::single_element_loop`，未新增生产依赖。具体格式/脚本检查见本节交付补充                                                                                                                                                |
| 真实 Linux SDK 长流程 | **未通过**。初次容器/WSL 转发未就绪，增加有界 SSH banner 就绪检查后连接恢复。五个标准包的监控、查询、日志与禁用后共享 SSH/SFTP 租约断言已执行，但后续 SDK 保存/确认/任务长流程发生运维租约意外关闭，出现 PLUGIN_SESSION_CLOSED；不能将整项计为通过。linux.log 保留失败证据；未放宽校验或删掉有效断言，临时调用间隔实验没有解决问题，未保留该实验代码 |

沙箱最初阻止 Vitest 临时文件 rename 和本机回环网络，改在正常本机环境重跑后完整前端/Rust 检查通过；没有修改生产权限。测试子进程与容器均为本轮独占，目录和身份有明确边界；临时容器按 ID/标签清理，不操作用户已有主机/凭据/容器。Windows 拖放验证仍是向原生已注册接收器投递同形事件并执行真实 IPC，不等于资源管理器物理拖动手势验收。

正常配置程序 `.local/plugin-tools/ServerDeck.exe`，SHA256 `E3158D2F94CE01FB3F3596A1E45663233E05D23A89F288433BDEFC2BC9082A2D`；构建日志和清单同目录。未启动最终普通程序、替换用户程序或安装发布包。未测 macOS/Linux 桌面、Release 安装器、新的 Docker/systemd 远端修改和完整交互容器终端；已有 Monaco chunk 提示保留。已知剩余风险是上述 Linux SDK 长流程连接中断，不能宣称所有远端回归已通过。本阶段功能实现完成，没有新阶段依赖；不在本轮扩大为 SSH 连接机制重构。

交付补充：相关 Prettier、全项目 ESLint、五个修改过的 Node QA 脚本语法、PowerShell 夹具语法解析、当前文档链接和限定差异空白检查通过。最终 EXE 与构建来源 SHA256 一致，五个完整标准插件包字节均已核对嵌入。额外 application Clippy 检查通过；前端辅助服务已停止，最后一次 Linux 临时容器按精确 ID 只读确认已移除。旧运行程序和用户数据未被替换或清理。

## 2026-11-04：个人域名、插件管理重排与上传目录

六项调整落地：五个内置 ID 为 cn.hiboot.plugins.*；管理入口回到设置，顶部插件只显示已安装名称；管理页重做为拖拽安装区和紧凑列表，没有路径输入；列表仅启停与卸载，名称打开插件自身页；来源/权限/运行状态/包详情集中到自身设置，禁用、未授权或无 UI 包也能进入；上传示例源码位于 plugins/upload，客户端上传内容位于应用数据目录 plugins/upload/<ID>/versions，与系统内容 system 分开。

旧 packages/<ID>/versions 按原来源迁移，记录、安装代、授权和个人配置不变；冲突拒绝且不覆盖，逐版本原子移动可续跑。系统域名迁移保留配置与原卸载选择，新身份不继承旧授权；旧系统记录归档，第三方包 ID 不改写。应用 identifier、主机、凭据及数据库结构不变。

主要文件为 repository/layout 与仓库读写/清理、bundled_plugins，五个 manifest，PluginPage/PluginSettings/PluginsView、导航/工作区及样式；上传示例和所有构建/文档引用同步移动。既有原生插件脚本同步为新拖放/自身设置入口，只完成语法检查，不把其完整 SSH 交互视为本轮已执行。

| 实际检查            | 结果与证据                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端全量            | 49 文件/313 项通过；含拖放单包校验、ACK、迟到预览、升级失败/取消、列表精简、禁用插件权限页、授权表单不被轮询覆盖                                     |
| Rust 全工作区       | 214 项通过，3 项保持 ignored；rust-workspace.log                                                                                                     |
| 迁移/存储回归       | 应用与核心针对性检查通过；原授权/数据/安装代不变、系统到上传升级备份、冲突不覆盖、原卸载墓碑、域名配置迁移且新身份无授权、链接拒绝、提交失败旧代有效 |
| 真实 Linux SDK/WASM | 临时 Ubuntu/OpenSSH/Nginx 通过；新 ID 和 system/upload 目录支持真实采样、查询、日志及原有 SDK/写入/取消；linux.log                                   |
| Windows WebView2    | 独立应用标识和全新数据目录，四组通过；native-result.json 指向截图和结果；无用户主机/凭据访问                                                         |
| 浏览器              | 1440×900 深浅、900×600 深、390×844 浅四组通过；浏览器夹具明确仅用于 UI，含自身来源/权限、无列表来源、导航归属、启停/卸载及图表/详情回归              |
| 上传示例源码        | Nginx Manager 六项单测通过；移动后的 Host Info 简名公开 SDK WASM 构建/打包通过                                                                       |

原生 WebView2 实际执行：读真实嵌入的五个 cn.hiboot 包并校验 system 落盘，禁用资源插件可打开自身设置，保存真实权限后启用并运行 WASM health；向 Tauri 已注册的拖放接收器传递同形事件，实际 Rust 预览/摘要绑定/确认安装 metadata 包，校验 upload 路径和 user 来源，进入自身设置再经真实 UI 卸载。最初测试调用 emit_to 被生产 ACL 拒绝，改为隔离调试客户端的接收器事件投递，没有开放 emit/emit-to 权限。未自动化 Windows 资源管理器的物理拖动手势；接收/安装链路与真实 OS 手势明确区分。

本轮不操作用户现有主机、凭据、配置或保留中的验收容器，临时 Linux 容器按身份清理；QA 客户端正常退出。未做 macOS/Linux 桌面实机、Release 安装包或新增 Docker/systemd 远端修改/容器交互终端验收。保留已有 Monaco 大 chunk 和原 OpenSSH Clippy 单元素循环豁免，无新增生产依赖、数据库迁移或后续阶段依赖。

最终 TypeScript/Vite/Windows debug 构建、ESLint、Cargo fmt、修改文件 Prettier、工具脚本语法与当前文档相对路径检查通过；全工作区 Clippy 使用既有 `-D warnings -A clippy::single_element_loop`，未扩大生产权限。设置页面额外四组浏览器复验通过，原分类草稿与语言行为保持。正常配置程序为 `.local/plugin-management-redesign/ServerDeck.exe`，SHA256 `876C18E3B43A221444279B1B1CE1ECDD55D5751DC6ABCF6F1ADB4DA4ABEF9C0B`，与构建来源一致；五个 cn.hiboot 完整包字节均已核对嵌入。构建/测试/截图/包摘要在同目录，最终普通配置程序未启动或替换用户程序。

目录迁移后旧客户端不再兼容新的内容路径，不支持直接切回旧程序；原内容、记录和个人数据保留。此为存储布局变化的明确兼容边界，无自动回退工具。本阶段完成，无新增下一阶段依赖。

## 2026-11-04：五个独立标准 WASM 系统插件

本次替代上一个原生提供者方案。五个独立源码在 plugins/system/{resources,docker,processes,services,logs}，仅依赖公开 SDK，分别编译/打包，发行资产位于 plugins/system/packages。内置与用户上传使用同一仓库、WASM runtime、授权、管理和卸载，菜单显示全部安装及来源标签；初始禁用且未授权，卸载后不自动重装。UI v2 共享可信服务器渲染器对上传包同样开放，全部业务先调用本包 WASM。

已实际执行的检查（最终汇总见本节末尾）：

- 五个独立 crate 原生单测共 10 项通过，验证自身业务能力和跨域拒绝；五个实际 WASM release 包通过相同标准构建/打包工具生成。
- 前端全量、SDK/应用资源隔离与生命周期、Rust 工作区以及 Tauri IPC 执行结果保存在 `.local/standard-system-plugins/`。标准安装测试实际载入五个包并执行 WASM，验证默认拒绝、UI 授权、Guest 能力策略、Host 拒绝、撤权、卸载/重启和上传同包的 user 来源。
- 实际独立 Ubuntu/OpenSSH/Nginx 容器调用五个标准 WASM：监控读取真实内核与样本，进程和端口有真实记录，文件日志返回真实内容，Docker/systemd 缺少运行环境时保留实际不可用码。仍运行原有 SDK 的文件保存/冲突/符号链接越权、审批、任务、Nginx 日志和取消回归。单项 Linux 全链路通过，临时凭据/容器按身份校验后清理；未碰已有用户验收环境。
- Edge 四组（1440×900 深/浅、900×600 深、390×844 浅）验证资源分类/图表、内部列表滚动、键盘/详情/危险操作确认、进程贡献联动、菜单五个内置/一个上传来源、相同启停确认/取消与卸载。上传资源包从同一菜单打开相同图表，证明没有按系统 ID 选择组件。浏览器只用显式内存 RPC 夹具，不代替真实 WASM/SSH 检查。
- 错误提示 15 组复验通过，包括普通/长 Unicode 文字选择、复制事件和原生 dialog 内通知；不改写用户系统剪贴板。

真实 Linux 首次暴露大结构化 JSON 超出原有 200 万 fuel，调整为超过 1 KiB 走有配额、归属和 TTL 的不透明分块结果，未放宽 WASM 限额；复测通过。浏览器首次暴露标准上下文栏占用和样式优先级问题，复用 server-panel 样式并收紧插件上下文布局，桌面概览无额外滚动，四组复验通过。

主要修改 SDK 1.1/UI v2、plugin-core 包校验/来源、application 标准资源/首次分发、Tauri 单次终端交接、五个独立插件、PluginServerSurface 和统一管理/导航。旧原生注册表/IPC/门控已移除，旧配置行保留，不做数据库结构迁移。架构、决策、PRD、开发及使用文档已同步。

未验收真实 Docker daemon/systemd 状态修改、交互式容器终端的完整原生 UI 到远端链路、Release 安装包及 macOS/Linux 桌面。Docker/systemd 本轮只验证实际不可用处理；终端票据的归属/目标/主机/版本/上下文/TTL/单次消费和主窗口 ACL 已测试，不能等同于全部平台终端验收。保留既有 Monaco 大包与 Cargo 硬链接回退提示；无新增生产依赖或后续阶段依赖。

最终检查汇总：前端 48 文件/308 项通过；Rust 工作区 209 项通过、3 项按既有标记 ignored（Linux 夹具项另行显式运行通过），最后 SDK/包协议增量 17 项通过；五个独立 crate 共 10 项通过。TypeScript/Vite、Windows Tauri debug/custom-protocol、全项目 ESLint、Cargo fmt 通过。全工作区 Clippy 使用 -D warnings -A clippy::single_element_loop，仅豁免既有 OpenSSH 单元素循环；新增告警已修正。修改文件格式、八个构建/浏览器/原生工具语法、限定差异和当前文档相对路径检查通过；原生旧脚本只同步新菜单契约并检查语法，没有宣称本轮执行完整原生 UI 到远端流程。

最终程序为 `.local/standard-system-plugins/ServerDeck.exe`，SHA256 `3B1CD73B613ACDDC74168EBC2AD86A3430E2D3641D22F4E5A28FB09A08EC7651`；构建日志/清单、每个包摘要与源码位置、浏览器截图及回归记录位于同目录。已核对五个完整标准包字节确实嵌入最终 EXE，包内 WASM/UI 及文件摘要正确，五个源码 Cargo.toml 只有公开 SDK 依赖。没有安装或启动最终程序、替换用户 EXE 或改动原有验收环境。

## 2026-11-04：服务器管理五个原生内置插件（历史，已被标准包替代）

已实现资源监控、Docker 管理、进程与端口、系统服务、日志查看五个原生提供者。插件管理分别展示系统内置与本地安装插件，内置启停真实写入现有 settings 表并在重启后保留；不提供单独卸载。服务器管理继续贡献九个分类，按启用状态过滤，支持全部禁用/恢复、不可用状态重试、跨插件进程/日志联动。Rust 独立门控保护原生查询、监控、日志恢复及容器终端；禁用等待在途操作后清理采样或内置日志，保留共享连接、远端工作负载与外部插件资源。

主要实现为 core/storage/application 的 builtin_plugins、原生提供者注册表及 store、ServerView/PluginsView、两个受 main ACL 保护的 IPC。复用现有 MonitorView、OperationsView 和宿主采集/操作服务，不降低到受限 WASM 表单，也不向外部包开放原生渲染；外部包不能使用 serverdeck.builtin.*。

实际验证：

- 前端全量 48 文件/306 项通过；最后服务器管理/插件管理 2 文件/9 项复验通过。覆盖注册完整性、加载失败重试、启停真实结果/清理失败后的状态同步、确认取消、资源切换、日志目标禁用及全部禁用后无失效标签面板。
- Rust 全工作区 208 项通过、3 项按原标记 ignored；包含本机 SSH/SFTP/转发、旧数据与凭据边界、插件包/runtime 和真实 Tauri IPC。新增 IPC 测试验证固定五项、禁用确认、持久化、原生请求 PLUGIN_DISABLED、未知 ID、其他窗口和远程 origin 拒绝；最后该 IPC 单项复验通过。应用层测试验证不同插件门控独立，禁用等待自身在途操作。
- 四组 Edge 主题/尺寸（1440×900 深/浅色、900×600 深色、390×844 浅色）通过原服务器图表/列表/详情/危险确认回归，以及五项管理卡片、禁用取消/确认、重新进入状态保留、分类隐藏、全部禁用与恢复；15 组错误提示场景通过。均为明确的浏览器内存夹具，不等同于真实远端业务执行。
- TypeScript/Vite、全项目严格 ESLint、Cargo fmt、本次文件 Prettier、UI 工具语法、限定差异及文档链接检查通过。全工作区 Clippy 使用 `-D warnings -A clippy::single_element_loop`，仅豁免原有 OpenSSH 单元素循环告警；本次新告警已修正。
- Windows Tauri debug/custom-protocol 构建通过，`.local/builtin-plugins/ServerDeck.exe` 与构建来源 SHA256 校验一致；清单与日志在同目录。默认 Cargo 输出 EXE 覆盖被系统拒绝，改用 `.local/native-ui-build` 独立缓存完成测试和构建，没有结束用户程序。初次产物驱动的控制台编码错误已修正，构建与复制最终完成。

未执行本轮真实远端 Docker/systemd/完整原生界面端到端、Release 安装包或跨平台验收；三个 ignored 检查包括系统环境或专用 Linux 夹具要求，不能视为通过。本次没有连接用户服务器、修改持久主机/凭据或清理现有隔离环境。原生插件随应用更新，不能作为独立 sdplugin 包升级；启停是内置工作流控制，不是撤销 AI/外部插件的独立授权。保留既有 Monaco 大包与 Cargo 硬链接回退提示，无新增生产依赖、数据库迁移或下一阶段依赖，本阶段完成后停止。

## 2026-11-04：插件导航与全局语言统一

新增顶部“插件”模块，管理入口与已授权的 navigation/settings 贡献集中在该模块侧栏；打开管理页、插件工作区或已有插件标签时同步顶部归属。顶部模块切换沿用只切换菜单的规则，保留当前页面、主机连接和插件草稿。移除管理页与插件工作区的独立语言选择及可变 locale，文案和字典标签使用已保存的全局 product.language；唯一语言入口是“设置 → 工作区与连接”，当前只提供完整简体中文。公开 SDK 双语标签格式保持兼容。

主要修改 types/navigation.ts、AppNavigation.vue、plugins store、PluginsView/PluginView 与独立选择器样式；同步导航/工作区/插件单测、共享浏览器导航和原生插件测试脚本，以及 PRD、用户指南、架构和决策。修复前四项导航/入口断言失败，修复后前端 46 文件/299 项通过，最后导航 7 项复验通过。TypeScript/Vite、全项目严格 ESLint、本次文件 Prettier、五个工具脚本语法及限定差异检查通过。

Edge 内存夹具验证四组主题/窗口（1440×900 深/浅色、900×600 深色、390×844 浅色）下的顶部顺序、设置/插件侧栏隔离、两处语言入口移除、中文字典标签、模块切换和插件草稿保留、标签返回及无横向溢出。原设置、布局和工作区三套浏览器脚本各四组通过，共 16 组。工作区旧菜单断言遗漏已有 AI/模型入口，并保留四模块计数，已同步当前菜单；全部原有终端和上下文断言保留。日志、截图和结果位于 `.local/plugin-navigation/`。

未重跑 Windows WebView2 插件原生端到端、Rust 或跨平台测试，未重建桌面程序/安装器。本轮浏览器不调用 Rust、用户服务器或持久设置，不把内存夹具视为真实插件业务验收。保留既有 Monaco 大包提示，无新增依赖、迁移或阶段依赖；下文独立中英切换结果属于旧阶段历史，当前行为以上述全局语言规则为准。

## 最终验收矩阵（2026-11-04）

本轮严格按 13A-1 → 13A-2 → 13A-3 → 13A-4 → 13A-5 实现、测试、修复、更新文档后推进。下列“已实现且已验证”指本机 Windows x64 Host 与隔离 Linux 验证范围；不代表所有平台、可信签名发行或 OS 进程隔离已经验收。各阶段详细结果保留于后文。

### 普通配置客户端交互验收补充（用户最终验收通过）

按用户要求启动普通配置的 Windows 验收版，用户完成本地开发包安装、隔离主机私钥凭据、SSH 主机密钥核对及插件授权。实际 SSH/SFTP 已连接，插件已成功检测 Nginx 并读取隔离容器配置；该容器不挂载宿主数据，只映射回环端口。此前错误授权根目录被 Rust 拒绝，用户改为正确的隔离根目录后读取成功。

用户确认保存时出现“数据已变化或存在关联”，只读核对远端摘要仍等于读取摘要，配置未写入，HTTP 仍为 200 且无测试响应头。回归测试以真实确认对象模拟经过 61 秒，复现旧代码返回通用 `CONFLICT`。修复后过期或失效确认返回 `PLUGIN_CONFIRMATION_EXPIRED` 和重新发起操作的提示，弹窗标明 60 秒有效期，不延长权限、不自动重试，草稿保留。新测试覆盖过期删除、重复拒绝、取消以及新确认单次消费；应用层 25 项通过，需专用 Linux 夹具的 1 项未在本次局部复验中执行（前述阶段已有独立实测）。日志为 `.local/plugin-13a/manual-approval-expiry-{before,after}.log`。

本次局部复验的 Rust fmt、应用层标准 Clippy、TypeScript、组件严格 ESLint、相关文件 Prettier、差异检查及 Windows Tauri debug 构建通过；保留已有 OpenSSH 单元素循环、缓存硬链接回退和 Monaco 大包提示。未重复全工作区/全前端/原生七组测试，也未重新发布插件包。修复程序另存 `.local/plugin-13a/ServerDeck-13A-confirmation-fix.exe`；来源与副本 SHA256 均为 `DDAD2F084B8DCF4772B7495275D2C9C7613B59491B8457C2FE25191974BFB757`，记录于 `manual-approval-deliverables.json`。

用户在普通配置客户端依次明确确认保存、`nginx -t` 和重载后报告成功，并启动日志。随后独立只读核对：HTTP 200，响应体仍为隔离测试页面，`X-ServerDeck-Acceptance` 从空变为 `13A`；远端配置 SHA256 为 `88822a48cfd8ec472325fd2299b337f12762d3a14469a681a72118bb94901ebd`，与保存确认摘要一致。实际插件日志出现 SIGHUP/reconfiguring、新 worker 启动和旧 worker 以 0 退出；UI 实测日志 running → paused → running → closed，搜索 reconfiguring 只显示匹配的两行。

确认无未保存配置后正常退出旧客户端，启动上述修复版。实际窗口来自修复版路径，Nginx 插件及授权重启后保留；重新选择隔离主机，SSH/SFTP 均连接成功，公开插件读取返回新文档标识、测试响应头配置及同一保存摘要。当前重载按钮在新上下文中保持未验证禁用，未继承旧会话验证状态。修复版未重新执行写入/重载，也未手动等待 60 秒验证过期弹窗；过期错误由上述应用层回归覆盖。真实业务写入/校验/重载验证来自用户操作的旧候选，不将两次客户端运行混为一轮。

本次人工引导流程已由实际 HTTP、配置摘要与原生 UI 日志交叉核验。2026-11-04 用户明确确认“验收通过，暂留隔离测试环境”；本轮 13A-1～13A-5 开发及上述 Windows/Nginx 验收范围完成，已披露的限制与未重复检查保持不变。按用户要求保留隔离容器、临时验收主机/凭据及修复版窗口，不执行清理，不影响原有主机。结果摘要位于 `.local/plugin-13a/manual-acceptance/results.json`；只记录测试元数据，不含密码或私钥内容。

| 任务项                      | 状态           | 实现与验证依据                                                                        |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| 13A-1.1 领域/仓库           | 已实现且已验证 | plugin-core/repository，重启/持久化测试                                               |
| 13A-1.2 清单严格协议        | 已实现且已验证 | manifest serde 严格校验、SemVer/API/平台与入口测试                                    |
| 13A-1.3 安全本地包          | 已实现且已验证 | JSON/base64，无压缩/链接表示；路径/重复/超限/摘要/Windows junction 拒绝               |
| 13A-1.4 安装/启停/升级/回滚 | 已实现且已验证 | 核心事务代际测试、真实提交失败回滚、原生安装与升级                                    |
| 13A-1.5 完整性/信任策略     | 已实现且已验证 | 摘要绑定、显式未验证开发模式；签名验证接口保留，密码学验证未实现                      |
| 13A-1.6 数据隔离/卸载       | 已实现且已验证 | 每插件 data/cache、默认保留/明确清理、链接防护/远程文件保留                           |
| 13A-1.7 Rust/IPC            | 已实现且已验证 | Application + Tauri dispatcher 实际安装/列表/状态/卸载/ACL 测试                       |
| 13A-2.1 后端模型            | 已实现且已验证 | 无 WASI/导入 Wasmi，禁止原生动态库与普通子进程执行                                    |
| 13A-2.2 生命周期消息        | 已实现且已验证 | 版本化 ABI/启动/激活/健康/停止/取消/退出与配额测试                                    |
| 13A-2.3 运行时管理器        | 已实现且已验证 | 异常清理、崩溃显示、显式重启、禁用/升级/卸载/退出                                     |
| 13A-2.4 资源配额            | 已实现且已验证 | fuel/内存/并发/消息/任务限制；死循环/洪泛/超限/取消测试，OS/OOM/硬壁钟限制见下文      |
| 13A-2.5 默认无宿主能力      | 已实现且已验证 | 无导入 VM、非法导入/协议测试；秘密/Session 不传 Guest                                 |
| 13A-2.6 hello-world         | 已实现且已验证 | 真实 WAT→WASM 激活/诊断/释放，不充当业务实现                                          |
| 13A-2.7 元数据联动          | 已实现且已验证 | 禁用后拒绝调用、卸载停止任务/VM，原生生命周期验证                                     |
| 13A-3.1 权限模型            | 已实现且已验证 | 八项权限、操作/主机/目录默认拒绝矩阵                                                  |
| 13A-3.2 Rust 逐请求校验     | 已实现且已验证 | 授权绑定安装代/摘要/版本/发布者；升级失效、主机越界/撤权拒绝                          |
| 13A-3.3 Host API            | 已实现且已验证 | 公开 SDK 实际 SSH/SFTP/设置/通知/任务/日志；复用既有租约                              |
| 13A-3.4 单次风险审批        | 已实现且已验证 | 操作摘要+上下文代+60 秒一次性批准，真实保存/验证/重载 UI 确认                         |
| 13A-3.5 取消/错误/限额      | 已实现且已验证 | Linux 实测超时/输出限额/并发/取消；有界日志与拒绝事件                                 |
| 13A-3.6 公开 SDK            | 已实现且已验证 | 独立 Wasm workspace 只依赖 SDK；协议、类型、兼容与示例编译                            |
| 13A-3.7 权限矩阵            | 已实现且已验证 | 未授权/撤销/伪造/升级/主机范围/会话关闭/并发测试                                      |
| 13A-4.1 管理页              | 已实现且已验证 | 原生 UI 安装/权限/启停/升级/卸载/详情/错误                                            |
| 13A-4.2 安装风险预览        | 已实现且已验证 | 来源未验证/显式接受/身份/权限/兼容/摘要绑定测试                                       |
| 13A-4.3 五类贡献            | 已实现且已验证 | Host Info 原生工具栏/导航/右键/命令面板/设置页                                        |
| 13A-4.4 渲染与受控桥        | 已实现且已验证 | 严格 JSON、无插件脚本/URL、固定组件、CSP/ACL、恶意消息/字符串测试                     |
| 13A-4.5 生命周期            | 已实现且已验证 | 启用注册、撤权/禁用/卸载撤销、dirty 主机切换/关闭、崩溃错误态                         |
| 13A-4.6 主题/基础国际化     | 已实现且已验证 | 插件跟随全局语言（当前中文）、亮暗截图；SDK 双语资源保留，主应用完整英文不在声明范围  |
| 13A-4.7 官方 UI 示例        | 已实现且已验证 | Host Info 真实主机投影/只读 uname/隔离设置                                            |
| 13A-5.1 独立 Nginx 插件     | 已实现且已验证 | plugins/upload/nginx-manager 仅依赖公开 SDK，cargo tree/独立 Wasm 构建                |
| 13A-5.2 检测与差异          | 已实现且已验证 | 真正 command -v/nginx -V/systemctl 输出与配置路径；缺失/权限错误单测、非 systemd 实测 |
| 13A-5.3 配置编辑            | 已实现且已验证 | 真实原子保存/外部冲突、草稿与取消关闭、恢复路径失败单测                               |
| 13A-5.4 nginx -t            | 已实现且已验证 | 临时容器非法指令返回真实 stderr/非零码，合法配置返回 0                                |
| 13A-5.5 显式重载            | 已实现且已验证 | 主机/参数/摘要绑定，重跑 -t && reload，HTTP header 实际改变                           |
| 13A-5.6 日志                | 已实现且已验证 | 真实读/搜索/暂停/继续/取消；缓存/UTF-8 分块与惰性文本回归                             |
| 13A-5.7 包生命周期          | 已实现且已验证 | 真实禁用、1.0→1.1 新权限升级/重新授权、撤权/卸载，服务器文件及服务保留                |
| 13A-5.8 全链路              | 已实现且已验证 | WebView2 + native IPC + SQLite/OS 凭据 + 临时 Ubuntu SSH/SFTP/Nginx 七组通过          |
| 13A-5.9 安全可靠性          | 已实现且已验证 | 核心/运行时/SDK/原生测试综合覆盖权限伪造/主机/断线/崩溃/取消/限额/回归；平台限制另列  |
| 13A-5.10 文档/发布准备      | 已实现且已验证 | 开发/安全/测试/API/示例说明与验收版构建；未进行签名发行、安装器发布或跨平台发布       |

## 13A-5（已实现且完成 Windows WebView2 + 隔离 Ubuntu 业务验收）

主要修改：独立 `plugins/upload/nginx-manager/{manifest.json,ui.json,backend,README.md}`，`tools/build-plugin.mjs`、隔离容器/原生 QA 工具；通用 PluginLog 增加流式 UTF-8 解码回归、修正语言选择器样式优先级；补齐公开协议/安全/开发/进度与架构决策。没有给核心加入 Nginx 专用操作、私有 SDK 依赖或数据库迁移。

最终验证：

- `cargo test --workspace --offline --locked -j 2 --target-dir .local/plugin-13a/cargo-target`：202 项通过，默认 ignored 的 Linux SDK 测试已另行实际执行通过；其余既有 OS store/PTY ignored 项未冒充执行。
- 独立 Nginx crate `cargo test --manifest-path plugins/upload/nginx-manager/backend/Cargo.toml --offline --locked`：6 项通过。覆盖安全路径引用、缺失/权限拒绝、真实退出状态传播、失败验证禁止重载、摘要/主机/参数绑定、未保存拒绝、保存恢复信息与协议伪造。
- 前端 46 文件/294 项通过；含 SDK/桥/贡献/dirty、升级确认/取消、日志 65,536 字符缓存/分块 UTF-8/暂停取消和现有核心回归。
- 真实 Linux SDK 复验 1 项通过（stage5-linux-sdk.log），覆盖 Host 只读诊断、SFTP/冲突/链接边界、批准、任务/日志、限额/并发/取消/恢复。
- `tools/plugin-test-host/test.ps1 -Mode nginx`：七组真实原生场景通过（stage5-native-nginx.log）。结果和截图位于 `native/run-1793725003719-d971046d-c00d-4eb7-95ed-58e09f79b2d3/`。最后另行只读检查本任务标签的容器为空，临时凭据由 QA 清理。
- fmt/check/标准工作区 Clippy、独立 Nginx 严格 Clippy、严格 ESLint、TypeScript/Vite/Windows Tauri 构建通过。保留既有 core/openssh 单元素循环严格警告、硬链接回退提示和 Monaco 大 chunk；不因本轮修改无关代码。

关键实际断言：写入非法配置后 nginx -t stderr/exitCode 明确失败且重载禁用；恢复合法配置后，外部追加内容使旧验证摘要失效；重新验证并明确确认重载，HTTP `X-ServerDeck-Plugin` 返回本次随机标识。并发外部修改导致保存冲突时远端变化和本地草稿同时保留，取消关闭不丢编辑；日志追加/暂停/继续/搜索/取消真实生效；主机越界、关闭 SFTP 租约、撤销授权均由 Rust 拒绝。新增权限升级后 grant=null 且 disabled；卸载后配置/日志/HTTP 服务均保留。

测试修复记录：原生脚本按实际 TerminalSession DTO 检查现存租约，不读取不存在的 state；依据 busy 状态等待动作完成，避免把重载因验证失效而禁用当成调用未结束；Nginx 重载关闭旧 keepalive 连接，HTTP 核验使用独立连接；多步审批重试消耗 VM 消息，自动化按公开每秒 20 条配额节奏执行，没有删除限流断言/放宽生产配额。首次不满足这些等待条件的运行未计入通过。

最终复查修复了升级失败后旧插件 Host 能力门控未恢复的问题：保留旧安装代与授权时恢复 Host 控制状态，VM 仍按原安全策略重新激活，工作区重新绑定主机。回归测试在临时恢复旧停止行为时实际失败（upgrade-regression-before.log，PLUGIN_CANCELLED），修复后通过；同时验证真正 Windows 只读 record.json 提交失败后元数据/授权/能力仍可用。升级 UI 现在在资源清理/草稿放弃之前明确确认；取消没有原生写入，接受后清除过期上下文缓存，失败仍展示错误通知。新单测覆盖取消保留编辑、失败清理旧绑定及旧安装代保留。

发布边界/已知风险：只验证 Windows x64 Host + Ubuntu 容器；macOS/Linux 客户端、其他发行版/systemd 部署未执行原生验收。只有未验证来源的本地开发安装，没有签名信任/市场/发布服务；未打包发布 NSIS 或安装到用户环境。WASM 无 OS 进程/OOM/硬壁钟隔离，限制见 PLUGIN_RUNTIME/SECURITY；配置 include 树不锁定，外部写入最终竞态仍存在；单文件 UTF-8 32 KiB，命令最多 30 秒/输出配额，Guest 验证使用 20 秒。nginx reload 返回 0 后仍应检查业务与错误日志。没有自动提权、自动配置修复或远程 Agent。

下一阶段依赖：无。本轮开发到 13A-5 停止；用户最终验收已通过，隔离测试环境按用户要求保留。

### 复现准备与验收产物

需要 Windows WebView2、稳定 Rust/wasm32 目标、Node/npm、WSL Ubuntu-24.04（或脚本 Distro 参数）内的 Docker。先获取锁定依赖；以下路径是 QA 脚本约定，并非用户数据目录：

```powershell
cargo build --manifest-path tests/fixtures/plugins/diagnostics/backend/Cargo.toml --target wasm32-unknown-unknown --release --locked --target-dir .local/plugin-13a/sdk-guest
node tools/build-plugin.mjs tests/fixtures/plugins/host-info .local/plugin-13a/host-info.sdplugin
node tools/build-plugin.mjs nginx-manager .local/plugin-13a/nginx-manager.sdplugin
wsl -d Ubuntu-24.04 --exec docker build --tag serverdeck-plugin13a-test:13a /mnt/d/CodexProjects/operations/tools/plugin-test-host
./tools/plugin-test-host/test.ps1 -Mode sdk
./tools/plugin-test-host/test.ps1 -Mode ui
./tools/plugin-test-host/test.ps1 -Mode nginx
```

按仓库实际挂载位置修改 Docker build 的上下文路径。打包工具使用 create-only；已有包时复用已验证包或指定新输出，不自动删除。当前机器镜像元数据下载失败后，使用本机已有官方 `eclipse-temurin:21-jre`（Ubuntu 24.04.3）作基底，构建参数 `--pull=false --build-arg BASE_IMAGE=eclipse-temurin:21-jre`；其上实际安装 OpenSSH/Nginx/Python。Dockerfile 默认基底仍是 ubuntu:24.04，不要求 Java 运行环境。

本轮生成普通应用配置的 Windows debug 验收程序 `.local/plugin-13a/ServerDeck-13A.exe`（stage5-deliverable-build.log），阶段自动化验证使用同代码的独立 QA 客户端/数据目录。随后按用户明确要求启动普通配置客户端进行交互验收，进度见前文补充记录；未覆盖原有客户端。Host Info 与 Nginx 包位于同目录的 host-info.sdplugin/nginx-manager.sdplugin；SHA256 记录于 deliverables-sha256.json。上述产物为本地开发验收候选，未签名、未打包 NSIS 发布。

## 13A-4（已实现且完成 Windows WebView2 + 隔离 Linux 验证）

实现：真实管理页及预览摘要绑定、授权/启停/升级/卸载；五类贡献、严格 JSON 渲染/消息桥、生命周期撤销、主机上下文、dirty 保护、崩溃恢复、插件中英/主题。主要修改 SDK ui schema、package/repository、application/Tauri 三项 IPC、plugins/workspace stores、PluginView/PluginsView/PluginLog、导航/主机菜单/命令面板、host-info 示例及构建/QA 工具。UI 与开发文档已补齐。

验证：全 Rust 201 项通过（stage4-cargo-test.log），前端 44 文件/292 项通过（stage4-frontend-test.log）。新增摘要改变、UI 未授权/撤权/过期版本、脚本/原型拒绝、超限消息、声明动作、上下文去重、dirty 主机切换/关闭等断言。21 项 IPC 的异窗口/远程来源 ACL 实际 dispatcher 测试通过。cargo fmt/check/标准 Clippy、TypeScript/Vite、严格 ESLint 与 Windows Tauri QA 构建通过。

真实原生 `tools/plugin-test-host/test.ps1 -Mode ui` 五组通过：预览未验证提示/显式接受/安装、授权/指纹核验/真实 uname、亮暗主题和英语、五类贡献与独立设置/恶意文本惰性显示、禁用卸载撤销页面/菜单/运行时。证据 `.local/plugin-13a/stage4-native-ui.log`，截图及结果 `native/run-1793722873752-b2a938bd-5bd5-4f3d-a17d-de4adbaf4801/`。临时容器和 OS 凭据已清理；独立客户端目录保留证据。

修复/环境：Pinia 挂载与新增导航断言同步；修正原生读取旧输出、role=option 和异步撤销等待竞争。临时容器复用端口时正确触发主机密钥变化拒绝，改用每次新 QA 数据目录，未关闭指纹校验。沙箱临时目录 rename 失败改用项目 TEMP/TMP。严格 Clippy -D warnings 被原有 core/openssh 单元素循环警告阻断，标准检查通过；既有硬链接回退/Monaco chunk 提示保留。

未完成/风险：没有未完成阶段开发项。任意 HTML/JS UI 不支持，macOS/Linux 客户端未验证；WASM 无 OS 进程/OOM/强制壁钟隔离，来源仍未签名。下一阶段依赖已验证 UI/权限/文件写入/日志能力，继续独立 Nginx 插件。

## 13A-1（已实现且在 Windows 上验证）

完成标准：不执行代码安装元数据包；重启持久化；非法包拒绝；旧版本在失败升级后可用；卸载删除入口并按选择保留/清除数据；六项 IPC 受窗口 ACL 限制。关键测试见 plugin-core repository/tests.rs，真实 dispatcher 验证见 desktop tests/ipc.rs。

首轮三个纯包测试通过，四个安装测试因系统临时目录内原子重命名被当前沙箱拒绝而失败。将 TEMP/TMP 显式设为本工作区 `.local/plugin-13a/tmp` 后七项全部通过。没有放宽包校验或删除断言。后续完整检查结果将在本节记录。

已追加真实只读 record 提交失败回滚、Windows Junction 逃逸与不跟随清理两项测试。Junction 夹具创建在沙箱内被拒绝，使用仅本阶段临时目录的原生测试后九项全部通过。日志：`.local/plugin-13a/package-tests-native.log`。

| 检查                                                                          | 结果/证据                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| cargo check --workspace                                                       | 通过；cargo-check.log                                               |
| cargo clippy --workspace                                                      | 通过；保留既有 openssh 单元素循环告警；cargo-clippy.log             |
| cargo clippy -p serverdeck-plugin-core --all-targets --no-deps -- -D warnings | 通过                                                                |
| cargo fmt --all --check                                                       | 通过                                                                |
| npm run typecheck / npm run build                                             | 通过；frontend-build.log；保留既有 Monaco chunk 提示                |
| 前端全量测试（--maxWorkers=2）                                                | 42 文件/286 项通过；frontend-tests-limited.log                      |
| npm run lint / 修改文件 Prettier / node --check 打包工具                      | 通过                                                                |
| 实际 Tauri dispatcher、六项插件命令 ACL                                       | 通过；完整工作区测试中的 plugin_metadata_real_ipc_lifecycle_and_acl |
| cargo test --workspace -j 2（独立目录）                                       | 全部通过（含九项插件核心与三项真实 IPC）；cargo-test-isolated.log   |

原始全量并发造成 Windows 页面文件不足，Rust/前端进程退出；前端限制并发后通过。默认 Cargo 输出目录的旧 EXE 无法覆盖，改用 `.local/plugin-13a/cargo-target`，debug 信息关闭，只以两任务编译。完整 Rust 集成测试在本机回环服务上执行，未连接用户服务器。日志路径均相对 `.local/plugin-13a/`。

未验证：macOS/Linux 原生构建、断电恢复、签名来源可信性。签名是明确未实现的能力，本版只允许不可信本地开发模式；不是验收通过的来源认证。下一阶段依赖：本阶段仓库、状态、文件摘要和主窗口 IPC。

## 13A-2（已实现且在 Windows 上验证）

已实现 Wasmi 无 WASI 沙箱、版本化 ABI/生命周期协议、启用激活/按需启动、重复激活复用、禁用/升级/卸载/退出排空、崩溃状态和显式重启、内存/fuel/栈/消息/速率/并发/活动实例限额。真实 hello-world WAT/WASM 与独立打包命令可用；五项运行时 IPC 和 TS 契约已同步。主要文件：plugin-runtime/{vm,manager,protocol,tests}、application/plugins、Tauri plugin_commands/ACL、hello-world 源码、运行时与依赖许可文档。

| 检查                                                                                       | 结果/证据                                                                        |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| cargo test --workspace --offline --locked -j 2 --target-dir .local/plugin-13a/cargo-target | 191 项通过（四项真实 IPC，运行时当时十一项）；stage2-final-cargo-test.log        |
| 最后取消通知调整后的运行时复验                                                             | 12 项通过；stage2-runtime-final.log                                              |
| cargo check --workspace / --offline --locked                                               | 通过；stage2-cargo-check.log / stage2-locked-check.log                           |
| cargo clippy --workspace / 运行时 all-targets --no-deps -D warnings                        | 通过，原有 openssh 告警保留；stage2-clippy.log                                   |
| cargo fmt --all --check / ESLint / 修改文件 Prettier                                       | 通过                                                                             |
| 前端全量 / 类型与生产构建                                                                  | 42 文件/286 项通过；stage2-frontend-test.log；类型/构建通过，原有 chunk 提示保留 |
| 实际 IPC 安装→启用激活→WASM 返回→health→禁用→卸载                                          | 通过；real_wasm_backend_through_install_enable_call_disable_and_uninstall_ipc    |

运行时测试包含启动函数与调用死循环、unreachable、内存初始/增长/地址越界、WASI/秘密/Tauri 导入拒绝、过大消息、消息洪泛、ABI 不兼容/无效回复、八实例/两执行/八等待准入、取消后资源释放、升级后旧代拒绝和显式重启。取消处理本身 trap 仍会释放实例。壁钟分支用真实 WASM 配合测试中的零截止时间验证，没有把固定业务输出冒充 SSH 功能。

首次内存增长测试受到模块自述最大值先行拒绝，调整有效测试模块声明后直接验证 Host 限额；未删除安全断言。Cargo 新依赖解析曾顺带改动两个既有 Windows 依赖绑定，已恢复并通过 --locked 检查/回归。WASM 运行库的许可证清单与随包文本已补充，开发工具依赖仅列入清单。

未完成/风险：OS 进程隔离、全进程 OOM 硬限额、抢占式壁钟终止、跨平台原生验收未实现/未验证，具体边界见 [PLUGIN_RUNTIME.md](../../plugins/PLUGIN_RUNTIME.md)。默认没有宿主能力可调用，不授予 Guest 原生导入。下一阶段依赖为已验证的身份/版本绑定、取消令牌与有界消息入口，13A-3 将引入默认拒绝的受控能力桥。

## 13A-3（已实现且完成 Windows Host + 隔离 Linux 验证）

实现八项默认拒绝权限、安装代/包摘要/版本/发布者/主机/操作/规范路径授权；Host 侧逐请求校验、独立单次风险批准、撤销/升级重授。公开 Rust SDK 1.0.0 和独立诊断 WASM 可用；主机投影、SSH、SFTP 原子编辑、独立设置、通知、任务和 ACK 日志复用现有管理器，没有第二个连接池。新增七项主窗口 IPC/ACL、TS 类型/服务、取消与资源所有权。

主要文件：plugin-sdk、plugin-core/permissions 与授权仓库、application/plugins/{capabilities,state,tests}、ssh/ops（租约绑定）、sftp/lib（规范路径）、tasks/lib（复用有界 exec）、Tauri 命令/ACL/IPC 测试、SDK 示例和隔离容器工具。SDK、安全、版本、架构和决策文档同步。

| 检查                                                                | 结果/证据                                                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| cargo test --workspace --offline --locked -j 2（独立目录）          | 200 项通过；stage3-cargo-test.log                                                                   |
| 公开 SDK 独立 WASM release 构建，--offline --locked                 | 通过；stage3-sdk-final.log；诊断包 .local/plugin-13a/diagnostics.sdplugin                           |
| 隔离 Ubuntu/OpenSSH/Nginx SDK 全链路                                | 通过；stage3-linux-verified.log（显式执行默认 ignored 的 Linux 集成测试）                           |
| cargo check --workspace / cargo clippy --workspace                  | 通过；stage3-workspace-check.log / stage3-workspace-clippy.log                                      |
| 新模块 all-targets --no-deps -D warnings / cargo fmt / 独立示例 fmt | 通过；stage3-clippy-final.log                                                                       |
| 前端全量 / 类型与构建 / ESLint / 修改文件 Prettier                  | 42 文件/287 项、类型与构建通过；stage3-frontend-tests.log / stage3-frontend-build.log；静态检查通过 |
| 真实 Tauri 管理、授权/撤销、能力请求与全部十八项插件 IPC ACL        | 四项 dispatcher 测试通过，包含未授权、授权设置读写、撤销后拒绝、伪造身份字段和非主窗口拒绝          |

Linux 集成实际完成：随机 OS 凭据经既有应用连接路径认证、主机公钥核验、安装独立 SDK 编译的 WASM、授权后读当前主机和执行 uname -a；SFTP 读/确认保存、未保存退出保护、外部改动冲突不覆盖、规范路径拒绝符号链接逃逸；一次性命令批准不可重用、普通输入伪造 Host 返回拒绝；真实任务、Nginx 访问日志读取/暂停/停止、超时/输出超限、并发拒绝和在途取消。测试后临时凭据和随机标记容器清理，不连接用户服务器或挂载宿主数据。

初次 Docker Hub 元数据大小校验失败，改用本机已有官方 Ubuntu 24.04 基础镜像的新构建层，不更改旧镜像/容器。初次测试夹具主机公钥带注释与协议公钥不同，规范化后仍保留完整验证；随后定位 Windows stdin CRLF 导致临时密码末尾含 CR，改为 UTF-8/明确 LF 输入，最终真实链路通过。没有关闭密钥验证或用协议模拟替代 Linux。

默认全工作区仍跳过既有 OS 凭据专门测试、真实 Linux 交互 PTY 测试，以及需外部夹具的新 SDK 测试；新 SDK Linux 测试另行显式执行，包含真实 OS 凭据保存/读取/清理，但不等同于所有凭据类型和 PTY 交互都已验收。未验证 macOS/Linux 原生桌面及所有发行版。远端命令取消不保证进程已终止，已确认写入安全收尾、32 KiB/30 秒/输出等限额见 SDK/安全文档；这些不是未完成的隐藏能力。

下一阶段依赖：已经验证的 grant/context/confirmation/capability IPC、公开 SDK 与资源生命周期。13A-4 尚未完成插件管理页和 UI 贡献渲染，不把当前 API 当作完整 UI 功能。
