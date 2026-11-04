# 插件开发与本地安装

## 工作区工具插件

AI 助手、批量运维、自动运维和网络诊断位于 plugins/system 的独立目录，只依赖公开 SDK；例如 `node tools/build-plugin.mjs plugins/system/assistant .local/assistant.sdplugin`。公开 UI v3 和工具能力对上传包同样开放，完整契约、权限及宿主职责见 [内置插件](BUILTIN_PLUGINS.md)。上传目录只保留真实 Nginx Manager，四个测试包源码移到 tests/fixtures/plugins；构建这些夹具必须传显式目录，简名仍仅查找 plugins/upload。

九个内置系统插件也是独立标准 WASM 包，源码位于 plugins/system，使用本文相同的构建/安装/授权流程。公开服务器能力和 UI v2 对上传包同样开放；来源由宿主记录，见 [BUILTIN_PLUGINS.md](BUILTIN_PLUGINS.md)。

平台 SDK 1.2.0，API wire version=1（继续兼容 ^1.0.0）；包 formatVersion=1、manifest schemaVersion=1，UI 支持 v1 表单、v2 标准服务器视图和 v3 工作区工具。当前只支持显式确认的未签名本地开发包，不存在在线市场或可信官方签名发行流程。官方示例代码也显示来源未验证。

## 构建公开 SDK 示例

需要稳定 Rust、`wasm32-unknown-unknown` 目标、Node 22+；按环境先安装目标与获取锁定依赖。示例是独立 Cargo workspace，只依赖公开 `serverdeck-plugin-sdk` 与其公开 serde 类型，不依赖 application/core/Tauri 内部 IPC。

```powershell
rustup target add wasm32-unknown-unknown
node tools/build-plugin.mjs tests/fixtures/plugins/host-info .local/host-info.sdplugin
node tools/build-plugin.mjs nginx-manager .local/nginx-manager.sdplugin
node tools/build-plugin.mjs plugins/system/docker .local/docker.sdplugin
npm run plugins:build
```

打包输出必须不存在且位于源目录外。构建脚本使用 --offline --locked；新环境先通过 Cargo 正常获取示例 Cargo.lock 对应依赖。`.local/plugin-build` 保存独立 WASM 构建缓存及临时打包输入，不进入产品目录。打包工具只包含 manifest、backend.wasm、ui.json；摘要由工具生成，安装端重新验证。

Host Info 演示主机脱敏信息、只读 uname、独立设置和五种贡献点。早期 hello-world 是生命周期测试，diagnostics 是公开 SDK 能力集成测试，不冒充实际业务。自定义插件参考其 manifest/backend/ui 文件及 [PLUGIN_SDK.md](PLUGIN_SDK.md)、[PLUGIN_UI_EXTENSION.md](PLUGIN_UI_EXTENSION.md)。

Nginx Manager 为独立业务插件，详见 `plugins/upload/nginx-manager/README.md`。真实 Linux 检测、32 KiB 单文件编辑/原子保存/冲突、nginx -t、显式重载和有限日志均通过公开 SDK 完成；主程序没有 Nginx 业务分支。验证/重载对具体命令和路径单次确认，保存/参数/主机/配置摘要变化后需重新验证。非 systemd、未安装或权限不足展示真实失败信息；不自动提权。公开协议和 package schema 未因该业务插件新增私有接口。

## 桌面安装流程

“设置 → 插件管理” → 拖入一个 .sdplugin 文件或点击“选择插件包” → 弹窗核对身份/权限/摘要 → 明确接受未验证包 → 安装。没有手工路径输入；默认禁用且未授权。拖放复用 Tauri 原生文件事件，Rust 仍重新验证普通文件、包大小、摘要和预览绑定。

顶部“运维工具”侧栏只显示已安装插件，不显示来源或管理入口。点击任意插件可进入自己的页面，即使未启用、未授权或没有 UI 贡献；来源、启停、权限和目录范围在该页的“插件设置”。已授权功能页可返回设置，其他声明页面通过页内选择器进入。管理列表只有卸载操作。终端右上角 SFTP 右侧“工具”下拉菜单按插件名称显示已启用项，点击在当前主机打开，未启用项不显示。配置页与管理页铺满工作区可用宽度。语言统一使用全局偏好，目前完整界面仅简体中文，SDK 双语契约保留。

全部插件无需选择允许访问的主机，启用并具备对应能力后适用于所有已登记主机，使用时选择当前目标并连接。上传插件仍在自己的设置页授予清单内权限、具体操作和规范远程目录；内置系统分发包的声明权限、操作和所需目录由系统预置且不可修改，已有禁用选择保留。SSH 其他命令、文件写入及系统修改仍逐次确认，首次连接核验主机指纹；上传包不要为方便测试授予 `/` 写入范围。详见 [内置插件](BUILTIN_PLUGINS.md)。

安装更高版本时提示旧版本并保留备份，全部授权失效，升级后需重新授权并启用。包变化/非法版本拒绝且保留已安装代。禁用、撤权会停止调用/流；卸载默认保留本地设置，另有明确清理选择；均不会删除远程服务器配置或日志。

升级会先明确确认停止插件资源和放弃未保存内容；取消保持编辑不变。提交失败恢复旧安装代/授权和能力门控，旧页面重新打开后绑定连接；不会恢复已被明确放弃的草稿或后台任务。错误通过现有通知显示，不用旧版本元数据伪装升级成功。

## 开发契约与验证

WASM ABI、受控 API、取消/配额/错误码见 [PLUGIN_RUNTIME.md](PLUGIN_RUNTIME.md)、[PLUGIN_SDK.md](PLUGIN_SDK.md)。业务操作逐次使用真实 Host 响应；非零退出、权限拒绝、取消、超时、断线、冲突必须保留原因，不得伪装通过。内部 Host 响应只通过保留 Resume 操作返回，普通 UI payload 不能伪造。

Windows 本地自动化：`cargo test --workspace`、前端 test/typecheck/build/lint；隔离 Linux SDK 验证使用 `tools/plugin-test-host/test.ps1`。真实桌面 UI 使用 `-Mode ui`，会构建任务专用 Tauri 客户端、创建全新独立数据目录及无宿主挂载的临时容器，测试结束清理其 OS 凭据与容器，不读取用户主机配置。Docker 镜像准备、环境调整、真实执行结果与平台范围见 [PLUGIN_TEST_REPORT.md](../validation/plugins/PLUGIN_TEST_REPORT.md)。用户服务器不作为开发测试目标。

项目真实上传业务源码位于 plugins/upload，协议测试夹具位于 tests/fixtures/plugins，旧空 examples/plugins 已删除，客户端安装内容位于应用数据目录 plugins/upload/<ID>/versions；旧路径自动迁移且授权/配置保持不变。内置源码/内容分别位于项目 plugins/system 和应用数据目录 plugins/system，完整迁移边界见 [BUILTIN_PLUGINS.md](BUILTIN_PLUGINS.md)。
