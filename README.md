# ServerDeck

ServerDeck 是面向开发者和运维人员的本地优先服务器运维桌面客户端，基于 Rust、Tauri 2、Vue 3 和 TypeScript 构建。
通过 SSH/SFTP 管理 Linux 服务器，将终端、文件、监控和运维操作集中在同一主机工作区，无需云端账号或远程 Agent。

## 主要功能

- **主机与凭据管理**：分组、标签、收藏、搜索、OpenSSH Config 预览导入，以及系统凭据库存储。
- **SSH 终端**：多标签、分屏、搜索、主题与快捷键设置，支持密码、私钥、SSH Agent、跳板、代理和端口转发。
- **SFTP 文件管理**：本地/远程双栏浏览、后台上传下载、冲突处理、校验和远程文本编辑。
- **Linux 监控与运维**：三个独立标准 WASM 插件：系统服务（资源监控、进程端口、systemd、日志、网络诊断）、Docker 管理、AI 运维助手。功能从当前主机 SSH/SFTP 右侧“工具”菜单进入，只列具有功能页面的启用插件；安装、升级、卸载和各插件的启停、权限及配置统一从“设置 → 插件管理”进入，功能页也可打开自身设置。全部插件适用于所有主机，内置权限/范围预置且只读，上传权限自行配置。见[内置插件说明](docs/plugins/BUILTIN_PLUGINS.md)。
- **网络诊断与文件管理**：本机/远端诊断，以及独立 SFTP 文件传输。
- **运维自动化**：命令/脚本库、执行历史和本地计划，执行前预览目标并确认。
- **模型管理与 AI 助手**：注册、查看、编辑和删除 OpenAI 兼容模型，Key 独立存于系统凭据库；助手直接多轮对话，默认关联全部资产，按问题匹配并连接主机，提供授权上下文、脱敏、Markdown 回答和逐条命令审核。见 [AI 助手说明](docs/guides/AI_ASSISTANT.md)。
- **统一工作区**：全局搜索、主题与偏好设置，以及不含凭据的配置备份与恢复。

各项功能的完成范围和验证状态见[功能矩阵与测试报告](docs/validation/TEST_REPORT.md)。

## 版本与平台

当前版本为 **0.1.0-beta.1，未签名测试版**。
Windows x64 安装与运行已验证，远端验收环境为 Ubuntu 24.04；macOS/Linux 客户端尚未完成构建和实机兼容性验证。当前完整界面语言为简体中文。

依赖安全通告、内存目标和长期稳定性等发布条件尚未全部满足。详细状态见[安全说明](docs/release/SECURITY.md)和[发布检查表](docs/release/RELEASE_CHECKLIST.md)。

## 安装与快速开始

本仓库提供源码和构建说明，安装器与校验文件不随 Git 仓库分发。Windows 测试安装包可按下方开发说明自行构建；产物位置见[发布检查表](docs/release/RELEASE_CHECKLIST.md)。
安装前请阅读[安装与升级说明](docs/guides/USER_GUIDE.md#安装与升级)，当前安装包未签名，SHA256 校验不能替代发布者身份验证。

1. 在凭据管理中配置密码或私钥；使用 SSH Agent 时，先启动系统 Agent 并加载密钥。
2. 新建主机，填写地址、端口、账号并关联凭据。
3. 首次连接时，通过可信渠道核对服务器 SHA256 主机密钥指纹，再确认连接。
4. 在同一主机工作区使用终端、文件、监控及运维模块。

详细操作、升级和数据备份方法见[使用说明](docs/guides/USER_GUIDE.md)。

## 开发

在项目根目录运行，先安装以下依赖：

- Rust stable，项目声明最低版本为 1.94。
- Node.js 22.13+ 和 npm。
- Windows：MSVC C++ Build Tools、Windows SDK 和 WebView2。
- macOS/Linux：对应的 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)，这些客户端平台尚未验收。

启动桌面开发环境：

```powershell
npm ci
npm run tauri -- dev
```

`npm run dev` 仅启动浏览器前端，完整功能需要 Tauri/Rust 后端。

构建 Windows NSIS 测试安装包：

```powershell
node tools/tauri.mjs build --bundles nsis
```

独立调试二进制、原生验收和发布复验步骤见[发布检查表](docs/release/RELEASE_CHECKLIST.md)。

## 测试

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

以上命令用于本地检查，不代表所有平台均已通过。需要系统凭据库、桌面应用或授权 SSH 服务器的测试，另见[原生验收说明](docs/release/RELEASE_CHECKLIST.md#原生验收)；已执行结果见[测试报告](docs/validation/TEST_REPORT.md)。

## 重要限制

- 密码和私钥口令使用系统凭据库；服务不可用时操作失败，不降级为明文存储。本地 RSA 私钥签名被禁用，请使用 Ed25519/ECDSA 或系统 Agent。
- SSH 主机密钥变化会阻断连接；危险操作需要确认，应用不自动提权。
- 文件传输失败后从头重试，不支持断点续传或跨进程重启恢复。远程编辑仅支持不超过 2 MiB 的 UTF-8 普通文本，保存时不保证保留 ACL、扩展属性和硬链接关系。
- 本地计划依赖应用运行和已有认证连接，退出、休眠或断线时不保证执行。超时、断线或在途取消后，远端任务可能仍在运行，需要人工核实。
- 配置备份不包含凭据、私钥路径、主机信任、执行历史或自动计划；自行写入脚本和备注的秘密仍需在分享前检查。

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
