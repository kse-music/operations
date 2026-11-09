# ADR 0003：保守 OpenSSH 导入与字段白名单导出（初始决策）

整理状态：部分被 [ADR 0006](0006-terminal-routing.md)、0017、0022 替代；保守解析原则保留，旧 JSON 导出和旧字段不属于当前接口。

以下保留原决策正文和当时验证边界；当前接口及功能以[总体架构](../ARCHITECTURE.md)和[决策索引](../DECISIONS.md)为准。

日期：2026-11-01；状态：已实施。

受限 ProxyJump 与 Keepalive 已由 0006 扩展；以下为原始阶段二边界。

问题：有损解析 ProxyJump、Include、Match 或多 IdentityFile 后继续连接可能指向错误端点或使用错误认证；本轮尚无 SSH 连接能力，不能虚构这些选项支持。

支持 Host/HostName/Port/User/IdentityFile/ConnectTimeout、注释/双引号/等号、first-value-wins、明确别名上的通配符和否定模式。所有候选先预览；影响连接/信任/认证的未知项阻止候选，Include/Match 影响无法确定时阻止文件中的候选。keepalive/compression 等少量非端点设置仅提示未导入。通配符不展开为资产。
预览列出最终用户、地址、认证与超时；默认用户取当前本地用户名，无 IdentityFile 时按系统 Agent 导入，用户必须复核并选择确认。
提交再次解析并在事务内去重（同名或相同 hostname+port+username），重复跳过，不更新原主机。只读取原配置，不执行任何命令，不提供 OpenSSH 配置写回。

导出为版本化 JSON，明确列出字段白名单：主机基础字段、标签、备注、分组、收藏与连接超时。不含 credential_id/secret_ref/私钥路径和秘密。这是非敏感配置导出，不是完整保险库备份；用户自行填入备注的秘密不能靠字段白名单识别。

权衡：不引入完整 OpenSSH 执行环境、系统 ssh 子进程或复杂配置覆盖框架；对超出支持范围的内容明确阻止，用户可调整文本或手动配置。后续确需支持代理时再扩展模型和测试，不静默降级。
验证：全局/Host 顺序与首次赋值、引号/注释/等号、通配符否定、多别名、重复识别、非法值、Include/Match/ProxyJump 阻断、事务回滚与实际导入界面。
依据：[OpenSSH ssh_config 手册](https://man.openbsd.org/ssh_config)。
