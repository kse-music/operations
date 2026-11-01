# 主机、凭据与配置导入导出阶段验收

日期：2026-11-01（Asia/Shanghai）。基于现有第一阶段实现继续开发，未实现 SSH 终端。

## 交付行为

- 主机创建、编辑、复制、确认删除；IP/ASCII 域名、端口、用户名、认证、超时、备注、标签、分组、收藏；列表与详情、搜索、标签/收藏筛选和排序。
- 单层分组创建/改名/排序/确认删除；删组后主机保留在未分组。主机复制使用新 ID，共享原安全凭据引用；删主机不删凭据或私钥文件。
- SSH 密码、私钥路径和加密私钥口令通过独立凭据页面管理。秘密写入系统原生凭据库，SQLite 仅有 opaque 引用、路径和非秘密元数据；UI 无秘密读取接口。
- 凭据更新使用 revision 和新秘密版本；清理意图先持久化，跨存储失败或中断可重试。关联删除必须确认解除主机关联；库不可用明确报错，不做明文 fallback。
- 系统 SSH Agent 认证配置入口，不连接服务器、不启动代理、不声称 Agent 已联调。
- OpenSSH 文件/粘贴预览、支持字段解析、重复识别、选择导入、危险或不支持选项阻断；只读原文件，不执行配置命令或覆盖已有主机。
- 非敏感 JSON 导出及真实文件下载；字段白名单排除凭据 ID、秘密引用、私钥路径、密码和私钥口令。
- 左侧主机树、分组折叠、添加/编辑/凭据对话框、右键/更多菜单、删除确认、loading/empty/error/success 状态，均使用真实 Rust/SQLite。

## 仓库与迁移

开始时仍非 Git 仓库，本轮没有初始化 Git 或生成 commit，没有覆盖先前业务代码。执行中新增的仓库 AGENTS.md 已读取，按其要求更新架构、计划与 DECISIONS，并排除出项目自动格式化范围。
PRD 保持 31,350 字节，SHA256 未变化：`58A3650F717DFEF522017D19BD1EA0C01B95D677CC3C11C41D76615520446B82`。

`002_hosts.sql` 将 schema 从 v1 升级为 v2，保留 app_config（自身配置版本仍为 1），增加 host_groups、credentials、hosts、secret_gc。
迁移在事务中执行，外键/端口/认证/超时有约束；未知未来版本拒绝降级，损坏配置不重置。没有删除或重新初始化用户数据库。

## 自动化结果

环境：Windows x64、Rust/Cargo 1.97.1、Node.js 22.17.0、Tauri 2.12.5、keyring 4.2.0、WebView2；其他 OS 未声明验证。

| 检查                                                                                    | 结果                                                           |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| cargo fmt --all -- --check                                                              | 通过                                                           |
| cargo clippy --workspace --all-targets --locked -- -D warnings                          | 通过                                                           |
| cargo test --workspace --locked                                                         | 24 passed，0 failed；原生系统库测试默认 ignored，另行显式运行  |
| cargo test -p serverdeck-security native_store_roundtrip_update_and_delete -- --ignored | 1 passed；真实 Windows 库随机条目读写、更新、删除              |
| npm run format:check                                                                    | 通过，PRD/AGENTS 不参与自动改写                                |
| npm run lint                                                                            | 通过，零警告                                                   |
| npm run typecheck                                                                       | 通过                                                           |
| npm test                                                                                | 7 passed，0 failed                                             |
| npm run build                                                                           | 通过                                                           |
| node tools/tauri.mjs build --debug --no-bundle                                          | 通过，交付前恢复普通配置与内嵌生产前端                         |
| npm run test:native                                                                     | 10 项真实桌面场景通过，无 IPC mock                             |
| npm audit --omit=dev                                                                    | 0 vulnerabilities                                              |
| 完整 npm audit                                                                          | 未通过：14 moderate，0 high/critical，原有开发工具间接依赖告警 |
| 完整 Cargo audit                                                                        | 未通过：原有 RSA 漏洞 1 项及信息警告 5 项，无新增安全豁免      |

Rust 用例组成：core 7、storage 7、application 5、Tauri IPC 2、SSH 隔离探针 3，共 24。原生 OS 凭据测试另运行 1 项。
覆盖正常与错误路径：非法地址/端口/用户/标签、凭据类型不匹配、共享引用、过期编辑、存储失败不回退、GC 重试、v1 迁移保留偏好、未来 schema 拒绝、导入 first-value-wins/通配符/否定/等号/引号/非法选项/重复/选择/事务回滚、窗口/origin ACL、无秘密读取命令以及错误载荷不泄漏。

## 实际桌面验收

`tools/native-e2e.mjs` 启动真实打包 EXE，通过 Playwright CDP 操作 WebView2 页面，并经过实际 IPC、SQLite 和系统凭据库。
每次使用独立 Tauri identifier、数据目录、测试 EXE、WebView profile 和随机 loopback 调试端口；首次写入前调用真实 bootstrap 核对目录，防止操作正常用户数据。

本轮最终通过的记录：`.local/native-e2e/1793526018801-e3ae25a7-9929-4451-99ad-c63a34a59cda/results.json`，并保留 `hosts.png`、导出 JSON 与下载文件以便复查。

1. 通过界面创建分组和主机，设置分组/标签。
2. 编辑地址和备注，真实列表更新。
3. 更多菜单复制配置，得到独立 HostId。
4. 创建 SSH 密码与加密私钥口令，关联主机；编辑界面秘密为空，扫描 SQLite/日志无测试秘密。
5. 终止并重启自身测试进程，主机、分组、认证引用和修改后的备注恢复。
6. OpenSSH 预览显示重复主机及不支持 ProxyJump，只导入选中的可用条目。
7. 实际点击下载 JSON，验证下载字节与白名单导出一致，不含秘密/凭据引用/私钥路径。
8. 经确认对话框删除主机，列表为空。
9. 删除系统凭据，待清理数量为 0。
10. 第二次重启，删除结果仍保持。

原生截图自动化工具未返回可用页面内容，因此没有依赖它盲点坐标；实际流程改由 WebView2 自动化取得可复现证据，并已人工查看测试截图。
重启采用对自己创建的测试进程终止后再启动，验证的是提交后持久化；不将其描述为 OS 关闭按钮的优雅退出验证。原有 application 退出等待测试继续通过。
最初失败均保留并已修复：分组文本定位、select 的稳定可访问名称、WebView2 重启时旧调试端点竞争。最后完整流程通过后不再扩大测试范围。
所有测试数据只存在于 `.local` 隔离目录；先前失败尝试中的随机凭据已通过目录核对后的清理入口删除，不清理其他应用或用户凭据。保留诊断目录，不做递归文件删除。

## 主要修改文件

- 根：Cargo.toml/Cargo.lock、package.json/package-lock.json、.prettierignore、README.md。
- core：Cargo.toml、src/lib.rs；新增 src/hosts.rs、src/openssh.rs。
- storage：Cargo.toml、src/lib.rs；新增 migrations/002_hosts.sql、src/hosts.rs、src/hosts/tests.rs。
- security：新增 Cargo.toml、src/lib.rs。
- application：Cargo.toml、src/lib.rs、src/logging.rs；新增 src/hosts.rs。
- Tauri：build.rs、capabilities/main.json、src/commands.rs、src/lib.rs、tests/ipc.rs；相应 permissions/autogenerated 由构建生成。
- 前端：App.vue、main.ts、services/ipc.ts、views/WorkspaceView.vue；新增 types/hosts.ts、services/hosts.ts、stores/hosts.ts/hosts.test.ts、styles/hosts.css、views/HostsView.vue/CredentialsView.vue、components/Modal.vue/HostSidebar.vue/HostDialog.vue/GroupManager.vue/CredentialDialog.vue/ImportDialog.vue。
- 测试工具：新增 tools/native-e2e.mjs，Playwright 仅为 devDependency，未引入生产浏览器或服务。
- 文档：更新 ARCHITECTURE.md、IMPLEMENTATION_PLAN.md；新增 DECISIONS.md、本记录；保留阶段一 VALIDATION.md 和 PRD。

## 限制、风险与下一阶段依赖

- 本轮不建立 SSH 连接，不实现终端、SFTP 或监控；密码/私钥/Agent 在真实服务器上的认证兼容仍需下一阶段验证。
- 私钥仅存路径引用，不验证存在性、格式或算法，不复制文件。Agent 不启用转发或自动降级。
- macOS/Linux 系统凭据行为、权限提示及正式打包尚未实机验收；没有安装包/签名或性能承诺。
- 复杂 OpenSSH 配置明确拒绝导入；Include、Match、代理、多 IdentityFile、动态令牌等兼容性待后续有实际模型需求时扩展。
- OS 库可能不可用或被外部清理。hasSecret 表示配置了秘密引用；实际使用时必须重新读取并处理缺失/锁定错误。删除失败的旧秘密明确保持待清理，系统服务恢复后重试。
- 完整安全审计仍未全绿。RSA 告警仅在隔离 SSH 探针中，桌面普通依赖不含 SSH/RSA；原有 Linux GTK/glib 和开发工具链告警继续记录，不以忽略列表掩盖。
- 下一阶段开始前，应先解决/评估 SSH 密码学门禁，完成真实 OpenSSH/Agent 认证与主机信任设计；之后才能按授权实施 SSH 终端。本轮到此停止。
