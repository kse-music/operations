# ServerDeck 文档导航

按用途管理文档，当前说明按功能维护，重要决策和验证记录保留各自历史。阅读当前需求/实现时无需逐条判断日期记录是否已经失效。

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
- [13A 插件阶段历史](validation/plugins/PLUGIN_TEST_REPORT.md)：早期阶段的实现与验收证据；当前需求和执行状态以 PRD、SDK 和实施计划为准。

## 架构与决策：architecture

- [总体架构](architecture/ARCHITECTURE.md)：模块职责、数据流、接口和生命周期。
- [助手工具与任务](architecture/ASSISTANT_AGENT.md)：工具目录、文件预览/保存、双端传输、运行期任务及审批绑定。
- [数据库与配置升级](architecture/DATA_MIGRATIONS.md)：支持版本、事务与一致备份、失败恢复及后续迁移开发规则。
- [技术决策](architecture/DECISIONS.md)：按主题索引独立 ADR，标明有效、部分替代和退出范围的关系。
- [ADR 0001：SSH 候选库与密码学安全门禁](architecture/decisions/0001-ssh-crypto-gate.md)：独立决策记录。

## 使用指南：guides

- [使用说明](guides/USER_GUIDE.md)：安装、升级、主机连接、日常操作和备份。
- [AI 助手](guides/AI_ASSISTANT.md)：模型配置、主机关联、切页后台处理、工具目录、运行期任务及 SSH 查询/计划/确认执行/复查。

## 插件开发：plugins

- [系统内置插件](plugins/BUILTIN_PLUGINS.md)：内置 WASM 插件、源码目录自动发现与注册、平铺工具栏和预置权限。
- [架构](plugins/PLUGIN_ARCHITECTURE.md)
- [开发与本地安装](plugins/PLUGIN_DEVELOPMENT.md)
- [包格式](plugins/PLUGIN_PACKAGE_FORMAT.md)
- [运行时与 ABI](plugins/PLUGIN_RUNTIME.md)
- [公开 SDK](plugins/PLUGIN_SDK.md)：Rust 5.2 / Vue 5.2，插件源码边界与公共能力。
- [API 版本策略](plugins/PLUGIN_API_VERSIONING.md)
- [安全边界](plugins/PLUGIN_SECURITY.md)
- [插件 UI 扩展](plugins/PLUGIN_UI_EXTENSION.md)：当前 UI v4 独立前端、隔离与生命周期。

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

### 文档分工

| 文档                                                     | 应维护的内容                           | 更新方式                                              |
| -------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| `product/PRD.md`                                         | 当前有效需求、功能范围、验收要求       | 按功能直接修订，明确保留待实现需求，移除失效规则      |
| `architecture/ARCHITECTURE.md`                           | 当前模块、数据流、接口边界、生命周期   | 按模块合并更新，精确契约链接到专门文档                |
| `product/IMPLEMENTATION_PLAN.md`                         | 当前模块状态、剩余工作、阶段依赖和门禁 | 更新对应状态/缺口，链接证据，不复制每次构建和修复日志 |
| `architecture/DECISIONS.md` 与 `architecture/decisions/` | 重要设计取舍和替代关系                 | 索引按主题维护，一项重要决定一份短 ADR                |
| `validation/`                                            | 特定版本/环境下真实执行的检查和结果    | 按模块/主题保留历史，可使用日期/版本章节              |
| Git 历史                                                 | 逐次代码、文档变更                     | 通过提交和差异追溯，不在四份总览重写一遍              |

### 当前说明的更新

1. “更新相关文档”指修订对应章节，不要求每项改动都更新四份文档。只写受影响的需求、实现或状态，删除重复/失效描述，不能用顶部新条目覆盖旧正文。
2. PRD、架构和实施计划不按日期追加逐次变更，也不保留“下方仅为历史”“本节替代下文”等冲突兜底。发布日期/版本基线可以作为必要元数据，不能代替按主题组织正文。
3. 整理前核对现有实现及相关报告，区分已实现、待实现、已退出范围；保留未关闭需求和验收缺口，不以文档删减改变产品范围。必要历史先移至 ADR 或验证记录，保留原环境、限制和链接。
4. 同一事实由对应文档维护：需求归 PRD、状态归计划、精确契约归接口/SDK 文档，其他位置用简短说明和链接，避免多份内容漂移。接口变化同步 SDK、调用方、示例、测试和前端类型。

### 决策和验证历史

1. 仅影响架构、安全、数据、公开契约或长期维护成本的重要取舍建 ADR；普通修复、样式和例行测试不建。文件为 `architecture/decisions/<编号>-<主题>.md`，至少包含日期、状态、背景/选项、选择、后果及验证链接，索引按主题登记。
2. 已接受决策实质变化时新增替代 ADR，在旧记录标明已替代/部分替代及链接，保留原理由；普通勘误/链接修复可原位进行。历史决定不覆盖当前 PRD/架构/计划。
3. 验证按模块写入 `validation/` 并更新[索引](validation/README.md)，同一主题优先补充已有报告。保留版本、环境、命令、结果、失败、未执行项和证据路径；不能用旧版本/已移除功能的通过记录声明当前或全平台通过。
4. 实施计划只摘要状态、主要缺口及证据链接。固定历史归档不承接后续流水；新证据回到对应模块报告。

### 目录、拆分与检查

1. `docs/` 根目录只保留本导航，新增文档按用途归类并补充索引。同一主题的小调整原位修订，独立主题或完整阶段才新建；内容过大时按功能/模块拆分并保留简短总览，不按每日/每次改动拆文件。
2. 使用相对 Markdown 链接；移动或改标题时检查入站引用、锚点、仓库首页、开发规范、示例和配置。文档整理验证格式、本地路径/锚点、索引可达性、重复与失效描述；不需要为纯文档变更重跑业务构建。
3. 移动许可文档时同步 Tauri 资源配置；安装包内 `THIRD_PARTY_NOTICES.txt`、`DEPENDENCY_INVENTORY.md` 名称保持稳定。

返回[项目首页](../README.md)。
