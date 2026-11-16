# Docker 管理插件

这是独立 UI v4 / WASM 标准插件。`frontend/` 维护 Vue 页面、交互和前端测试，`backend/` 维护命令、解析、策略和 Rust 测试；只使用公开 SDK 和普通库。内置分发及用户上传使用相同运行、授权与沙箱边界，当前版本和最低 API 以 [manifest](manifest.json) 为准。

- [使用说明](../../../docs/guides/DOCKER.md)：容器、镜像、Compose、日志、Shell、归档和远程传输。
- [实现与生命周期](../../../docs/architecture/DOCKER.md)：查询授权、配置解析、缓存、日志监督与暂存清理。
- [公开 SDK](../../../docs/plugins/PLUGIN_SDK.md)与[插件开发](../../../docs/plugins/PLUGIN_DEVELOPMENT.md)：接口、打包和安装。

## 构建与检查

从仓库根目录执行，先按[开发指南](../../../docs/guides/DEVELOPMENT.md)准备锁定依赖并确认磁盘空间：

```powershell
npm run test -w @serverdeck/desktop -- ../../plugins/system/docker/frontend
cargo test --manifest-path plugins/system/docker/backend/Cargo.toml --target-dir target --offline --locked --no-run
node tools/build-plugin.mjs plugins/system/docker .local/docker.sdplugin
```

输出包须不存在。Rust 单测编译后复制测试 EXE 到隔离 QA 目录再运行；不启用未授权的远程测试。修改内容后提高插件自身版本并重建客户端，同版本重打包不替换用户已安装内容。

WSL Shell 回归对测试 EXE 副本执行 `--ignored --nocapture`，仅运行生产命令体和隔离 Shell 夹具，不连接真实 Docker daemon。真实日志生命周期、Compose、镜像传输和候选安装器的前置条件及验收见[原生检查](../../../docs/release/NATIVE_VALIDATION.md#docker)，夹具结果不能代替实际 SSH/SFTP/Docker 链路。
