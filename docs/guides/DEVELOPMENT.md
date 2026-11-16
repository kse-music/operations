# 开发、构建与验证

开发约束见根目录 [AGENTS.md](../../AGENTS.md)，模块入口见[总体架构](../architecture/ARCHITECTURE.md)。本页维护源码准备和本地检查；发布流程见[发布检查表](../release/RELEASE_CHECKLIST.md)，第三方插件作者使用[独立开发包](../plugins/PLUGIN_DEVELOPMENT.md)。

## 环境与资源

需要 Rust stable 1.94+、Node.js 22.13+、npm 和 `wasm32-unknown-unknown`。Windows 需要 MSVC C++ Build Tools、Windows SDK、WebView2；其他平台需对应 Tauri 系统依赖和独立原生验收。CI 使用的具体工具链以 [候选构建](../../.github/workflows/release.yml)和[签名草稿流程](../../.github/workflows/update-release.yml)为准。

仓库文本统一使用 LF 换行，由 `.gitattributes`、`.editorconfig` 和 Prettier 配置共同约束；不需要修改开发者全局的 `core.autocrlf`。格式检查排除 `.ssr/` 等构建产物，避免扫描生成文件。

构建前确认输出盘至少 10 GiB 空闲。遵循 [.cargo/config.toml](../../.cargo/config.toml)：关闭增量编译，dev/test 为行号级调试信息。桌面与原生单测共用根 `target/`，WASM 插件复用 `.local/plugin-build/<插件>/`，不新增另一套桌面 Cargo 缓存。

原生 QA 运行复制后的 EXE，避免锁住构建输出；普通程序若从 `target/` 运行，重建前由用户正常退出。不整删 `.local/`，其中含应用数据、QA 证据、安装包及可能的签名密钥。清理仅限已确认可重建且未使用的子目录，先核实绝对路径、构建锁和重解析点，不跟随链接。

## 准备与运行

在仓库根目录执行：

```powershell
npm ci
rustup target add wasm32-unknown-unknown
npm run plugins:fetch
npm run tauri -- dev
```

`npm run dev` 只启动浏览器前端，完整产品需要 Tauri/Rust 后端；浏览器无后端时显示真实不可用状态。

桌面入口扫描 `plugins/system/` 的完整源码目录，分别编译 WASM/Vue，生成包与嵌入注册表。插件正式编译为 locked/offline；首次或依赖/锁文件变化后先 fetch，不改锁绕过缺失依赖。`plugins:fetch` 包含测试夹具；正式发布的生产准备可用 `node tools/build-system-plugins.mjs --fetch-only`。

内置插件内容改变须提高自身 manifest 版本并重建客户端；同版本重打包不会替换已安装内容。源码删除不自动卸载用户安装。规则见[插件版本约定](../plugins/PLUGIN_API_VERSIONING.md)。

## 应用版本与构建

应用唯一版本源为根 [Cargo.toml](../../Cargo.toml) 的 `[workspace.package].version`。桌面 dev/build 检查来源，并通过 `cargo update --workspace` 同步工作区锁记录，不更新锁定的第三方依赖；提交生成的 `Cargo.lock`。SDK、插件、数据库和配置格式独立管理版本。

```powershell
# Windows NSIS 安装器；正式 updater 产物需要既有签名密钥
node tools/tauri.mjs build --bundles nsis
# 嵌入当前前端资源的调试 EXE
node tools/tauri.mjs build --debug --no-bundle
```

| 产物           | 本地路径                                                     |
| -------------- | ------------------------------------------------------------ |
| 调试 EXE       | `target/debug/serverdeck-desktop.exe`                        |
| Release EXE    | `target/release/serverdeck-desktop.exe`                      |
| Windows 安装器 | `target/release/bundle/nsis/ServerDeck_<版本>_x64-setup.exe` |
| 插件包         | `plugins/system/packages/*.sdplugin`                         |
| 独立开发包     | `apps/desktop/dist/serverdeck-plugin-development-kit.zip`    |

指定 `--target` 时 Cargo 产物位于 `target/<目标三元组>/...`。已有相配的当前 Release EXE 时，`node tools/tauri.mjs bundle --bundles nsis` 可只打安装器。路径不是下载地址；更新签名和 Windows 发布者签名分别处理，见[更新分发](../release/UPDATES.md)。

前端构建生成开发包，包含公开 SDK、锁文件、样例、工具和插件规范。文档或 SDK 调整后同时检查包内副本和相对链接，在仓库外执行独立准备/构建；仅检查源码目录不能证明下载包可用。

## 本地检查

根据影响范围选择检查；纯文档整理检查事实、格式、路径、标题锚点、导航及分发副本，不把它当成功能验收。完整源码候选验证入口为：

```powershell
npm run plugins:fetch
npm run plugins:build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run test:build
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

本地 Rust 测试先编译，再复制测试 EXE 到隔离 QA 目录运行。以下 PowerShell 示例只运行默认测试，不启用需要额外环境或授权的 ignored 测试：

```powershell
$qaDirectory = Join-Path $PWD ('.local/qa/rust-tests/' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $qaDirectory -Force | Out-Null
$artifactLog = Join-Path $qaDirectory 'artifacts.jsonl'
cargo test --workspace --locked --no-run --message-format=json | Set-Content -LiteralPath $artifactLog
if ($LASTEXITCODE -ne 0) { throw 'Rust 测试编译失败' }
$testArtifacts = Get-Content -LiteralPath $artifactLog | ForEach-Object {
  ConvertFrom-Json -InputObject $_
} | Where-Object { $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable }
foreach ($testArtifact in $testArtifacts) {
  $testCopy = Join-Path $qaDirectory ([IO.Path]::GetFileName($testArtifact.executable))
  Copy-Item -LiteralPath $testArtifact.executable -Destination $testCopy
  & $testCopy
  if ($LASTEXITCODE -ne 0) { throw "Rust 测试失败：$testCopy" }
}
```

以上是本地 Windows EXE 流程；其他平台按对应可执行文件验证。`--no-run` 不运行 doctest；有文档代码测试时另运行 `cargo test --workspace --doc --locked`。CI 使用隔离 runner 执行工作流中的检查，不代替原生或安装器验收。

## 原生与发布验证

桌面、真实系统凭据、UAC、Shell、SSH/SFTP、模型账号及安装升级分别按[原生验收](../release/NATIVE_VALIDATION.md)执行。先阅读测试入口的操作范围；远程变更需要对测试主机和资源的明确授权，不能用只读检查授权覆盖写入。

发布另运行锁定依赖审计，并复核许可文件与实际安装资源。保留同一候选提交、平台、命令、结果及未执行原因；测试脚本、协议夹具、CI 打包成功都不能代替真实端到端结果。不要将 QA 流水追加回产品基线。

返回[文档导航](../README.md)。
