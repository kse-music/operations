# 错误提示统一验收

日期：2026-11-03。

## 完成范围

所有页面、终端窗格和弹窗的错误文案统一进入右下角气泡。移除原有页头/表单横幅，以及连接、任务、端口转发、日志流和监控磁盘行的错误文案。文件传输的故障原因与恢复路径合并进气泡，安全凭据库不可用也通过气泡提示。保留失败状态、重试入口、旧监控样本标记、主机密钥确认及危险操作确认。

共享错误由 store 的作用域观察，局部错误由组件观察；关闭通知不会改写后端状态，未变化的轮询错误不会再次弹出，清空后重试同一错误仍会通知。通知在原生弹窗中保持可见和可关闭；表单校验只提示首个无效字段并聚焦它，不出现浏览器字段位置的错误气泡。

## 已执行验证

- `npm test`：29 个文件、172 项测试通过。新增截图错误跨页面只显示一次、通知去重/关闭、同一 tick 重试、观察器释放、弹窗及嵌套弹窗迁移、表单首个无效字段聚焦等回归；同步更新删除/保存/剪贴板/主机上下文错误的断言，继续验证真实安全约束。
- `npm run typecheck`、`npm run lint`、`npm run build`：通过。构建保留 Monaco 等大包的既有体积提醒。
- 本次修改文件的 Prettier 格式检查与 `git diff --check`：通过。
- `node tools/ui-errors-e2e.mjs`：13 项真实 Edge 浏览器 UI 检查通过，覆盖终端、文件、监控、运维、自动化、批量、网络、安全凭据、备份、设置、本地环境共 11 页，以及 1440×900 / 390×844 弹窗校验。断言错误只在气泡出现、右下角定位、关闭生效、无其他 alert、无页面运行时异常；弹窗检查原生 popover 顶层和可点击性。
- 已人工查看终端、宽窗口弹窗和窄窗口弹窗截图。界面夹具及结果位于 `.local/error-notifications/`。

## 环境与限制

Vitest 默认临时目录在沙箱中发生 EPERM，设置当前命令的 TEMP/TMP 为工作区 `.local/notification-test-tmp` 后通过，没有改动系统环境。沙箱内 Edge 无法启动，沙箱外无法访问沙箱内预览；界面脚本现会启动并关闭自己的本机临时 Vite 服务，在获批环境中完成验证。

浏览器检查使用独立前端故障夹具，不连接远程主机、不写入持久用户配置，不代表本轮重新验证了真实 SSH/SFTP 或 Rust 后端。未运行原生 Tauri 全链路、其他平台或旧 WebView 兼容检查；原始终端/日志/命令输出属于业务数据，继续保留。不存在数据库迁移或新依赖；后续发布依赖正常的原生打包与平台验收，本阶段不启动下一阶段。

## 2026-11-06 Linux 通知高度修复

主机保存后的单条通知在 Linux WebKitGTK 中被拉至接近整个窗口高度。通知容器使用固定定位、manual popover 和 Grid，未覆盖 popover 默认内在高度，触发 WebKit 的高度计算问题。`apps/desktop/src/styles/product.css` 中为 `.toast-stack` 显式设置 `height: auto`，保留右下角定位、内容换行、高度上限及滚动。

### 本次验证

- 本机 WebKitGTK 2.52.6 使用仓库真实 foundation、theme 和 product 样式及通知 DOM 夹具验证。1440×900 中恢复默认 `fit-content` 时通知高度为 832px，采用修复后为 54px；390×844 中分别约为 776px 和 54px。两种尺寸均验证三条通知按内容排布、长中文换行、超长内容滚动、原生 modal 中右下角定位、关闭按钮不被 backdrop 遮挡，以及关闭通知后弹窗仍打开。脚本、结果和宽窄截图位于 `.local/notification-height-qa/`，已查看截图。
- `npm test -- --run src/components/notification-toasts.test.ts src/composables/error-notifications.test.ts`：2 文件、4 项通过，覆盖真实 Vue 组件的去重、关闭、嵌套弹窗迁移及无效表单聚焦。
- `npm run typecheck`、`npm run lint`：通过。
- 在 `apps/desktop` 执行 `npx vite build`：生产前端构建通过，保留既有的大 chunk 提醒。本次未执行系统插件重建。
- 修改文件的 Prettier 检查及 `git diff --check`：通过。

原生布局夹具首次保存截图因缺少 Cairo foreign struct converter 失败，改用现有 GTK 截图接口后通过；最初内联夹具未解析 SDK 主题导入，改为加载实际主题后完成上述最终复验。夹具只验证通知布局，不读写主机或用户配置。未重建桌面二进制和安装包，未重验真实主机保存全链路、Windows WebView2 或其他平台。无新增依赖、数据库或通知业务逻辑变化，未发现本次新增风险；当前修复无后续功能依赖，分发给已安装应用仍需常规桌面构建。

## 2026-11-11 关闭终端后偶发记录不存在

用户报告偶发“记录不存在或已被删除”，补充可能发生在关闭本地终端后。该文案是通用 `NOT_FOUND`；现有应用日志没有这次通知的调用来源，无法还原截图当时的唯一触发顺序。

通过真实 `TerminalPane`、终端 Store 和通知 Store 的组件回归，固定“已发出 resize → 会话关闭 → resize 返回 NOT_FOUND”的顺序，在原实现中复现相同通知。本地与 SSH 终端共用的实现均受影响：关闭等待后端完成期间仍保持 connected，resize 的迟到错误直接写入通知；已移除窗格的 xterm 缓冲回调也会继续发出 ACK。原实现下首批 14 项回归中 10 项失败、4 项通过。

### 修复范围

- `apps/desktop/src/stores/terminals.ts`：上传安全停止后、请求关闭前将窗格置为 closing。关闭失败保留窗格，只在仍处于 closing 时恢复原状态，不覆盖后端已经报告的 failed/closed。
- `apps/desktop/src/components/TerminalPane.vue`：离开 connected 时同步停止尺寸定时器、清除待粘贴内容并取消旧输入队列；重新进入 connected 时绑定当前输入会话。resize 绑定发起时的连接代号和 Session ID，迟到失败仅作用于仍然有效的会话；ACK 在发送和错误处理时均检查会话生命周期。
- `apps/desktop/src/types/terminal.ts`：closing 展示为“正在关闭”。不全局屏蔽 NOT_FOUND；有效会话的真实错误、进程失败和关闭失败继续通知。
- 新增 `apps/desktop/src/components/terminal-lifecycle.test.ts`：本地/SSH 共 20 项，覆盖关闭事件到达前的输入/resize/ACK、关闭后的 resize 错误、移除后的缓冲 ACK、替换会话、有效会话真实错误、关闭失败后继续输入，以及后端已失败时不恢复 connected。

### 验证与限制

- Windows 本机执行 `npm test -- --run terminal src/composables/error-notifications.test.ts src/components/notification-toasts.test.ts`：16 文件、143 项通过。最终测试夹具声明修正后单独复验生命周期文件，20 项通过。
- `npm run lint`、`npm run typecheck`：通过。检查期间修正了新增测试夹具的未用参数及回调类型声明。
- 在 `apps/desktop` 执行 `npx vite build`：前端生产构建通过，保留既有的大 chunk 提醒；构建前 D 盘可用空间约 149.5 GiB。未重建 WASM 插件。
- 本次修改文件的 Prettier 检查及 `git diff --check`：通过。
- 首次测试因沙箱默认 TEMP 下的缓存 rename 返回 EPERM 而未进入测试；仅为当前测试进程设置 TEMP/TMP 到 `.local/qa/terminal-close/tmp` 后执行上述检查，未修改系统环境。

验证使用可控 IPC 与 xterm 回调夹具，运行生产 Vue/Pinia 逻辑；未重新执行原生 Windows PowerShell/ConPTY、真实 SSH 或其他平台全链路。未修改 Rust、数据库、持久配置或用户数据，未执行 Rust 构建/测试及桌面 EXE/安装包打包。已确定并覆盖上述关闭竞态，截图原始事件仍缺少精确追踪证据；已安装应用获得此修复依赖后续常规桌面构建和分发，本阶段不启动下一阶段。
