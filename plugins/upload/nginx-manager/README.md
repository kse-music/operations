# Nginx Manager 1.0.0

独立公开 SDK 插件：只依赖 `serverdeck-plugin-sdk`（serde/serde_json），没有私有 crate、内部 IPC、Agent 或自动 sudo。业务全部在本目录 WASM 中；主程序使用通用声明式表单/日志渲染器，无 Nginx 专用分支。

## 构建与安装

在仓库根目录执行：

```powershell
rustup target add wasm32-unknown-unknown
node tools/build-plugin.mjs nginx-manager .local/nginx-manager.sdplugin
cargo test --manifest-path plugins/upload/nginx-manager/backend/Cargo.toml --offline --locked
```

构建使用独立 Cargo.lock/target，离线前先获取锁定依赖；输出文件必须不存在。桌面设置 → 插件管理 → 预览本地包，检查权限并明确接受“本地开发、来源未经验证”。示例虽由本仓库提供，尚无可信签名发行功能。

授予必要的 hosts.read、ssh.execute、sftp.read、sftp.write、ui.contribute，设置最窄读写目录，使用时选择 Linux 主机并核对连接指纹。需要验证/重载时允许请求“其他命令”，每次仍由主界面展示实际命令并单独确认。只读检测无需允许任意命令。文件写入另行确认。启用后从当前主机工具栏、顶部运维工具菜单、主机右键菜单或 Ctrl+K 打开。

## 实际使用

1. 选择主机并连接 SSH/SFTP，首次核对主机指纹。检测通过真实 `command -v nginx`、`nginx -V` 和 `systemctl is-active nginx` 返回版本、编译配置路径及服务状态。未安装/权限不足/非 systemd 保留实际退出码和输出；非 systemd 状态不冒充服务已运行。
2. 检查可执行文件、配置路径、可选运行前缀。不同发行版/自定义安装可手工填绝对路径；不会隐式改用系统默认配置。使用 nginx 二进制的 `-s reload`，PID 来源沿用选定配置/前缀，不能自动替换为其他服务或提权。
3. 读取已授权的单个 UTF-8 配置（32 KiB 上限）。编辑后显示未保存提示；重读/关闭/切换主机要处理草稿。保存使用现有 SFTP 原子替换与摘要/属性冲突检测，主界面先确认。失败保留本地内容，原子替换失败时展示 recoveryPath，不冒充成功。
4. 保存/放弃编辑后运行磁盘配置验证；审批中检查完整路径和命令。界面显示真实 stdout/stderr、exitCode、state、truncated。非零、超时、取消或权限失败均不是验证成功。
5. 重载要求已有成功验证，核对同一主机、路径、二进制/前缀及配置 SHA256。文件变化要求重新验证；每次重载均明确确认，并在同一命令中再次 `nginx -t && nginx -s reload`。返回退出码 0 表示命令成功，应结合业务请求/错误日志核对服务效果；不声称外部 include 树有事务锁。
6. 填有读权限的日志路径并开始日志，使用有限缓存搜索、暂停/继续和取消。权限、会话、路径变化都有明确错误。关闭工作区/禁用/撤权/升级/卸载清理 Host 资源。快速自动化须遵守每秒 20 条消息配额，多步动作及审批重试也消耗消息；限流后稍后重试，不放宽配额。

## 隔离测试配置

`tools/plugin-test-host` 创建无宿主目录挂载的临时 Ubuntu/OpenSSH 容器，运行普通用户 plugin 的 Nginx：

| 设置          | 测试值                            |
| ------------- | --------------------------------- |
| 配置文件      | /home/plugin/nginx/nginx.conf     |
| 前缀          | /home/plugin/nginx/               |
| 日志          | /home/plugin/nginx/logs/error.log |
| 授权读/写目录 | /home/plugin/nginx                |

执行 `tools/plugin-test-host/test.ps1 -Mode nginx`，真实桌面安装、授权、SSH/SFTP、非法配置、保存冲突、摘要变化拒绝、显式重载后 HTTP header 改变、日志、主机越界/断线、禁用/升级/撤权/卸载。Docker 镜像构建方式见 `docs/validation/plugins/PLUGIN_TEST_REPORT.md`。测试结束移除精确所有权容器与临时凭据；不会触碰用户服务器。卸载默认保留本插件本地数据，不删除服务器配置/日志，也不停止 Nginx。

## 范围与兼容

API/SDK 1.0.0、manifest/包/UI 协议均为 v1；已在 Windows x64 Host + 隔离 Ubuntu 实测。macOS/Linux 客户端未验收；不声称支持所有发行版/部署模式。无系统服务安装、自动修复、自动提权、多文件编辑、配置 include 树锁、在线市场或可信签名。配置竞争窗口、进程/内存隔离和 SDK 配额详见插件安全/运行时文档。
