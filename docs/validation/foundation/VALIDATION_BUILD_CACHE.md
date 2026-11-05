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
