# 本地构建缓存清理与磁盘保护

日期：2026-11-05（Asia/Shanghai）。范围为本地编译产物清理与构建配置，不修改业务源码或用户数据。

## 配置与边界

- `.cargo/config.toml` 关闭增量编译，开发/测试使用 `line-tables-only` 调试信息，保留回溯行号，减少缓存与符号体积；Release 配置保持原样。
- 桌面及原生测试统一使用 `target/`，不再创建 `.local/native-ui-build` 或 `.local/plugin-13a/cargo-target` 的桌面缓存。插件测试移除单独的 debug 环境覆盖，避免同一输出目录反复生成两种调试配置。
- 原生测试使用复制到 QA 目录的 EXE，不直接运行编译输出，复制后恢复普通配置的构建；原有独立 QA 标识、数据路径和权限边界保留。
- 桌面构建入口 `tools/tauri.mjs` 的 build/dev 及 `tools/build-plugin.mjs`、`tools/build-system-plugins.mjs` 在项目磁盘空闲不足 10 GiB 时明确失败；磁盘查询失败继续传播，不假装空间足够。不自动清理任何数据。
- 启动前检查不是硬配额，不能阻止构建期间其他程序写满磁盘；直接执行 Cargo 不经过 Node 检查，须按 AGENTS.md 自行检查空间。Windows 构建已运行的 EXE 前应正常退出程序，不结束用户进程。

## 本次清理

仅清理三套既有 Cargo 输出目录下的 `debug/{incremental,deps,build,.fingerprint,examples}`，保留目录根部的 EXE/PDB、Release 安装包、WASM 产物、源码、锁文件、应用/QA 数据和历史日志。

删除前校验工作区内绝对路径及全部祖先、子目录无重解析点，检查 Rust 构建进程并取得三套 debug 目录的 Cargo 文件锁；清理期间持有锁，失败则终止。清理前后校验既有桌面 EXE 的 SHA256。原始记录保存在 `.local/build-cache-maintenance/cleanup.json`。

## 验证

清理 257,857 个缓存文件，文件大小累计 201.874 GiB；以 D 盘可用空间实测，实际释放 **178.766 GiB**，空闲从 0.377 GiB 恢复至 179.142 GiB。随后重新编译验证，2026-11-05 11:07（Asia/Shanghai）空闲为约 177.76 GiB。文件大小累计与实际占用有差异，释放量以盘符测量为准。

| 检查                                                                    | 实际结果                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm run test:build`                                                    | 7 项通过，覆盖不足/恰好 10 GiB、块大小换算、磁盘查询错误传播，以及三个入口低空间时不启动子构建；已加入现有 CI |
| `cargo test -p serverdeck-core --lib --offline --locked -j 2 --verbose` | 17 项通过，0 失败/忽略；日志 `cargo-core-test.log`                                                            |
| `cargo check --workspace --offline --locked -j 2`                       | 全工作区检查通过，日志 `cargo-workspace-check.log`                                                            |
| 实际 Rust 参数及缓存                                                    | 核心测试使用 `-C debuginfo=line-tables-only`，无 `-C incremental=`；两次 Rust 验证后增量缓存文件仍为 0        |
| 根目录、桌面子目录、独立插件目录的 Cargo metadata                       | 均解析到根目录 `target/`；插件打包工具继续显式使用原 WASM 目录                                                |
| 修改的 JS / PowerShell 语法                                             | `node --check` 及 PowerShell Parser 通过                                                                      |
| 修改的 JS/JSON/YAML/Markdown 格式、Cargo TOML                           | Prettier、TOML 解析及关键设置断言通过；`git diff --check` 通过                                                |
| 保留内容                                                                | 四份既有 debug/release EXE 的 SHA256 在清理前后均一致；未删除 `.local/` 的其他数据、历史日志或 Release 安装包 |

原始日志与清理记录均位于 `.local/build-cache-maintenance/`。Cargo 在受限环境中提示无法更新全局缓存的 last-use 数据（只读数据库），上述命令最终均正常退出；未修改全局 Rust 配置或权限。

首次编译需重建依赖，关闭增量编译后修改 Rust 的重编译耗时可能增加；行号级信息不提供完整变量调试。尚未完成跨平台或真实 GUI/SSH 回归，本次不将缓存配置检查等同于业务功能验收。

## 2026-11-06 NSIS 解压拒绝访问

- Tauri CLI 2.12.4 完成前端和 Rust Release 构建，NSIS 3.13 ZIP 校验通过，随后在解压阶段报告 Windows 错误 5。临时使用项目内工具缓存后仍可复现。用 Windows 标准 ZIP 解压器独立复现，确定被拒绝的路径为 `nsis-3.13/Plugins/x86-ansi/TypeLib.dll`。Windows Defender、代码完整性和 AppLocker 在复现时段无对应事件，具体拦截来源未确认。
- 逐文件以 SHA-256 比较已有默认 NSIS 缓存和官方 ZIP，441 个文件一致。另按 Tauri 的预期摘要验证 `nsis_tauri_utils.dll`，恢复默认工具缓存设置后复用该缓存。未改动安全软件设置或全局缓存。
- `node tools/tauri.mjs bundle --bundles nsis` 成功，生成 9.35 MiB 的 Windows x64 安装包。此时 Release 程序已含正确的 NSIS 标记，重复补写标记的警告不影响本次产物。核对了安装包的 PE 和 NSIS 头、版本、SHA-256 及未签名状态。
- 原始命令 `node tools/tauri.mjs build --bundles nsis` 在复用缓存时完整通过，生成 `target/release/bundle/nsis/ServerDeck_0.1.0-beta.1_x64-setup.exe`，大小为 9,796,441 字节，SHA-256 为 `D526771A9F0199489C5949210E86AD33DA6334DC404CF5DCB83B288A5AB7780C`，未签名。未运行安装、升级或卸载验收。
- `npm run test:build` 共 7 项通过。日志和旧安装包备份位于 `.local/nsis-packaging-20261106-081718-1f55c1bd/`。首次解压仍依赖本机允许创建上述 DLL，本次范围为构建和生成安装包。

## 2026-11-06 内置插件包改为构建产物

### 完成范围

`plugins/system/packages/assistant.sdplugin` 和 `docker.sdplugin` 已从 Git 索引移除，本地文件保留；`.gitignore` 忽略该目录的 `.sdplugin` 及打包 `.sdplugin.tmp` 文件。提交内容以插件源码、清单与锁文件为准。现有构建脚本、产物路径、Rust 编译期嵌入与用户插件安装方式继续使用。

桌面 `dev/build` 原本就会生成系统插件包，无需额外实现。候选 CI 在 Clippy/测试前安装 `wasm32-unknown-unknown`、分别下载两个插件的锁定依赖并执行 `npm run plugins:build`，成功打包后将插件包另存为 artifact。`tools/plugin-test-host/test.ps1` 的 SDK 模式在启动临时远端夹具前先生成内置包，失败时直接停止。README、内置插件说明、发布复建步骤及实施计划已同步。

### 本次验证

- 开始构建前确认项目所在磁盘约 810 GiB 可用；原生编译使用根目录 `target/`，WASM 沿用 `.local/plugin-build/<插件>/`，未调整 Cargo 缓存配置。
- 将两份本地包移至 `.local/plugin-package-qa/2026-11-06T04-52-06.767Z/` 备份，确认目标文件缺失后执行 `npm run plugins:build`：成功重新生成。两份生成包分别与备份字节一致；四个包内文件的大小和 SHA-256 均与清单一致。
- `cargo test -p serverdeck-plugin-core -p serverdeck-application --lib --offline --locked --no-run`：编译成功，验证生成包可被编译期嵌入。将测试程序复制至上述 QA 目录后运行：应用层 `plugins::` 筛选 20 项通过、1 项既有专用 Linux 测试主机依赖忽略；插件核心全部 26 项通过。覆盖真实内置 WASM 激活、升级、卸载选择、授权与包校验。
- `npm run build`：完整插件生成、Vue 类型检查及 Vite 生产前端构建通过，保留既有大 chunk 提醒。
- `npm run test:build` 成功；另以 `node --test --test-isolation=none tools/build-space.test.mjs` 显式运行 7 项构建磁盘保护测试，全部通过。
- `git ls-files plugins/system/packages` 为空；`git check-ignore -v` 确认两份生成包命中规则，重新构建后没有包内容的新增修改，索引只保留本次取消跟踪的删除记录。
- 修改的 YAML/Markdown 通过 Prettier 检查，已暂存及未暂存差异均通过 `git diff --check`。

### 边界与依赖

本机为 Linux，未执行 GitHub Actions、Windows PowerShell/WSL 原生验收或桌面安装器构建。未连接用户远程主机、修改用户配置或引入数据库迁移。全新克隆后直接运行相关 Cargo 命令仍须先生成插件包；首次构建和锁文件更新后须先按 README 下载依赖，实际插件编译保留 `--offline --locked`。当前无剩余实现依赖，跨平台 CI 和原生验收待相应环境执行。

## 2026-11-06 兼容界面和测试插件包改为构建产物

- Git 忽略兼容界面的 `frontend.css`、`frontend.js` 和 `server-capabilities.sdplugin` 测试包。桌面 `dev/build` 生成兼容界面和内置插件包，`npm run plugins:build` 还生成测试包，供 CI、Rust 测试和原生运维验收使用。
- Windows 上将现有插件产物移入 `.local/` 下的 QA 备份后，`npm run build` 重建了兼容界面和两个内置包，确认测试包仍缺失。`npm run plugins:build` 随后生成了测试包。校验了兼容界面 CSS 与 JS 的作用域 ID、三个插件包的身份、WASM 文件头、文件大小和 SHA-256 摘要。
- `npm run test:build` 通过 7 项。`cargo test -p serverdeck-application --lib --no-run --offline --locked` 编译通过，复制测试 EXE 至 QA 目录后执行 `plugins::`，21 项通过，1 项依赖 Linux SSH 测试环境的用例保持忽略。未执行 GitHub Actions 或原生远程运维验收。

## 2026-11-06 调试、打包与测试产物的 Git 审计

- 从 Git 索引移除 `apps/desktop/.local/model-management/tmp/node-compile-cache/` 下的 606 个 Node.js 编译缓存文件，保留本地副本。`.gitignore` 现在覆盖各级 `.local/`、任意位置的 `*.sdplugin` 及其 `.tmp` 文件。
- 对照 Git 索引和 17 个输出路径，核对 Rust 缓存与安装包、Vite 前端与依赖缓存、Tauri 生成权限与 schema、插件包、兼容界面及 QA 输出。确认依赖锁文件、图标、权限配置和插件清单仍作为构建输入跟踪。用 `cargo metadata` 验证桌面、两个内置插件和测试夹具从各自目录解析到根 `target/`。
- Windows 上 `npm run test:build` 的 7 项测试通过。使用嵌套 `.local/` 作为 Node.js 编译缓存位置，实测新生成的 235 个缓存文件均被忽略。`npm run build` 通过。本次对安装包路径执行 Git 忽略检查，未重打安装包或执行跨平台验收。

## 2026-11-06 平台版本更新为 0.2.0

### 完成范围

平台从 0.1.0-beta.1 更新为 0.2.0，统一根目录和桌面的 npm 清单、Cargo 工作区、Tauri 配置及对应锁文件。关于页继续读取后端 `CARGO_PKG_VERSION`，现有 App 测试与浏览器页面验证数据同步更新；README、变更记录、当前架构说明和随包第三方声明同步。插件及 Rust/Vue SDK 沿用独立版本。

发布清单取消必须包含 beta 的旧命名约束，版本一致性、应用身份、权限、图标和摘要检查继续保留。旧安装包名称、测试及安全报告保持历史版本，发布条件仍由原发布检查表记录。

### 本次验证

- 构建前项目磁盘约 812 GiB 可用，沿用根目录 `target/` 和既有 WASM 插件输出目录。
- 通过 `cargo metadata --no-deps --format-version 1 --offline --locked` 及 JSON 结构化断言，确认 14 个平台 Cargo 包、6 处 npm/Tauri 清单与锁文件版本均为 0.2.0，Rust/Vue SDK 均仍为 4.0.0。
- `npm test -- --run src/App.test.ts`：1 个测试文件、68 项通过，包括关于页显示 `v0.2.0` 及原有启动、错误和工作区流程。
- `npm run typecheck`：桌面及 Vue SDK 类型检查通过。
- `cargo check -p serverdeck-application --offline --locked -j 2`、`cargo check -p serverdeck-desktop --offline --locked -j 2`：均通过，桌面配置与 Rust 应用层使用 0.2.0。
- `npm run plugins:build`：两个内置插件生成通过，无插件源码、清单或已跟踪生成资源变化。
- `cargo fmt --all -- --check`、修改的 App 测试 ESLint、修改文件 Prettier、两个修改脚本的 `node --check` 与 `git diff --check`：通过。

### 边界与依赖

仅执行编译检查，未生成或替换桌面可执行文件、Release 安装器及发布摘要，未运行页面 E2E 脚本、完整发布清单脚本、全量业务单测、原生 GUI 或跨平台验收。现有可执行文件和安装包仍可能显示旧版本，需重新构建并启动后生效；版本号变化不表示既有发布条件已满足。当前无剩余实现依赖，本阶段完成后停止。
