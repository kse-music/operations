# ServerDeck 文档

本目录维护产品研发基线、架构、源码开发、发布验收及公开插件契约。用户指南和开发者教程统一由官网独立项目维护，本仓库不保留教程副本。功能已实现、源码测试通过与候选产物发布验收分别判断。

## 阅读入口

| 用途           | 入口                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 了解产品       | [产品基线（PRD）](product/PRD.md)                                                                                                                   |
| 安装与日常操作 | [官网用户文档](https://ops.hiboot.cn/docs/)、[Docker](https://ops.hiboot.cn/docs/docker.html)、[AI 助手](https://ops.hiboot.cn/docs/assistant.html) |
| 本地开发与检查 | [开发、构建与验证](guides/DEVELOPMENT.md)、[开发规范](../AGENTS.md)                                                                                 |
| 理解实现       | [总体架构](architecture/ARCHITECTURE.md)及下方模块说明                                                                                              |
| 插件开发教程   | [官网开发者中心](https://ops.hiboot.cn/developers/)、[第一个插件](https://ops.hiboot.cn/developers/quickstart.html)                                 |
| 插件公开契约   | [源码与构建契约](plugins/PLUGIN_BUILD_CONTRACT.md)、[公开 SDK](plugins/PLUGIN_SDK.md)                                                               |
| 准备上线       | [发布门禁](release/RELEASE_CHECKLIST.md)、[原生验收](release/NATIVE_VALIDATION.md)、[更新分发](release/UPDATES.md)                                  |
| 安全与许可     | [安全说明](release/SECURITY.md)、[依赖清单](release/DEPENDENCY_INVENTORY.md)、[第三方许可原文](release/THIRD_PARTY_NOTICES.txt)                     |

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
- [源码与构建](plugins/PLUGIN_BUILD_CONTRACT.md)：源码布局、构建约束、产物与安装数据边界。
- [包格式](plugins/PLUGIN_PACKAGE_FORMAT.md)：清单、载荷、摘要、路径和大小限制。
- [公开 SDK](plugins/PLUGIN_SDK.md)：平台原语、权限、审批、资源和错误契约。
- [运行时与 ABI](plugins/PLUGIN_RUNTIME.md)：WASM 导出、异步续接和执行限额。
- [版本约定](plugins/PLUGIN_API_VERSIONING.md)：当前版本与变更规则。
- [安全边界](plugins/PLUGIN_SECURITY.md)：授权、隔离、目标复验与取消。
- [UI 扩展](plugins/PLUGIN_UI_EXTENSION.md)：独立前端、通信、上下文和生命周期。

## 维护约定

1. 产品基线写当前功能、交互和限制；架构写实际模块、数据流、安全与生命周期；本地开发指南写仓库研发与检查；插件文档维护公开契约；发布检查表维护验收要求。面向用户的操作指南及第三方插件开发教程只在官网维护，仓库 README、插件 README 和开发包 README 只提供对应入口。
2. 修订对应主题正文，合并重复内容、删除失效说明。文档不记录逐次改动、阶段演进、旧方案或替代关系，不建立决策档案、实施流水和历史验证档案。重要设计理由直接写入当前架构或安全边界。
3. 当前功能以代码、类型和调用链为依据。接口变化同步 SDK、调用方、示例、测试和本目录公开契约，并按 SDK 版本显式导入官网规范快照，审核教程的适用版本。公开契约原文以本目录为准，官网及独立开发包中的副本用于分发，不能分别手工改写。产品、SDK、插件和数据格式版本分别管理，单纯文档整理不改变执行协议或自动增加授权。
4. 数据升级契约是现行运行能力，须说明支持版本、事务、备份、失败和恢复规则；不得因文档整理删除迁移链或改变数据保护行为。
5. 发布检查表列出当前仍需验证的项目；没有针对候选产物实际执行的检查保持待验，不把代码存在或以前的测试结果当作当前发布通过。命令、环境、结果和限制随本次交付提供，原始输出留在隔离 QA/发布产物目录，不把执行流水写回产品文档。
6. 新研发文档按产品、源码开发、架构、插件契约或发布归类并更新本导航；按功能拆分。仓库文档间使用相对链接，对外教程使用官网公开 URL，不引用官网项目的本地目录。移动或改名后检查路径、标题锚点、入站引用、契约导入映射和开发包包含的文档；产品构建不依赖官网源码，官网构建不隐式读取产品源码。
7. 许可文件及安装包中的 `THIRD_PARTY_NOTICES.txt`、`DEPENDENCY_INVENTORY.md` 名称保持稳定，资源配置与许可原文必须保留。

返回[项目首页](../README.md)。
