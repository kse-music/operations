# ServerDeck 发布检查表

本表是当前候选产物的上线门禁，功能范围见[产品基线](../product/PRD.md)。每项须针对同一提交、版本和产物实际执行；未取得结果保持待验，源码存在、以前通过或本次文档整理均不代表当前候选通过。

## 发布门禁

- [ ] 固定候选提交、Cargo 工作区版本、锁文件、工具链、目标平台与产物 SHA-256，保留实际检查环境和结果。
- [ ] 完成[开发与验证](../guides/DEVELOPMENT.md#本地检查)中的适用格式、编译、静态及测试检查，生成当前生产插件及开发包。
- [ ] 在 Windows x64 实装并验证主机 → SSH → SFTP → Docker/助手 → 关闭/重启，完成[模块原生验收](NATIVE_VALIDATION.md)。不能用浏览器或协议夹具替代实际 EXE。
- [ ] 完成[数据库/配置升级](../architecture/DATA_MIGRATIONS.md)及数据目录迁移、失败保护；实测安装升级的数据和系统凭据引用保留。
- [ ] 完成[更新分发](UPDATES.md)的清单、公钥、签名版本、网络与取消、旧版发现/下载/覆盖安装/重启；验收普通安装和更新的 Windows 图标刷新。
- [ ] 从候选客户端重新下载独立开发包，在仓库外准备依赖、类型检查、测试、构建并上传，验证授权、启停、WASM 调用和卸载。
- [ ] 运行 `npm audit --audit-level=moderate` 和 `cargo audit --deny unsound`，复核最终依赖链的 RSA、GLib、停止维护项及其他报告，不以 ignore 或旧结果代替处置。
- [ ] 复核[依赖清单](DEPENDENCY_INVENTORY.md)、[许可原文](THIRD_PARTY_NOTICES.txt)、锁文件与实际安装资源；元数据存在不等于人工许可复核完成。
- [ ] 落实最终安装器的 Windows 发布者签名、updater 签名和可信分发；三者分别检查，SHA-256 不能证明身份。
- [ ] 测量真实进程树的冷启动、空闲内存和至少 20 个活动 SSH 终端；目标三秒内可交互、空闲内存尽量 150 MB，记录机器、场景和偏差，不将目标写成已测承诺。
- [ ] 完成 24 小时终端/采样/日志/传输并发、断线、睡眠/网络切换与百次启动退出；检查泄漏、排空和未知结果保护。
- [ ] 完成[安装版复验](NATIVE_VALIDATION.md#安装版复验)，包括安装、启动、正常退出、重装、升级及默认保留数据的卸载；覆盖 WebView2、系统凭据、Agent、选择器、拖放、输入法、高 DPI 和物理多屏。
- [ ] 若分发 macOS/Linux 或其他架构，完成各自构建、系统集成、凭据、安装卸载、窗口和显示验收；macOS 另验签名/公证，未测平台不声明支持。
- [ ] 全部阻断项关闭，QA/发布产物中留存候选标识、环境、命令、结果、失败及限制后，再正式公开。

## 版本来源与更新

只修改根 [Cargo.toml](../../Cargo.toml) 的工作区版本，桌面 dev/build 自动检查来源并同步工作区锁记录，提交配套 `Cargo.lock`。SDK、插件及持久格式独立管理，具体准备见[构建指南](../guides/DEVELOPMENT.md#应用版本与构建)。关于页时间是本次前端构建时间，不等同于正式 Release 发布时刻。

正式草稿和未签名候选是不同产物。同一提交应先通过 [Candidate builds (unsigned, no publish)](../../.github/workflows/release.yml)，再按 [Windows and Linux release draft](../../.github/workflows/update-release.yml) 生成包含 Windows updater 产物与 Linux deb、AppImage 的完整草稿；后者不运行全量测试。草稿成功不代表已上线或通过原生验收。核对两端构建成功、当前版本附件齐全及发布说明一致，Linux 安装包仍需单独原生验收。发布顺序、密钥与 Authenticode 签名后重签规则见[更新分发](UPDATES.md#发布流程)。

## 构建和产物

输出盘至少 10 GiB 空闲，桌面与原生编译复用根 `target/`；遵守构建锁和复制 EXE 的约定，不整删缓存或用户数据。依赖准备、命令与产物路径集中在[开发与构建](../guides/DEVELOPMENT.md)。

完成适用检查并准备既有签名环境后，在仓库根运行：

```powershell
node tools/tauri.mjs build --bundles nsis
node tools/release-manifest.mjs
```

本地未指定目标三元组时，安装器位于 `target/release/bundle/nsis/`，校验清单位于 `.local/release-qa/SHA256SUMS` 和 `.local/release-qa/release-manifest.json`。这些是本地产物路径；正式用户附件及 `latest.json` 按[更新分发](UPDATES.md#发布文件)准备，不用有期限的 CI Artifact 作为用户下载源。

## 原生验收

具体断言、前置条件、脚本参数和安装版复验统一见[原生功能验收](NATIVE_VALIDATION.md)。真实远程变更先取得测试主机/资源授权，使用隔离数据和凭据；不删除实际用户数据满足前置条件，不把 kill 当正常退出，不以单项自动化代替完整产品验收。

返回[文档导航](../README.md)。
