# 桌面虚拟挂载容量误报修复（2026-11-03）

## 原因与实现

用户后续截图显示 `/run/user/1000/doc`、`gvfs` 和 `gnome-remote-desktop/cliprdr-WR3kdo` 三个挂载点被汇总为容量不可用，并各弹出错误通知。之前只统一前端持久挂载筛选，遗漏 Rust disk 的伪文件系统分类；已有前端用例使用已经设置 pseudo 的 proc，无法发现这一遗漏。

`crates/monitor/src/disk.rs` 增加 `fuse.portal`、`fuse.gvfsd-fuse` 类型识别；无 subtype 的 GNOME 剪贴板挂载同时要求 `fuse` 和完整的 `/run/user/<数字 UID>/gnome-remote-desktop/cliprdr-<非空单级名称>` 路径。它们沿用 pseudo 标记，自动退出后端容量异常计数和前端错误气泡。保留原始无容量原因，在显示全部挂载时仍能查看，没有伪造零容量或修改远端权限。

真实数据盘、SSHFS、rclone、普通 FUSE、相似但不匹配的路径仍参与监控；整体 df 命令失败仍报采集警告。无新增依赖、IPC、数据库变更或远端命令。

类型依据为 [文档门户 FUSE 实现](https://github.com/flatpak/xdg-desktop-portal/blob/main/document-portal/document-portal-fuse.c)、[GNOME GVFS 实现](https://github.com/GNOME/gvfs/blob/master/client/gvfsfusedaemon.c) 和 [GNOME RDP 剪贴板 FUSE 实现](https://github.com/GNOME/gnome-remote-desktop/blob/main/src/grd-rdp-fuse-clipboard.c)。截图没有原始 mountinfo；测试使用依据上述实现构造的输入，不能表述为已采集用户主机。

## 验证

- 修改前新增的三个 Rust 回归测试全部失败，其中精确复现“3 个挂载点容量不可用”；日志为 `.local/desktop-mount-fix/before.log`。
- 修改后 metrics 11 项、历史缓存单元 1 项、SSH 回环集成 3 项通过。新增用例覆盖三个 UID、原始容量仍未知、真实盘与 FUSE 存储不误过滤、路径边界、df 非零退出仍告警且保留有效数据。
- 监控、服务器管理及错误通知前端 3 个文件共 13 项通过。Monitor 严格 Clippy（all-targets、no-deps、-D warnings）及 cargo fmt 检查通过。
- 将原始 mountinfo/df 夹具交给生产 Rust Processor，序列化实际 Sample DTO，再注入真实 Edge 浏览器的 API 测试边界。正常场景为零采集警告、零错误气泡，默认只显示根盘，全部挂载保留四行；加入 `/data` 容量缺失后恰有一条真实磁盘告警和气泡，全部五行保留。两种场景均无浏览器异常，已检查概览截图。
- 复现、测试、实际 Rust JSON、浏览器脚本、截图及结果位于 `.local/desktop-mount-fix`。没有把手工设置 pseudo 的浏览器夹具当成后端分类验证。

首次在受限沙箱运行 SSH 集成测试，三项均等待状态超时；同一代码在沙箱外仅连接本机测试服务后全部通过。未连接用户服务器，未执行完整原生 UI 或跨平台验收。匹配范围限于已确认的类型和 GNOME 常规运行目录，自定义运行目录或未来新增虚拟类型仍需按证据补充，未知类型继续显示诊断。无新增阶段依赖。

## 构建交付

`node tools/tauri.mjs build --debug --no-bundle` 通过 TypeScript、Vite 和 Windows Tauri 编译。产物为 `.local/desktop-mount-fix/ServerDeck.exe`，已校验与本次构建来源 SHA256 一致，哈希和字节数记录于同目录 `build.json`。源码差异和修改文档格式检查通过。保留既有 Monaco 大包及增量缓存硬链接回退复制提示，没有生成 Release 安装包或替换、结束用户正在运行的程序。需启动新版后端才能使用新的挂载分类。
