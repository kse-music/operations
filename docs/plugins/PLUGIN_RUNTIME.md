# 隔离运行时 v1

当前 Host API 4.0 同时支持独立前端 UI v4；页面使用浏览器 sandbox/MessageChannel，后端继续使用本文的 Wasmi ABI 和配额。WASM 的 fuel/线性内存限制不覆盖 JS 页面执行，不能将两层保障混为一谈。界面加载与兼容策略见[UI 协议](PLUGIN_UI_EXTENSION.md)，安全和原生验收边界见[安全文档](PLUGIN_SECURITY.md)。

13A-2 使用 Wasmi 1.1.0（MIT/Apache-2.0，Rust MSRV 1.86），仅开启 std 与 extra-checks。解释执行二进制 WASM，不加载动态库，不运行 Node，不接入 WASI。不提供任何导入，因此文件系统、网络、环境变量、秘密、进程、Tauri IPC 和内部 SSH Session 均不可达。每次加载核验安装代及入口摘要。后续能力 API 必须单独提供授权桥，不能开放 WASI 作为捷径。

依据：[Wasmi Module API](https://docs.rs/wasmi/1.1.0/wasmi/struct.Module.html)、[StoreLimitsBuilder](https://docs.rs/wasmi/1.1.0/wasmi/struct.StoreLimitsBuilder.html)；已按下载的固定版本源码核对 fuel/limits/instantiate_and_start 接口。

## ABI 与协议

Guest 导出 memory、`sd_api_version() -> i32`（必须为 1）、`sd_alloc(length: i32) -> i32`、`sd_handle(operation: i32, pointer: i32, length: i32) -> i64`。输入为 UTF-8 JSON Message（protocolVersion/requestId/operation/payload），输出描述符高 32 位是响应地址，低 32 位是长度。Host 检查所有边界与 JSON 字段，不信任 Guest 指针。

Operation 编码：0 startup、1 activate、2 deactivate、3 health、4 cancel、5 exit、6 invoke、7 resume（13A-3，仅 Host 发出能力响应）。Reply 为 `{protocolVersion:1,result,error}`，error 可空，非空为 `{code,message}`；业务失败保留为回复，生命周期失败使激活失败。requestId 由 Host 单调递增，同一实例不复用多路并发，因此输出属于当前同步调用。取消以 Host 令牌优先实施，无需等待恶意 Guest 协作；停止发送 deactivate/exit 后无论回复如何都释放 VM。

## 限额与生命周期

- 每实例线性内存 16 MiB、一块 memory、一个 table/4096 元素、一实例；调用栈 256 层/值栈 256 KiB；开启 Wasmi strict 编译限额。
- 每次入口/start/ABI/生命周期与业务调用以 fuel 计量，调用预算 200 万，输入/输出各 64 KiB，每插件每秒 20 消息。
- 全局两个执行工作线程槽、最多八个活动实例，最多八个停止请求等待；没有无界消息通道或自动任务生成。
- 纯 WASM 在有界 spawn_blocking 中执行，不占用异步执行器；每次完成后检查两秒壁钟预算，超时结果拒绝。fuel 会终止死循环，不使用只丢弃 JoinHandle 的 timeout 冒充终止。

启动→激活→活动；重复激活复用同代实例。trap/fuel/无效消息使本实例 crashed 并释放 VM，其他插件不受影响；只允许用户显式重新激活，不自动重启崩溃循环。请求前及进入工作线程后均核验 enabled/revision，旧版本不能调用。禁用先持久禁用再取消/停止/释放；卸载在代码删除前排空运行时。升级停止旧实例，包提交失败后尝试恢复旧启用实例，恢复失败明确记录。应用退出关闭准入并排空全部实例。

新增主窗口 IPC：plugin_statuses/activate/call/health/cancel；TS 类型/服务同步。没有把这些管理命令授予 Guest。启用不含 backend 的元数据/UI 包仍只改变持久状态；启动后已启用后端按需激活，不在初始化中自动运行所有插件。

## 安全保障边界

这是 WASM 能力沙箱，不是 OS 进程隔离。线性内存有硬限额，fuel 有硬指令预算；壁钟检查不是操作系统抢占，系统暂停或底层运行时缺陷不能保证两秒内返回。编译内存、解释器本身和全进程 OOM 没有独立 OS 进程硬配额，依赖 4 MiB 输入、严格编译限额与有限并发降低风险；不声称可抵御解释器自身漏洞或同用户进程改写仓库。尚未验证 macOS/Linux 原生运行。WASI、网络和任意第三方原生代码始终未开放。
