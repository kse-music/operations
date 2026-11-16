import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';
import { createSearchIndex, sectionsFromHtml } from './search-index.mjs';
import { searchOptions } from '../src/search-options.mjs';

test('搜索章节保留真实阅读地址，去除标记并解码正文', () => {
  const html =
    '<h1 id="连接">连接 <a class="header-anchor" href="#连接">#</a></h1><p>先核对 SHA-256 指纹。</p><h2 id="代理">代理</h2><p>A &amp; B &lt;token&gt;</p>';
  const result = sectionsFromHtml(html, '/docs/hosts.html', '主机');
  assert.equal(result[0].url, '/docs/hosts.html');
  assert.equal(result[0].title, '连接');
  assert.equal(result[1].url, '/docs/hosts.html#代理');
  assert.equal(result[1].text, 'A & B <token>');
});

test('同一份全文索引可检索中文用户指南与英文开发者内容', async () => {
  const data = await createSearchIndex(
    fileURLToPath(new URL('../documentation/', import.meta.url)),
  );
  const index = MiniSearch.loadJSON(JSON.stringify(data.index), searchOptions);
  assert.ok(index.search('指纹').some((result) => result.url.startsWith('/docs/')));
  assert.ok(index.search('Skill').some((result) => result.url.startsWith('/developers/')));
  assert.ok(index.search('权限').some((result) => result.url.startsWith('/docs/')));
  assert.ok(index.search('权限').some((result) => result.url.startsWith('/developers/')));
  assert.deepEqual(index.search('zzzqxy-no-documents-927351'), []);
  const stored = Object.values(data.index.storedFields);
  assert.ok(stored.every((section) => !section.text.includes('import manifest')));
  assert.ok(stored.every((section) => !section.text.includes('{{ manifest.')));
});
