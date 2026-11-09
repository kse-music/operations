# ServerDeck

ServerDeck 是面向开发者和运维人员的本地优先服务器运维桌面客户端，基于 Rust、Tauri 2、Vue 3 和 TypeScript 构建。
通过 SSH/SFTP 管理 Linux 服务器，将终端、文件、Docker 和 AI 运维操作集中在同一主机工作区，无需云端账号或远程 Agent。

## 主要功能

- **主机与凭据管理**：分组、标签、收藏、搜索、OpenSSH Config 预览导入，以及系统凭据库存储。
- **SSH 终端**：多标签、分屏、搜索、主题与快捷键设置，支持密码、私钥、SSH Agent、跳板、代理和端口转发。
- **SFTP 文件管理**：本地/远程双栏浏览、后台上传下载、冲突处理、校验和远程文本编辑。
- **插件运维**：三个独立标准 WASM 插件：Docker 管理、AI 运维助手、Nginx 管理；MySQL 巡检独立开发并上传安装。Nginx 支持服务器直接安装和 Docker 容器的配置、校验、重载与日志。系统服务插件及旧标准系统界面已移除，AI 仍可按问题查询资源、进程、端口和 systemd。功能从当前主机 SSH/SFTP 右侧平铺的工具按钮进入，只列具有功能页面的启用插件；安装、升级、卸载和各插件的启停、权限及配置统一从“设置 → 插件”进入，功能页也可打开自身设置。全部插件适用于所有主机，内置权限/范围预置且只读，上传权限自行配置。见[内置插件说明](docs/plugins/BUILTIN_PLUGINS.md)。
- **运维自动化**：命令/脚本库、执行历史和本地计划，执行前预览目标并确认。
- **模型管理与 AI 运维智能体**：注册、查看、编辑和删除 OpenAI 兼容模型，Key 独立存于系统凭据库；助手按问题匹配主机，通过 SSH 自动查询、生成固定目标计划，在宿主确认后执行并复查。支持清理无标签 Docker 镜像、容器与 systemd 操作，保留脱敏、指纹核验和有界执行。主机标签保持打开时，切换工具、设置或其他主机仍继续回答，关闭所属主机才取消该页工作。见 [AI 助手说明](docs/guides/AI_ASSISTANT.md)。
- **统一工作区**：全局搜索、主题与偏好设置。

各项功能的完成范围和验证状态见[功能矩阵与测试报告](docs/validation/TEST_REPORT.md)。

插件使用 SDK5：命令、SQL、脱敏、提示词和计划属于插件，平台只提供通用连接/执行/文件/模型等基础能力。内置目录自动发现，外部开发包包含两端SDK、规范和可独立构建的闭环样例。见[SDK边界](docs/plugins/PLUGIN_SDK.md)。

## 版本与平台

当前源码版本为 **0.3.0**，安装包仍需重新构建与验收。
Windows x64 安装与运行已验证，远端验收环境为 Ubuntu 24.04；macOS/Linux 客户端尚未完成构建和实机兼容性验证。当前完整界面语言为简体中文。

依赖安全通告、内存目标和长期稳定性等发布条件尚未全部满足。详细状态见[安全说明](docs/release/SECURITY.md)和[发布检查表](docs/release/RELEASE_CHECKLIST.md)。

## 安装与快速开始

本仓库提供源码和构建说明，安装器与校验文件不随 Git 仓库分发。Windows 测试安装包可按下方开发说明自行构建；产物位置见[发布检查表](docs/release/RELEASE_CHECKLIST.md)。
安装前请阅读[安装与升级说明](docs/guides/USER_GUIDE.md#安装与升级)，当前安装包未签名，SHA256 校验不能替代发布者身份验证。

1. 在凭据管理中配置密码或私钥；使用 SSH Agent 时，先启动系统 Agent 并加载密钥。
2. 新建主机，填写地址、端口、账号并关联凭据。
3. 首次连接时，通过可信渠道核对服务器 SHA256 主机密钥指纹，再确认连接。
4. 在同一主机工作区使用终端、文件、Docker 及 AI 运维工具。

详细操作、升级和数据备份方法见[使用说明](docs/guides/USER_GUIDE.md)。

## 开发

在项目根目录运行，先安装以下依赖：

- Rust stable，项目声明最低版本为 1.94。
- Rust WASM 目标：`rustup target add wasm32-unknown-unknown`。
- Node.js 22.13+ 和 npm。
- Windows：MSVC C++ Build Tools、Windows SDK 和 WebView2。
- macOS/Linux：对应的 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)，这些客户端平台尚未验收。

启动桌面开发环境：

```powershell
npm ci
rustup target add wasm32-unknown-unknown
npm run plugins:fetch
npm run tauri -- dev
```

`npm run dev` 仅启动浏览器前端，完整功能需要 Tauri/Rust 后端。

`dev/build`（包括 Tauri 入口）会自动发现 `plugins/system/` 下的插件源码目录，生成 `plugins/system/packages/*.sdplugin` 和 Rust 注册文件 `registry.rs`。新增完整插件目录后无需修改构建、注册或发布清单，重新构建并启动客户端即可出现在插件管理中。产物由 Git 忽略；`packages` 是保留的产物目录。插件编译使用 `--offline --locked`，首次构建、新增依赖或锁文件更新后先运行 `npm run plugins:fetch` 下载全部已发现插件及测试夹具的锁定依赖。

构建 Windows NSIS 测试安装包：

```powershell
node tools/tauri.mjs build --bundles nsis
```

独立调试二进制、原生验收和发布复验步骤见[发布检查表](docs/release/RELEASE_CHECKLIST.md)。

Git 忽略调试、打包和测试生成的文件，包括各级 `.local/` 下的缓存和验收输出，以及手动打包生成的 `*.sdplugin`。源码、构建配置、依赖锁文件和 Tauri 图标等打包输入随仓库分发。

本地构建使用 `.cargo/config.toml`：关闭增量编译，开发/测试只保留行号级调试信息；桌面和原生验收统一复用 `target/`，WASM 插件继续使用 `.local/plugin-build/<插件>/`。原生测试运行 QA 目录中的 EXE 副本，避免占用编译输出。清缓存后的首次构建会重新编译依赖，速度会慢一些；需要变量级断点调试时应在确认空间充足后临时覆盖配置。

桌面 `build/dev` 和插件构建入口在项目磁盘空闲不足 10 GiB 时拒绝启动，不自动删除文件。该检查仅发生在启动前，不是硬配额；直接执行 Cargo 或其他程序写盘仍需留意可用空间。清理缓存前须确认没有构建在运行，不能整删 `.local/` 或应用数据目录。详见[本地构建缓存验证](docs/validation/foundation/VALIDATION_BUILD_CACHE.md)。

## 测试

完成开发准备后，首次运行测试或测试夹具锁文件更新时，先下载夹具的锁定依赖。

```powershell
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
npm run build
```

直接执行依赖插件资源的 Cargo 检查、测试或编译前，先运行 `npm run plugins:build`。该命令还会生成 Git 忽略的 `server-capabilities.sdplugin` 测试夹具。插件目录增删、插件/夹具或公开 SDK 源码变化后也需重新生成，Rust 的 `include!` / `include_bytes!` 在编译时读取注册文件及插件包。只把源码目录放入仓库不会热安装到已经运行的客户端。

以上命令用于本地检查，不代表所有平台均已通过。需要系统凭据库、桌面应用或授权 SSH 服务器的测试，另见[原生验收说明](docs/release/RELEASE_CHECKLIST.md#原生验收)；已执行结果见[测试报告](docs/validation/TEST_REPORT.md)。

## 重要限制

- 密码和私钥口令使用系统凭据库；服务不可用时操作失败，不降级为明文存储。本地 RSA 私钥签名被禁用，请使用 Ed25519/ECDSA 或系统 Agent。
- SSH 主机密钥变化会阻断连接；危险操作需要确认，应用不自动提权。
- 文件传输失败后从头重试，不支持断点续传或跨进程重启恢复。远程编辑仅支持不超过 2 MiB 的 UTF-8 普通文本，保存时不保证保留 ACL、扩展属性和硬链接关系。
- 本地计划依赖应用运行和已有认证连接，退出、休眠或断线时不保证执行。超时、断线或在途取消后，远端任务可能仍在运行，需要人工核实。

完整兼容性与安全边界见[使用说明](docs/guides/USER_GUIDE.md)和[安全说明](docs/release/SECURITY.md)。

## 文档

- [文档导航](docs/README.md)：按用途查看全部文档、模块验证记录及维护约定。
- [使用说明](docs/guides/USER_GUIDE.md)：安装、连接、日常操作和备份。
- [功能矩阵与测试报告](docs/validation/TEST_REPORT.md)：完成范围、验收结果和已知缺口。
- [安全说明](docs/release/SECURITY.md)：凭据保护、依赖风险与安全边界。
- [发布检查表](docs/release/RELEASE_CHECKLIST.md)：构建、原生验收和发布条件。
- [产品需求](docs/product/PRD.md)、[架构](docs/architecture/ARCHITECTURE.md)、[实施计划](docs/product/IMPLEMENTATION_PLAN.md)与[技术决策](docs/architecture/DECISIONS.md)。
- [变更记录](CHANGELOG.md)。

## 许可证

项目采用 [MIT 许可证](LICENSE)。第三方依赖及其许可证见[依赖清单](docs/release/DEPENDENCY_INVENTORY.md)和[第三方声明](docs/release/THIRD_PARTY_NOTICES.txt)。
