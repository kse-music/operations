# ServerDeck 插件开发包

本包包含匹配版本的公开 Rust / TypeScript SDK、锁文件、构建工具和独立样例，不依赖宿主源码或 Tauri。

- [官网开发者中心](https://ops.hiboot.cn/developers/)：开发教程的唯一维护入口。
- [第一个插件](https://ops.hiboot.cn/developers/quickstart.html)：环境准备、构建和运行样例。
- [调试与测试](https://ops.hiboot.cn/developers/testing.html)、[打包与安装](https://ops.hiboot.cn/developers/packaging.html)：验证和交付步骤。
- [包内规范导航](docs/plugins/PLUGIN_BUILD_CONTRACT.md)：源码与构建契约及其他离线公开规范。
- [SDK 版本约定](docs/plugins/PLUGIN_API_VERSIONING.md)：核对本包与客户端适用范围。

样例位于 example/，包含无需主机的问候设置页和读取真实 free -b 结果的主机内存巡检页。包内契约对应下载时的 SDK 版本；官网可能已更新，使用前核对版本。当前插件包没有密码学签名验证，自述身份和摘要不能单独证明可信来源。

本包只分发契约快照和样例，不复制官网教程。首次准备公开依赖需要网络；具体命令统一由官网教程维护。
