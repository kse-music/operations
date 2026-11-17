import { readFile, writeFile } from 'node:fs/promises';
import { render } from '../.ssr/entry-server.js';
import { siteOrigin as origin } from './site-config.mjs';

// A real origin is supplied by Sites or the explicitly selected custom domain.
const pages = [
  ['index.html', 'home', '/'],
  ['marketplace.html', 'marketplace', '/marketplace.html'],
  ['privacy.html', 'privacy', '/privacy.html'],
  ['security.html', 'security', '/security.html'],
  ['404.html', 'not-found', '/404.html'],
];
for (const [file, page, path] of pages) {
  const target = new URL(`../dist/${file}`, import.meta.url);
  let html = await readFile(target, 'utf8');
  if (!html.includes('<!--app-html-->')) throw new Error(`${file} 缺少预渲染插入点。`);
  html = html.replace('<!--app-html-->', await render(page));
  if (page !== 'not-found')
    html = html.replace(
      '</head>',
      `<link rel="canonical" href="${origin}${path}" /><meta property="og:url" content="${origin}${path}" /><meta property="og:image" content="${origin}/assets/social-card.png" /></head>`,
    );
  if (page === 'home') {
    const data = {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'ServerDeck',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Windows',
      url: origin,
      license: 'https://github.com/kse-music/operations/blob/main/LICENSE',
      description: '本地服务器工作台，通过 SSH/SFTP 管理终端、文件和 Docker，并提供 AI 运维助手。',
    };
    html = html.replace(
      '</head>',
      `<script type="application/ld+json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script></head>`,
    );
  }
  await writeFile(target, html);
}
await writeFile(
  new URL('../dist/sitemap.xml', import.meta.url),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages
    .filter(([, page]) => page !== 'not-found')
    .map(([, , path]) => `<url><loc>${origin}${path}</loc></url>`)
    .join('')}</urlset>\n`,
);
await writeFile(
  new URL('../dist/robots.txt', import.meta.url),
  `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
);
console.log(`已预渲染 ${pages.length} 个页面，并生成 canonical、结构化数据与 sitemap。`);
