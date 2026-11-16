# ServerDeck 产品官网

独立 npm 项目，产品首页使用 Vue 3 + Vite，用户文档和插件开发者中心使用 VitePress。三者沿用深色、薄荷绿与相同品牌标识，合并输出纯静态 `dist/`。正式域名为 `https://ops.hiboot.cn`。

## 项目边界

`website/` 是独立 npm 项目，使用自己的 `package.json`、`package-lock.json`、TypeScript 和 Vite 配置，不属于仓库根目录的 npm workspace。源码、构建脚本和静态资源均在本目录内，可将整个目录复制到其他位置，安装自身依赖后单独开发、测试和构建。

不调用桌面 IPC、主机、模型或业务数据库。首页工作台使用明确标注的演示数据。当前仅提供产品信息、站内文档与官方下载入口；没有插件市场、账户、付款或在线安装功能。

## 开发与构建

需要 Node.js 22.13+。在本目录执行：

```powershell
npm ci
npm run dev
```

开发启动两个本地服务：官网 `http://127.0.0.1:4180/`，文档 `http://127.0.0.1:4181/docs/` 与开发者中心 `/developers/`。开发时的链接会在两个服务间导航；生产构建全部使用同域路径。也可分别运行 `npm run dev:site` 或 `npm run dev:docs`。

```powershell
npm test
npm run build
npm run preview
```

生产预览只需要 `http://127.0.0.1:4180/` 一个服务。构建先预渲染官网，再生成 VitePress 页面，合并产物并检查站内链接、章节锚点、静态资源、canonical、sitemap 和 SDK 快照摘要。中间产物与缓存位于 `.ssr/`，不进入源码格式检查。

开发模式每次打开搜索都会从当前文档重新读取索引，编辑后重新打开弹窗即可检索新内容。生产构建会全量生成静态索引，发布时与 HTML 一起部署。

VitePress 固定为稳定版 1.6.4，其嵌套 Vite 通过 `overrides` 固定为 6.4.6，避开旧版开发服务器的已知问题。官网继续使用自己的 Vite 8。升级时同时验证类型、完整构建、文档搜索与两个开发服务；不要移除覆盖后重新引入旧依赖。

首页“下载客户端”使用固定的 `https://github.com/kse-music/operations/releases/latest`，进入 GitHub 最新正式发布页后由用户选择 Windows x64 安装包。官网不保存或展示具体产品分发版本和包大小，结构化数据也不绑定某个安装包；仅发布产品新版无需同步下载信息或重新部署官网。功能、限制或 SDK 契约变化时仍需按实际情况更新文档。

站点正式地址为 `https://ops.hiboot.cn`。需要切换域名时，在构建进程中设置 `WEBSITE_ORIGIN` 为无路径的 HTTPS 源，再重新构建；该值用于 canonical、分享元数据、结构化数据、robots 与 sitemap。不会修改桌面应用的更新源。

## 内容与入口

- `src/App.vue`：首页、导航、首屏下载入口及页脚；`components/WorkspacePreview.vue` 为可切换的界面演示，明确使用示例数据，不连接或操作服务器。
- `src/components/InfoPage.vue`：隐私与安全正文。
- `src/components/SiteHeader.vue`：官网与文档共用的单行页头、菜单和布局尺寸。`SiteControls.vue` 在同一行提供全文搜索、Ctrl / ⌘ K 和深浅主题，手机端收起文字；文档通过 `DocsHeader.vue` 接入，不设置第二行工具栏或另一套导航。
- `src/content.ts`：固定的最新发布页、站内文档入口、功能介绍和常见问题。
- `src/style.css`、`src/site.css`：A 方案基础样式及官网样式；不依赖外部字体、CDN、分析埋点、Cookie、账号或表单。
- `scripts/prerender.mjs`：输出完整正文与页面元数据；分享图位于 `public/assets/social-card.png`。
- `.openai/hosting.json`：Sites 的站点身份与静态产物位置。

- `documentation/docs/`：安装、连接、终端、SFTP、Docker、AI、插件管理与排障。
- `documentation/developers/`：插件入门、UI / WASM、权限、测试、打包教程；`reference/` 保存 SDK 规范快照。
- `documentation/.vitepress/`：导航、侧栏、中文搜索、主题与 SEO。
- `scripts/assemble.mjs`、`scripts/check-docs.mjs`：合并静态产物及完整性检查。

`documentation/docs/` 是用户指南的唯一维护位置，`documentation/developers/` 中参考规范以外的页面是开发者教程的唯一维护位置。产品仓库及开发包 README 只链接官网，不再保留教程正文。用户操作和开发流程变化时直接修订这里并同步导航；内部阅读链接使用 `/docs/xxx.html`、`/developers/xxx.html` 或目录首页 `/docs/`，不指向 GitHub Markdown。源码、Release 与问题反馈继续指向 GitHub。

文档使用静态预渲染、代码高亮与复制、左右侧栏、页内目录和上一篇 / 下一篇。全站共用浏览器内中文全文搜索：`scripts/search-index.mjs` 从文档正文生成 `search-index.json`，首页与文档使用同一索引；两个开发服务分别提供同源索引接口，生产合并为单一静态文件。查询只在浏览器处理，没有外部字体或搜索服务。

全站主题使用同一个 `vitepress-theme-appearance` 本地偏好，默认深色，首页也提供实际浅色配色。头部初始化脚本在首屏绘制前应用偏好；开发时跨 4180 / 4181 导航携带外观选择并立即从地址中移除，生产同域直接共享本地偏好。没有 Cookie、分析埋点或账户。

## 同步公开 SDK 规范

SDK 规范原文由产品仓库的 `docs/plugins/` 维护，包含源码与构建、SDK、UI、包格式、运行时、安全、版本等九篇契约；网站的 `reference/` 仅保存可独立构建的版本化快照。教程不能反向改写契约，公开规范也不包含入门操作教程。需要更新时先修改并核对产品 SDK 与契约，再显式指定产品源码根目录：

```sh
npm run docs:import -- --source D:/path/to/product-source
npm test
npm run build
```

导入会覆盖九篇规范，改写规范之间的阅读链接，在 `documentation/reference-manifest.json` 记录 SDK / UI / ABI / 包版本、来源 SHA-256 与站内文件 SHA-256。代码与路径占位符按字面显示。不要单独修改快照正文；导入后审核差异、同步教程及适用版本，再一起提交。构建验证快照摘要，不联网、不隐式导入，也不把 SDK 版本等同于客户端产品版本。

## 静态部署

部署完整 `dist/` 到静态托管根目录，包含 `docs/`、`developers/`、`docs-assets/`、`assets/`、许可文件和根目录 HTML。文档使用 `.html` 路径，服务须支持目录 `index.html`，例如 `/docs/`，以及深层 HTML 直达。

未知路径返回真正的 HTTP 404，可使用根目录 `404.html`。不要统一回退首页 `index.html`，否则文档链接故障会被伪装成成功。首页、HTML、`hashmap.json`、`search-index.json`、`appearance-init.js`、robots 和 sitemap 应重新验证；带哈希的 JS / CSS 可长期缓存。更新采用完整目录替换，避免旧 HTML 引用已删除的资源。修改域名解析或替换已有线上目录前，先确认目标服务与回退方式，保留现有数据及配置。

Sites 发布使用相同身份及完整静态产物，不上传仓库中的客户端、QA 记录、应用数据或任何凭据。站点访问范围与自定义域名/DNS 是独立配置；部署成功不代表自定义域名已经解析或允许公开访问。托管平台的访问控制和网络日志以实际平台配置为准。

发布前检查正文、最新发布页与安装包和文档可达性、桌面与手机布局、键盘导航、FAQ、静态预渲染、元数据，以及隐私和安全页面。网站检查不代替桌面安装包的发布验收。
