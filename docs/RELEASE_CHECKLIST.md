# 0.1.0-beta.1 发布检查表

2026-11-02。结论：仅测试版候选产物，**禁止标成稳定版**，没有自动创建外部 Release。

## 当前可复核项

- [x] 阅读 PRD 与后续需求，形成带证据/范围/缺口的功能矩阵（TEST_REPORT）。
- [x] Cargo/npm/Tauri 版本一致，保留应用标识和 schema 5 迁移，不清库。
- [x] Windows Release NSIS 当前用户安装；多分辨率图标、版本、发布者、描述。
- [x] 默认配置初始化；安装目录与业务数据分离；旧 schema 2→5 真实启动迁移。
- [x] Rust fmt / Clippy / 常规单元集成 / 显式系统凭据与真实 Linux Engine；前端类型/ESLint/单元/生产构建。
- [x] 20 个真实终端、8 MiB 输出、5000 条目录、5 文件 SHA256、1000 主机首屏的可复跑基线。
- [x] npm 原 14 中等风险修复到 0；RustSec 原始失败结果和上游风险保留，没有 ignore 假绿。
- [x] 安全/用户指南/变更记录/架构/实施状态与第三方许可元数据/通知。
- [x] macOS arm64/x64、Linux x64 手动 CI 和平台 bundle 配置，仅准备，未执行。
- [x] 最终 Network 修复后功能 34、性能 8、自动化 10、真实传输中确认退出 3；独立运维 21、约 313 秒并发曲线、五次进程树退出、实际卸载保留数据库（范围/Hash 见 TEST_REPORT）。

## 稳定版阻断项

- [ ] 完成签名 Windows 安装器、可信下载发布渠道、签名验证和升级/卸载系统矩阵；当前未签名。
- [ ] 解决/重新评估 RSA 通告及 Linux GLib unsound；上游维护告警完成跨平台依赖升级验证。
- [ ] 整进程树空闲内存达到目标或经 PRD 明确决策调整；未启用 CDP 的普通模式当前约 271 MiB private，目标约 150 MB 未达到，不擅自改指标。
- [ ] 24 小时监控/日志/终端/传输压力、持续断线重连、睡眠/网络切换、百次启动退出和资源释放矩阵。
- [ ] macOS 两种架构与 Linux 原生构建/凭据库/Agent/安装/卸载/高 DPI，签名及 Apple 公证。
- [ ] SFTP 面板宽度/仅远程模式、命令交互终端执行模式等 PRD 差异明确实现或由用户正式调整需求。
- [ ] 实际系统 Agent/硬件令牌、Windows 原生拖放/选择器/输入法与物理多显示器。
- [ ] 依赖许可证清单人工复核；THIRD_PARTY_NOTICES 汇总源文件，46 个解析包缺顶层许可文件，不能声称已完成法律审查。

## 复建及产物

```powershell
npm ci
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm run format:check
npm run lint
npm run typecheck
npm test
npm audit --audit-level=moderate
node tools/tauri.mjs build --bundles nsis
node tools/release-manifest.mjs
```

Cargo 审计单独执行 `cargo audit --deny unsound`，目前预期失败并应阻止稳定发布。CI 没有上传签名秘密、没有写 contents 权限，没有自动上传测试输出。已有 npm/Cargo lock 必须保留。

Windows 安装包：`target/release/bundle/nsis/ServerDeck_0.1.0-beta.1_x64-setup.exe`；程序：`target/release/serverdeck-desktop.exe`；校验：`.local/release-qa/SHA256SUMS` 和 `release-manifest.json`。校验值不是发布者签名。最终安装器大小/Hash 以清单为准。

安装前备份数据和保留凭据库；默认卸载保留配置，不选择“删除数据”选项。应用退出过程中先完成脏文本、传输和任务确认，不能把 kill 当作正常退出验收。自动更新未实现，未来必须先具备签名和来源校验方案。
