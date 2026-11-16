import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const decodeHtml = (value) =>
  value.replace(/&(?:amp|quot|apos|lt|gt|#(\d+)|#x([\da-f]+));/gi, (entity, dec, hex) => {
    if (dec || hex) return String.fromCodePoint(parseInt(dec || hex, hex ? 16 : 10));
    return { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }[
      entity.toLowerCase()
    ];
  });

export async function collectFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, name)));
    else files.push(name);
  }
  return files;
}

export function inspectHtml(html) {
  const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), ([, id]) => decodeHtml(id)));
  const links = Array.from(
    html.matchAll(/<(?:a|link|script|img)\b[^>]*?\b(?:href|src)="([^"]+)"/g),
    ([, value]) => decodeHtml(value),
  );
  return { ids, links };
}

export function checkLink(value, page, pages, files, origin) {
  const url = new URL(value, `${origin}/${page}`);
  if (url.hostname === 'github.com' && /\/blob\/[^/]+\/.*\.md$/i.test(url.pathname)) {
    throw new Error(`文档仍跳转 GitHub Markdown：${value}`);
  }
  if (url.origin !== origin) return;
  const pathname = decodeURIComponent(url.pathname).slice(1);
  const target = pathname.endsWith('/') || !pathname ? `${pathname}index.html` : pathname;
  if (!files.has(target)) throw new Error(`站内目标不存在：${value}`);
  if (
    url.hash &&
    pages.has(target) &&
    !pages.get(target).ids.has(decodeURIComponent(url.hash.slice(1)))
  ) {
    throw new Error(`站内锚点不存在：${value}`);
  }
}

export async function verifySnapshots(documentationRoot) {
  const manifest = JSON.parse(
    await readFile(path.join(documentationRoot, 'reference-manifest.json'), 'utf8'),
  );
  for (const entry of manifest.documents) {
    const content = await readFile(path.join(documentationRoot, entry.file));
    if (createHash('sha256').update(content).digest('hex') !== entry.contentSha256) {
      throw new Error(`SDK 规范快照发生未同步的修改：${entry.file}；请使用 docs:import 重新导入。`);
    }
  }
  return manifest;
}

export async function verifySite(dist, documentationRoot, origin) {
  const manifest = await verifySnapshots(documentationRoot);
  const files = new Set(await collectFiles(dist));
  const pages = new Map();
  const errors = [];
  for (const file of files) {
    if (file.endsWith('.html'))
      pages.set(file, inspectHtml(await readFile(path.join(dist, file), 'utf8')));
  }
  for (const [file, page] of pages) {
    for (const link of page.links) {
      try {
        checkLink(link, file, pages, files, origin);
      } catch (error) {
        errors.push(`${file}: ${error.message}`);
      }
    }
  }
  const sitemap = await readFile(path.join(dist, 'sitemap.xml'), 'utf8');
  const search = JSON.parse(await readFile(path.join(dist, 'search-index.json'), 'utf8'));
  if (search.version !== 1 || !search.index?.storedFields)
    throw new Error('缺少可用的站内搜索索引');
  const indexedPages = new Set();
  for (const section of Object.values(search.index.storedFields)) {
    try {
      checkLink(section.url, 'index.html', pages, files, origin);
    } catch (error) {
      errors.push(`搜索结果：${error.message}`);
    }
    indexedPages.add(section.url.split('#')[0]);
  }
  const sourcePages = (await collectFiles(documentationRoot)).filter((file) =>
    /^(docs|developers)\/.+\.md$/.test(file),
  );
  for (const source of sourcePages) {
    const target = source.replace(/\.md$/, '.html');
    const route = `/${target}`.replace(/\/index\.html$/, '/');
    if (!pages.has(target)) errors.push(`文档未生成：${source}`);
    if (!sitemap.includes(`<loc>${origin}${route}</loc>`)) errors.push(`站点地图未收录：${route}`);
    if (!pages.get(target)?.links.includes(`${origin}${route}`))
      errors.push(`canonical 缺失或错误：${route}`);
    if (!indexedPages.has(route)) errors.push(`搜索未收录：${route}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return {
    pages: pages.size,
    documentationPages: sourcePages.length,
    references: manifest.documents.length,
  };
}
