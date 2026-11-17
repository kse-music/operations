---
title: 插件开发包下载
description: 按 SDK 版本下载包含公开 SDK、锁文件、工具、样例和规范的独立插件开发包。
aside: false
---

<script setup>
import DevelopmentKitDownloads from '../.vitepress/theme/DevelopmentKitDownloads.vue'
import manifest from '../reference-manifest.json'
</script>

# 插件开发包下载

选择与你的客户端兼容的 SDK 版本。每个 ZIP 包含匹配版本的 Rust / TypeScript SDK、锁文件、构建工具、独立样例和九篇公开规范，无需 ServerDeck 源码或 Tauri 工具链。

<DevelopmentKitDownloads />

本页只列出实际提供的开发包。各版本使用独立下载地址，新增版本时保留已有版本；当前规范版本为 SDK **{{ manifest.sdkVersion }}**。

## 下载后开始

解压到独立目录，按[第一个插件](/developers/quickstart.html)准备环境、构建并安装样例。本站教程与当前规范版本配套；选择其他版本时，以该开发包内的规范和 SDK 类型为准，并核对[版本与兼容性](/developers/reference/versions.html)。

客户端 **设置 → 插件 → 开发者中心** 会在默认浏览器打开本站。插件开发包统一从官网获取，客户端不内置或导出 ZIP。
