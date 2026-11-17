import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { siteOrigin } from './site-config.mjs';

const source = fileURLToPath(new URL('../.ssr/documentation/dist/', import.meta.url));
const destination = fileURLToPath(new URL('../dist/', import.meta.url));
async function merge(relative = '') {
  for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (child === '404.html') continue; // Preserve the existing whole-site 404 page.
    if (entry.isSymbolicLink()) throw new Error(`文档产物不允许链接：${child}`);
    if (entry.isDirectory()) {
      await mkdir(path.join(destination, child), { recursive: true });
      await merge(child);
    } else {
      const target = path.join(destination, child);
      let existing;
      try {
        existing = await readFile(target);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (existing && !existing.equals(await readFile(path.join(source, child))))
        throw new Error(`官网与文档产物路径冲突：${child}`);
      await copyFile(path.join(source, child), target);
    }
  }
}
await merge();
const routes = ['/', '/marketplace.html', '/privacy.html', '/security.html'];
async function collect(relative) {
  for (const entry of await readdir(path.join(destination, relative), { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await collect(child);
    else if (entry.name.endsWith('.html')) routes.push(`/${child}`.replace(/\/index\.html$/, '/'));
  }
}
await collect('docs');
await collect('developers');
await writeFile(
  path.join(destination, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map((route) => `<url><loc>${siteOrigin}${route}</loc></url>`).join('')}</urlset>\n`,
);
console.log(`官网与文档已合并：${routes.length} 个可索引页面。`);
