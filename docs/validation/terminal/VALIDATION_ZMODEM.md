# ZMODEM rz 上传验证（2026-11-03）

## 完成标准与结果

SSH 终端收到合法 ZRINIT 后自动调用原生多文件选择 IPC；选择后通过原 PTY 上传，正常文件、二进制、中文文件名和空文件能够由真实 lrzsz 接收。取消选择、取消传输、读取失败、超时和断线均结束本地发送并释放授权，终端输出 ACK 不依赖选择器关闭，不能将旧选择发送到重连后的会话。普通按键及粘贴在传输期间隔离，Ctrl+C / Ctrl+X 和进度区按钮可取消。

已实现上述应用流程。原生选择器调用复用项目的 tauri-plugin-dialog 方式，标题使用现有 ConnectionStatus 的实际 SSH 连接快照；当前未完成原生窗口中“SSH 握手→操作系统选择窗口→本地文件读取→远端文件”全链路人工验收，以下分层测试不替代该项。

## 已执行检查

- `npm test`：36 文件、238 项通过。新增协议测试使用真实 zmodem.js 编解码，覆盖二进制、多文件、中文名、空文件、所有握手切分点、伪握手、取消选择、远端跳过、读取失败、断线后的迟到选择、超时、不支持的接收端参数，以及 ZFIN 与 Shell 提示符同包。组件回归验证自动调用选择 IPC、选择时继续 ACK、普通输入隔离、取消后恢复输入及断线后不读文件。
- `cargo test -p serverdeck-application -p serverdeck-ssh --offline` 的 Application 部分：11 项通过，包括新增 3 项授权/分块读取/变更文件测试。首次使用沙箱系统临时目录时日志轮转测试遇到权限拒绝，改用 `.local/zmodem/tmp` 后通过。
- `cargo test -p serverdeck-ssh --offline`：1 项 Agent 单测与 18 项 Engine 集成测试通过。沙箱首次因回环套接字权限拒绝，获准本机套接字访问后复验通过。live 远端测试按既有要求忽略，未提供或读取服务器秘密。
- `cargo test -p serverdeck-desktop --test ipc --offline`：2 项通过。新增校验确认上传选择/读取/释放 IPC 拒绝其他窗口和远程来源；无效会话在打开选择器或读取文件前返回 NOT_FOUND。
- `cargo clippy -p serverdeck-ssh -p serverdeck-application -p serverdeck-desktop --all-targets --no-deps --offline -- -D warnings` 通过。core 的独立 Clippy 被已有 `crates/core/src/openssh.rs:290` 的 single_element_loop 阻断；未改无关代码或降低警告等级。
- 全量 ESLint、修改文件 Prettier、rustfmt、Node/Python 测试工具语法和差异检查通过。TypeScript/Vite 与普通配置 Tauri debug 构建结果及产物见 IMPLEMENTATION_PLAN。

## 真实 rz 协议验收

仅使用本机 WSL Linux，在 `.local/zmodem` 解包 Ubuntu 仓库的 lrzsz 0.12.21-10，通过 Python 为真实 rz 分配 PTY，再由 Node 工具加载生产 ZmodemUpload 服务发送文件。未安装系统软件、连接用户服务器或改动正式应用数据。验收命令：

```powershell
$env:SERVERDECK_RZ_TEST_BINARY='/mnt/d/CodexProjects/operations/.local/zmodem/lrzsz/usr/bin/rz'
node tools/zmodem-rz-e2e.mjs
```

五项场景全部通过：

1. 2 MiB 全字节值二进制、中文空格文件名、空文件和混合换行文本，多文件落盘内容逐字节相等。
2. 取消选择：不读取文件，正常结束协议，无远端文件。
3. 远端同名保护：真实 rz 拒收时不读取或覆盖已有内容，准确计数跳过。
4. 文件选择延迟 6.5 秒：真实保活交换后仍可正常上传。
5. 发送一块后取消：真实 rz 返回失败，本地停止读取并释放授权，不伪报成功。

每项同时断言只请求一次选择、只释放一次授权、解除终端输入占用，并保留协议结束后的 Shell 输出标记。结果与 SHA256：`.local/zmodem/protocol-e4e95975-e02f-4c1b-8b5a-ea1902e3f41b/results.json`。

## 范围、限制与下一阶段

当前只支持 SSH 终端 rz 上传；sz 下载和目录传输使用既有 SFTP。每批最多 100 个普通文件，单文件小于 4 GiB；已实测文件上限为 2 MiB，不将协议大小边界视作大文件实测。远端文件冲突处理由 rz 参数决定；中途取消可能保留部分文件，应用不自动执行远端删除或覆盖。同一终端关闭、重连或退出会终止传输，不能像 SFTP 任务一样脱离终端继续。

未在用户实际服务器、完整原生选择器交互或 macOS/Linux 桌面端验收；未生成 Release/安装包，未安装或替换运行中的程序。保留既有 Vite Monaco 大 chunk 与增量缓存硬链接回退提示。没有新增配置、数据库迁移或下一阶段实现依赖；本阶段到此停止。
