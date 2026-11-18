# 软件更新分发

ServerDeck 使用公开仓库 [kse-music/operations 的 Releases](https://github.com/kse-music/operations/releases) 分发 Windows x64 安装版、Linux x86_64 的 deb/AppImage，以及 macOS Intel、Apple Silicon（M 系列）的 DMG 和应用 ZIP。应用内更新仅面向 Windows，Linux、macOS 包供手动下载安装升级。客户端行为见[使用说明](https://ops.hiboot.cn/docs/installation.html)，运行期与信任边界见[架构](../architecture/ARCHITECTURE.md#软件更新)。无需独立更新业务服务器。安装包不提交进 Git，也不使用有保留期限的 Actions Artifact 作为用户下载源。

## 发布文件

每个正式 Release 同时包含：

- `ServerDeck_<版本>_x64-setup.exe`：NSIS 当前用户安装包，保留 `cn.hiboot.desktop` 身份及现有数据。
- 同名 `.exe.sig`：官方 Tauri CLI 生成的安装包签名，可信注释必须绑定当前应用版本。
- `latest.json`：由 `tools/update-manifest.mjs` 生成，包含工作区版本、更新说明、发布时间、精确版本的下载 URL 与完整签名内容。
- `ServerDeck_<版本>_amd64.deb`：Linux x86_64 Debian 安装包。
- `ServerDeck_<版本>_amd64.AppImage`：Linux x86_64 AppImage。
- `ServerDeck_<版本>_x64.dmg`、`ServerDeck_<版本>_x64.app.zip`：Intel Mac 磁盘映像与应用归档。
- `ServerDeck_<版本>_aarch64.dmg`、`ServerDeck_<版本>_aarch64.app.zip`：Apple Silicon Mac 磁盘映像与应用归档。

`latest.json` 仍只包含 Windows 更新项；Linux、macOS 不生成 updater 签名或自动更新清单。macOS 的 `.app` 是目录，通过 `ditto` 压缩为保留权限和符号链接的 ZIP 后上传，两种架构的归档文件名互不覆盖。当前流程不导入 Apple 开发者证书、不执行公证；这些产物不能视为已通过 Gatekeeper 或原生安装运行验收，正式公开前须另行落实签名、公证及两种架构的实测。

客户端固定请求 `https://github.com/kse-music/operations/releases/latest/download/latest.json`。下载 URL 指向该版本的 `/releases/download/v<版本>/...`，不使用随新发布变化的最新包地址。首次正式清单尚未发布时，客户端会如实显示检查失败。普通用户无需 GitHub 账号或 Token；软件不携带仓库访问凭据。

Windows 安装包在文件替换后通过 NSIS 安装完成钩子通知系统刷新应用 EXE 及已有快捷方式的图标，普通安装与应用内更新均自动执行。无需用户运行刷新命令；不删除系统缓存文件、不重启 Explorer，也不取消或重建任务栏固定项。该行为须随新的安装包分发，已发布安装包不会自动获得新增钩子。

## 发布密钥

公钥固定在 `apps/desktop/src-tauri/tauri.conf.json`。本地既有私钥的约定位置为 Git 忽略目录 `.local/updater-signing/serverdeck.key`；发布前须在持有该密钥的环境核对其与公钥匹配、访问权限及安全备份，不能从源码或本文推断密钥已准备好。私钥不得随 QA、构建缓存或临时文件清理，不覆盖或反复生成。公钥可公开，私钥内容不得进入源码、命令参数、聊天、日志或 Release。

在 GitHub 仓库创建受保护的 `release` Environment，配置 Secret `TAURI_SIGNING_PRIVATE_KEY` 为该私钥内容；若密钥设置了口令，同时配置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。通过 GitHub 的 Secret 输入界面填写，不把值写入 workflow。需限制可使用该 Environment 的发布引用及人员，并在替换发布密钥前设计已经安装客户端的公钥过渡。

本地签名构建可将 `TAURI_SIGNING_PRIVATE_KEY` 环境变量设为该私钥的绝对文件路径，再运行现有 `node tools/tauri.mjs build --bundles nsis`。不要输出环境变量值或签名器的密钥生成输出。当前 CLI 在构建时自动绑定工作区版本，手工重新签名须显式提供 `signer sign --app-version <版本>`。更新器不接受缺少签名版本的旧签名。

## 发布流程

1. 只修改根 `Cargo.toml` 的工作区版本，运行既有准备入口并提交配套锁文件，将准备发布的完整代码推送到 `main`。无需手动创建或推送标签。GitHub 的 `release` Environment 允许 `main` 分支部署。
2. 在 Actions 中手动运行 **Windows, Linux and macOS release draft**（`.github/workflows/update-release.yml`），分支选择 `main`。更新说明可留空，由 GitHub 根据本次版本标签和固定提交 SHA 自动生成，上一版本由 GitHub 自动选择；填写时使用原样的自定义说明。自动内容通常包含合并的 PR、贡献者和完整变更链接，不会自动改写成中文产品摘要；主要直接提交代码、较少使用 PR 时，说明可能只有变更链接，发布前须复核。生成失败、内容为空或超过客户端的 64 KiB 限制时停止，不静默替换或截断。推送代码不会自动触发发布。
3. 发布流程先对本次固定提交的完整 npm 锁文件运行一次 `npm audit --package-lock-only --audit-level=moderate`。审计通过后，Windows、Linux 和两个 macOS 架构任务分别检出同一提交，安装工具链、系统及 npm 依赖，通过 `cargo fetch --locked --target <目标三元组>` 和 `node tools/build-system-plugins.mjs --fetch-only` 联网准备工作区与生产插件依赖。Windows 使用 `release` Environment 的既有密钥构建 NSIS 签名安装包和更新清单，并暂存同一份说明；Linux 在 Ubuntu 22.04 上构建 x86_64 deb、AppImage；macOS Intel 使用 `macos-15-intel`、Apple Silicon 使用 `macos-15`，分别构建对应目标的 DMG、`.app`，校验可执行文件架构并归档应用。Linux、macOS 显式关闭 updater artifacts，不读取 Windows 签名密钥。各目标构建包含生产 WASM 插件的离线编译、前端类型检查及打包。
4. 全部构建成功后，汇总任务下载本次运行的中间产物，确认当前版本的九项发布附件为非空文件，并检查 Windows 更新清单与版本、签名和说明一致；随后通过 `tools/update-release.mjs` 为固定提交自动创建 `v<版本>` 标签，再一起上传到同一个 **Release 草稿**。草稿正文与 `latest.json` 使用同一份说明，说明文件自身不作为附件上传。已有标签只有指向同一提交时才允许复用，包括已存在的附注标签；指向其他提交时明确失败，须提高工作区版本，不能移动或强制覆盖标签。已公开的 Release 不允许覆盖。同一提交的草稿运行失败后，重跑完整流程以重新审计，同步更新说明并替换尚未发布的文件。任一构建或附件校验失败不创建标签；标签创建后若草稿上传失败，标签保留用于同一提交重试。若验收时需要修改说明，应以自定义说明重跑同一提交，使草稿与清单一致。
5. 依据[发布检查表](RELEASE_CHECKLIST.md)分别验收 Windows、Linux 和两种架构的 macOS 候选安装包，落实 Windows 发布者签名及 Apple 开发者签名、公证，核对安装包、公钥、签名版本、平台及清单内容。更新签名与平台发布者签名分别管理；现有流程不自动提供 Windows 发布者证书或 Apple 开发者证书。
6. 确认文件完整且验收满足后，手动将草稿正式发布并设为 Latest。草稿与预发布版本不作为正式更新渠道。所有附件应在对用户可见前上传完成，不能先公开清单再补包。

发布流程复用 npm 下载缓存，并按运行平台、架构、Rust 版本及 Cargo 配置/锁文件隔离 Rust 下载和编译缓存：Windows 复用根 `target/release` 的编译依赖，Linux 和 macOS 复用根 `target/<目标三元组>/release` 的编译依赖，各任务缓存自身现有生产插件 `.local/plugin-build/assistant`、`.local/plugin-build/docker` 编译目录。macOS 缓存键同时包含 runner 和目标架构，两个架构的中间 Artifact 独立命名，汇总后使用带架构后缀的文件名。生产插件的预取不限制 `--target`，按各自锁文件下载完整依赖，覆盖离线解析可能读取的其他目标依赖清单；实际编译仍限定 `wasm32-unknown-unknown`。缓存不包含签名密钥、应用数据、测试目录或安装包；首次运行或缓存失效时仍须完整编译，命中缓存时也保留锁定依赖准备与编译校验，不通过去掉 `--offline` 或 `--locked` 绕过依赖准备。供汇总任务使用的 Actions Artifact 保留 14 天，仅用于任务间交付，不是用户下载渠道。

**Candidate builds (unsigned, no publish)**（`.github/workflows/release.yml`）集中执行 npm 审计、格式、lint、类型、前端单元测试和构建工具测试，另行执行 Rust 依赖审计。源码检查通过后，四个目标各自在对应原生 runner 上构建内置插件和测试夹具，运行 Clippy 和 Rust 测试，并上传内置插件包。手动勾选 `Build and upload unsigned installers` 才会额外构建无签名安装包和上传产物，该选项关闭 updater artifacts。正式公开前应检查同一提交的候选验证结果，并验收签名草稿中的实际产物。如果进行 Authenticode 签名，须先完成安装包签名，再生成 updater `.sig` 和清单；修改 `.exe` 后必须重新生成 updater 签名。

## 发布验收与限制

必须实测更旧的已安装版本发现新版、GitHub 清单与附件下载、签名/签名版本拒绝、网络中断及取消、退出确认取消保留工作、正常排空后覆盖安装、应用重新启动及主机/设置/凭据引用/插件数据保留。数据格式变化另遵守完整[数据升级契约](../architecture/DATA_MIGRATIONS.md)，不自动降级或恢复原数据库。

当前只接入 Windows x64 正式版全量更新；Linux deb/AppImage、macOS DMG/应用 ZIP 使用手动安装升级，须分别验证安装、启动、系统凭据、SSH/SFTP、窗口及数据保留，macOS 还须验证对应架构及系统签名、公证和 Gatekeeper 行为，不能以打包或草稿上传成功代替原生验收。其他平台的应用内更新须独立实现与验收。GitHub 下载可达性需在用户网络验证；没有更新器的旧版本需最后一次手动安装。草稿上传、Secret 配置或源码测试通过，都不代表正式安装升级已经验收。

返回[文档导航](../README.md)。
