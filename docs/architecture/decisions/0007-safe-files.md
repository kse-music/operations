# ADR 0007：SFTP 租约、独立后台队列和保守文本替换

整理状态：部分被 [ADR 0018](0018-workspace-lifecycle.md) 替代；安全替换原则保留，当前无持续目录跟随，主机关闭会确认取消并排空传输。

外部编辑范围由 [ADR 0031](0031-external-file-editing.md) 扩展：小型 UTF-8 限制继续适用于内置编辑器，外部副本按字节流式回传，复用本记录的冲突检测和保守原子替换原则。

内置编辑器的额外原子替换勾选确认由 [ADR 0032](0032-default-atomic-text-save.md) 替代：保存动作默认采用原子替换，保留后端安全检查及外部编辑回传确认。

以下保留原决策正文和当时验证边界；当前接口及功能以[总体架构](../ARCHITECTURE.md)和[决策索引](../DECISIONS.md)为准。

日期：2026-11-01；状态：已实现，验证见 [阶段四验收](../../validation/files/VALIDATION_STAGE4.md)。

采用已锁定并验证的 russh-sftp 3.0.1，使用 RawSftpSession 是为了有界目录读取、明确请求大小和 OpenSSH posix-rename 扩展；普通文件操作均是 SFTP 请求。Files 租约复用现有认证路由的 Transport，目录和传输有独立 Channel。任务由 Rust 保存，UI 页面不拥有取消权限；显式断开、应用退出才执行相应取消流程。

传输选择同目录独占临时文件、SHA-256 校验及明确冲突策略，不增加断点续传、跨重启自动任务或通用任务框架。并发和队列/目录/规划内存均设边界。取消保留已提交文件，提交临界阶段等待结果；网络故障清理失败必须呈现恢复路径。

编辑仅支持小型 UTF-8 普通文件。以内容 hash 和基础属性两次检测外部变化，必须有 WRITE 权限，原子替换必须保留 uid/gid/mode，缺少扩展或保留失败则不保存，不退化为删除/截断原件。原子替换的 inode、ACL/xattr、硬链接局限必须由用户明确确认；服务端无 CAS，最后检查与 rename 的竞态无法彻底消除，不能夸大保证。

终端目录采用 OSC 7 报告并由用户勾选跟随，不解析 pwd/提示符，不安装远端 Agent、不修改 Shell 启动文件。文件终端动作只运行经过确认、固定模板且 POSIX 转义的目录/less/tail 命令，使用独立 PTY，避免污染或注入已有 Shell。

Monaco 0.57 和 worker 均本地打包、按需加载，基础语言高亮，无远程 schema、脚本执行或插件。新引入的 DOMPurify 通过 override 锁定已发布 3.4.17 修复，生产 npm 审计重新检查；不强制升级无关开发依赖。Rust RSA 既有门禁保持。

实际原生验收发现同步 Tauri 传输入口没有 Tokio 运行时，已改异步并加入错误线程回归；另补退出的后端实时复核，不能让前端轮询延迟绕过未完成传输确认。tail 的 exit-signal 与断线分离，保留其他终端可用。

依据：[russh-sftp 3.0.1](https://docs.rs/russh-sftp/3.0.1/russh_sftp/)、[OpenSSH SFTP 扩展](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL)、[Monaco ESM](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md)、[Tauri 原生选择器](https://v2.tauri.app/plugin/dialog/)。实现以固定版本源码、协议测试及原生 Linux 证据为准。
