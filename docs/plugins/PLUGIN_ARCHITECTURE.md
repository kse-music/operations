# 插件架构

当前契约为 Host/Rust/TS SDK5、UI4、ABI/wire1。插件以独立 Vue UI + WASM 后端提供完整业务，内置与上传使用相同运行、审批和资源边界。

```text
插件 Vue 页面 → authenticated MessageChannel → 可信 UI 桥
  → 本包声明 action → 本包 WASM async Runtime
  → Platform request → Native 权限/目标/审批/配额
  → 通用 SSH、SFTP、模型、配置等 → 同一 Future 续接 → 插件解析与展示
```

SDK只有平台 DTO/客户端、async 续接、通用 UI/生命周期。Docker命令/环境变量策略在Docker插件；MySQL查询及巡检规则在外部插件；助手提示词、脱敏、资产匹配、工具循环和变更计划在助手插件。Native不识别这些动作，不按插件ID提供业务后门。

宿主私有功能可以继续复用自身 Operations/Monitor 等服务；它们不作为插件公开领域接口。平台层负责连接凭据、SSH主机指纹、文件提交、模型提供者传输、真实目标确认和资源归属，不选择业务命令或组装业务提示词。

一个安装修订共享有界VM；每个打开页面具有可信owner。平台资源绑定插件/安装代/VM代/owner，目标额外绑定SSH配置或模型修订；关闭一个owner不会取消其他页面。原生审批保存原WASM请求，批准或拒绝后原地续接，不重新调用动作开头。

源码扫描自动发现 `plugins/system/<dir>`；发布产物仍使用统一校验/仓库导入。新增服务插件只增加目录或上传包，不修改SDK/宿主。详细请求、限额与生命周期见[SDK](PLUGIN_SDK.md)和[安全边界](PLUGIN_SECURITY.md)。
