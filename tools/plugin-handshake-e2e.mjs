// UI protocol regression: real PluginFrame + packaged SDK/Vue, no native or remote calls.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { discoverSystemPlugins } from './system-plugins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const qa = path.join(root, '.local/qa/plugin-handshake');
await mkdir(qa, { recursive: true });
const inputs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (await discoverSystemPlugins(root)).map(({ destination }) => path.join(root, destination));
const packages = await Promise.all(
  inputs.map(async (file) => {
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    const ui = JSON.parse(
      Buffer.from(pkg.files.find((entry) => entry.path === 'ui.json').content, 'base64'),
    );
    return { ...pkg, ui };
  }),
);
const script = path.join(qa, 'harness.ts');
await writeFile(
  script,
  `import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PluginFrame from '/src/components/PluginFrame.vue';
import { useModelsStore } from '/src/stores/models';
import { usePluginsStore } from '/src/stores/plugins';
let app, pinia;
window.mountHandshake = (pkg) => {
  app?.unmount();
  pinia = createPinia();
  useModelsStore(pinia).refresh = async () => {};
  const plugin = {
    source: 'system', manifest: pkg.manifest, enabled: true, revision: 'handshake',
    packageDigest: 'ui-fixture', trust: 'local_development_unverified', previousVersion: null,
  };
  const plugins = usePluginsStore(pinia);
  plugins.installed = [plugin];
  plugins.grants[pkg.manifest.id] = {
    version: 1, pluginId: pkg.manifest.id, pluginVersion: pkg.manifest.version,
    publisher: null, packageDigest: plugin.packageDigest, revision: plugin.revision,
    permissions: pkg.manifest.permissions, operations: pkg.manifest.permissions,
    readRoots: [], writeRoots: [],
  };
  app = createApp(PluginFrame, {
    pluginId: pkg.manifest.id, revision: plugin.revision,
    page: pkg.ui.pages[0], hostId: '', active: true,
  }).use(pinia);
  app.mount('#fixture');
};
window.handshakeHarnessReady = true;
`,
);
const html = path.join(qa, 'harness.html');
await writeFile(
  html,
  `<!doctype html><meta charset="utf-8"><div id="fixture"></div><script type="module" src="/@fs/${script.replaceAll('\\', '/')}"></script>`,
);
const server = await createServer({
  root: path.join(root, 'apps/desktop'),
  configFile: path.join(root, 'apps/desktop/vite.config.ts'),
  server: { host: '127.0.0.1', port: 19429, strictPort: true },
});
let browser;
const results = [];
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath:
      process.env.SERVERDECK_BROWSER ??
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.route('http://sdplugin.localhost/**', async (route) => {
    const [, id, , , asset] = new URL(route.request().url()).pathname.split('/');
    const pkg = packages.find((item) => item.manifest.id === id);
    assert(pkg, `Unknown package ${id}`);
    let body, contentType;
    if (asset === 'index.html') {
      body = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${pkg.ui.frontend.style}"><div id="app"></div><script type="module" src="${pkg.ui.frontend.script}"></script>`;
      contentType = 'text/html';
    } else {
      const file = pkg.files.find((item) => item.path === asset);
      assert(file, `Missing ${asset}`);
      body = Buffer.from(file.content, 'base64');
      contentType = asset.endsWith('.css') ? 'text/css' : 'text/javascript';
    }
    await route.fulfill({
      contentType,
      body,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Security-Policy':
          "default-src 'none'; script-src http://sdplugin.localhost; style-src http://sdplugin.localhost 'unsafe-inline'; connect-src 'none'; sandbox allow-scripts allow-forms",
      },
    });
  });
  await page.goto(`http://127.0.0.1:19429/@fs/${html.replaceAll('\\', '/')}`);
  await page.waitForFunction(() => window.handshakeHarnessReady === true);
  for (const pkg of packages) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.evaluate((value) => window.mountHandshake(value), pkg);
      try {
        await page.frameLocator('iframe').locator('#app > *').first().waitFor({ timeout: 10000 });
      } catch (error) {
        console.error(
          JSON.stringify({
            id: pkg.manifest.id,
            errors,
            host: await page.locator('body').innerText(),
          }),
        );
        await page.screenshot({ path: path.join(qa, 'browser-failure.png') });
        throw error;
      }
      assert.equal(await page.getByText('正在加载插件界面…').count(), 0);
      assert.equal(await page.getByText('插件界面加载超时', { exact: false }).count(), 0);
      results.push({
        id: pkg.manifest.id,
        version: pkg.manifest.version,
        attempt,
        mounted: true,
      });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(qa, 'browser-after.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await browser?.close();
  await server.close();
}
