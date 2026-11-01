# ServerDeck 技术决策

## 0012：主机绑定导航、独立租约与保守备份恢复

日期：2026-11-02；状态：已实施，实测与限制见 [产品整合验收](VALIDATION_PRODUCT.md)。

统一 HostId 导航而不是强制把所有模块合成一个巨型会话：终端、文件、监控和运维继续使用独立租约，Transport 按现有完整连接签名复用。导航标签仅表示页面上下文，关闭它不意味着断开服务；实际关闭有单独入口和确认。Operations 不再依赖全局可变 active 来决定操作目标，所有敏感确认绑定页面 HostId 和 SessionId；批量选择保留完整目标预览。

选择少量本地状态与原生窗口事件完成整合，不引入路由框架、UI 套件、国际化运行时或窗口插件。zh-CN 字典提供语言扩展入口，未完成的翻译不会出现在选项中。任务/连接摘要只传元数据，Toast 不复制输出；主机分组一次计算、初始渲染和搜索结果有界，避免仅为外观删减已有能力。

备份选择可审查的严格 JSON 和新增式恢复，skip/copy 不覆盖原资产。用单数据库事务实现分组、主机、跳板、条目和可选偏好的一致恢复，缺失依赖整体失败。凭据/私钥路径/秘密参数值和信任不导出；历史与计划也不导出，避免恢复后悄悄执行。认证代理主机阻止自动恢复而不是移除认证继续连接，SSH 密码/私钥主机可恢复配置但需重新关联凭据。代价是备份不等同于完整保险库或无人值守环境迁移；用户自行写进正文/说明的秘密仍需审查。

默认 SSH 选项只用于新主机，避免全局设置改变已授权路由/连接或已有计划。默认代理的凭据引用必须有效，删除前须解除全局默认引用；备份不携带该认证关系。窗口使用逻辑尺寸与原生最大化状态，恢复约束到当前屏幕，不自动恢复位置、SSH 连接或命令。其他平台和物理混合 DPI 仍需各自实机验证。

## 0011：分离脚本参数、持久状态与本地确认式调度

日期：2026-11-02；状态：已实施，证据见 [自动化验收](VALIDATION_AUTOMATION.md)。

新增具体 automation crate，复用 tasks 执行槽和 Operations SSH 租约。任务本身允许用户输入任意 Shell，但不把模板值插进正文：固定 Python bootstrap 从 stdin 读取分离 JSON，然后用 execv 将正文与位置参数传给 `/bin/sh`。相比复杂模板转义器，这一方式有清晰的解释边界；代价是远端需 Python 3、脚本须使用 POSIX Shell 且正确引用 `"$1"`，参数仍可能被远端同用户/管理员观察。不安装 Agent、不自动 sudo、不执行本机用户命令。

只使用已完成用户认证/指纹确认的连接，授权快照绑定正文、参数、执行选项和完整路由/凭据 revision。目标或执行内容变化撤销计划；不会在后台新登录或自动信任。输出默认不持久化，秘密参数条目禁止保存默认值及定时执行，并完全抑制 stdout/stderr，避免对回显做字符串替换却漏掉分块/变形内容。普通任务输出显式选择保存、每流 8 KiB；SQL 历史持续保留、分页查询、用户确认删除，有限内存历史不代表自动删除用户持久记录。

执行前持久化 Running，后台 revision 检查拒绝旧快照覆盖；开始状态保存失败不发送命令。收到 0 退出码才成功，超时/断线/在途取消为 Unknown，应用重启不重放。正文、普通参数、目标及结果快照进入 SQLite v5，秘密参数只在临时零化内存和 SSH stdin 中存在；手动取消未开始任务是明确 Cancelled。资源使用现有 Tokio/semaphore/token/JoinHandle，不引入消息总线或 DAG。

本地调度选择简单五字段 Cron/每日/每周及持久固定 UTC 偏移，不引入时区数据库或常驻服务。普通计划需明确授权；危险计划到期只生成待人工确认项。数据库事务 claim+下一时间+唯一键避免同一发生点重复，已有未结束任务不积压。错过计划只 skip 或 ask，绝不自动追赶危险操作；退出/睡眠/关机不保证执行。编辑执行内容或路由后重新授权，失败和待确认在应用根级可见。真实 WebView2、独立 Linux 容器和跨分钟重启验收覆盖这一边界。

## 0010：受管诊断与显式批量队列

日期：2026-11-02；状态：已实施，证据见 [网络/批量验收](VALIDATION_NETWORK_BATCH.md)。

复用已认证 Operations/Files 租约，选择单独的 tasks crate 管理诊断和批量任务。诊断工具使用封闭枚举；本地只执行固定系统程序，远端参数严格校验，保留工具原始输出和失败，不以 ICMP 判断主机生死。SSH 延迟选择已认证 exec 往返，明确包含 Channel/Shell 成本；避免为了测量而重复使用凭据登录。

批量命令需要用户先确认连接、全部目标和完整命令。任意 Shell 无法靠字符串分类保证安全，因此所有命令均确认，不自动提权、重试或断线重放；超时/中断结果未确认。全局及每批 semaphore、有界历史/输出、独立取消令牌和退出排空足够当前范围，不引入持久任务总线、时序/日志数据库或定时编排。

批量文件复用已有 SFTP 安全提交和哈希校验，在后端聚合每目标 TransferInfo；显式重试仅针对文件失败目标并保持原冲突策略。取消等待清理屏障后释放批量并发槽；超时并不意味着已提交数据自动回滚。代价是取消可能需要等待清理，状态和恢复路径必须保留。

依据：[Microsoft Ping](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/ping)、[Microsoft Tracert](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/tracert)、[MTR 官方输出格式](https://github.com/traviscross/mtr/blob/master/FORMATS)、[MTR 权限边界](https://github.com/traviscross/mtr)。以锁定源码、协议测试和实机行为为准；不把 raw socket 权限失败隐藏为成功。

## 0009：共享 SSH 主机上下文的 CLI 运维和受限日志流

日期：2026-11-01；状态：已实现，证据见 [运维验收](VALIDATION_OPERATIONS.md)。

用户明确追加 PRD P1 运维范围。选择现有 SSH + Docker CLI，而非新增 Docker HTTP 客户端和 API 转发：CLI 兼容协商与 JSON 格式足够当前操作，减少认证/网络暴露面。只显式连接标准 Unix Socket并清除 context/Host/TLS 环境覆盖；不默认启用 TCP、sudo 或 su。普通账号无权限就失败，测试服务器权限由用户在服务器侧授予，应用不修改权限。

所有动作由 Rust 封闭枚举构造，参数严格校验/单引号转义；容器/镜像用全 ID，服务带明确 scope，写操作要求 confirmed，UI 输入全文并绑定 SessionId。容器环境全部默认遮蔽，显式确认才显示；不将输出存日志/数据库。进程信号选 pidfd + boot/start 标识，不使用存在 PID 复用窗口的检查后 kill；代价是信号需要较新的 Linux 和 Python pidfd 支持，能力不足明确失败。

Logs 不复用交互终端，用独立非 PTY Channel 和 ACK，每块最多 16 KiB、渲染后应答，暂停背压。前端 1 MiB/5000 行、最多 8 标签，纯文本过滤/导出；关闭请求 TERM 并 close。已有终端、SFTP 和 Monitor 仍保持独立所有权。操作成功只代表命令返回成功，断线/超时不等于回滚，失败提示要求重新核对。反馈仅本次应用内有界元数据；持久审计留待明确需求。

依据：[Docker 格式化](https://docs.docker.com/engine/cli/formatting/)、[Docker 容器详情](https://docs.docker.com/reference/cli/docker/container/inspect/)、[systemctl](https://www.freedesktop.org/software/systemd/man/256/systemctl.html)、[Linux proc stat](https://www.man7.org/linux/man-pages/man5/proc_pid_stat.5.html)，实现以锁定依赖源码和实机验证为准。

## 0008：固定只读采集、独立监控租约和有界内存历史

日期：2026-11-01；状态：已实现。证据见 [阶段五验收](VALIDATION_STAGE5.md)。

监控复用现有 SSH 认证路由和严格主机信任，使用独立 Monitor 租约及短命 exec Channel，不往交互式终端注入命令，也不安装 Agent。固定 POSIX 脚本按 NUL 分节并附状态；Rust 限制响应和时间，逐项解析。没有任意 exec IPC、远端 Python/JSON 工具依赖或通用采集框架。测试中的 Python 只用于独立交叉核对，不属于产品依赖。

CPU/网络用连续计数差与远端 uptime，首次或异常返回未知；内存遵循 MemAvailable，缺失时才显式近似。磁盘使用 mountinfo 保留路径/设备语义，df 获取真实容量；不可用挂载点保留原因，默认过滤伪 FS/镜像/重复挂载。不给负差做无依据的计数器回绕推算。

每主机一个 Tokio 任务，watch 只有值变化才唤醒；视图隐藏暂停，恢复清空差分基线，停止/退出清理独立租约。历史限 600 点/30 分钟，不上时序数据库、不跨重启恢复；趋势用 Vue SVG 保留节点更新，满足当前有限折线需求而不增加大型图表依赖。

依据：[Linux procfs](https://www.kernel.org/doc/html/v6.12/filesystems/proc.html)、[GNU df](https://www.gnu.org/software/coreutils/manual/html_node/df-invocation.html)、锁定版本 russh API 与真实 Linux 验证。iowait 的内核语义允许下降，按零差处理；df 可能隐藏重复/伪挂载，不能将缺失行伪造为容量 0。

## 0007：SFTP 租约、独立后台队列和保守文本替换

日期：2026-11-01；状态：已实现，验证见 [阶段四验收](VALIDATION_STAGE4.md)。

采用已锁定并验证的 russh-sftp 3.0.1，使用 RawSftpSession 是为了有界目录读取、明确请求大小和 OpenSSH posix-rename 扩展；普通文件操作均是 SFTP 请求。Files 租约复用现有认证路由的 Transport，目录和传输有独立 Channel。任务由 Rust 保存，UI 页面不拥有取消权限；显式断开、应用退出才执行相应取消流程。

传输选择同目录独占临时文件、SHA-256 校验及明确冲突策略，不增加断点续传、跨重启自动任务或通用任务框架。并发和队列/目录/规划内存均设边界。取消保留已提交文件，提交临界阶段等待结果；网络故障清理失败必须呈现恢复路径。

编辑仅支持小型 UTF-8 普通文件。以内容 hash 和基础属性两次检测外部变化，必须有 WRITE 权限，原子替换必须保留 uid/gid/mode，缺少扩展或保留失败则不保存，不退化为删除/截断原件。原子替换的 inode、ACL/xattr、硬链接局限必须由用户明确确认；服务端无 CAS，最后检查与 rename 的竞态无法彻底消除，不能夸大保证。

终端目录采用 OSC 7 报告并由用户勾选跟随，不解析 pwd/提示符，不安装远端 Agent、不修改 Shell 启动文件。文件终端动作只运行经过确认、固定模板且 POSIX 转义的目录/less/tail 命令，使用独立 PTY，避免污染或注入已有 Shell。

Monaco 0.57 和 worker 均本地打包、按需加载，基础语言高亮，无远程 schema、脚本执行或插件。新引入的 DOMPurify 通过 override 锁定已发布 3.4.17 修复，生产 npm 审计重新检查；不强制升级无关开发依赖。Rust RSA 既有门禁保持。

实际原生验收发现同步 Tauri 传输入口没有 Tokio 运行时，已改异步并加入错误线程回归；另补退出的后端实时复核，不能让前端轮询延迟绕过未完成传输确认。tail 的 exit-signal 与断线分离，保留其他终端可用。

依据：[russh-sftp 3.0.1](https://docs.rs/russh-sftp/3.0.1/russh_sftp/)、[OpenSSH SFTP 扩展](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL)、[Monaco ESM](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md)、[Tauri 原生选择器](https://v2.tauri.app/plugin/dialog/)。实现以固定版本源码、协议测试及原生 Linux 证据为准。

## 0006：日常终端、受管路由与归属明确的端口转发

日期：2026-11-01；状态：已实施。证据见 [SSH 使用增强验收](VALIDATION_SSH_USABILITY.md)。

继续使用锁定的 russh 0.65：connect_stream 接受 TCP、代理流或 direct-tcpip ChannelStream，避免为了代理执行本地 Shell。受管跳板逐跳验证密钥、独立认证，最多 4 层，配置和凭据 revision 参与 Transport 复用。SOCKS5 支持无认证/用户名密码，HTTP CONNECT 支持无认证/Basic；秘密仍来自 OS 库。HTTP 代理不使用 TLS，代理认证没有额外加密，界面明确提示可信网络边界。ProxyCommand 不启用；Include/Match、复杂 ProxyJump 字符串拒绝，不能忽略后连接错误目标。导入依赖按事务排序，同名跳板端点冲突阻断，不写回 ssh_config。

标签拥有布局，窗格拥有 Session，Transport 可共享；二叉树只计算百分比几何，不重排 xterm DOM，避免拖动导致 Shell 重启。最多 8 窗格/标签、32 总窗格。布局只持久化 HostId、标题、顺序和比例，重启恢复未连接状态；不保存终端正文，不回放命令。终端偏好追加到原版本配置并默认兼容，键位校验保留 Ctrl+C/Z；大文本先确认并遵守远端 Bracketed Paste，显式本地导出，默认不录制。

转发归属于创建它的 Session，不采用全局永久隧道服务。Local/Remote/Dynamic 显式启停，默认回环、公共绑定需要前后端显式确认；Remote 仍受服务端 GatewayPorts/AllowTcpForwarding 策略约束。并发流、记录、入口队列均有上限。停止、断线、关闭清理监听和子任务；同一远程端口的精确所有权防止重复请求撤销其他隧道。远程取消未确认时断开所属 Transport，优先避免服务器遗留监听，并明确提示共享终端受影响。Dynamic 暂限无认证 CONNECT，不支持 UDP/BIND；Remote 不支持端口 0；转发不自动恢复。

原生验证发现并修复两项实际交互缺陷：ResizeObserver 不再抢搜索焦点；布局保存与凭据读取改为有界元数据等待，连接前 BUSY 有限重试必须新建 Tauri Channel。输入数据只在原 Session 内重试，重连清空旧队列，不能重放命令。

依据：[OpenSSH 配置语义](https://man.openbsd.org/ssh_config)、[xterm 终端偏好/Bracketed Paste](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)、固定版本本地 russh client Config/Handle/Handler 源码与实际协议测试。未引入 SFTP、远程执行命令模板或通用任务框架。

## 0005：russh 生产接入、独立 PTY 和应用层背压

日期：2026-11-01；状态：已实施，Windows → Ubuntu OpenSSH 实测。

采用锁定于 Cargo.lock 的 russh 0.65.0，关闭默认 feature，使用 ring + rsa。真实握手、密码、普通/加密 Ed25519、Agent 签名、独立 Channel、PTY resize、断线和有界输出已验证，无需替换实现。保持原有 probe 独立，不把 SFTP 子系统接入本阶段产品。

应用自己的 SQLite 信任表以 hostname+port 保存完整公钥；未知主机必须完成 live challenge 确认才发送认证信息，密钥变化硬性阻止。系统 known_hosts 的 CA/哈希/撤销导入没有被简化成不正确的字符串解析，明确留待后续。

Transport 与终端 Session 分开管理：复用键包含主机、端点、账户和凭据 ID/revision。每个 Shell 一个 Channel；关闭一个只取消该 Channel，最后一个退出后才关闭 Transport。重连创建新 Shell，不重放输入。总数限制 32；受远端 MaxSessions 限制时明确失败，不自动增开无限连接。

Tauri Channel 本身不提供端到端背压，采用最多一块 16KiB 输出 + xterm.write 完成回调 ACK，后台收到对应序号才继续读取。控制输入/resize 与输出消费分开，Ctrl+C 和取消不被解析等待阻塞。代价是每块有一次 IPC 往返；2MiB 实测通过，尚无长期吞吐和内存基准。russh 内部控制队列仍有无界部分，不能宣称恶意服务端下有硬内存上限。

保留 RUSTSEC-2023-0071 的非零审计结果，不添加 ignore。生产私钥文件入口拒绝 RSA；RSA Agent 使用系统进程签名并要求 SHA-2，应用不做 RSA 私钥运算。Ed25519/ECDSA 文件、密码、Agent 可用；主机 RSA 公钥验证不属于本地私钥签名。系统 Agent 的实现安全性由系统提供，当前只验证了隔离命名管道 Agent 的真实签名认证，未验证用户系统服务与实际加载身份。

依据：[russh 0.65 API](https://docs.rs/russh/0.65.0/russh/client/struct.Handle.html)、[xterm flow control](https://xtermjs.org/docs/guides/flowcontrol/)、[Tauri Channel](https://v2.tauri.app/develop/calling-frontend/#channels)、[RustSec RSA 通告](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)。实际证据与限制见 [阶段三验收](VALIDATION_STAGE3.md)。

## 0001：SSH 密码学安全门禁（保留）

见 [ADR 0001](decisions/0001-ssh-crypto-gate.md)。RSA 漏洞门禁保留；本轮受限接入的生产决策见 0005，不允许本地 RSA 私钥签名。

## 0002：原生凭据库、不可变秘密引用与清理意图

日期：2026-11-01；状态：已实施，Windows 已验证。

问题：主机配置必须在 SQLite 中持久化，秘密必须放在 OS 安全库。两者无跨系统原子事务；直接更新同一秘密可能使数据库保存失败后仍替换共享凭据，删除失败也不能假装完成。

采用 keyring 4.2 原生适配（Windows Credential Manager、macOS Keychain、Linux Secret Service），没有普通 JSON/SQLite 或进程内 mock fallback。应用只定义写入、读取、删除的窄 Rust 边界，读取不暴露为 IPC。测试中的故障注入实现只用于自动化。

新秘密使用新 UUID reference；先记录 SQLite secret_gc 意图，再写 OS entry。随后 SQLite 事务切换引用、增加 revision、移除新意图并登记旧 entry 待删除。提交失败补偿删除新 entry；崩溃和删除失败保留清理记录，UI 明确报告且允许重试。
被共享的凭据类型不可直接更改；更新用 revision 拒绝过期编辑。删除引用默认拒绝有主机关联的凭据，显式确认后解除关联并保留主机配置。删除主机只减少引用，不自动删除凭据。

权衡：只使用系统库比自建加密文件保险库少一套密钥管理与恢复逻辑；代价是依赖用户会话和服务可用性。当前“检查可用性”只证明读取服务可达，不提前承诺后续写入一定成功。秘密写入失败返回安全错误并保留原引用，不退化为明文。
若操作中断，可能存在待清理秘密，但它有持久化 opaque 引用；本轮不保证在系统服务长期不可用时秘密立即物理删除。服务恢复后可重试，不能隐藏此限制。

秘密输入 DTO 不实现 Debug/Serialize，Rust 缓冲使用 Zeroizing；前端表单提交/卸载清空输入。JS、OS 与依赖库内部内存副本的清零不作绝对保证。私钥只引用文件路径，不读取/复制正文，不宣称已验证文件、加密算法或 SSH 可登录。

验证：SQLite 迁移、凭据关联/共享/过期版本、故障库不回退、旧秘密重试清理、日志/数据库泄漏扫描，外加原生 Windows 凭据库测试和真实打包应用 E2E。
依据：[keyring v1 原生存储说明](https://docs.rs/keyring/4.2.0/keyring/v1/index.html)。macOS/Linux 尚需各自实机验收。

## 0003：保守 OpenSSH 导入与字段白名单导出（初始决策）

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

## 0004：实际桌面 E2E 与数据隔离

日期：2026-11-01。

原生窗口截图工具未返回可用页面内容，增加 Playwright CDP 对实际 WebView2 的流程测试。无 IPC mock：点击/填写真实 Vue 页面，经权限边界调用 Rust、SQLite 和系统凭据库。
测试使用 Tauri 构建配置覆盖及不同 identifier，把数据库、日志和 WebView 数据放在 `.local/native-e2e/<随机目录>`；首次变更前通过实际 bootstrap 检查目录。测试 EXE 单独复制，根目录 Debug 产物恢复普通配置；debugging 只对该测试子进程开放 loopback 端口，正式配置不启用 CDP。
端到端测试在每次启动使用新随机端口并直连 WebSocket endpoint，避免旧 WebView 退出与调试端点启动竞争。重启验收通过终止自己创建的测试进程后重新启动来检查提交后的持久化，不将其描述为系统窗口关闭按钮验收。

依据：[Playwright WebView2](https://playwright.dev/dotnet/docs/webview2)、[Microsoft WebView2 flags](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags)。调试参数与测试目录只存在于测试工具生成的临时配置及进程环境。

## 2026-11-02：保持 0.1.0-beta.1，发布门禁独立于构建成功

Windows NSIS 当前用户安装和实际 Release 程序验收可以在当前环境执行；其他平台仅提供手动 CI，不声称已产出或签名。应用标识和 SQLite schema 5 保持，目录/数据库权限修复不重置配置。

npm minimatch 依赖覆盖至修复版本，并重跑类型、ESLint 和前端测试；RSA 无上游修复且仍需公钥验证/外部 Agent 兼容，维持本地 RSA 签名阻断，不忽略 cargo audit。Linux GLib 风险保留为平台发布门禁，避免无验证的大版本替换。

先保存真实性能基线；内存目标未达标，不用工作集修剪、排除 WebView 或降低安全校验伪装达标。本轮未因单次延迟测量引入 SFTP 流水线、激进缓存或默认 SSH 自动重试。后续优化须以重复基准、剖析和完整传输/取消回归为依据。
