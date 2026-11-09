# ADR 0008：固定只读采集、独立监控租约和有界内存历史

整理状态：保留为宿主内部服务的设计依据；当前没有独立内置监控/系统服务插件，参见 [ADR 0016](0016-plugin-platform.md)、0022。

以下保留原决策正文和当时验证边界；当前接口及功能以[总体架构](../ARCHITECTURE.md)和[决策索引](../DECISIONS.md)为准。

日期：2026-11-01；状态：已实现。证据见 [阶段五验收](../../validation/monitoring/VALIDATION_STAGE5.md)。

监控复用现有 SSH 认证路由和严格主机信任，使用独立 Monitor 租约及短命 exec Channel，不往交互式终端注入命令，也不安装 Agent。固定 POSIX 脚本按 NUL 分节并附状态；Rust 限制响应和时间，逐项解析。没有任意 exec IPC、远端 Python/JSON 工具依赖或通用采集框架。测试中的 Python 只用于独立交叉核对，不属于产品依赖。

CPU/网络用连续计数差与远端 uptime，首次或异常返回未知；内存遵循 MemAvailable，缺失时才显式近似。磁盘使用 mountinfo 保留路径/设备语义，df 获取真实容量；不可用挂载点保留原因，默认过滤伪 FS/镜像/重复挂载。不给负差做无依据的计数器回绕推算。

每主机一个 Tokio 任务，watch 只有值变化才唤醒；视图隐藏暂停，恢复清空差分基线，停止/退出清理独立租约。历史限 600 点/30 分钟，不上时序数据库、不跨重启恢复；趋势用 Vue SVG 保留节点更新，满足当前有限折线需求而不增加大型图表依赖。

依据：[Linux procfs](https://www.kernel.org/doc/html/v6.12/filesystems/proc.html)、[GNU df](https://www.gnu.org/software/coreutils/manual/html_node/df-invocation.html)、锁定版本 russh API 与真实 Linux 验证。iowait 的内核语义允许下降，按零差处理；df 可能隐藏重复/伪挂载，不能将缺失行伪造为容量 0。
