# 插件运行时与 ABI

当前Host API/SDK5，WASM ABI与wire1，UI4。Wasmi解释执行wasm32-unknown-unknown，不运行Node、动态库或WASI，无原生导入；激活核验安装修订和入口摘要。

导出memory、`sd_api_version()->i32`、`sd_alloc(length)->i32`、`sd_handle(operation,pointer,length)->i64`。高32位为响应地址、低32位为长度。Host检查所有指针/长度/JSON；SDK export_plugin宏封装安全缓冲访问。

操作码0 startup、1 activate、2 deactivate、3 health、4 cancel、5 exit、6 invoke、7 resume。Reply为`{protocolVersion:1,result,error}`，错误`{code,message}`。业务invoke接收`{action,input}`；只有宿主能resume返回hostResponse，普通UI不能伪造能力响应。

推荐backend::Runtime顺序async编排：平台等待让出WASM，原生收到能力请求后授权/审批/执行，resume原Future。每插件单动作；审批continuation为owner绑定的一次性本机token，不能重放动作开头或跨页使用。平台业务结果与大输出由SDK自动分块、校验UTF8和释放，原错误与清理错误一起保留。

每实例16MiB线性内存、一个memory、一个table/4096元素、调用栈256层/值栈256KiB。每次入口20,000,000 fuel、64KiB输入/输出、20消息/秒，完成后检查2秒壁钟。燃料终止死循环；壁钟检查不是OS抢占。全局2个执行线程槽、8活动VM、有限停止队列；平台全局4调用槽。每动作含续接最多96平台请求/180秒，Host续接异步节流65ms，不放宽消息速率。

startup→activate→active。重复activate复用同修订VM；trap/fuel/坏消息使实例crashed并释放，不自动重启循环。绑定owner共享VM、隔离平台资源，最后owner关闭释放VM根；crashed须显式重启。撤权/禁用/升级/卸载/退出先关闭准入再取消排空资源和VM，故障明确传播。

平台原生资源、审批和输出限制详见[SDK](PLUGIN_SDK.md)。这是WASM能力沙箱，无独立进程编译内存/OOM硬配额；Windows之外尚未完整原生验收。
