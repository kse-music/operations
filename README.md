# ServerDeck

ServerDeck 是面向开发者和运维人员的本地优先服务器工作台，基于 Rust、Tauri 2、Vue 3 和 TypeScript 构建。通过 SSH/SFTP 将终端、文件、Docker 和 AI 运维集中在同一主机工作区，无需云端账号或远端 Agent。

## 功能

- **主机管理**：多级文件夹、搜索、拖动、复制、连接测试、受限 OpenSSH Config 预览导入；密码和私钥交给系统凭据库。
- **终端**：本地与 SSH Shell、多会话、分屏、查找、快捷键、原生剪贴板、网址打开、rz 上传及向当前 Shell 目录拖放文件/文件夹；支持跳板和代理。
- **文件管理**：本地/远程双栏 SFTP、目录操作、后台传输、冲突处理、SHA-256 校验、确认式 sudo 用户切换、独立文本编辑窗口和 Windows 系统应用编辑。
- **Docker 插件**：容器、镜像、Compose 项目、资源与启动配置、日志、Shell，以及经确认的启停、重启、删除和日志清理。
- **AI 运维助手**：匹配登记主机，按问题采集并脱敏，通过模型流式回答；预览并按审批模式执行固定目标计划、局部文本修改和单文件传输，执行后复查。
- **模型与插件管理**：远程 OpenAI 兼容模型、本地 Codex/Claude Code 来源；本地插件包安装、权限、配置、启停和卸载，以及可下载的独立开发包。
- **桌面工作区**：主机标签、全局搜索、深浅主题、中英文、字号与快捷键设置、数据目录迁移和安全退出。

功能边界见[产品基线](docs/product/PRD.md)，操作见[使用说明](docs/guides/USER_GUIDE.md)。

## 平台与版本

应用版本以 [Cargo.toml](Cargo.toml) 的 `[workspace.package].version` 为唯一来源。SDK、插件包和数据格式分别管理版本。

Windows x64 是首要发布验收平台；macOS/Linux 客户端及其他架构须分别完成原生验收。界面支持简体中文和 English。源码可构建不等于安装包或所有平台已经通过发布验收，发布前按[检查表](docs/release/RELEASE_CHECKLIST.md)逐项确认。

## 快速开始

本仓库提供源码；安装器和校验文件由发布流程另行分发。安装前阅读[安装与升级](docs/guides/USER_GUIDE.md#安装与升级)。

1. 新建主机，填写地址、端口、用户名和认证信息，测试连接后保存。
2. 首次连接通过可信渠道核对 SHA-256 主机指纹；密钥变化时停止连接并排查。
3. 双击主机打开工作区，在 SSH、SFTP、Docker 和 AI 助手之间切换。
4. 使用助手前，在“设置 → 模型”准备模型，再在助手插件设置中保存绑定。

## 开发与构建

需要 Rust stable 1.94+、Node.js 22.13+、npm 和 `wasm32-unknown-unknown` 目标。Windows 还需 MSVC C++ Build Tools、Windows SDK 和 WebView2；其他平台需安装相应 Tauri 系统依赖。

```powershell
npm ci
rustup target add wasm32-unknown-unknown
npm run plugins:fetch
npm run tauri -- dev
```

`npm run dev` 仅启动浏览器前端，完整功能需要 Tauri/Rust 后端。

桌面开发和打包自动扫描 `plugins/system/`，独立编译插件并生成包和 Rust 注册表。插件构建使用 locked/offline；首次构建或插件依赖/锁文件变化后，先运行 `npm run plugins:fetch`。新增源码目录后需重新构建客户端。

```powershell
# Windows NSIS 安装器
node tools/tauri.mjs build --bundles nsis
# 嵌入前端资源的调试程序
node tools/tauri.mjs build --debug --no-bundle
```

发布只修改 Cargo 工作区版本，入口自动检查版本来源并同步工作区锁记录；将生成的 `Cargo.lock` 一并提交。产物路径和原生验收见[发布检查表](docs/release/RELEASE_CHECKLIST.md)。

构建前输出磁盘至少保留 10 GiB 空闲。遵循 `.cargo/config.toml`：关闭增量编译，开发/测试使用行号级调试信息；桌面和原生测试共用根 `target/`，WASM 缓存使用 `.local/plugin-build/<插件>/`。原生 QA 运行复制后的 EXE，避免锁定构建输出。`.local/` 包含数据和诊断产物，不得整删；清理缓存须核对路径、使用状态和目录链接，保留安装包及用户数据。

## 测试

依赖插件资源的 Cargo 检查前，先生成插件和测试夹具：

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

这些是执行入口，不表示已经通过。真实 SSH、系统凭据、桌面交互和安装器检查需要隔离环境及相应授权，见[原生验收](docs/release/RELEASE_CHECKLIST.md#原生验收)。

## 使用边界

- 系统凭据库不可用时明确失败，不降级为明文；本地 RSA 私钥签名被禁用，使用 Ed25519/ECDSA 或系统 Agent。
- 主机密钥必须核验；变更按宿主审批规则授权，不自动提权。
- 文件传输失败后从头重试，不支持断点续传或跨重启恢复。桌面文本编辑上限 2 MiB，助手文本编辑上限 32 KiB；原子替换不保证保留 ACL、扩展属性或硬链接关系。
- 助手任务和对话仅在运行期保留。超时、断线或取消后远端操作可能已经发生，须核对实际结果，不能自动重放变更。
- 当前没有自动更新或插件密码学签名验证；文件摘要不能证明发布者身份。

完整边界见[安全说明](docs/release/SECURITY.md)。

## 文档与许可

[文档导航](docs/README.md)提供产品、使用、架构、插件和发布入口；开发要求见 [AGENTS.md](AGENTS.md)。

项目采用 [MIT 许可证](LICENSE)。第三方依赖及许可证见[依赖清单](docs/release/DEPENDENCY_INVENTORY.md)和[第三方声明](docs/release/THIRD_PARTY_NOTICES.txt)。
