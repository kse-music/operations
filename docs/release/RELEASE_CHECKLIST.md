# 0.1.0-beta.1 发布检查表

2026-11-02。结论：仅测试版候选产物，**禁止标成稳定版**，没有自动创建外部 Release。

## 当前可复核项

- [x] 阅读 PRD 与后续需求，形成带证据/范围/缺口的功能矩阵（TEST_REPORT）。
- [x] Cargo/npm/Tauri 版本一致；当前应用标识统一为 cn.hiboot.desktop，只使用当前目录和凭据服务，不清库、不自动迁移旧身份；当前 schema 为 9。
- [x] Windows Release NSIS 当前用户安装；多分辨率图标、版本、发布者、描述。
- [x] 默认配置初始化；安装目录与业务数据分离；当前 schema 9 初始化、重复打开及非当前版本拒绝保留数据。
- [x] Rust fmt / Clippy / 常规单元集成 / 显式系统凭据与真实 Linux Engine；前端类型/ESLint/单元/生产构建。
- [x] 20 个真实终端、8 MiB 输出、5000 条目录、5 文件 SHA256、1000 主机首屏的可复跑基线。
- [x] npm 原 14 中等风险修复到 0；RustSec 原始失败结果和上游风险保留，没有 ignore 假绿。
- [x] 安全/用户指南/变更记录/架构/实施状态与第三方许可元数据/通知。
- [x] macOS arm64/x64、Linux x64 手动 CI 和平台 bundle 配置，仅准备，未执行。
- [x] 最终 Network 修复后功能 34、性能 8、自动化 10、真实传输中确认退出 3；独立运维 21、约 313 秒并发曲线、五次进程树退出、实际卸载保留数据库（范围/Hash 见 TEST_REPORT）。

## 稳定版阻断项

- [ ] 完成签名 Windows 安装器、可信下载发布渠道、签名验证和升级/卸载系统矩阵；当前未签名。
- [ ] 完成 当前 cn.hiboot 应用身份的 NSIS 安装/卸载，以及 macOS/Linux 当前目录与凭据存储原生验收。
- [ ] 解决/重新评估 RSA 通告及 Linux GLib unsound；上游维护告警完成跨平台依赖升级验证。
- [ ] 整进程树空闲内存达到目标或经 PRD 明确决策调整；未启用 CDP 的普通模式当前约 271 MiB private，目标约 150 MB 未达到，不擅自改指标。
- [ ] 24 小时监控/日志/终端/传输压力、持续断线重连、睡眠/网络切换、百次启动退出和资源释放矩阵。
- [ ] macOS 两种架构与 Linux 原生构建/凭据库/Agent/安装/卸载/高 DPI，签名及 Apple 公证。
- [ ] SFTP 面板宽度/仅远程模式、命令交互终端执行模式等 PRD 差异明确实现或由用户正式调整需求。
- [ ] 实际系统 Agent/硬件令牌、Windows 原生拖放/选择器/输入法与物理多显示器。
- [ ] 依赖许可证清单人工复核；THIRD_PARTY_NOTICES 汇总源文件，46 个解析包缺顶层许可文件，不能声称已完成法律审查。

## 复建及产物

客户端前端构建会生成并嵌入 `serverdeck-plugin-development-kit.zip`。更新 Host API 或 SDK 时，同步样例清单及依赖锁文件，并从客户端重新下载，在仓库外完成样例打包和安装验证。操作记录见[插件开发包验收](../validation/plugins/PLUGIN_TEST_REPORT.md#2026-11-07-插件开发包下载)。

```powershell
npm ci
rustup target add wasm32-unknown-unknown
cargo fetch --manifest-path plugins/system/docker/backend/Cargo.toml --target wasm32-unknown-unknown --locked
cargo fetch --manifest-path plugins/system/assistant/backend/Cargo.toml --target wasm32-unknown-unknown --locked
cargo fetch --manifest-path tests/fixtures/plugins/server-capabilities/backend/Cargo.toml --target wasm32-unknown-unknown --locked
npm run plugins:build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm run format:check
npm run lint
npm run typecheck
npm test
npm audit --audit-level=moderate
node tools/tauri.mjs build --bundles nsis
node tools/release-manifest.mjs
```

Cargo 审计单独执行 `cargo audit --deny unsound`，目前预期失败并应阻止稳定发布。CI 没有上传签名秘密、没有写 contents 权限，没有自动上传测试输出。已有 npm/Cargo lock 必须保留。

Windows 安装包：`target/release/bundle/nsis/ServerDeck_0.1.0-beta.1_x64-setup.exe`；程序：`target/release/serverdeck-desktop.exe`；校验：`.local/release-qa/SHA256SUMS` 和 `release-manifest.json`。校验值不是发布者签名。最终安装器大小/Hash 以清单为准。

这些是本机构建产物路径，`target/` 和 `.local/` 已被 Git 忽略，不是下载地址；克隆源码不会获得安装器或校验文件。发布时需另行提供可信的分发入口。

安装前备份数据和保留凭据库；默认卸载保留配置，不选择“删除数据”选项。应用退出过程中先完成脏文本、传输和任务确认，不能把 kill 当作正常退出验收。自动更新未实现，未来必须先具备签名和来源校验方案。

## 本地调试构建

嵌入生产前端资源、无需 Vite 服务的 Windows 调试二进制：

```powershell
node tools/tauri.mjs build --debug --no-bundle
```

产物为 `target/debug/serverdeck-desktop.exe`。只构建 Release 二进制可运行 `node tools/tauri.mjs build --no-bundle`。Windows 会锁定运行中的 EXE，重新构建前先关闭该程序。

## Release 依赖加载失败排查

Vite 的 `Some chunks are larger than 500 kB` 是体积警告，后面的 Rust 编译错误需单独处理。`E0463: can't find crate` 表示编译器未能加载依赖，并不只意味着 Cargo.toml 缺少声明，参见 [Rust 错误说明](https://doc.rust-lang.org/error_codes/E0463.html)。先确认依赖声明、当前 Rust 工具链和构建目标；若依赖已声明且已有产物，却在复用 Release 缓存时持续失败，可在没有其他构建进程运行时重新生成缓存：

```powershell
cargo clean --release
node tools/tauri.mjs build --bundles nsis
```

`cargo clean --release` 清理当前 target 目录的 Release 生成产物，包括旧安装包，下次构建会重新编译全部 Release 依赖；需要保留的旧包应先另存。它不清理 Debug 产物或应用数据目录，具体范围见 [Cargo clean 文档](https://doc.rust-lang.org/cargo/commands/cargo-clean.html)。不要用删除数据库、用户配置或 Cargo.lock 来排查这类编译错误。若错误仍存在，保留完整构建日志继续定位，不自动反复清理或掩盖错误。

## NSIS 工具解压失败排查

如果日志已经出现 `Built application at`，随后在 `extracting NSIS` 时报告 `PermissionDenied`，应检查 NSIS 工具解压时的文件创建权限。本机曾在创建 `Plugins/x86-ansi/TypeLib.dll` 时复现，切换缓存目录后同样失败。

Tauri 默认使用 `%LOCALAPPDATA%\tauri\NSIS`，可复用与当前 CLI 匹配的完整缓存。缓存缺失且解压仍被拒绝时，保留完整日志并检查对应文件和安全软件的拦截记录。参见 [Tauri 的 NSIS 缓存检查逻辑](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs#L75-L105)。

已有当前版本的 Release 程序时，可从仓库根目录仅重跑安装包生成步骤：

```powershell
node tools/tauri.mjs bundle --bundles nsis
```

## 原生验收

常规编译、类型与单元测试入口见 [README](../../README.md#测试)。Windows 受限执行环境可能禁止 Vitest 缓存重命名或 loopback TCP；这些测试需要正常本地进程权限。

桌面 CRUD/凭据/导入的隔离端到端测试，以及显式系统凭据库集成测试：

```powershell
npm run test:native
cargo test -p serverdeck-security native_store_roundtrip_update_and_delete -- --ignored
```

原生 E2E 使用 `.local/native-e2e` 下独立数据库、复制的测试 EXE 和仅测试进程的 loopback CDP；结束后清理随机凭据并恢复正常构建，保留诊断产物。普通应用构建不开放调试端口。测试流程和证据见[主机/凭据验收](../validation/foundation/VALIDATION_STAGE2.md)。

SSH 模块验收需要已授权测试账号、带外核对的主机指纹，以及仅本次进程使用的密码；不要把秘密写入命令历史或文件。设置 `SERVERDECK_TEST_HOST`、`SERVERDECK_TEST_USER`、`SERVERDECK_TEST_PIN` 并按 [SSH 增强验收](../validation/terminal/VALIDATION_SSH_USABILITY.md#复现与边界)或[网络/批量验收](../validation/operations/VALIDATION_NETWORK_BATCH.md#复现)的隐藏密码方式启动。依赖 Docker 的套件还需要已授权 Docker 环境。

运行 `--ops`、`--ops-probe` 或 `--product` 验收前，按上面的复建步骤执行 `npm run plugins:build`，生成运维验收使用的 `server-capabilities.sdplugin`。

| 验收范围                       | 入口                                       | 详细记录                                                              |
| ------------------------------ | ------------------------------------------ | --------------------------------------------------------------------- |
| SSH 基础                       | `npm run test:terminal`                    | [SSH 基础验收](../validation/terminal/VALIDATION_STAGE3.md)           |
| 分屏、标签、代理、跳板与转发   | `npm run test:terminal -- --advanced`      | [SSH 增强验收](../validation/terminal/VALIDATION_SSH_USABILITY.md)    |
| SFTP 与远程编辑                | `npm run test:terminal -- --sftp`          | [SFTP 验收](../validation/files/VALIDATION_STAGE4.md)                 |
| Linux 监控                     | `npm run test:terminal -- --monitor`       | [监控验收](../validation/monitoring/VALIDATION_STAGE5.md)             |
| Docker、日志、进程、端口与服务 | `npm run test:terminal -- --ops`           | [Linux 运维验收](../validation/operations/VALIDATION_OPERATIONS.md)   |
| 网络与批量操作                 | `npm run test:terminal -- --network-batch` | [网络/批量验收](../validation/operations/VALIDATION_NETWORK_BATCH.md) |
| 自动化与计划                   | `npm run test:terminal -- --automation`    | [自动化验收](../validation/operations/VALIDATION_AUTOMATION.md)       |
| 完整产品流程                   | `npm run test:terminal -- --product`       | [产品整合验收](../validation/workspace/VALIDATION_PRODUCT.md)         |

测试输出和下载保存在 `.local/terminal-e2e` 的隔离目录。远端测试只创建和清理 UUID/标签所属临时资源，不修改宿主 sshd；具体夹具和环境要求以各套件说明为准。

## 安装版发布复验

先按“复建及产物”生成安装包和清单，安装到专属 QA 目录；以下占位路径须替换为实际路径，要求空主机目录，不得清除已有用户数据来满足前置条件。

```powershell
node tools/release-startup-bench.mjs <installed-serverdeck-desktop.exe> <artifact-directory>
node tools/native-terminal-e2e.mjs --release --installed-exe <installed-serverdeck-desktop.exe> --release-qa
```

模块验收选项也可用于安装版：`--automation --network-batch --ops --monitor --sftp` 覆盖对应模块，`--advanced` 覆盖 SSH 增强；`--soak --ops` 增加五分钟同时监控/Docker 日志，`--exit-transfer` 验证真实上传中确认退出与重启清理。`--modules-only` 仅用于独立复测模块，不算完整终端回归。

安装版验收拒绝已有主机/凭据的目录，结束后恢复原偏好。功能证据、失败重跑、性能口径和未完成条件以[测试报告](../validation/TEST_REPORT.md)为准；CI 手动生成四类候选产物，不自动创建 Release、上传用户数据或引入自动更新。
