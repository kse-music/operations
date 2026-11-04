# SFTP 权限与拥有者显示验收

日期：2026-11-02。本轮仅调整远程文件的两列展示及属主名称传递。

## 已完成

- 权限显示为九位符号（`rwxr-xr-x`、`rw-r--r--`），正确处理 s/S/t/T 和无权限，缺失时显示 `—`。
- 拥有者显示服务器返回的名称，列名为“拥有者”；没有可识别名称时保留真实 UID，UID 0 不自动猜作 root。鼠标提示保留 UID。
- 后端保留常见 Unix 格式 SFTP NAME.longname 中的属主名称，新增可空 FileEntry.owner；不执行远端命令，不修改数值属性或文件安全保存流程。本地文件列表不增加这两列。

主要文件：`components/FilePane.vue`、`types/files.ts`、`core/src/files.rs`、`sftp/src/remote.rs`、`sftp/src/local.rs` 及对应协议、组件和页面检查。

## 验证

- 前端全量 20 文件、76 项通过；追加 UID 0 未知名称回退用例后，FilePane 的 10 项通过。
- SFTP 单元测试 2 项、真实回环 SSH/SFTP 协议集成测试 5 项通过。服务器把 sftp-owner 写入 longname，在实际协议编码/解码后断言客户端 owner 和原 UID 均正确保留；现有传输、取消、安全保存和会话隔离测试仍通过。
- TypeScript、ESLint 通过；SFTP Clippy 在仅允许既有 core::openssh single_element_loop 告警后通过。
- 沙箱内回环握手最初因网络限制失败，使用正常本机环境和项目临时目录重跑全部协议测试后通过；没有连接用户主机。
- Edge + Playwright 检查 36 个菜单页面及表单状态通过，在三组尺寸/主题下断言远程表头、首行 `rwxr-xr-x` / root、本地列数不变和双栏对齐。截图位于 `.local/ui-sftp-owners/`，已核对桌面 SFTP 截图。这是 UI 夹具检查，不作为用户远程主机验证。
- Vite 生产构建、Windows Tauri debug 构建通过，调试程序为 `.local/native-ui-build/debug/serverdeck-desktop.exe`。没有自动重启当前窗口或安装发布版。
- Rustfmt、修改文件的 Prettier 和 `git diff --check` 通过。页面检查脚本同步选择显式的全局主机上下文、只等待当前可见视图，保留原有布局和内容断言。

## 限制与后续依赖

longname 的格式由服务器决定，当前只识别常见 Unix ls 风格；服务器只给数字或采用其他格式时仍显示 UID。没有实施 NSS/LDAP 用户名查询，不为取得显示名称读取远端用户数据库或启动命令。用户主机和不同发行版实测尚未运行，后续依赖授权测试主机；本次不声称所有 SFTP 服务都返回用户名。

本轮不涉及 SQLite 迁移、凭据或配置重置。已知的 Monaco 大 chunk 和原有 Clippy 告警不在本次修改范围；完成后停止，不扩展其他文件功能。
