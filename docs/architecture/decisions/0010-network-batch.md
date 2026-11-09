# ADR 0010：受管诊断与显式批量队列

整理状态：已退出当前范围，见 [ADR 0022](0022-feature-retirement.md)；保留原架构取舍及失败边界，不再提供诊断/批量功能。

以下保留原决策正文和当时验证边界；当前接口及功能以[总体架构](../ARCHITECTURE.md)和[决策索引](../DECISIONS.md)为准。

日期：2026-11-02；状态：已实施，证据见 [网络/批量验收](../../validation/operations/VALIDATION_NETWORK_BATCH.md)。

复用已认证 Operations/Files 租约，选择单独的 tasks crate 管理诊断和批量任务。诊断工具使用封闭枚举；本地只执行固定系统程序，远端参数严格校验，保留工具原始输出和失败，不以 ICMP 判断主机生死。SSH 延迟选择已认证 exec 往返，明确包含 Channel/Shell 成本；避免为了测量而重复使用凭据登录。

批量命令需要用户先确认连接、全部目标和完整命令。任意 Shell 无法靠字符串分类保证安全，因此所有命令均确认，不自动提权、重试或断线重放；超时/中断结果未确认。全局及每批 semaphore、有界历史/输出、独立取消令牌和退出排空足够当前范围，不引入持久任务总线、时序/日志数据库或定时编排。

批量文件复用已有 SFTP 安全提交和哈希校验，在后端聚合每目标 TransferInfo；显式重试仅针对文件失败目标并保持原冲突策略。取消等待清理屏障后释放批量并发槽；超时并不意味着已提交数据自动回滚。代价是取消可能需要等待清理，状态和恢复路径必须保留。

依据：[Microsoft Ping](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/ping)、[Microsoft Tracert](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/tracert)、[MTR 官方输出格式](https://github.com/traviscross/mtr/blob/master/FORMATS)、[MTR 权限边界](https://github.com/traviscross/mtr)。以锁定源码、协议测试和实机行为为准；不把 raw socket 权限失败隐藏为成功。
