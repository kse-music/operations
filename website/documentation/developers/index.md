---
title: 插件开发者中心
description: 从第一个插件到权限、UI、WASM 与打包，查阅 ServerDeck 的公开 SDK 和开发规范。
aside: false
---

<script setup>
import manifest from '../reference-manifest.json'
</script>

# 把运维经验，变成可复用的工具。

<p class="portal-intro">用 Vue 构建界面，用 WASM 承载业务。通过公开 SDK 调用连接、文件和模型能力，让宿主处理权限、身份与资源边界。</p>

<div class="portal-actions"><a href="/developers/quickstart.html">构建第一个插件 →</a><a href="/developers/reference/sdk.html">查阅 SDK 参考</a></div>

<div class="version-badges"><span>SDK {{ manifest.sdkVersion }}</span><span>UI v{{ manifest.uiVersion }}</span><span>ABI {{ manifest.abiVersion }}</span><span>包格式 {{ manifest.packageVersion }}</span></div>

<div class="portal-grid">
<a class="portal-card" href="/developers/quickstart.html"><small>01 / START</small><strong>从可运行样例开始</strong><span>下载独立开发包，准备环境，构建并安装第一个插件。</span></a>
<a class="portal-card" href="/developers/ui-and-backend.html"><small>02 / BUILD</small><strong>连接 UI 与业务动作</strong><span>明确 Vue、WASM 和平台之间的职责，处理状态与真实错误。</span></a>
<a class="portal-card" href="/developers/permissions.html"><small>03 / AUTHORIZE</small><strong>让能力拥有清楚的边界</strong><span>声明最小权限，理解审批、目录范围和安装修订。</span></a>
<a class="portal-card" href="/developers/packaging.html"><small>04 / DELIVER</small><strong>打包并验证交付</strong><span>校验版本、载荷、安装、升级与取消后的真实状态。</span></a>
</div>

## 教程和参考各司其职

入门教程帮助你完成一条可运行链路；[SDK 参考](/developers/reference/sdk.html)、[UI 契约](/developers/reference/ui.html)、[包格式](/developers/reference/package-format.html)和[安全契约](/developers/reference/security.html)定义精确字段与限制。

公开规范按 SDK 版本导入本站，构建和阅读都不依赖产品源码仓库的本地目录。SDK、插件业务版本与客户端版本分别管理，先核对实际开发包与[兼容性规则](/developers/reference/versions.html)。

## 当前交付方式

当前通过本地 `.sdplugin` 包安装和分发，没有在线市场或付费安装接口。开发者身份是包内自述，当前没有密码学签名验证；不能用作者信息或摘要代替来源核对。
