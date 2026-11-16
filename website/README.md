# ServerDeck 产品官网

沿用深色与品牌薄荷绿视觉，独立于桌面应用构建。官网使用 Vue 3 Composition API、严格 TypeScript 和 Vite；生产构建预渲染首页、隐私、安全与 404 页面，输出纯静态 `dist/`。不调用桌面 IPC、主机、模型或业务数据库。

## 项目边界

`website/` 是独立 npm 项目，使用自己的 `package.json`、`package-lock.json`、TypeScript 和 Vite 配置，不属于仓库根目录的 npm workspace。源码、构建脚本和静态资源均在本目录内，可将整个目录复制到其他位置，安装自身依赖后单独开发、测试和构建。

本项目独立维护，下载、使用文档和许可说明通过公开 GitHub URL 访问，不依赖本地仓库的其他目录。

## 开发与构建

需要 Node.js 22.13+。在本目录执行：

```powershell
npm ci
npm run dev
```

开发地址为 `http://127.0.0.1:4180/`。正式构建：

```powershell
npm run release:sync
npm test
npm run build
npm run preview
```

`release:sync` 从官方公开 GitHub 最新正式 Release 同步安装包元数据，只接受同仓库、同正式版本的 Windows 安装包和签名链接。网络、版本或文件校验失败时返回非零并保留已有快照；构建不会联网或隐式改变下载版本。公开新安装包后，需重新同步、检查并发布官网。

站点正式地址为 `https://ops.hiboot.cn`。需要切换域名时，在构建进程中设置 `WEBSITE_ORIGIN` 为无路径的 HTTPS 源，再重新构建；该值用于 canonical、分享元数据、结构化数据、robots 与 sitemap。不会修改桌面应用的更新源。

## 内容与入口

- `src/App.vue`：首页、导航、下载及页脚；`components/WorkspacePreview.vue` 为可切换的界面演示，明确使用示例数据，不连接或操作服务器。
- `src/components/InfoPage.vue`：隐私与安全正文。
- `src/content.ts`：公开文档入口、功能介绍和常见问题；`src/release.json` 只记录已经公开的正式分发版本，不使用尚未发布的工作区版本。
- `src/style.css`、`src/site.css`：A 方案基础样式及官网样式；不依赖外部字体、CDN、分析埋点、Cookie、账号或表单。
- `scripts/prerender.mjs`：输出完整正文与页面元数据；分享图位于 `public/assets/social-card.png`。
- `.openai/hosting.json`：Sites 的站点身份与静态产物位置。

当前 Docker 专项指南尚未公开，入口使用已公开的使用指南对应章节。文档链接变更须核对远端页面与章节，不能只检查本地文件存在。

## 静态部署

将构建后的 `dist/` 部署到静态托管根目录。服务需支持 `/privacy.html` 和 `/security.html` 直达、未知路径返回真正的 404，并按托管平台配置 404 页面。首页和普通 HTML 应支持重新验证，带哈希的 JS/CSS 可采用长期缓存。修改域名解析或替换已有线上目录前，先确认目标服务与回退方式，保留现有数据及配置。

Sites 发布使用相同身份及完整静态产物，不上传仓库中的客户端、QA 记录、应用数据或任何凭据。站点访问范围与自定义域名/DNS 是独立配置；部署成功不代表自定义域名已经解析或允许公开访问。托管平台的访问控制和网络日志以实际平台配置为准。

发布前检查正文与下载版本、安装包和文档可达性、桌面与手机布局、键盘导航、FAQ、静态预渲染、元数据，以及隐私和安全页面。网站检查不代替桌面安装包的发布验收。
