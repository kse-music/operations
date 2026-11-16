import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMarkdownRenderer } from 'vitepress';
import MiniSearch from 'minisearch';
import { searchOptions } from '../src/search-options.mjs';

const plain = (html) =>
  html
    .replace(/<a\b[^>]*class="header-anchor"[^>]*>[\s\S]*?<\/a>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(
      /&(?:amp|quot|apos|lt|gt|nbsp|ZeroWidthSpace|#(\d+)|#x([\da-f]+));/gi,
      (entity, dec, hex) => {
        if (dec || hex) return String.fromCodePoint(parseInt(dec || hex, hex ? 16 : 10));
        return {
          '&amp;': '&',
          '&quot;': '"',
          '&apos;': "'",
          '&lt;': '<',
          '&gt;': '>',
          '&nbsp;': ' ',
          '&zerowidthspace;': '',
        }[entity.toLowerCase()];
      },
    )
    .replace(/\s+/g, ' ')
    .trim();

export function sectionsFromHtml(html, route, pageTitle) {
  const headings = [...html.matchAll(/<h([1-3])\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)];
  return headings
    .map((heading, index) => {
      const text = plain(html.slice(heading.index + heading[0].length, headings[index + 1]?.index));
      const url = heading[1] === '1' ? route : route + '#' + heading[2];
      return { id: url, url, pageTitle, title: plain(heading[3]), text };
    })
    .filter((section) => section.title && section.text);
}

async function markdownFiles(root, relative) {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(root, name)));
    else if (entry.name.endsWith('.md')) files.push(name);
  }
  return files;
}

export async function createSearchIndex(root) {
  const md = await createMarkdownRenderer(root);
  const manifest = JSON.parse(await readFile(path.join(root, 'reference-manifest.json'), 'utf8'));
  const sections = [];
  const files = [
    ...(await markdownFiles(root, 'docs')),
    ...(await markdownFiles(root, 'developers')),
  ];
  for (const file of files) {
    const source = (await readFile(path.join(root, file), 'utf8'))
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace(/\{\{\s*manifest\.(\w+)\s*\}\}/g, (match, key) => String(manifest[key] ?? match));
    const env = { path: path.join(root, file), relativePath: file };
    const html = md.render(source, env);
    if (env.frontmatter?.search === false) continue;
    const route = '/' + file.replace(/\.md$/, '.html').replace(/index\.html$/, '');
    sections.push(...sectionsFromHtml(html, route, env.frontmatter?.title || env.title));
  }
  const index = new MiniSearch(searchOptions);
  index.addAll(sections);
  return { version: 1, index: index.toJSON() };
}

export async function writeSearchIndex(root, outDir) {
  await writeFile(
    path.join(outDir, 'search-index.json'),
    JSON.stringify(await createSearchIndex(root)) + '\n',
  );
}

export function searchIndexPlugin(root) {
  return {
    name: 'serverdeck:document-search',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/search-index.json') return next();
        try {
          const result = await createSearchIndex(root);
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify(result));
        } catch (error) {
          server.config.logger.error(`文档搜索索引生成失败：${error.message}`);
          response.statusCode = 500;
          response.end('文档搜索索引生成失败');
        }
      });
    },
  };
}
