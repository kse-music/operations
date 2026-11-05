# ServerDeck 文档导航

按用途管理文档，验证记录再按功能模块归档。目录调整保留了原文件名和历史内容。

## 从哪里开始

| 目标                     | 入口                                                                            |
| ------------------------ | ------------------------------------------------------------------------------- |
| 安装、连接与日常使用     | [使用说明](guides/USER_GUIDE.md)                                                |
| 查看需求及当前开发状态   | [产品需求](product/PRD.md)、[实施计划](product/IMPLEMENTATION_PLAN.md)          |
| 理解实现和设计取舍       | [总体架构](architecture/ARCHITECTURE.md)、[技术决策](architecture/DECISIONS.md) |
| 开发或安装插件           | [插件开发指南](plugins/PLUGIN_DEVELOPMENT.md)                                   |
| 查看功能范围与验证证据   | [测试报告](validation/TEST_REPORT.md)、[验证记录索引](validation/README.md)     |
| 构建、发布与检查安全边界 | [发布检查表](release/RELEASE_CHECKLIST.md)、[安全说明](release/SECURITY.md)     |

## 产品与实施：product

- [产品需求](product/PRD.md)：需求基线、交互和能力范围。
- [实施计划](product/IMPLEMENTATION_PLAN.md)：当前状态、阶段完成情况和后续依赖。
- [13A 插件系统开发任务](product/ServerDeck_13A_Codex_开发任务.md)：该阶段的原始任务及验收要求；执行状态以实施计划为准。

## 架构与决策：architecture

- [总体架构](architecture/ARCHITECTURE.md)：模块职责、数据流、接口和生命周期。
- [技术决策](architecture/DECISIONS.md)：设计取舍及其依据。
- [ADR 0001：SSH 候选库与密码学安全门禁](architecture/decisions/0001-ssh-crypto-gate.md)：独立决策记录。

## 使用指南：guides

- [使用说明](guides/USER_GUIDE.md)：安装、升级、主机连接、日常操作和备份。
- [AI 助手](guides/AI_ASSISTANT.md)：模型配置、主机关联、切页后台处理、SSH 智能体查询/计划/确认执行/复查及兼容命令审核。

## 插件开发：plugins

- [系统内置插件](plugins/BUILTIN_PLUGINS.md)：三个 cn.hiboot 标准 WASM 插件、平铺工具栏、预置只读权限、全主机适用及目录迁移。
- [架构](plugins/PLUGIN_ARCHITECTURE.md)
- [开发与本地安装](plugins/PLUGIN_DEVELOPMENT.md)
- [包格式](plugins/PLUGIN_PACKAGE_FORMAT.md)
- [运行时与 ABI](plugins/PLUGIN_RUNTIME.md)
- [公开 SDK](plugins/PLUGIN_SDK.md)：Rust 3.0 / Vue 3.0，插件源码边界与公共能力。
- [API 版本策略](plugins/PLUGIN_API_VERSIONING.md)
- [安全边界](plugins/PLUGIN_SECURITY.md)
- [插件 UI 扩展](plugins/PLUGIN_UI_EXTENSION.md)：UI v4 独立前端及 v1–v3 兼容。

插件测试结果统一放在[插件验证记录](validation/plugins/PLUGIN_TEST_REPORT.md)。

## 发布与安全：release

- [发布检查表](release/RELEASE_CHECKLIST.md)：构建、原生验收和发布条件。
- [安全说明](release/SECURITY.md)：凭据保护、依赖风险和安全边界。
- [依赖清单](release/DEPENDENCY_INVENTORY.md)：第三方包与许可证元数据。
- [第三方声明](release/THIRD_PARTY_NOTICES.txt)：安装包携带的许可证原文。

## 验证记录：validation

[测试报告](validation/TEST_REPORT.md)提供功能矩阵和已知缺口；[验证记录索引](validation/README.md)列出基础、主机、终端、文件、监控、运维、工作区、AI 和插件的具体证据。

验证记录描述当时的版本、环境和结果，保留历史失败与限制；后续变更的当前状态结合实施计划和对应模块记录判断。

## 维护约定

1. `docs/` 根目录只保留本导航；新增文档按上述用途归类，并补充索引链接。
2. 同一主题的小修复优先补充已有文档；只有独立主题或完整阶段需要时才新建文件，避免每次调整都新增一份报告。
3. 当前需求写入产品需求，开发状态写入实施计划，设计取舍写入架构或决策，执行证据写入对应模块的验证记录。
4. 文档之间使用相对 Markdown 链接；移动文件时检查仓库首页、示例、开发规范和配置中的引用。
5. 移动许可文档时同步 Tauri 资源配置；安装包内的 `THIRD_PARTY_NOTICES.txt`、`DEPENDENCY_INVENTORY.md` 名称保持稳定。

返回[项目首页](../README.md)。
