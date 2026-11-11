# ServerDeck 插件开发包（SDK5）

这是完整独立工程，含Rust/TypeScript SDK5、配套文档、构建工具和锁文件；不依赖ServerDeck源码或Tauri。插件自身负责业务，SDK只提供平台原语。样例包含本地问候和真实远程内存巡检（free -b、输出解析、低可用内存判断）。

准备Node.js22.13+、Rust稳定版1.94+、rustup/Cargo，构建盘至少10GiB。首次准备需要网络获取锁定依赖：

```sh
rustup target add wasm32-unknown-unknown
npm ci
cargo fetch --manifest-path example/backend/Cargo.toml --target wasm32-unknown-unknown --locked
npm run typecheck
npm test
npm run package
```

生成example.sdplugin；再次输出请用新文件名，或移动旧产物：`node tools/build-plugin.mjs ./example ./example-1.1.1.sdplugin`。修改manifest的id/name/author、自己的Vue页面和WASM动作即可。UI页面ID/动作声明必须对应贡献/调用；后端使用backend::Runtime和显式hostId，顺序await平台能力。

在「设置 → 插件」上传包，核对本地开发包提示，授权并启用。配置页问候无需主机；内存巡检从已登记主机工作区打开，需ssh.execute及真实命令单次确认，远端须有Linux free命令。升级提高manifest.version并重新授权。

固定后台查询可在 manifest 的 `preapprovedCommands` 声明完整 Command（最多 16 条、合计 JSON ≤48 KiB），并同时声明 `ssh.execute`、`ssh.execute.preapproved`。用户核对命令后单独授予后者权限及 operation，才可对完全匹配的 Execute 免除逐次确认。程序、参数、超时均逐字段匹配，预授权匹配无动态模板；此授权不保证命令只读，不适用于流、终端或文件写入。详见 SDK 和包格式文档。

需要直接打开流或终端时，可另声明 `ssh.interactive.preapproved`，用户单独授予同名权限和 operation 后才对 StreamOpen/Terminal 免除逐次确认，仍需基础 `ssh.execute` 授权。这会允许当前安装修订启动任意交互命令，上传包默认未选；不能代替 Execute、文件写入或本机 TCP 的确认。完整边界见 SDK。

SDK 提供“请求批准/帮我批准/完全访问权限”三种任务模式。带参数的读取必须单独声明并授权受限argv模板；完全访问还须可信宿主首次授权，仍限于已授予能力和目录，在当前会话持续生效，切换到request/assist或关闭owner时撤销；新建对话需调用request，不以页面隐藏代替关闭。完整模式、模板及失效规则见SDK文档；上传包不默认获得这些权限。

`streaming` 平台请求和 Vue `progress` 客户端支持有界模型文本流及插件显示进度；句柄绑定原owner/VM，工具仍须独立授权和审批。先在WASM解析并脱敏回答，再发布显示片段；完整结果校验前不能执行计划。字段、取消及配额见SDK文档。

需要易懂的操作确认时，前端可使用 `invoke(action, input, { confirmation: { title, message, confirmLabel } })`。例如标题“停止容器？”，正文说明容器名称和服务中断影响，按钮“停止”。宿主显示原生取得的实际目标和业务说明，不提供执行详情或命令脚本入口；完整命令仍由原生审批绑定，这些纯文本不参与授权，也不传给 WASM。字段限额和完整契约见 SDK 的 UI 说明。

前端测试`npm test`，类型检查`npm run typecheck`。后端可用`cargo test --manifest-path example/backend/Cargo.toml --no-run --target-dir <QA共享target>`编译，Windows将EXE复制到QA目录运行；WASM产物在.local/plugin-build/example。工具默认locked/offline打包，先fetch依赖，不通过改锁掩盖失败。

前端通过 `mountPlugin` 完成 SDK 就绪通知、MessageChannel 连接确认和可信上下文接收后挂载；不要在握手完成前自行调用平台。

解压后的 `docs/plugins/` 包含 `PLUGIN_SDK.md`、`PLUGIN_DEVELOPMENT.md`、`PLUGIN_UI_EXTENSION.md`、`PLUGIN_SECURITY.md` 和 `PLUGIN_PACKAGE_FORMAT.md` 等规范。MySQL/Redis 等服务业务属于插件，不需要给 SDK 或宿主增加服务枚举、私有 Store 或原生业务接口。
