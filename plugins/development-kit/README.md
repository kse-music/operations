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

前端测试`npm test`，类型检查`npm run typecheck`。后端可用`cargo test --manifest-path example/backend/Cargo.toml --no-run --target-dir <QA共享target>`编译，Windows将EXE复制到QA目录运行；WASM产物在.local/plugin-build/example。工具默认locked/offline打包，先fetch依赖，不通过改锁掩盖失败。

2026-11-09 的开发包修复了 SDK5 前端加载握手：恢复就绪通知和连接确认，API/UI/ABI 契约不变。用修复前开发包打出的 UI 需更新公开 SDK 并重新打包，提高插件版本后上传升级；无需修改插件业务或宿主服务接口。

参考[SDK](docs/plugins/PLUGIN_SDK.md)、[开发规范](docs/plugins/PLUGIN_DEVELOPMENT.md)、[UI](docs/plugins/PLUGIN_UI_EXTENSION.md)、[安全](docs/plugins/PLUGIN_SECURITY.md)、[包格式](docs/plugins/PLUGIN_PACKAGE_FORMAT.md)。新增MySQL/Redis等服务能力属于插件；不需要给SDK或宿主新增服务枚举、私有Store或原生业务接口。
