# 系统内置标准插件

## 当前范围（2026-11-05）

系统分发三个独立标准 WASM 插件。资源监控、进程与端口、systemd 服务、日志查看、网络诊断合并为“系统服务”；Docker 管理和 AI 运维助手独立保留。自动运维与批量运维继续移除。

| 插件 ID                       | 独立源码                   | 功能        | 预置权限                                                                                                 |
| ----------------------------- | -------------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `cn.hiboot.plugins.services`  | `plugins/system/services`  | 系统服务    | `ui.contribute`, `system.read`, `system.manage`, `metrics.read`, `logs.read`, `sftp.read`, `network.run` |
| `cn.hiboot.plugins.docker`    | `plugins/system/docker`    | Docker 管理 | `ui.contribute`, `system.read`, `system.manage`                                                          |
| `cn.hiboot.plugins.assistant` | `plugins/system/assistant` | AI 运维助手 | `ui.contribute`, `assistant.use`                                                                         |

三个包版本为 1.2.0，要求 Host API ^2.1.0，Rust SDK 与前端 SDK 均为 2.1.0。WASM ABI/wire/包格式/manifest schemaVersion 仍为 1，UI 为 v4；保留旧能力和兼容 UI。见[API 版本策略](PLUGIN_API_VERSIONING.md)。

“系统服务”只有一个插件身份和功能贡献，页内五分类支持键盘方向键。资源监控内含概览/磁盘/网络，进程内含监听端口。页签采用按需挂载的有界缓存；切换保留输入，隐藏时暂停监控/列表/诊断轮询并停止日志流，已读日志继续保留。进入系统服务仍使用当前主机，不重复选择主机。全局搜索和任务中心的网络诊断定位到同一插件的诊断分类，本机模式无需连接主机，其余主机分类在该全局页面中不可用。

Docker 采用容器/镜像分类、从真实列表计算的状态摘要、精简列和分组操作；CPU/详情/日志/Shell、危险操作目标确认保留。AI 采用主对话区、可收起上下文、固定输入区和问题建议；建议只填写草稿，发送/授权/命令审批保持原机制。

## 使用入口

顶部仅保留主机运维、资产管理和设置，不再提供独立运维工具模块。设置中的插件管理统一提供安装、升级、卸载及全部安装身份的详情、启停、权限和配置，包含禁用、未授权或无功能页面的包。插件功能从当前主机工作区 SSH/SFTP 右侧“工具”菜单进入，仅列启用且有功能页面的插件，固定当前主机，不重复选择主机；功能页“插件设置”打开同一设置标签，返回设备标签保留功能及草稿。全局搜索可打开 AI 与网络诊断，相关工作区归属主机运维；网络来源、诊断目标与 AI 跨主机分析仍按各自用途明确选择。

每台主机保留一个设备标签，按插件/贡献/主机缓存页面、草稿与结果。隐藏时停止交互及日志、释放 WASM VM，返回时重新绑定并激活，准备完成后才开放界面。草稿仅保留在当前运行内；旧资源句柄须重新获取，已提交网络诊断任务由宿主管理。任务中心仅保留文件传输和网络诊断，停用插件不静默取消已提交的诊断。

## 源码、构建和加载

每个 `plugins/system/<name>` 拥有 frontend、backend、manifest、UI JSON、测试和独立 Cargo.lock。公开 TypeScript/Vue SDK 提供共享状态、能力客户端和公共 UI；宿主只保留原生基础服务、管理和权限桥。

执行 `npm run plugins:build`，或 `node tools/build-plugin.mjs plugins/system/docker .local/docker.sdplugin`，使用与上传包相同的编译和打包器生成 WASM/UI/JS/CSS 与摘要。标准发行资产位于 `plugins/system/packages/*.sdplugin`。宿主验证安装代、授权和摘要后将包内 JS/CSS 加载到不透明来源 iframe，禁止直接访问父 DOM、原生 IPC 和外部网络。

AI 与系统服务中的网络 ToolInvoke 经不可变单次票据、真实 WASM、Host 类型化能力与原有审批执行；Guest 不取得模型 Key、私有 SSH 租约或任意 IPC 名称。服务器插件使用 SDK 公共监控、系统查询、日志和容器终端能力；危险操作继续核对目标和确认。主机密钥、连接配置一致性、取消、速率、资源配额和失败诊断保持。

旧 UI v1 表单和 v2/v3 的保留工具继续兼容，组合服务器兼容源在 `plugins/compat/server/frontend`。插件图标仍从 manifest.icon 读取，三个标准包各自声明；上传同样支持，未指定或未知名称使用 boxes。

## 升级、旧数据与存储

旧 resources/processes/logs/network 的 system 记录（含旧域名）在启动时归档，原 payload/设置不删除；同 ID 的上传源不归档。services 沿用自己的启停、设置与卸载选择，不猜测或覆盖原四个插件的配置。

版本升级只更新较低版本的 system 安装，复用标准仓库和备份，保留启停、设置、卸载墓碑及上传源；同版本不重装，也不降级。预置权限只读，上传权限仍需显式授权。所有插件适用于所有主机，实际使用时绑定入口主机；不会自动提权。

启动时在读取新 SDK 元数据前，将两个已删除内置身份（含旧域名）和声明已移除权限的旧安装记录原子移至 `plugins/retired/<id>-removed-<uuid>`，不再注册或允许激活。记录、payload、配置和既有数据库历史不清空，不重启旧计划；依赖这些已删除接口的上传包需修改后重新安装。新安装不能重新注册两个已删除内置身份。该归档兼容代码不包含调度或执行实现。

Windows 默认仓库在 `%APPDATA%/cn.hiboot.desktop/plugins`：system 为系统包，upload 为上传内容，packages 保存当前安装记录，data 保存插件设置。仓库源码 `plugins/upload` 与应用安装仓库不同，不被启动扫描。应用身份迁移仍沿用既有安全目录检查，不覆盖已有新目录或用户上传包。

## 验证边界

本轮三插件/五分类真实 SSH、旧记录归档、接口拒绝、草稿和权限回归见[插件验证记录](../validation/plugins/PLUGIN_TEST_REPORT.md)。不将历史九插件测试记录当作当前功能范围；跨平台、签名安装器和长期运行仍需各自验收。
