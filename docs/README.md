# ServerDeck 文档

文档以当前代码和真实产品入口为基线，按用途维护。本文是统一导航；功能已实现、源码测试通过与候选产物发布验收分别判断。

## 阅读入口

| 用途           | 入口                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 了解产品       | [产品基线（PRD）](product/PRD.md)                                                                                               |
| 安装与日常操作 | [使用说明](guides/USER_GUIDE.md)、[Docker](guides/DOCKER.md)、[AI 运维助手](guides/AI_ASSISTANT.md)                             |
| 本地开发与检查 | [开发、构建与验证](guides/DEVELOPMENT.md)、[开发规范](../AGENTS.md)                                                             |
| 理解实现       | [总体架构](architecture/ARCHITECTURE.md)及下方模块说明                                                                          |
| 开发和安装插件 | [插件开发指南](plugins/PLUGIN_DEVELOPMENT.md)、[公开 SDK](plugins/PLUGIN_SDK.md)                                                |
| 准备上线       | [发布门禁](release/RELEASE_CHECKLIST.md)、[原生验收](release/NATIVE_VALIDATION.md)、[更新分发](release/UPDATES.md)              |
| 安全与许可     | [安全说明](release/SECURITY.md)、[依赖清单](release/DEPENDENCY_INVENTORY.md)、[第三方许可原文](release/THIRD_PARTY_NOTICES.txt) |

## 架构模块

- [桌面工作区与设置](architecture/DESKTOP.md)：窗口、导航、偏好、语言和页面生命周期。
- [主机连接、凭据与终端](architecture/CONNECTIONS_TERMINALS.md)：主机目录、SSH 信任、路由、PTY、本地会话和上传协议。
- [文件、传输与编辑](architecture/FILES.md)：SFTP 身份、校验提交、系统拖放、回收站和独立编辑器。
- [Docker 插件实现](architecture/DOCKER.md)：业务职责、Compose、详情与列表缓存、日志及镜像传输。
- [助手工具与运行期任务](architecture/ASSISTANT_AGENT.md)：模型协议、审批、任务、局部文件修改、跨工具资源和 Skill。
- [数据库与配置升级](architecture/DATA_MIGRATIONS.md)：当前格式、全部支持版本、迁移链、备份和失败/恢复规则。

## 插件规范

- [内置插件](plugins/BUILTIN_PLUGINS.md)：分发、入口、管理和能力边界。
- [插件架构](plugins/PLUGIN_ARCHITECTURE.md)：业务与平台职责及资源归属。
- [开发与安装](plugins/PLUGIN_DEVELOPMENT.md)：独立开发包、目录、构建和安装。
- [包格式](plugins/PLUGIN_PACKAGE_FORMAT.md)：清单、载荷、摘要、路径和大小限制。
- [公开 SDK](plugins/PLUGIN_SDK.md)：平台原语、权限、审批、资源和错误契约。
- [运行时与 ABI](plugins/PLUGIN_RUNTIME.md)：WASM 导出、异步续接和执行限额。
- [版本约定](plugins/PLUGIN_API_VERSIONING.md)：当前版本与变更规则。
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
