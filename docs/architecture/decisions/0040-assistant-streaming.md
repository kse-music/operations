# ADR 0040：助手流式回答

日期：2026-11-11。状态：已实施。

## 背景与选项

用户明确要求边生成边显示。此前model_complete请求stream=false，助手在整轮完成后统一显示。仅做前端打字动画不能改善等待；直接把模型原始JSON送入界面会绕过插件脱敏；让UI读取排队中的动作结果会被在途Guest阻塞。

## 选择

- SDK5.4增加通用model_start/poll/close和progress_open/publish/read/close，沿用models.use与ui.contribute，不给Native加入助手协议解释器。模型保留原凭据/修订及本地CLI隔离，进度不代表批准。
- Native接收远程SSE、本地Codex和Claude文本增量，用有界通道交给原WASM动作。WASM逐片解析顶层可见字符串、处理转义/代理对，复用Redactor且暂留未完成词和自定义秘密前缀，再发布文本进度。未结束或异常响应不能生成可执行计划。
- Native进度只保存当前有界文本和修订，UI通过原owner的控制通道增量读取，不被Guest队列阻塞。完成后一次替换最终结果；停止/异常保留片段及状态，片段不进入历史。切换/关闭立即停止读取，迟到响应丢弃，不等待旧读阻塞会话。
- 普通平台请求仍限96次，模型轮询/进度发布单独限1024次，两个计数在批准续接中保留；动作180秒、fuel/内存、原审批与取消边界保持。资源在关闭owner/撤权/停止/升级时取消并等待收尾；不持久化、无数据库或配置迁移。

## 后果与验证

助手2.5.0声明Host/Rust/Vue SDK ^5.4.0，ABI/wire1、UI4和现有model_complete保持。网络或提供方不支持流式时明确失败，不自动重试或假装流式；本地来源是否实际输出增量取决于安装CLI支持，最终成功仍以完成事件/退出状态为准。完整协议和配额见[SDK](../../plugins/PLUGIN_SDK.md#模型流与文本进度54)。

接口依据为[OpenAI流事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)、[Codex文本增量](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)、[Claude部分消息](https://code.claude.com/docs/en/agent-sdk/streaming-output)。本次没有迁移模型、账号登录或运行真实计费请求。验证见[助手流式回答](../../validation/ai/VALIDATION_ASSISTANT_CHAT.md#2026-11-11-助手流式回答)。
