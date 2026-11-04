# 用户上传业务插件源码

这里只保留真实可用的 Nginx Manager，使用公开 SDK 实现检测、配置编辑、校验、重载和日志；能力及限制见 [说明](nginx-manager/README.md)。它仍需构建成 `.sdplugin` 后由用户明确安装、启用和授权，不会因源码放在这里而自动安装。

metadata、hello-world、diagnostics、host-info 是必要的开发验证夹具，已移至 `tests/fixtures/plugins`；它们不作为正式业务插件分发。旧空 `examples/plugins` 目录已删除。

内置源码位于 `plugins/system`，两类采用同一 SDK、包格式和运行时。客户端安装的上传内容位于应用数据目录 `plugins/upload/<ID>/versions/<revision>`；配置和授权继续使用 `plugins/data`、`plugins/authorizations`，此次源码整理不删除用户已安装内容。
