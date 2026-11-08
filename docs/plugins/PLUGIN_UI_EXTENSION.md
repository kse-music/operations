# 插件 UI v4

平台尚未正式发布，目前仅支持 UI v4。UI v1–v3 的宿主表单、标准视图兼容资源和前端回退已删除。插件必须自带前端，内置和上传包使用同一套构建、摘要校验、iframe、SDK 桥和 WASM 授权链路。

## UI v4：包内独立界面

清单要求 Host API `^4.0.0`，`entry.ui` 指向 JSON 声明。`ui.json` 必须提供 `uiVersion:4`、title、pages 和 `frontend:{script:"frontend.js",style:"frontend.css"}`。每页必须有唯一 id、title、fields、actions 和 surface；log/initialAction 为空，页面初始化和日志展示由插件前端负责。

| surface      | 用途与限制                                                        |
| ------------ | ----------------------------------------------------------------- |
| `frontend`   | 自定义页面，自行声明 WASM actions 和输入字段                      |
| `operations` | Docker 标准语义，sections 为 containers/images 的非空且不重复子集 |
| `tool`       | assistant 标准语义，工具类型必须与 Manifest 贡献一致              |

operations/tool 的 fields 为空、actions 只有 bridge。全部有界面插件必须有 WASM 后端；贡献与页面 ID 及标准语义匹配。JSON 拒绝未知字段，动作/字段拒绝原型键和超限输入；JS/CSS 入口必须是包内已校验的普通文件，不接受 URL、绝对路径或目录穿越。

前端入口使用公开 SDK：

```ts
import { mountPlugin } from '@serverdeck/plugin-sdk/runtime';
import App from './App.vue';
import '@serverdeck/plugin-sdk/ui/base.css';
mountPlugin(App);
```

使用 `invoke(action, values)` 调用当前页面声明的自身 WASM 动作，使用 SDK 的公开客户端访问获授权的宿主服务。源码不能导入 desktop、其他插件或 Tauri；构建器只允许本包、公开 SDK 和普通第三方依赖。Host Info 和 custom-ui 示例都包含自己的前端。

## 页面隔离与上下文

PluginFrame 只加载当前包声明的入口；宿主提供可信 HTML 壳，不代供业务前端。脚本运行于无 same-origin 权限的 sandbox iframe，通过绑定实际 frame、插件和安装代的 MessageChannel 调用白名单桥。资源协议每次复验启用、授权、安装代、页面和摘要。危险操作必须由可信宿主从冻结的真实输入生成批准，插件自己的确认或 confirmed 字段不能成为授权依据。详见[安全边界](PLUGIN_SECURITY.md#ui-v4-的页面隔离与原生能力)。

主机功能由宿主传入固定 hostId，无上下文入口由宿主选择一次主机。settings 贡献在无主机上下文的配置弹窗展示。页签通过持续挂载/隐藏保留插件自己的状态、草稿和结果，宿主不保存旧声明式表单草稿。

普通插件隐藏时收到 visible:false，停止交互和轮询并释放原生资源；恢复后重新绑定与获取不透明句柄，旧请求不能自动重试。内置 System 助手已开始的匹配、查询、回答及已批准执行归属工作区，隐藏后允许必要续接，关闭所属工作区才停止；隐藏页不能发起新的执行审批。上传同 ID 包不获得该例外。禁用、撤权、升级、卸载继续撤销资源。

## 界面与字号

SDK 提供主题及 `ui/base.css`。当前宿主推送 interfaceFontScale（0.95、1、1.15、1.3、1.45），SDK 更新 iframe 根节点的字号变量，不重挂载界面。辅助信息、正文、分组、弹窗标题和页面标题基数为 12/14/16/20/24px。基础组件和样式可以复用，自有硬编码字号由插件作者维护。

## 验证

SDK/包校验覆盖当前 UI、旧版本拒绝、资源路径与摘要、声明动作及权限边界。原生隔离、真实 WASM、SSH 和平台范围以[插件验证记录](../validation/plugins/PLUGIN_TEST_REPORT.md)为准；历史记录描述当时版本，不代表当前继续提供旧协议。
