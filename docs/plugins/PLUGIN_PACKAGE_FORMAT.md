# 本地插件包 v1

## SDK 1.2 工具贡献

formatVersion/schemaVersion 仍为 1。使用新工具的包声明 apiVersion ^1.2.0、uiVersion 3；贡献 kind=tool 且 tool 为 assistant/batch/automation/network 之一，其他贡献不能携带 tool 字段。必须有匹配页面的工具标准视图和独立 WASM 后端，完整校验通过后才可安装。

13A-1 使用 `.sdplugin`，UTF-8 JSON：`{formatVersion: 1, manifest, files: [{path, content}]}`。content 为严格标准 base64，不压缩，不支持链接、设备文件或权限位。源码目录使用 `manifest.json`；打包器将其嵌入 manifest 字段并生成 files 校验清单。不得当作 ZIP 解包。

严格校验由 `crates/plugin-core/src/manifest.rs` 和 `package.rs` 实现，所有结构拒绝未知字段、重复对象字段；数组路径拒绝大小写冲突、文件/目录冲突和重复项。版本化协议需要修改 schemaVersion/formatVersion。当前只接收 1。

manifest 必填：schemaVersion、id（小写反向域名）、name、version（SemVer）、author、description、apiVersion（SemVer 范围）、entry（backend 可空且仅 `.wasm`，ui 可空且新安装只允许严格声明式 `.json`）、permissions、contributions、platforms、files、publisher（可空，自述身份，不代表验证通过）。后端/UI 入口必须在 files 中。贡献声明包含 id、label、kind（workspace/navigation/host_menu/command/settings/server），需要 ui.contribute 声明与 UI 入口。早期阶段允许登记的 .html 元数据仍可列举/卸载，但不会执行，也不能作为新 UI 包安装；当前 UI v1/v2 见 [PLUGIN_UI_EXTENSION.md](PLUGIN_UI_EXTENSION.md)。

files 校验清单每项为 path、size（解码字节数）、sha256（小写十六进制）。每个实际文件须有且只有一个校验项，缺失、额外、损坏均拒绝。manifest.json 是保留名，不允许作为普通载荷文件。

路径只允许 `/` 分隔的 ASCII 字母、数字、点、下划线、连字符组件；禁止绝对路径、盘符、反斜杠、空组件、`.`、`..`、尾随点、Windows 设备名/ADS。完整路径最多 200 字节。此可移植子集暂不支持中文资源文件名。

上限：原包 16 MiB（打开后以 limit+1 再读，防止仅依赖 stat），128 文件，单文件 4 MiB，解码总量 12 MiB，64 个已安装插件。压缩炸弹没有对应表示，ZIP/压缩数据不能通过 JSON 校验。JSON/base64 带来约三分之一体积开销，换取简单可审计格式；较大资源不在本版范围。

尚未实现密码学签名验证。PublisherVerifier 仅定义验证接口，默认信任策略拒绝普通安装；必须显式传入 developmentConfirmed=true，结果始终是 local_development_unverified。自述作者、publisher、SHA256 均不能证明来源可信。签名算法/密钥管理在真实验证实现前不能加入可信来源 UI。

示例：`node tools/package-plugin.mjs tests/fixtures/plugins/metadata .local/metadata.sdplugin`（输出必须不存在）。打包器只准备文件，最终权威校验始终在 Rust。

SDK 1.1 的 server 贡献必须对应 UI v2 surface 页面。安装记录的 source 由 Host 写入，不属于包 manifest；上传不能声明 system 来源。分发内置包使用相同 Package 校验和文件摘要，默认禁用/未授权，来源标签不是数字签名。

运行时版本内容按安装来源存放在应用数据目录 plugins/system/<ID>/versions/<revision> 或 plugins/upload/<ID>/versions/<revision>。packages/<ID>/record.json 为统一记录，备份保留其原来源/安装代；授权与个人数据仍共享 authorizations 和 data 路径。旧 packages/<ID>/versions 在启动时迁移，不重写包或授权。
