# 验证记录索引

最新：[系统服务合并、Docker/AI 界面与三插件逐项验证](plugins/PLUGIN_TEST_REPORT.md#2026-11-05系统服务合并与界面优化)。

最新：[移除自动运维与批量运维，七插件逐项验证](plugins/PLUGIN_TEST_REPORT.md#2026-11-05移除自动运维与批量运维)。旧自动化/批量验收记录仅作历史证据，不代表当前仍支持这些工具。

当前功能范围、验收结果和已知缺口见[测试报告](TEST_REPORT.md)，当前开发状态见[实施计划](../product/IMPLEMENTATION_PLAN.md)。

以下记录按模块归档，保留各阶段的环境、命令、结果和限制；历史验收通过不表示后续版本或所有平台已经验证。

## 基础与配置

- [cn.hiboot 应用身份统一验证](foundation/VALIDATION_IDENTITY.md)
- [阶段一交付与验证记录](foundation/VALIDATION.md)
- [主机、凭据与配置导入导出阶段验收](foundation/VALIDATION_STAGE2.md)

## 主机与目录

- [点击主机直接连接 Shell 验收](hosts/VALIDATION_HOST_CLICK_CONNECT.md)
- [主机总数徽标位置验收](hosts/VALIDATION_HOST_COUNT.md)
- [侧栏主机跨组拖动验收](hosts/VALIDATION_HOST_DRAG.md)
- [主机优先布局验证（2026-11-03）](hosts/VALIDATION_HOST_FIRST_LAYOUT.md)
- [主机管理列表精简验收](hosts/VALIDATION_HOST_INVENTORY.md)
- [主机列表操作入口调整验收](hosts/VALIDATION_HOST_LIST_ACTIONS.md)
- [主机行操作精简与悬停显示验收](hosts/VALIDATION_HOST_ROW_ACTIONS.md)
- [移除侧栏主机菜单验收](hosts/VALIDATION_HOST_SIDEBAR_MENU.md)
- [顶栏精简与主机树收缩入口验收](hosts/VALIDATION_HOST_SIDEBAR_TOGGLE.md)
- [工作区主机树 CRUD 验收](hosts/VALIDATION_HOST_TREE_CRUD.md)
- [根目录、多级文件夹和主机右键菜单验收](hosts/VALIDATION_HOST_TREE_FOLDERS.md)
- [主机工作区布局验收](hosts/VALIDATION_HOST_WORKSPACES.md)
- [主机名称可选验收](hosts/VALIDATION_OPTIONAL_HOST_NAME.md)
- [移除主机栏标题文字验收](hosts/VALIDATION_REMOVE_HOST_HEADING.md)
- [主机管理移除标签、备注和收藏验收](hosts/VALIDATION_REMOVE_HOST_METADATA.md)

## SSH 与终端

- [SSH / SFTP 技术验证与暂定决策](terminal/SSH_TECH_VALIDATION.md)
- [终端顶部紧凑布局验收](terminal/VALIDATION_COMPACT_TERMINAL_HEADER.md)
- [移除会话菜单“关闭其它”验收](terminal/VALIDATION_REMOVE_CLOSE_OTHERS.md)
- [会话栏精简与复制会话验证（2026-11-03）](terminal/VALIDATION_SESSION_TAB_DUPLICATE.md)
- [终端会话标签菜单验证（2026-11-03）](terminal/VALIDATION_SESSION_TAB_MENU.md)
- [SSH 日常使用增强验收](terminal/VALIDATION_SSH_USABILITY.md)
- [SSH 与交互式终端验收](terminal/VALIDATION_STAGE3.md)
- [终端快捷复制粘贴验收（2026-11-02）](terminal/VALIDATION_TERMINAL_CLIPBOARD.md)
- [移除终端窗格常驻栏验收（2026-11-02）](terminal/VALIDATION_TERMINAL_CONTEXT_MENU.md)
- [ZMODEM rz 上传验证（2026-11-03）](terminal/VALIDATION_ZMODEM.md)

## SFTP 与文件

- [SFTP 权限与拥有者显示验收](files/VALIDATION_SFTP_METADATA.md)
- [SFTP 文件管理阶段验收](files/VALIDATION_STAGE4.md)

## 监控与磁盘

- [桌面虚拟挂载容量误报修复（2026-11-03）](monitoring/VALIDATION_DESKTOP_MOUNTS.md)
- [磁盘容量误报修复（2026-11-03）](monitoring/VALIDATION_MONITOR_MOUNT_NOTICE.md)
- [Agentless Linux 监控阶段验收](monitoring/VALIDATION_STAGE5.md)

## 运维、网络与自动化

- [运维自动化验收](operations/VALIDATION_AUTOMATION.md)
- [常用模板折叠抽屉验证（2026-11-03）](operations/VALIDATION_AUTOMATION_TEMPLATE_DRAWERS.md)
- [网络诊断与多服务器批量运维验收](operations/VALIDATION_NETWORK_BATCH.md)
- [Linux 运维阶段验收](operations/VALIDATION_OPERATIONS.md)
- [服务器管理整合验证（2026-11-03）](operations/VALIDATION_SERVER_MANAGEMENT.md)

## 工作区与交互

- [主机上下文一致性验收](workspace/VALIDATION_CONTEXT.md)
- [错误提示统一验收](workspace/VALIDATION_ERROR_NOTIFICATIONS.md)
- [主机交互与本地终端验收](workspace/VALIDATION_INTERACTIONS.md)
- [页面布局调整验收](workspace/VALIDATION_LAYOUT.md)
- [顶部模块与左侧菜单验证（2026-11-03）](workspace/VALIDATION_MODULE_NAVIGATION.md)
- [顶部模块不自动打开默认菜单（2026-11-03）](workspace/VALIDATION_MODULE_SELECTION.md)
- [禁用系统右键菜单验收](workspace/VALIDATION_NATIVE_MENU.md)
- [产品整合与交互验收](workspace/VALIDATION_PRODUCT.md)：含 2026-11-04 任务中心恢复底部弹窗的回归与布局验证。
- [移除标签栏本地工作区按钮验收](workspace/VALIDATION_REMOVE_LOCAL_WORKSPACE_BUTTON.md)
- [设置导航与关于页面合并验证](workspace/VALIDATION_SETTINGS_NAVIGATION.md)
- [全局设置分类 Tab 验收（2026-11-02）](workspace/VALIDATION_SETTINGS_TABS.md)
- [一级工作区标签右键菜单验收](workspace/VALIDATION_WORKSPACE_TAB_MENU.md)

## 模型与 AI 助手

- [AI 运维助手验证记录](ai/VALIDATION_AI_ASSISTANT.md)
- [助手直接对话验证](ai/VALIDATION_ASSISTANT_CHAT.md)
- [助手自动关联主机验证](ai/VALIDATION_ASSISTANT_HOSTS.md)
- [AI 运维助手布局验证](ai/VALIDATION_ASSISTANT_LAYOUT.md)
- [模型管理验证记录](ai/VALIDATION_MODEL_MANAGEMENT.md)
- [模型注册测试及界面验证](ai/VALIDATION_MODEL_TEST.md)

## 插件系统

- [插件阶段验证记录](plugins/PLUGIN_TEST_REPORT.md)：含 2026-11-05 取消顶部运维工具、配置统一归属设置及四布局回归；保留配置入口/请求循环/缓存 VM/九插件真实 SSH，以及插件使用统一、主机草稿隔离、系统包升级、源码归属/UI v4/SDK 边界、图标、上传安装和旧夹具清理的历史证据。

维护时优先更新同一主题的记录；新增独立记录后在对应模块补充链接。构建产物、截图和原始日志继续使用项目约定的 `.local/` 目录，不迁入文档目录。

返回[文档导航](../README.md)。
