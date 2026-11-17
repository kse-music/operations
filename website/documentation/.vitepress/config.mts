import { defineConfig } from 'vitepress';
import { fileURLToPath } from 'node:url';
import { siteOrigin } from '../../scripts/site-config.mjs';
import manifest from '../reference-manifest.json';
import { searchIndexPlugin, writeSearchIndex } from '../../scripts/search-index.mjs';

export default defineConfig({
  lang: 'zh-CN',
  title: 'ServerDeck',
  titleTemplate: ':title · ServerDeck 文档',
  description: 'ServerDeck 用户文档与插件开发者中心。',
  appearance: 'dark',
  cleanUrls: false,
  // Marketing pages are built separately; docs:check validates the merged output.
  ignoreDeadLinks: ['/index', '/marketplace', '/privacy', '/security'],
  outDir: fileURLToPath(new URL('../../.ssr/documentation/dist/', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../../.ssr/documentation/cache/', import.meta.url)),
  assetsDir: 'docs-assets',
  vite: {
    publicDir: fileURLToPath(new URL('../../public/', import.meta.url)),
    resolve: {
      alias: [
        {
          find: /^\.\/components\/VPNav\.vue$/,
          replacement: fileURLToPath(new URL('./theme/DocsHeader.vue', import.meta.url)),
        },
      ],
    },
    plugins: [searchIndexPlugin(fileURLToPath(new URL('../', import.meta.url)))],
  },
  async buildEnd(config) {
    await writeSearchIndex(config.srcDir, config.outDir);
  },
  head: [
    ['script', { src: '/appearance-init.js' }],
    ['link', { rel: 'icon', href: '/assets/serverdeck.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#0e1414' }],
  ],
  transformHead({ pageData }) {
    const path = '/' + pageData.relativePath.replace(/\.md$/, '.html').replace(/index\.html$/, '');
    return [
      ['link', { rel: 'canonical', href: siteOrigin + path }],
      ['meta', { property: 'og:title', content: `${pageData.title} · ServerDeck` }],
      ['meta', { property: 'og:image', content: `${siteOrigin}/assets/social-card.png` }],
      ['meta', { property: 'og:url', content: siteOrigin + path }],
    ];
  },
  markdown: {
    lineNumbers: true,
    config(md) {
      const renderInlineHtml = md.renderer.rules.html_inline!;
      md.renderer.rules.html_inline = (tokens, index, options, env, renderer) => {
        // Escape specification placeholders such as <ID>, but preserve generated anchor symbols.
        if (
          env.relativePath?.startsWith('developers/reference/') &&
          !tokens[index].meta?.isPermalinkSymbol
        ) {
          return md.utils.escapeHtml(tokens[index].content);
        }
        return renderInlineHtml(tokens, index, options, env, renderer);
      };
    },
  },
  themeConfig: {
    sidebar: {
      '/docs/': [
        {
          text: '开始使用',
          items: [
            { text: '文档首页', link: '/docs/' },
            { text: '安装与升级', link: '/docs/installation' },
            { text: '连接第一台主机', link: '/docs/quickstart' },
            { text: '工作区与主机', link: '/docs/hosts' },
          ],
        },
        {
          text: '日常工作',
          items: [
            { text: '终端与快捷键', link: '/docs/terminal' },
            { text: 'SFTP 文件管理', link: '/docs/files' },
            { text: 'Docker 与 Compose', link: '/docs/docker' },
            { text: 'AI 助手与模型', link: '/docs/assistant' },
            { text: '安装和管理插件', link: '/docs/plugins' },
          ],
        },
        {
          text: '数据与支持',
          items: [
            { text: '设置与数据', link: '/docs/settings' },
            { text: '安全与隐私', link: '/docs/security' },
            { text: '常见问题与排障', link: '/docs/troubleshooting' },
            { text: '版本与适用范围', link: '/docs/versions' },
            { text: '开源许可', link: '/docs/license' },
          ],
        },
      ],
      '/developers/': [
        {
          text: '开发入门',
          items: [
            { text: '开发者中心', link: '/developers/' },
            { text: '开发包下载', link: '/developers/downloads' },
            { text: '第一个插件', link: '/developers/quickstart' },
            { text: 'UI 与 WASM 协作', link: '/developers/ui-and-backend' },
            { text: '权限与审批', link: '/developers/permissions' },
            { text: '调试与测试', link: '/developers/testing' },
            { text: '打包与安装', link: '/developers/packaging' },
          ],
        },
        {
          text: `SDK ${manifest.sdkVersion} 公开规范`,
          items: [
            { text: 'SDK / API 参考', link: '/developers/reference/sdk' },
            { text: '插件架构', link: '/developers/reference/architecture' },
            { text: '源码与构建契约', link: '/developers/reference/development' },
            { text: 'UI 扩展契约', link: '/developers/reference/ui' },
            { text: '包格式', link: '/developers/reference/package-format' },
            { text: 'WASM 运行时与 ABI', link: '/developers/reference/runtime' },
            { text: '权限与安全契约', link: '/developers/reference/security' },
            { text: '版本与兼容性', link: '/developers/reference/versions' },
            { text: '内置插件与分发', link: '/developers/reference/builtins' },
          ],
        },
      ],
    },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    sidebarMenuLabel: '章节导航',
    returnToTopLabel: '回到顶部',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换浅色模式',
    darkModeSwitchTitle: '切换深色模式',
    notFound: {
      title: '页面未找到',
      quote: '从文档首页继续，或搜索你需要的主题。',
      linkLabel: '返回使用文档',
      linkText: '返回使用文档',
    },
    footer: { message: '让每一次连接，都更从容。', copyright: '© 2026 ServerDeck contributors' },
  },
});
