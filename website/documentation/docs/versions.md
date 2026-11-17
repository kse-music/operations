---
title: 版本与适用范围
description: 区分公开安装包、当前代码基线、SDK 和插件协议版本，核对适用范围与支持平台。
---

<script setup>
import manifest from '../reference-manifest.json'
</script>

# 版本与适用范围

## 公开安装包与文档基线

官网下载入口指向 [GitHub 最新正式发布页](https://github.com/kse-music/operations/releases/latest)，请在该页选择 Windows x64 安装包；版本、大小和更新说明以发布页为准。本文档依据 **v0.9.3 代码基线**及现行指南整理，不能据此认为尚未发布的代码已经进入旧安装包。

遇到入口或行为差异时，先在“设置 → 关于”核对实际客户端版本，再查看[官方 Releases](https://github.com/kse-music/operations/releases) 的更新说明。文档的适用范围以正文说明为准，不会随安装包发布自动更新。

### SFTP 新建权限

v0.9.3 代码基线中，新文件上传和普通单文件中转默认请求 `0644`，新建目录默认请求 `0755`，受服务端 umask 和策略限制。覆盖与编辑的暂存仍以 `0600` 创建，再保留原目标权限及属主提交。合并已有目录不改权限，不复制本地源权限位。

此项不能作为 v0.9.2 已分发安装包的行为承诺。操作时以实际版本及服务器最终权限为准。

## SDK 与插件协议

开发者中心公开规范的 SDK 版本为 **{{ manifest.sdkVersion }}**。它与客户端产品版本、插件自己的版本分别管理：

| 范围                          | 当前规范                      |
| ----------------------------- | ----------------------------- |
| Host API / Rust SDK / Vue SDK | {{ manifest.sdkVersion }}     |
| 插件包与 Manifest schema      | {{ manifest.packageVersion }} |
| WASM ABI / wire               | {{ manifest.abiVersion }}     |
| UI 扩展                       | {{ manifest.uiVersion }}      |

开发包统一从官网[按 SDK 版本下载](/developers/downloads.html)，开发前核对客户端支持的 SDK 与所选开发包。文档的版本说明不会为旧执行协议增加兼容、放宽权限或恢复失效授权，详见[版本契约](/developers/reference/versions.html)。

## 平台和能力边界

Windows x64 是当前正式下载平台；其他平台、架构、本地 CLI 与原生安装升级行为需要各自验收。源码能够构建不等于完整平台支持。

当前没有云同步、团队权限、插件在线下载安装、集中监控平台或持久任务中心。官网的[插件市场](/marketplace.html)使用静态目录展示，下载功能仍在建设中。运行期会话与任务不跨应用重启恢复。
