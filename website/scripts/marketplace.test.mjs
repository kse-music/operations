import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

let server;
let catalog;
let render;
let pageFromPath;
let SiteHeader;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    plugins: [vue()],
    server: { middlewareMode: true },
    appType: 'custom',
  });
  catalog = await server.ssrLoadModule('/src/marketplace.ts');
  ({ render } = await server.ssrLoadModule('/src/entry-server.ts'));
  ({ pageFromPath } = await server.ssrLoadModule('/src/pages.ts'));
  ({ default: SiteHeader } = await server.ssrLoadModule('/src/components/SiteHeader.vue'));
});
after(async () => server?.close());

test('插件市场有独立路由，未知地址仍保持 404', () => {
  assert.equal(pageFromPath('/marketplace.html'), 'marketplace');
  assert.equal(pageFromPath('/'), 'home');
  assert.equal(pageFromPath('/missing.html'), 'not-found');
});

test('分类和关键词共同筛选名称、描述、标签及作者，空结果不伪造内容', () => {
  const { filterPlugins, marketplacePlugins } = catalog;
  assert.equal(filterPlugins('', '全部插件', 'recommended').length, marketplacePlugins.length);
  assert.deepEqual(
    filterPlugins('  REDIS  ', '数据库', 'recommended').map((item) => item.id),
    ['redis'],
  );
  assert.deepEqual(filterPlugins('Redis', 'AI 助手', 'recommended'), []);
  assert.deepEqual(filterPlugins('不存在的插件', '全部插件', 'recommended'), []);
  assert.deepEqual(
    filterPlugins('pod 终端', '全部插件', 'recommended').map((item) => item.id),
    ['kubernetes'],
  );
  assert.deepEqual(
    filterPlugins('ServerDeck', '全部插件', 'recommended').map((item) => item.id),
    ['docker', 'assistant'],
  );
  assert.equal(new Set(marketplacePlugins.map((item) => item.id)).size, marketplacePlugins.length);
});

test('最新更新和名称排序可用，排序不会改写默认目录', () => {
  const { filterPlugins, marketplacePlugins } = catalog;
  const original = marketplacePlugins.map((item) => item.id);
  const updated = filterPlugins('', '全部插件', 'updated');
  assert.equal(updated[0].id, 'redis');
  assert.ok(
    updated.every((item, index) => !index || updated[index - 1].updatedAt >= item.updatedAt),
  );
  const named = filterPlugins('', '全部插件', 'name');
  assert.ok(
    named.every(
      (item, index) => !index || named[index - 1].name.localeCompare(item.name, 'zh-CN') <= 0,
    ),
  );
  assert.deepEqual(
    marketplacePlugins.map((item) => item.id),
    original,
  );
});

test('首屏预渲染真实市场内容、当前导航及按钮，不提供伪下载地址', async () => {
  const html = await render('marketplace');
  assert.match(html, /id="marketplace-title">插件市场/);
  assert.match(html, /href="\/marketplace\.html" class="active" aria-current="location"/);
  assert.equal(
    (html.match(/class="market-card(?:\s|"|$)/g) || []).length,
    catalog.marketplacePlugins.length,
  );
  for (const plugin of catalog.marketplacePlugins) {
    assert.ok(html.includes(plugin.name));
    assert.ok(html.includes(`aria-label="下载${plugin.name}"`));
  }
  assert.ok(!html.includes('.sdplugin'));
  assert.ok(!html.includes('download='));
});

test('官网和文档导航均可进入市场，开发服务使用正确站点源', async () => {
  const home = await render('home');
  assert.ok(home.includes('href="/marketplace.html"'));
  for (const section of ['docs', 'developers']) {
    const html = await renderToString(createSSRApp(SiteHeader, { section }));
    assert.ok(html.includes('href="http://127.0.0.1:4180/marketplace.html"'));
    assert.ok(html.includes('href="/docs/"'));
    assert.ok(html.includes('href="/developers/"'));
  }
});
