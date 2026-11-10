# AI 运维助手布局验证

## 2026-11-10 输入区焦点与空间

助手包2.3.1。按用户截图去掉文本区聚焦的浏览器默认白色outline/阴影；仅作用于助手提问区，不移除模式选择器/按钮的键盘焦点提示。文本区最小高度60→112px、最大高度140→240px；底栏上间距7→12px、外框底部内距14→10px，底栏下移并扩大输入空间；矮窗口最小高度42→72px。主要修改 `plugins/system/assistant/frontend/assistant.css`、包版本及当前使用说明，无后端/IPC/审批/存储行为或依赖变化。

- 标准系统插件构建通过；磁盘约156 GiB空闲，复用原有WASM缓存及根target。Windows Debug无安装器构建初次因运行中的 `target/debug/serverdeck-desktop.exe` 被锁定而失败（访问拒绝）；用户正常退出后重新构建通过，没有强杀。新程序复制到QA的 `ServerDeck-composer-layout.exe`，最终结果见 `native-build.log`。
- 真实打包前端在独立无头Edge通过MessageChannel加载，1524×852/100%、960×600/145%、960×400/100%检查：聚焦outline为none、阴影none、内边框0px；文本区高度分别达到112/112/72px，底栏间距至少12px、底部内距约11px，无横向溢出且发送按钮保持可见。截图已查看，界面数据为显式标注的本机夹具，不连接真实模型或服务器。
- 格式与diff检查及构建结果保存在 `.local/qa/assistant-composer-layout/`；样式变更未重跑Rust单元或远程运维测试。尚未验收完整原生WebView2流程、安装器、macOS/Linux；既有发送、审批与换行逻辑未修改。

证据：`ui-result.json`、`composer-1524x852-1.png`、`composer-960x600-1.45.png`、`composer-960x400-1.png`、`plugins-build.log`。

## 2026-11-07 模型绑定弹窗

助手包 1.8.1。按本地服务与模型管理分组，Codex/Claude Code 并排卡片显示连接状态；选中来源的模型与授权操作合并为紧凑状态行，注册模型采用列表。未绑定为轻量行，底栏固定当前绑定、未保存/操作提示与取消/保存。助手设置页签使用下划线，内容仅一个滚动容器，外层及 iframe 页面不滚动。

主要文件：`plugins/system/assistant/frontend/SettingsView.vue`、`apps/desktop/src/components/PluginSettingsDialog.vue`、`apps/desktop/src/styles/plugins.css`、助手 manifest；PRD、实施计划及内置插件版本文档同步。无后端、IPC、认证或数据库行为变化，无新依赖。

- Vitest 3 个相关文件共 55 项通过：助手绑定/发送门禁、两种本地授权与撤销、宿主桥及配置弹窗开关；取消不保存，保存后重开保留选择。jsdom 对 canvas 的既有提示未导致断言失败。
- TypeScript、ESLint、相关源文件 Prettier 与 diff whitespace 通过。前端生产、助手 WASM 与 Windows Tauri debug 无安装包构建通过，默认程序为 `target/debug/serverdeck-desktop.exe`。构建入口磁盘检查通过，复用根 target 和现有插件 WASM 缓存。Vite 保留已有 Monaco chunk 体积提醒，链接器保留库生成提示。
- 真实 Windows WebView2、打包 iframe/WASM 和 Rust IPC 验收通过：1280×820 深/浅主题、900×600 深色标准字号及浅色 145% 字号。核对本地卡片并排、状态不重叠、无横向溢出、外层及 iframe 页面无滚动、仅内容区最多一个滚动条、底部操作始终可见。截图已人工复查。
- 隔离应用中通过真实 ai_model_test/save 创建两项本机 HTTP 测试模型，CLI 状态使用本机 Claude Code；没有发送推理问题或连接用户服务器。验证键盘方向键选择、保存 Claude 绑定重开保留、取消选择不改变绑定、切换并保存注册模型、权限页签切回，以及撤销本地授权。测试模型及其系统凭据经正常删除接口清理，QA 程序退出，未修改正式应用绑定或授权。

最初脚本重开弹窗后立即检查 radio，先于异步配置读取完成而失败；改为等待 fieldset 就绪后，全流程及最终构建复验通过。使用者按项目要求正常退出正在占用 target 的程序后再构建，未强制关闭正式程序。

证据：`.local/qa/assistant-settings-layout/result.json`，同目录的 `desktop-dark.png`、`desktop-light.png`、`small-dark.png`、`small-large-font.png`、`unauthorized.png` 与 `build.log`。截图中的注册模型仅为本次 QA 数据。

范围限制：本轮为样式与布局，没有重跑 Rust 单元测试、真实推理或远端变更；已完成真实桌面/插件/IPC 交互验收。安装包、其他平台和屏幕阅读器尚未验收；长列表/大字号仍需在唯一内容区滚动。无新增阻断风险或依赖，其他平台验收属于后续发布工作。

日期：2026-11-03。范围：AI 助手页面布局与状态呈现，保留已有真实模型请求、授权、脱敏、发送审核和逐条命令批准契约。

## 完成内容与主要文件

- `apps/desktop/src/views/AssistantView.vue`：顶部紧凑模型栏；宽工作区中提问/结果为主区，服务器上下文在侧栏；窄工作区按提问、上下文、结果排列。授权项卡片显示说明和选中数量，日志配置集中，脱敏设置可折叠且不改变值。预览集中展示目标、模型、Token、预算、警告与完整请求；回答用正文样式，命令独立展示风险、目标、原因和审核入口，执行反馈与系统变更确认弹窗统一样式。生成预览、回答或错误后定位到相应区域。
- `apps/desktop/src/styles/assistant.css`：复用原主题变量和 Lucide 图标，统一间距、表单、分区、徽标与状态。按容器宽度 840px/460px 响应，适应侧栏占用；900×600 首屏保留提问操作按钮。提供等待、错误、空状态，支持减少动画偏好。模型输出仍以文本插值展示，无 HTML 渲染或模型内容决定样式/权限。
- `apps/desktop/src/views/assistant.test.ts`：保留发送批准、单次只读与独立变更确认、模型切换/编辑/删除撤销、失败恢复和晚到结果断言；追加指定日志/自定义脱敏在折叠布局中保持、连接门禁、分析取消及不重复提交检查，验证结果定位目标。
- `tools/native-ai-e2e.mjs`：在原生真实 IPC/SQLite/系统凭据/loopback HTTP 夹具中，增加助手空状态、预览、回答、错误四种状态各四组主题/尺寸截图，检查实际布局关系、横向溢出与首屏操作可见。
- AI 使用说明、技术决策、实施计划、质量报告同步。没有后端、IPC、数据库或依赖变化。

## 执行过的验证

| 检查                           | 结果                                                                 |
| ------------------------------ | -------------------------------------------------------------------- |
| `npm test`                     | 41 文件、275 项通过，含新增两项助手交互回归                          |
| 最终相关复验                   | 助手 7 项通过；模型/助手初期共 12 项通过                             |
| `npm run lint`                 | 通过。新增 ref 的 Vue 属性顺序告警已按规则调整后复验通过             |
| `npm run build`                | TypeScript/Vite 通过；最终原生 Tauri CLI 构建再次运行前端检查和构建  |
| Prettier / diff whitespace     | 相关源文件、脚本、文档检查通过                                       |
| `node tools/native-ai-e2e.mjs` | 最终完整通过，内置前端的隔离 Windows WebView2 应用，不依赖开发服务器 |

原生本次包含 4 次固定连接测试（含失败/重测）、3 次诊断请求，全部指向本机 HTTP 夹具。继续核验独立模型 ID/Key 路由、注册测试门禁、旧 Key 引用迁移、旧预览拒绝、删除确认及服务 503 后其他运维接口可用；未执行模型建议。测试结束删除所有临时模型及 OS 凭据，无清理警告。

助手 16 张状态截图覆盖 1440×900 和 900×600 深/浅主题。宽窗口实测上下文在提问旁，窄窗口提问位于上下文之前；页面及助手内部无横向溢出，空状态的预览按钮位于首屏范围。已审阅桌面空状态/预览/回答、小窗口空状态/回答/错误；最终缩短窄窗口提问区后再次完整验证首屏按钮可见。单条命令及变更批准由前端交互测试验证；本次原生测试无 SSH 目标，仅展示人工审阅命令，不把它表述为远程执行验收。

最终证据：`.local/assistant-layout/native/c765440f-e271-48d6-830e-dd61aca5cf5d/result.json` 及 PNG。前端日志 `.local/assistant-layout/frontend.log`，原生日志 `native.log`。前一轮完整通过截图也保留于同目录其他 UUID 下，不作为最终程序哈希来源。

交付程序：`.local/assistant-layout/ServerDeck.exe`，来自成功的 `node tools/tauri.mjs build --debug --no-bundle` 正常应用标识构建；与最终 target/debug 程序复制一致。SHA-256：`7A6CA33A036222A95E56756457A9CF460D92B22B9553F13C166B681CA1CCC0C1`。未关闭当前用户程序、修改正式模型配置或迁移用户数据。

## 未验证、已知风险与下一阶段依赖

本次仅调整前端，没有重跑 Rust 单元测试；Tauri 原生构建和完整调用链集成已运行。未新增外部真实计费调用、连接用户服务器或执行远程命令。没有验证 Release 安装包、macOS/Linux、更多窗口尺寸、屏幕阅读器或长时间运行；大回答仍在可滚动文本区内查看。构建保留原有 Monaco 大 chunk 告警。

既有模型准确性、脱敏遗漏、手填费用估算、HTTP 明文及取消后可能计费的限制不变。无新发现的阻断风险，无新增依赖；使用交付程序时先退出当前实例，以避免单实例机制聚焦旧版。本阶段完成后停止。
