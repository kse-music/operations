# Plugin SDK 5.2.0

Host 语义 API、Rust SDK、TypeScript SDK 均为 **5.2.0**；WASM ABI / wire 为 1，界面为 UI v4。当前开发期直接拒绝旧主版本、旧业务能力和旧 UI，不提供兼容层。

## 职责边界

插件提供完整业务：页面、命令/SQL、参数校验、结果解析、健康规则、提示词、工具循环、计划及复查。SDK 只提供平台协议、调用客户端、生命周期和通用界面基础。宿主管理身份、凭据、SSH/SFTP、模型传输、权限、审批和资源配额。

SDK **没有** Docker / MySQL / AI 运维助手业务接口，也没有桌面 Store、任意 Tauri 转发、系统查询枚举或特定插件 ID 的特权分支。容器操作由插件通过通用 SSH 执行 `docker`，模型业务由插件构造消息调用通用模型能力。新增服务插件只新增完整插件目录；无需修改 SDK、宿主路由或原生业务后端。

插件文件原语只使用主机 SSH 登录身份的 SFTP 租约，不继承桌面文件页手动切换的 sudo 用户或密码。文件页处于 sudo 身份或切换中时，`connections.ensureConnection(hostId, true)` 明确要求先切回原登录用户，不报告虚假的连接成功；桌面切用户不扩大插件已授权的目录或身份。

| 内容                             | 位置 / 入口                                          |
| -------------------------------- | ---------------------------------------------------- |
| Rust 协议、顺序 async 动作执行器 | `crates/plugin-sdk/src/{lib,platform,backend}.rs`    |
| Vue/TS SDK                       | `packages/plugin-sdk/src/`，`@serverdeck/plugin-sdk` |
| 独立页面启动                     | `runtime` → `mountPlugin(App)`                       |
| 本包声明的 WASM 动作             | `invoke<T>(action, input, options?)`                 |
| 平台原语                         | `platform` → `call<T>(request)`                      |
| 安全公开元数据                   | `context` → `usePlatformContext()`                   |
| 连接 / 终端 / 取消 / 草稿        | `connections` / `terminal` / `actions` / `drafts`    |
| 通用组件                         | `ui/{Modal,OpsTable,TrendChart,StreamDialog}.vue`    |

`StreamDialog` 使用宽弹窗，固定标题/工具栏并让输出区独立滚动。首次打开和默认跟随时滚到最新输出，用户向上翻阅后停止自动滚动但继续接收；“最新日志”或暂停后的“继续”恢复跟随。窗口尺寸/字号变化时仅在跟随模式重新定位末尾。过滤、复制、导出、1 MiB/5000 行缓存及隐藏/卸载释放自有流的边界不变，组件 props 与平台协议不变。

下载的开发包包含上述两端 SDK、工具、锁文件、文档和完整样例，无需 ServerDeck 源码或 Tauri 工具链。

`invoke` 可通过 `options.confirmation` 提供 `{title,message,confirmLabel?}` 纯文本业务说明，仅改变本次宿主确认弹窗的呈现。宿主冻结说明，始终保留原生审批的真实目标与完整命令；有真实目标时正文只展示目标及业务说明，不展示执行详情或命令脚本；完整命令仍由原生审批绑定。字段限制、缺失目标行为及边界见 [UI 契约](PLUGIN_UI_EXTENSION.md)。该说明不能批准执行、替换目标或重放动作。

## Rust 动作

```rust
use serverdeck_plugin_sdk::{
    ApiError, backend::{Action, Context, Runtime}, platform::Command,
    serde_json::{Value, json},
};
fn dispatch(context: Context, action: String, input: Value) -> Action {
    Box::pin(async move {
        if action != "inspect" { return Err(ApiError::new("ACTION", "未知动作")); }
        let host = input["hostId"].as_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| ApiError::new("HOST", "请选择主机"))?;
        let result = context.execute(host, Command::new("free").arg("-b"))
            .await?.checked()?;
        // 这里由插件解析真实输出并判断健康状态。
        Ok(json!({"output": result.stdout}))
    })
}
std::thread_local! {
    static RUNTIME: std::cell::RefCell<Runtime> =
        std::cell::RefCell::new(Runtime::new(dispatch));
}
fn handle(opcode: i32, payload: Value) -> Value {
    RUNTIME.with_borrow_mut(|runtime| runtime.handle(opcode, payload))
}
serverdeck_plugin_sdk::export_plugin!(handle);
```

每个动作中的平台调用须**顺序 await**。执行器保存原 Future；遇到审批时宿主保存续接状态，批准/拒绝后送回原等待点，不重跑动作开头。不要自己重试已提交的写操作。取消会以 `USER_CANCELLED` 返回，插件可收尾和返回部分结果；关闭/撤权会强制终止该作用域。

`Context::request(platform::Request)` 返回 JSON；`execute(...).checked()` 拒绝非零、未知退出码及截断。`info()` 提供时间、随机 nonce、安装修订和作用域信息。`Host` / `Model` 请求返回不透明 `binding`，可用 `context.with_bindings(vec![binding])` 将后续操作绑定到原 SSH 配置或模型修订；失效须重新准备，不能静默改投其他目标。

## 平台原语及权限

Rust 完整类型在 `platform.rs`，TS 对应 `types/platform.ts`。后端 `Capability` 只有 `Platform { request, bindings }`，身份和页面 owner 由可信宿主绑定。目标使用明确的登记 `hostId`，不使用界面当前选中主机或内部 session ID。

| 请求 kind                                      | 用途                              | 权限 / operation                                                      |
| ---------------------------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| `info`                                         | 时间、nonce、当前插件/作用域修订  | `ui.contribute`                                                       |
| `hosts`, `host`                                | 安全资产目录、指定主机及修订绑定  | `hosts.read`                                                          |
| `models`, `model`, `model_complete`            | 安全模型目录/绑定、插件自备消息   | `models.use`                                                          |
| `execute`                                      | 单次 SSH 命令，真实退出状态与输出 | `ssh.execute`                                                         |
| `stream_open/poll/pause/stop`                  | 任意已批准命令的有界 ACK 字节流   | `ssh.execute`                                                         |
| `terminal`                                     | 已批准命令的一次性 PTY 票据       | `ssh.execute`                                                         |
| `read_file`, `close_file`                      | 受目录范围约束的文本编辑句柄      | `sftp.read`                                                           |
| `save_file`, `file_dirty`                      | 冲突检测、原子保存、退出保护      | `sftp.write`                                                          |
| `transfer_prepare/start/status/cancel/close`   | 单文件本机上传及双端中转任务      | `sftp.transfer`；准备/启动另需目标 `sftp.write`，远程源需 `sftp.read` |
| `settings_read/write`                          | 本插件独立 JSON 配置              | `settings.read/write`                                                 |
| `notify`                                       | 有界通知                          | `ui.contribute` / `ui.notify`                                         |
| `tcp_connect`                                  | 从本机探测目标 TCP 端口，3 秒超时 | `network.connect`                                                     |
| `result_read/close`, `output_open/part/finish` | SDK 内部透明分块传输              | `ui.contribute`                                                       |

`Command { program, args, timeoutSecs }` 将程序和参数逐项 POSIX 引用；无需人工拼接。只有明确需要 shell 时使用 `Command::script`，插件仍必须验证/引用插入脚本的值。程序 ≤4096 字节、参数 ≤128 个且每个 ≤8192 字节、合计 ≤16384 字节，无 NUL；Execute 超时 1–30 秒。Stream/PTY 持续到显式关闭或页面生命周期结束。

Execute 默认经可信宿主**逐次确认真实目标与命令**。可选 Manifest `preapprovedCommands` 声明 1–16 条完整 Command（合计 JSON ≤48 KiB），同时声明并独立授予 `ssh.execute.preapproved` 权限及同名 operation 后，只有 program、args、timeoutSecs 完全匹配的 Execute 使用预授权；仍需 `ssh.execute`。预授权匹配不支持参数模板或通配符，脚本内容按原样精确匹配；上传包权限页展示完整命令，默认未选此能力，升级按原包摘要/修订重新授权。该机制不保证命令只读，不接受 Guest 的 `readOnly`/`confirmed` 免审，也无服务名白名单。

StreamOpen、Terminal 默认逐次确认。清单另声明 `ssh.interactive.preapproved`，并独立授予同名权限和 operation 后，当前安装修订可直接启动任意远程流和终端命令；仍需声明、授予 `ssh.execute` 及同名 operation。这是任意交互命令授权，不受 `preapprovedCommands` 限制，也不表示命令只读；上传包默认未选，升级需要重新授权。该权限不能免除 Execute、SaveFile、TcpConnect 的审批。隐藏/关闭、撤权、配额、取消和实际 SSH 配置复验仍适用。

`models.use` 授权允许外发插件提供的消息，模型 Key/CLI 登录材料始终在宿主；CLI 安装和账号授权由平台模型设置独立管理。插件自行负责业务预览、数据选择和脱敏。

## 前端闭环

### 审批模式与计划确认（5.2）

`approval_mode {mode:"request"|"assist"}`（ui.contribute）返回owner/VM绑定的opaque `binding`；WASM可将它放入 `Context::with_bindings`，不得把句柄交给模型或把模型字段作为授权。mode不是权限：仅当manifest与当前grant均声明、授予独立 `operations.read.preapproved` permission及operation时，assist才免除 `read_file`、`transfer_prepare`，以及 `preapprovedCommands` 中完整匹配Execute的单次确认；基础读写/SSH权限和目录范围仍必须满足。未列入清单的动态命令仍确认，不自动推断命令只读。普通 `ssh.execute.preapproved` 的已有行为不变。

`confirm_operations {operations:[{request,count}]}`（ui.contribute）供同一WASM动作内合并确认固定请求集合；request仅限execute/save_file/transfer_start，1–96个唯一条目、最多128次使用，完整消息仍≤60 KiB。重复请求可合并count，不能包含嵌套计划或其他能力。Native先按真实权限/句柄/配置和实际目标预检，未批准不执行；返回常规宿主确认并沿原Future续接。批准后后续相同请求及绑定按次数消费，不再弹单项确认，新增/变化/超次数请求拒绝并撤销剩余授权。授权仅保存在当前原生动作中，不跨新invoke、owner、VM或重放；不要用多个独立前端call请求共享它。拒绝、超时或关闭沿原生命周期取消，写入与复查仍保留各自提交边界。

文件保存确认含实际路径、摘要和原文/候选差异；差异超过显示限额明确标注省略，调用方仍须提供完整业务预览。读取免确认不等于秘密不会进入模型，应在模式说明中告知数据用途。此功能不提供AI自动批准写入，不替代主机指纹、目录授权或服务端冲突检测。

### 文件与传输（5.1）

`read_file {hostId,path}` 按审批模式和独立读取预授权读取≤32 KiB 的 UTF-8 普通文本，拒绝链接/别名路径。文档 ID 绑定页面、VM、登录身份、原文和插件配置；`save_file {documentId,content}` 经宿主单项或计划确认、复验配置/目录/原文版本，原子提交并读回复查。不能用新路径或跨页面句柄保存。未标记 dirty 的文档五分钟后可回收，dirty 文档沿用退出保护，过期须重新读取。`info.activeScopes` 返回当前插件仍打开页面的 opaque scope，仅供 Guest 清理遗留状态，不是授权凭证。

```ts
import { call } from '@serverdeck/plugin-sdk/platform';
import type { TransferPreview, TransferState } from '@serverdeck/plugin-sdk/types/platform';
const preview = await call<TransferPreview>({
  kind: 'transfer_prepare',
  source: { kind: 'local', path: 'D:\\work\\xx.tar.gz' },
  destination: { hostId: 'test-host-id', path: '/work' },
  overwrite: false,
});
// 展示 preview 后由用户确认；远程源使用 { kind:'remote',hostId,path }。
const state = await call<TransferState>({ kind: 'transfer_start', id: preview.id });
```

精确 DTO 以两端 SDK 类型为准。准备遵循读取审批模式，启动须经宿主单项或计划确认：前者授权读取源元数据及目标状态，后者固定实际源、目标、大小及覆盖策略。预览五分钟内单次消费，每 owner 最多8项、全局32项。目标是已有规范目录，preview 返回完整目标文件路径。只传单个普通文件，不跟随链接/重解析点，不传目录、不解包、不自动重试。

启动返回后任务在 Native 既有 SFTP 队列运行，复制使用固定32 KiB缓冲、同目录临时文件和目标读回 SHA-256；字节不通过 JS/WASM/模型。`transfer_status {id}` 返回原生状态、进度、速度、摘要、错误及恢复路径。`transfer_cancel {id}` 仅取消自有任务，可绕开同插件正在占用的 Guest 动作，不占用或释放其 busy 标记。`transfer_close {id}` 取消、等待安全收尾并释放句柄。状态/取消/关闭不依赖已过期的模型绑定，但仍验证当前权限、owner、VM代。启动后继续复验插件/模型/SSH修订、配置、目录授权和连接，关闭所属页面或撤权会取消并排空；运行中不受五分钟预览 TTL 截断，不支持跨重启恢复。提交已发生但复验失败为 `unverified`，不能自动重放或回滚。

SFTP v3 缺少服务端 CAS，远端属性可能只有秒级时间；同属性并发改写仍有竞态。保存/覆盖是文件替换，inode、硬链接、ACL/xattr 的限制沿用文件页。目标临时文件无法清理时返回恢复路径。

```ts
import { invoke } from '@serverdeck/plugin-sdk';
const result = await invoke('inspect', { hostId });
```

动作必须在当前 `ui.json` 页面 actions 中声明；结构化 input 为 JSON，最大 60 KiB、深度16、4096节点。不得传函数、循环引用或原型特殊字段。前端可直接使用 `call` 处理通用文件、配置等；业务编排放在自己的 WASM 中。`connections.ensureConnection(hostId, files?)` 委托平台连接及真实指纹审核，不向插件暴露租约。`terminal.openTerminal(ticket, hostId, presentation?)` 仅打开本页已批准票据。

终端可选 `presentation` 只接受 `title`（最多 160 字符）和 `description`（最多 240 字符）的非空、无控制字符纯文本；未知字段拒绝。用于显示容器等业务上下文，不作为主机、命令或权限依据，实际 SSH 地址仍由宿主展示。省略时沿用通用插件终端标题。弹窗复用宿主终端的查找、字体和剪贴板能力，支持最大化/还原及本地清屏；这些操作不创建新 PTY、不重放票据。结束后保留历史和原因，从插件原入口重新打开才创建新会话。

Context 只含主题/字号、入口 hostId、可见状态和获授权的公开元数据。资产目录需 hosts.read；仅 SSH/SFTP 权限只能看到入口主机的安全连接状态。无凭据表、认证配置、代理命令、内部连接/transport ID。models.use 允许模型公开状态；修改模型、Key、授权和安装工具不属于插件桥。

`setDraftDirty(boolean)` 仅报告当前页草稿状态，不传正文。`usePluginVisibility()` 用于停止隐藏页面的交互与轮询。每个打开的页面拥有隔离 owner；系统与上传插件采用相同规则。隐藏页不能发起新调用或审批，已开始的保留工作可收尾；Stream/PTY 关闭。关闭 owner 只清理其自有资源，最后一个 owner 离开才释放共享 VM 根。

## 资源与错误

- WASM 每次入口 20,000,000 fuel、16 MiB 线性内存、64 KiB 消息、每秒20消息；入口完成后检查2秒壁钟。
- 每插件一个在途动作，全局4个能力槽；动作含续接最多96次平台请求、180秒。透明分块也占请求预算。
- Execute stdout/stderr **各256 KiB**；超限取消并明确 truncated，不报完整成功。
- 单结果≤1 MiB，chunk32 KiB，TTL60秒；结果池和上传池各最多8个/8 MiB。两端 SDK 自动读/释放结果，大于48 KiB 的 WASM 输出自动分块。`__pluginResult` 为保留的传输字段，业务返回对象不要使用该字段。
- 文本文件≤32 KiB；配置≤16 KiB；模型消息≤64条且编码总量≤48 KiB，模型调用最多150秒。
- 原子文件提交已开始后等待安全收尾；中断不等于远端命令未执行，须展示真实错误并独立核对，禁止自动重放。

失败保留 `{code,message}`，不要静默替换为空列表或成功。常见错误有 `PLUGIN_PERMISSION_DENIED`、`PLUGIN_CANCELLED`、`USER_CANCELLED`、`PLUGIN_TARGET_CHANGED`、`PLUGIN_CONFIRMATION_EXPIRED`、输出/配额错误。清理和原请求同时失败时保留两者原因。

参见[开发指南](PLUGIN_DEVELOPMENT.md)、[安全边界](PLUGIN_SECURITY.md)、[运行时](PLUGIN_RUNTIME.md)。
