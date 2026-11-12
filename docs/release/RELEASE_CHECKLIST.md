# ServerDeck 发布检查表

本表用于当前候选产物的发布验收。所有项目须针对同一版本和明确环境实际执行，未填写结果的项目保持待验；源码可构建不代表稳定版已经验收。当前支持范围见[产品基线](../product/PRD.md)，安全边界见[安全说明](SECURITY.md)。

## 发布门禁

- [ ] 固定候选提交、Cargo 工作区版本、锁文件、工具链与目标平台，构建当前安装器，生成摘要清单。
- [ ] 在 Windows x64 完成实际安装、启动、正常退出、重装、升级和默认保留数据的卸载；分别检查 WebView2、凭据库、Agent、选择器、原生拖放、输入法、高 DPI 和物理多屏。
- [ ] 若分发 macOS/Linux 或其他架构，独立完成对应构建、凭据/Agent、文件交互、安装卸载及窗口/高 DPI 验收；macOS 检查签名和公证。未验收平台不声明支持。
- [ ] 完成主机 → SSH → SFTP → Docker/助手 → 关闭/重启的真实链路，并验证加载、空、失败、取消、撤权和配置变更。
- [ ] 按[数据升级契约](../architecture/DATA_MIGRATIONS.md)检查所有支持版本、跨版本、WAL、并发、备份失败、事务回滚/重试、未来版本拒绝及数据/关联/秘密引用保留；安装器升级也须实测。
- [ ] 完成 Rust/前端/构建工具检查，以及插件开发包在仓库外的构建、上传、启停、权限与卸载验收。
- [ ] 对最终锁定依赖运行 npm/Cargo 审计，核对 RSA、GLib 和维护风险；未解决风险形成明确发布处置，不用 ignore 或旧结果替代。
- [ ] 为最终安装器落实发布者签名和可信分发渠道；SHA-256 不能代替签名。没有签名的产物明确说明状态。
- [ ] 测量当前进程树的冷启动、空闲内存和 20 个活动 SSH 终端，工程目标为三秒内可交互、空闲内存尽量控制在 150 MB；未达到时修复或明确调整目标，不能擅自标为通过。
- [ ] 完成 24 小时监控/日志/终端/传输并发、断线重连、睡眠/网络切换及百次启动退出，检查泄漏、资源释放和未知结果保护。
- [ ] 复核第三方许可证、许可原文完整性、安装资源及发布包内容；[依赖清单](DEPENDENCY_INVENTORY.md)和[第三方声明](THIRD_PARTY_NOTICES.txt)是输入，不等于人工复核完成。
- [ ] 验收记录明确候选提交、平台、命令、结果、失败和限制，随 QA/发布产物保存；所有阻断问题关闭后再发布。

## 版本来源与更新

只修改根目录 [Cargo.toml](../../Cargo.toml) 的 `[workspace.package].version`。Rust 平台包继承工作区版本，Tauri 使用 Cargo 包版本，私有 npm 工程不重复声明。SDK、插件包、数据库 schema 和配置格式独立管理。

桌面 dev/build 自动检查版本来源，并通过 `cargo update --workspace` 同步工作区锁记录，保留锁定的第三方依赖；将生成的 `Cargo.lock` 一并提交。准备失败停止。关于页发布时间由本次前端打包生成，按北京时间显示，不随重新打开变化。

## 构建和产物

输出磁盘至少有 10 GiB 空闲；原生构建统一复用根 `target/`，保持 `.cargo/config.toml` 的缓存和调试信息设置。重新构建前正常退出正在使用构建输出的应用；原生 QA 使用复制后的 EXE，不强杀进程或整删缓存。

```powershell
npm ci
rustup target add wasm32-unknown-unknown
npm run plugins:fetch
npm run plugins:build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm run test:build
npm run format:check
npm run lint
npm run typecheck
npm test
npm audit --audit-level=moderate
cargo audit --deny unsound
node tools/tauri.mjs build --bundles nsis
node tools/release-manifest.mjs
```

审计返回非零时须检查原因并保留报告，不能视为通过。测试需要系统凭据服务或授权服务器时按下节单独执行。

| 产物         | 路径                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| Windows NSIS | `target/release/bundle/nsis/ServerDeck_<版本>_x64-setup.exe`              |
| Release 程序 | `target/release/serverdeck-desktop.exe`                                   |
| 校验与清单   | `.local/release-qa/SHA256SUMS`、`.local/release-qa/release-manifest.json` |
| 调试程序     | `target/debug/serverdeck-desktop.exe`                                     |

这些是本机构建路径，不能当作下载地址。调试程序可运行 `node tools/tauri.mjs build --debug --no-bundle`；已有相配的当前 Release 程序时，`node tools/tauri.mjs bundle --bundles nsis` 只重新生成安装包。

前端构建会嵌入 `serverdeck-plugin-development-kit.zip`。SDK、工具和文档修改后，检查 ZIP 内容完整，并从客户端重新下载，在仓库外构建、上传样例验证。不要修改锁文件来绕过构建失败，也不要删除数据库排查编译故障。

## 原生验收

- [ ] Windows 管理员本地终端：普通权限启动宿主，从本地会话栏加号选择普通或管理员内嵌会话，取消菜单不创建会话，侧栏无独立提权入口；分别核验宿主/普通 Shell 未提权和管理员 Shell 已提权。验收 UAC 取消及重试、分屏/复制/重连重新授权、输入/输出/resize/ACK、关闭单窗格与退出、主程序或代理意外结束时的进程回收；确认插件和其他窗口不能调用提权 IPC。须针对候选 EXE 与安装产物实测，自动化协议检查不代替 UAC 验收。

桌面和系统凭据验收使用隔离目录；涉及远程变更的测试须先授权测试主机与资源范围。原生 E2E 使用复制的 EXE、测试进程专用 loopback 调试端口及独立凭据，普通应用不开放调试端口。

```powershell
npm run test:native
cargo test -p serverdeck-security native_store_roundtrip_update_and_delete -- --ignored
```

SSH 测试从进程环境读取 `SERVERDECK_TEST_HOST`、`SERVERDECK_TEST_USER`、`SERVERDECK_TEST_PIN`、`SERVERDECK_TEST_PASSWORD`。PIN 通过带外渠道核对；密码通过隐藏输入仅放入本次进程环境，不进入命令行、文件或日志，使用后清除。先阅读测试入口的前置条件和实际操作，不能把只读检查视为对远端变更的授权。

| 范围                       | 入口                                  |
| -------------------------- | ------------------------------------- |
| SSH 真实终端               | `npm run test:terminal`               |
| 分屏、标签、路由与底层转发 | `npm run test:terminal -- --advanced` |
| SFTP、传输与编辑           | `npm run test:terminal -- --sftp`     |
| Docker 与宿主运维服务      | `npm run test:terminal -- --ops`      |
| 主机工作区与插件流程       | `npm run test:terminal -- --product`  |

测试入口在 `tools/`，插件和协议夹具在 `tests/fixtures/`；按用例检查实际覆盖范围，测试夹具不等同于真实模型账号或真实 Docker/外部服务。终端端到端输出位于 `.local/terminal-e2e/`，桌面验收位于 `.local/native-e2e/`。诊断输出须去敏，保留当前候选产物的必要证据。

## 安装版复验

将候选安装器装入专属 QA 目录。使用隔离且没有主机/凭据的测试配置，禁止清除实际用户数据来满足前置条件。以下占位路径替换为实际值：

```powershell
node tools/release-startup-bench.mjs <installed-serverdeck-desktop.exe> <artifact-directory>
node tools/native-terminal-e2e.mjs --release --installed-exe <installed-serverdeck-desktop.exe> --release-qa
```

安装版可组合 `--advanced`、`--sftp`、`--ops` 复验模块；`--exit-transfer` 检查传输中的确认退出。`--modules-only` 不算完整产品回归，短时脚本不能代替 24 小时稳定性门禁。确认退出后核对所有进程和资源释放，不把 kill 当正常退出。CI 生成候选产物不代替签名、可信发布或各平台原生验收。
