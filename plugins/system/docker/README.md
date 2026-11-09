# Docker 管理

独立 UI v4 标准插件包。界面、交互业务与前端测试在 `frontend/`，WASM 能力策略与 Rust 测试在 `backend/`；分别只引用公开 `@serverdeck/plugin-sdk` 和 `serverdeck-plugin-sdk`，普通 Vue/测试依赖按工作区管理。宿主通过相同沙箱、SDK、WASM 和授权机制加载内置与上传包。

清单预授权版本检测、容器列表、镜像列表、容器详情、环境变量和资源使用六条完整固定查询，进入、刷新及查看详情无需逐次确认。详情与资源使用读取当前主机快照，再按完整容器 ID 筛选；概览不读取环境变量，环境变量快照仅在打开对应标签时查询，前端只收到当前容器的数据，切换或关闭时清除明文。查询仍受平台输出和超时限制，容器数量或详情过大时会明确失败。内置包预置独立 `ssh.execute.preapproved` 授权；作为上传包安装时需在权限页核对命令后单独授予。

2.0.7 日志和 Shell 直接打开，使用独立 `ssh.interactive.preapproved` 权限；上传安装仍需用户单独授予，该能力允许当前安装版本直接启动任意远程流/终端命令。Shell 默认 `/bin/sh`。容器启动、停止、删除及镜像删除仅保留宿主一次确认，无需输入目标 ID。标题明确操作，正文显示容器/镜像名称、短 ID、实际 SSH 主机及服务中断/数据丢失影响，按钮直接标注“启动”“停止”或“删除”；不提供“执行详情”或命令脚本入口，完整命令仍由原生审批绑定。取消不执行命令；删除仍不强制、不删除卷。其他未声明命令继续审批，宿主没有 Docker 专用匹配规则。

验证：`npm run test -w @serverdeck/desktop -- ../../plugins/system/docker/frontend`；原生单测用 `cargo test --manifest-path plugins/system/docker/backend/Cargo.toml --target-dir target --offline --locked --no-run` 编译，将生成的测试 EXE 复制到 QA 目录再运行。构建会同时打包 WASM、UI 声明和独立 JS/CSS，完整契约见 [开发指南](../../../docs/plugins/PLUGIN_DEVELOPMENT.md)。

构建：`node tools/build-plugin.mjs plugins/system/docker OUTPUT.sdplugin`。

该包可像用户上传的插件一样安装、授权、启停、升级及卸载；系统来源只由应用的首次分发记录设置。
