# 软件更新分发

ServerDeck 使用公开仓库 [kse-music/operations 的 Releases](https://github.com/kse-music/operations/releases) 分发 Windows x64 正式版，客户端行为见[使用说明](../guides/USER_GUIDE.md#安装与升级)，运行期与信任边界见[架构](../architecture/ARCHITECTURE.md#软件更新)。无需独立更新业务服务器。安装包不提交进 Git，也不使用有保留期限的 Actions Artifact 作为用户下载源。

## 发布文件

每个正式 Release 同时包含：

- `ServerDeck_<版本>_x64-setup.exe`：NSIS 当前用户安装包，保留 `cn.hiboot.desktop` 身份及现有数据。
- 同名 `.exe.sig`：官方 Tauri CLI 生成的安装包签名，可信注释必须绑定当前应用版本。
- `latest.json`：由 `tools/update-manifest.mjs` 生成，包含工作区版本、更新说明、发布时间、精确版本的下载 URL 与完整签名内容。

客户端固定请求 `https://github.com/kse-music/operations/releases/latest/download/latest.json`。下载 URL 指向该版本的 `/releases/download/v<版本>/...`，不使用随新发布变化的最新包地址。首次正式清单尚未发布时，客户端会如实显示检查失败。普通用户无需 GitHub 账号或 Token；软件不携带仓库访问凭据。

## 发布密钥

公钥固定在 `apps/desktop/src-tauri/tauri.conf.json`，对应私钥在本机 Git 忽略目录 `.local/updater-signing/serverdeck.key`，已限制为当前 Windows 账户访问。应单独安全备份；不得随着 QA、构建缓存或临时文件清理，不覆盖或反复生成。公钥可公开，私钥内容不得进入源码、命令参数、聊天、日志或 Release。

在 GitHub 仓库创建受保护的 `release` Environment，配置 Secret `TAURI_SIGNING_PRIVATE_KEY` 为该私钥内容；若密钥设置了口令，同时配置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。通过 GitHub 的 Secret 输入界面填写，不把值写入 workflow。需限制可使用该 Environment 的发布引用及人员，并在替换发布密钥前设计已经安装客户端的公钥过渡。

本地签名构建可将 `TAURI_SIGNING_PRIVATE_KEY` 环境变量设为该私钥的绝对文件路径，再运行现有 `node tools/tauri.mjs build --bundles nsis`。不要输出环境变量值或签名器的密钥生成输出。当前 CLI 在构建时自动绑定工作区版本，手工重新签名须显式提供 `signer sign --app-version <版本>`。更新器不接受缺少签名版本的旧签名。

## 发布流程

1. 只修改根 `Cargo.toml` 的工作区版本，运行既有准备入口并提交配套锁文件，将准备发布的完整代码推送到 `main`。无需手动创建或推送标签。GitHub 的 `release` Environment 允许 `main` 分支部署。
2. 在 Actions 中手动运行 `.github/workflows/update-release.yml`，分支选择 `main`，只填写面向用户的更新说明。推送代码不会自动触发发布；流程固定检出点击运行时的提交 SHA，安装 npm 依赖后，先通过 `cargo fetch --locked` 与 `npm run plugins:fetch` 联网准备工作区及各独立插件锁定的 Rust 依赖，再读取工作区正式版本并离线编译 WASM 插件。格式、静态类型、测试与 npm 审计通过后生成签名安装包和清单；不能依赖开发机已有 Cargo 缓存，也不通过去掉 `--offline` 或 `--locked` 绕过依赖准备。
3. 构建与清单生成成功后，流程通过 `tools/update-release.mjs` 为该提交自动创建 `v<版本>` 标签，再上传完整的 **Release 草稿**。已有标签只有指向同一提交时才允许复用，包括已存在的附注标签；指向其他提交时明确失败，须提高工作区版本，不能移动或强制覆盖标签。已公开的 Release 不允许覆盖；同一提交的草稿失败可重跑，替换尚未发布的文件。构建失败不创建标签；标签创建后若草稿上传失败，标签保留用于同一提交重试。
4. 依据[发布检查表](RELEASE_CHECKLIST.md)验收同一候选安装器，落实 Windows 发布者签名，核对安装包、公钥、签名版本、平台及清单内容。更新签名与 Authenticode 分别管理；现有流程不自动提供 Windows 发布者证书。
5. 确认文件完整且验收满足后，手动将草稿正式发布并设为 Latest。草稿与预发布版本不作为正式更新渠道。所有附件应在对用户可见前上传完成，不能先公开清单再补包。

已有 `.github/workflows/release.yml` 继续生成未签名候选产物，并显式关闭 updater artifacts；不能将这些候选包直接替换成正式更新包。如果进行 Authenticode 签名，须先完成安装包签名，再生成 updater `.sig` 和清单；修改 `.exe` 后必须重新生成 updater 签名。流程不会自动把草稿发布给用户。

## 发布验收与限制

必须实测更旧的已安装版本发现新版、GitHub 清单与附件下载、签名/签名版本拒绝、网络中断及取消、退出确认取消保留工作、正常排空后覆盖安装、应用重新启动及主机/设置/凭据引用/插件数据保留。数据格式变化另遵守完整[数据升级契约](../architecture/DATA_MIGRATIONS.md)，不自动降级或恢复原数据库。

当前只接入 Windows x64 正式版全量更新，其他平台须独立实现与验收。GitHub 下载可达性需在用户网络验证；没有更新器的旧版本需最后一次手动安装。草稿上传、Secret 配置或源码测试通过，都不代表正式安装升级已经验收。

返回[文档导航](../README.md)。
