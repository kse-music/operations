# ServerDeck 文档

文档以当前产品和实现为基线，按用途直接维护。

## 阅读入口

| 用途               | 文档                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 了解产品功能与边界 | [产品基线](product/PRD.md)                                                                                                                   |
| 安装和日常使用     | [使用说明](guides/USER_GUIDE.md)、[AI 助手](guides/AI_ASSISTANT.md)                                                                          |
| 理解实现           | [总体架构](architecture/ARCHITECTURE.md)、[助手工具与任务](architecture/ASSISTANT_AGENT.md)、[数据升级契约](architecture/DATA_MIGRATIONS.md) |
| 开发和安装插件     | [开发指南](plugins/PLUGIN_DEVELOPMENT.md)、[公开 SDK](plugins/PLUGIN_SDK.md)                                                                 |
| 准备发布           | [发布检查表](release/RELEASE_CHECKLIST.md)、[更新分发](release/UPDATES.md)、[安全说明](release/SECURITY.md)                                  |
| 查看第三方许可     | [依赖清单](release/DEPENDENCY_INVENTORY.md)、[第三方声明](release/THIRD_PARTY_NOTICES.txt)                                                   |

## 插件规范

- [内置插件](plugins/BUILTIN_PLUGINS.md)：分发、管理和能力入口。
- [插件架构](plugins/PLUGIN_ARCHITECTURE.md)：业务与平台的职责边界。
- [开发与安装](plugins/PLUGIN_DEVELOPMENT.md)：独立开发包、目录、构建和安装。
- [包格式](plugins/PLUGIN_PACKAGE_FORMAT.md)：清单、载荷、摘要、路径和大小限制。
- [公开 SDK](plugins/PLUGIN_SDK.md)：平台原语、权限、审批、资源和错误契约。
- [运行时与 ABI](plugins/PLUGIN_RUNTIME.md)：WASM 导出、异步续接和执行限额。
- [版本约定](plugins/PLUGIN_API_VERSIONING.md)：当前版本与版本变更规则。
- [安全边界](plugins/PLUGIN_SECURITY.md)：授权、隔离、目标复验与取消。
- [UI 扩展](plugins/PLUGIN_UI_EXTENSION.md)：独立前端、通信、上下文和生命周期。

## 维护约定

1. 产品基线写当前功能、交互和限制；架构写实际模块、数据流、安全与生命周期；使用指南写可执行操作；插件文档维护公开契约；发布检查表维护验收步骤、待关闭条件和所需环境。
2. 修订对应主题正文，合并重复内容、删除失效说明。文档不记录逐次改动、阶段演进、旧方案或替代关系，不建立决策档案、实施流水和历史验证档案。重要设计理由直接写入当前架构或安全边界。
3. 当前功能以代码、类型和调用链为依据。接口变化同步 SDK、调用方、示例、测试和说明；精确契约只维护一处，其他文档引用链接。产品、SDK、插件和数据格式版本分别管理。
4. 数据升级契约是现行运行能力，须说明支持版本、事务、备份、失败和恢复规则；不得因文档整理删除迁移链或改变数据保护行为。
5. 发布检查表列出当前仍需验证的项目；没有针对候选产物实际执行的检查保持待验，不把代码存在或以前的测试结果当作当前发布通过。命令、环境、结果和限制随本次交付提供，原始输出留在隔离 QA/发布产物目录，不把执行流水写回产品文档。
6. 新文档按产品、指南、架构、插件或发布归类并更新本导航；按功能拆分，不按日期或每次改动建文件。使用相对链接，检查路径、标题锚点、入站引用和开发包包含的文档。
7. 许可文件及安装包中的 `THIRD_PARTY_NOTICES.txt`、`DEPENDENCY_INVENTORY.md` 名称保持稳定，资源配置与许可原文必须保留。

返回[项目首页](../README.md)。
