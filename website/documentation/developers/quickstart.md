---
title: 第一个插件
description: 使用独立开发包完成准备、构建、打包、安装和首次真实调用。
---

# 第一个插件

目标是先跑通下载包中的样例，再开始自己的业务。开发第三方插件不需要宿主源码或 Tauri 工具链。

## 准备独立开发包

1. 在 ServerDeck 中打开 **设置 → 插件 → 下载插件开发包**。
2. 将 ZIP 解压到独立目录，确认包含 `example/`、公开 SDK、构建工具和规范。
3. 准备 Node.js 22.13+、Rust stable 1.94+ 和至少 10 GiB 构建空间。

在开发包根目录执行：

```sh
rustup target add wasm32-unknown-unknown
npm ci
cargo fetch --manifest-path example/backend/Cargo.toml --locked
npm run typecheck
npm test
npm run package
```

首次或锁文件变化后要预取完整依赖，不给 `cargo fetch` 限定目标，因为离线解析仍可能读取其他目标的依赖清单。正式打包保持锁定和离线要求，缺少依赖时先准备，不改锁绕过。

## 安装并运行样例

生成的 `example.sdplugin` 是标准插件包。在客户端上传，核对来源、启用状态和权限，再进入样例页面。

- **问候设置页**：无需主机即可调用 WASM 的 `greet` 动作。
- **主机内存巡检页**：从主机工作区进入，由插件执行并解析真实 `free -b` 结果。

首次远程动作需要核对实际 SSH 目标与命令。请只在已授权的测试主机和资源上运行。

内存巡检需要 `ssh.execute`，由插件后端顺序调用平台能力并解析结果；远端必须具备 Linux `free`。页面的业务 DTO、命令及健康规则全部由样例维护，不依赖宿主私有业务接口。

## 改成自己的插件

确认样例可用后，再调整：

| 文件                    | 负责内容                            |
| ----------------------- | ----------------------------------- |
| `example/manifest.json` | ID、名称、版本、声明权限与贡献入口  |
| `example/ui.json`       | UI v4 页面、前端入口和动作声明      |
| `example/frontend/`     | Vue 页面、业务状态与动作调用        |
| `example/backend/`      | WASM 业务、命令、参数校验和结果解析 |

使用自己的反向域名 ID，更新包提高版本。不要复制宿主私有连接池、凭据库、路由或桌面 Store。[UI 与 WASM 协作](/developers/ui-and-backend.html)说明后续调用链。

后端保持独立 `[workspace]` 与 `cdylib`，只依赖公开 `serverdeck-plugin-sdk` 和能够编译到 `wasm32-unknown-unknown` 的普通库。开发包中样例的 SDK 路径为 `../../crates/plugin-sdk`；前端从 `@serverdeck/plugin-sdk` 或公开子路径导入。保持 UI 页面 ID、贡献声明与动作名对应，编译器会拒绝宿主、Tauri 或越界源码依赖。

::: tip 用精确契约核对实现
包内 SDK、锁文件、示例和规范应匹配同一版本。遇到未知字段、权限或协议拒绝，先核对[版本契约](/developers/reference/versions.html)，不要增加兼容解码绕过检查。
:::
