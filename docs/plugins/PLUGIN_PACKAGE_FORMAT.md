# 本地插件包 v1

当前 Host/Rust/Vue SDK 为 5.6.0，包格式和 WASM ABI 为 1，UI 为 4；版本约定见[版本规范](PLUGIN_API_VERSIONING.md)。

## UI v4 前端入口

包格式仍为 1。`entry.ui` 仍指向严格 JSON，不接收包内 HTML。`uiVersion:4` 必须声明 `frontend:{"script":"frontend.js","style":"frontend.css"}`，二者必须是包内真实普通文件，进入 files 的长度/SHA256 校验和现有单文件/总量上限。入口仅允许最长 80 字节的平面 ASCII 文件名，分别以 `.js`/`.css` 结束，不允许点开头、`..`、路径、URL 或额外资源入口。

宿主提供固定 HTML 壳并使用受限本地协议加载这两个入口；包内 JS/CSS 不进入宿主 DOM。构建工具把 Vue 和普通库打入单文件，图片可使用 data URI，运行时不能加载远程资源、动态分块或任意本地路径。包的 `apiVersion` 须覆盖使用的平台能力；模型流和文本进度要求至少 `^5.4.0`。仅接受 UI v4，缺少包内 frontend 或页面 surface 的声明直接拒绝。完整页面契约见[UI v4](PLUGIN_UI_EXTENSION.md)。

## 可选插件图标

在源码 `manifest.json` 中声明可选 `icon` 图标名，例如：

```json
{
  "apiVersion": "^5.4.0",
  "icon": "rocket"
}
```

以上仅展示图标字段，其他必填字段继续保留。图标无需额外权限或资源文件。系统和上传插件共用此配置，主机工具栏、设置中的管理列表、插件页面及安装预览统一显示，插件功能从主机工具栏进入。省略或设为 null 时使用默认 `boxes` 图标；符合名称格式但宿主尚不支持的图标名也回退默认。旧版已安装系统插件缺少字段时，从当前分发清单读取图标，仅用于显示，不改写包、摘要、安装代、启停或授权；上传插件不继承同 ID 系统插件的图标。

名称最多 64 字节，使用小写字母、数字和单个连字符分隔，首字符为字母。空串、路径、URL、标记文本及其他类型无效。当前支持：`activity`、`archive`、`bot`、`boxes`、`calendar-clock`、`chart-no-axes-combined`、`cloud`、`code`、`container`、`cpu`、`database`、`file-text`、`folder`、`globe`、`hard-drive`、`layers`、`list-tree`、`network`、`radio`、`rocket`、`scroll-text`、`search`、`server`、`settings-2`、`shield`、`terminal`、`wrench`。这些名称对应宿主静态内置的 Lucide 图标，大小与颜色随界面统一控制。

插件声明 `apiVersion: "^5.4.0"`，icon 为当前契约中的可选配置；包/Manifest 格式及 WASM ABI 为 1，UI 为 v4。

## 贡献与权限

可选 `preapprovedCommands` 使用既有 `{program,args,timeoutSecs}` 数组，普通固定命令至多16条；声明独立参数化读取权限后，可包含受限完整argv模板，总数至多32条，合计JSON仍≤48 KiB。普通 `ssh.execute.preapproved` 仍须独立授予且只精确匹配，不因新模板扩大已有授权。固定脚本、参数约束及完全访问首次授权见[SDK审批合同](PLUGIN_SDK.md#审批模式与计划确认)。

`ssh.interactive.preapproved` 是独立可选权限，必须同时声明 `ssh.execute`。授予同名权限和 operation 后，当前安装修订可直接启动任意 StreamOpen/Terminal 命令，不匹配固定命令清单；上传包默认不授予，升级重新绑定授权。它不免除 Execute、文件保存或本机 TCP 连接的确认，详见 [SDK](PLUGIN_SDK.md)。

formatVersion/schemaVersion 为 1。kind支持workspace/navigation/host_menu/command/settings/server，全部使用UI4 frontend页面。可选routes是最多32项的唯一合法导航标识；所有页面由插件独立 frontend 提供。

插件使用 `.sdplugin`，UTF-8 JSON：`{formatVersion: 1, manifest, files: [{path, content}]}`。content 为严格标准 base64，不压缩，不支持链接、设备文件或权限位。源码目录使用 `manifest.json`；打包器将其嵌入 manifest 字段并生成 files 校验清单。不得当作 ZIP 解包。

严格校验由 `crates/plugin-core/src/manifest.rs` 和 `package.rs` 实现，所有结构拒绝未知字段、重复对象字段；数组路径拒绝大小写冲突、文件/目录冲突和重复项。版本化协议需要修改 schemaVersion/formatVersion。当前只接收 1。

manifest 必填：schemaVersion、id（小写反向域名）、name、version（SemVer）、author、description、apiVersion（SemVer 范围）、entry（backend 可空且仅 `.wasm`，ui 可空且新安装只允许严格声明式 `.json`）、permissions、contributions、platforms、files、publisher（可空，自述身份，不代表验证通过）。后端/UI 入口必须在 files 中。贡献声明包含 id、label、kind（workspace/navigation/host_menu/command/settings/server），需要 ui.contribute 声明与 UI 入口。UI 入口仅接受 JSON 声明，页面必须自带前端，见 [UI v4](PLUGIN_UI_EXTENSION.md)。

files 校验清单每项为 path、size（解码字节数）、sha256（小写十六进制）。每个实际文件须有且只有一个校验项，缺失、额外、损坏均拒绝。manifest.json 是保留名，不允许作为普通载荷文件。

路径只允许 `/` 分隔的 ASCII 字母、数字、点、下划线、连字符组件；禁止绝对路径、盘符、反斜杠、空组件、`.`、`..`、尾随点、Windows 设备名/ADS。完整路径最多 200 字节。此可移植子集暂不支持中文资源文件名。

上限：原包 16 MiB（打开后以 limit+1 再读，防止仅依赖 stat），128 文件，单文件 4 MiB，解码总量 12 MiB，64 个已安装插件。压缩炸弹没有对应表示，ZIP/压缩数据不能通过 JSON 校验。JSON/base64 带来约三分之一体积开销，换取简单可审计格式；较大资源不在本版范围。

尚未实现密码学签名验证。PublisherVerifier 仅定义验证接口，默认信任策略拒绝普通安装；必须显式传入 developmentConfirmed=true，结果始终是 local_development_unverified。自述作者、publisher、SHA256 均不能证明来源可信。签名算法/密钥管理在真实验证实现前不能加入可信来源 UI。

示例：`node tools/package-plugin.mjs tests/fixtures/plugins/metadata .local/metadata.sdplugin`（输出必须不存在）。打包器只准备文件，最终权威校验始终在 Rust。

server贡献必须对应UI4 frontend页面。安装记录的 source 由 Host 写入，不属于包 manifest；上传不能声明 system 来源。分发内置包使用相同 Package 校验和文件摘要，由宿主设置系统来源与预置权限；上传包默认禁用/未授权，来源标签不是数字签名。

运行时版本内容按安装来源存放在应用数据目录 plugins/system/<ID>/versions/<revision> 或 plugins/upload/<ID>/versions/<revision>。packages/<ID>/record.json 为统一记录，备份保留其原来源/安装代；授权与个人数据仍共享 authorizations 和 data 路径。
