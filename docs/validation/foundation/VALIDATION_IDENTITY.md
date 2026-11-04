# cn.hiboot 应用身份统一验证

日期：2026-11-04，Windows x64。本轮按用户要求统一项目内自有域名，保留工作区已有的其他修改，不改写第三方插件身份。

## 修改范围

| 用途                    | 当前身份与主要文件                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 桌面应用及默认用户目录  | `cn.hiboot.desktop`；src-tauri/tauri.conf.json、core/identity.rs、application/identity.rs、src-tauri/src/lib.rs               |
| OS 凭据库服务           | `cn.hiboot.desktop.credentials.v1`；security/src/lib.rs                                                                       |
| 内置插件旧身份兼容      | 新包继续使用 `cn.hiboot.plugins.*`；application/bundled_plugins.rs 从集中兼容常量读取旧前缀                                   |
| 原生 QA 应用标识        | native-e2e、native-ui-e2e、native-terminal-e2e、native-ai-e2e、plugin-native-e2e                                              |
| 隔离容器/镜像所有权标签 | `cn.hiboot.qa`、`cn.hiboot.e2e`、`cn.hiboot.network-e2e`；plugin-test-host/test.ps1、ops-fixture.py、network-batch-fixture.py |
| 发布与文档              | release-manifest.mjs、产品/架构/决策、使用指南、插件目录说明、发布检查表                                                      |

全仓源码、配置、脚本和文档搜索后，旧域名仅保留在 core/identity.rs 的两个兼容常量中。构建缓存、历史二进制、忽略的 .local QA 配置和用户已有安装内容未做字符串替换；不会修改包摘要或伪造第三方身份。

## 数据保护行为

1. 迁移插件在单实例检查后、WebView 和数据库初始化前执行；仅普通生产 identifier 且没有 appDirectoriesOverride 时启用。QA 和自定义目录保持隔离。
2. 默认数据、本地数据、配置、缓存及日志根目录按同父目录原子改名；旧目录缺失时不创建它，新目录已有内容时不覆盖或自动合并。迁移可重入；路径不是绝对路径、叶目录是文件/符号链接/Windows 重解析点时拒绝，文件系统错误向上传播。无递归清理，无数据库 schema 变更。
3. 凭据新写入使用新服务。读取优先新服务，缺失时按原引用读取旧服务并复制；复制失败不能伪装成功。旧条目保留供回退，用户明确删除时先删除旧条目再删除新条目，避免兼容读取恢复旧值。没有明文文件回退，不输出秘密或引用。
4. 本轮仅在临时目录和随机命名凭据上测试，没有启动生产客户端去移动用户当前目录，没有改动已有主机、凭据或隔离容器。正常升级应先退出旧版，再启动新版。

## 实际检查

| 检查                                                                | 结果                                                                                                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test -p serverdeck-application --offline --locked`           | 37 项通过，1 项 Linux SDK 远程集成保持 ignored；其中 4 项新迁移回归验证配置、插件安装代/授权/禁用选择、已有新数据保护、自定义路径和 Windows Junction 拒绝 |
| `cargo test -p serverdeck-security --offline --locked -- --ignored` | 2 项真实 Windows Credential Manager 检查通过；含旧条目迁移、新服务优先、更新、删除后不复活，随机测试条目已清理                                            |
| 桌面编译                                                            | `cargo check -p serverdeck-desktop --offline --locked` 通过；保留既有增量缓存硬链接失败后复制的提示                                                       |
| Node/Python/PowerShell 脚本                                         | 修改脚本的语法检查通过，未执行 Docker 或真实远端操作                                                                                                      |

补充验证：core/security/application/desktop 四包 `cargo clippy --all-targets --offline --locked -- -D warnings -A clippy::single_element_loop` 通过，沿用既有 lint 例外；Cargo fmt、修改配置/脚本/文档的 Prettier、应用配置与共享身份常量一致性、文档文件链接及旧名称限定扫描通过。

桌面 IPC 重建**未完成**：两次 `cargo test -p serverdeck-desktop --test ipc --offline --locked` 均在替换现有 target/debug/serverdeck-desktop.exe 时遭遇 Windows 访问拒绝，未进入测试执行，不计为通过；未停止现有程序或删除 EXE。本轮完成的是编译/静态检查及库级与 OS 凭据验证，没有重新交付可运行 EXE 或安装器。不得把这些检查等同于真实用户目录迁移、桌面 IPC 或安装器验收。

## 限制与下一阶段依赖

未在用户真实默认目录执行迁移，未验证 macOS/Linux 原生目录、钥匙串或 Secret Service，未重新验收 NSIS 身份变化后的升级/卸载。新旧标识的程序不应并行运行；已有新目录优先，不会自动合并两份资料。旧凭据条目保留到用户明确删除，用于兼容回退。本阶段无新增依赖，不主动推进安装器或跨平台验收。
