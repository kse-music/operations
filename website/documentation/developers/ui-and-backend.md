---
title: UI 与 WASM 协作
description: 理解页面动作、WASM 业务和平台原语的职责，并按正确边界处理状态、取消和错误。
---

# UI 与 WASM 协作

## 保持完整业务在插件内

Vue 页面负责展示与交互，WASM 后端负责自己的业务动作。命令、SQL、参数校验、解析、规则和提示词由插件维护；宿主提供通用 SSH / SFTP / 模型传输、权限、审批和资源管理。

SDK 没有 Docker、MySQL 或 AI 助手专属业务接口。增加一种服务插件，优先使用已有通用能力，不修改宿主为插件 ID 设置特权分支。

## 页面调用本包动作

在下载包的问候示例中，前端通过公开客户端调用已声明动作：

```ts
import { invoke } from '@serverdeck/plugin-sdk';

const result = await invoke<{ output: string }>('greet', {
  name: 'ServerDeck',
});
```

这个例子依赖样例后端已实现 `greet` 并返回 `output`。调用名和业务 DTO 由插件自己定义；精确初始化与响应契约见 [SDK 参考](/developers/reference/sdk.html)。

前端入口从 `@serverdeck/plugin-sdk/runtime` 导入并调用 `mountPlugin(App)`。SDK 完成就绪通知、MessageChannel 连接确认和可信上下文接收后才挂载，不要在握手前自行调用平台。独立 Vue UI 经认证的消息通道进入当前包的 WASM 动作，不能直接访问父页面 Store、任意 Tauri IPC 或认证材料。

业务操作确认可通过 `invoke(action, input, { confirmation: { title, message, confirmLabel } })` 提供易懂的纯文本说明。例如停止容器时说明容器名称和中断影响。宿主仍显示原生取得的真实目标并绑定完整命令；这些文本不能授权、替换目标或传给 WASM，字段限制见 [UI 契约](/developers/reference/ui.html)。

## 正确呈现业务状态

页面需要区分未加载、加载、成功空结果、成功有数据、失败和已取消。失败保留真实错误及重试入口，未知数据不能显示成零，变更完成后需要读取实际结果复查。

输入参数在业务动作边界校验，异步操作提供明确取消路径。技术错误在适当边界记录或继续传播，不静默吞掉，也不要在多层重复记录敏感正文。

模型文本流和显示进度使用 SDK 的 `streaming` 平台请求与 Vue `progress` 客户端。句柄绑定原 owner / VM，工具仍独立授权和审批；先在 WASM 解析并脱敏，再发布显示片段，完整结果校验前不能执行计划。配额与取消规则见 [SDK](/developers/reference/sdk.html#模型流与文本进度)。

## 管理资源与草稿

每个打开页面有独立 owner，资源绑定插件、安装修订和 VM 代。默认隐藏会关闭流和 PTY；仅宿主明确保留的工作区可以在既有授权范围内继续声明任务，新的确认仍等待页面可见。

关闭页面、撤权或升级时清理所属资源。未保存内容应报告草稿状态并在关闭前审核，不因为切页而擅自提交。完整生命周期以 [UI 契约](/developers/reference/ui.html)为准。

## 助手 Skill 资源

本节针对 AI 运维助手自身的资源扩展；普通插件不会因放入 `skills/` 目录就自动获得工具或权限。

在助手源码的 `skills/<name>/SKILL.md` 中编写 `name`、`description` 及使用说明，需要时添加 UTF-8 参考资源，再重新构建插件。名称与目录保持一致，使用小写字母、数字和单横线；描述可使用单行字符串或缩进多行文本，不依赖完整 YAML 语义。

构建自动扫描资源目录。初始请求只提供名称及用途，模型通过 `skill_read` 按需读取正文与相对资源，工具目录仍随每次推理发送。当前最多 32 个 Skill，每个最多 128 项资源，单项 32 KiB、总量 256 KiB；链接、重解析点和非法路径拒绝。

脚本资源只作为文本读取；要执行仍需通过普通命令工具和相同审批，不能用 `allowed-tools` 或元数据增加权限。修改资源后重新构建即可，无需增加 Rust 问题分支。当前没有运行时安装、Skill 管理页或 MCP 接入。调试时验证按需读取和越界路径拒绝，不把资源文本当作用户授权。
