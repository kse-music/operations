// Isolated WebView2 integration. Empty-host rendering fixture; never connects SSH/SFTP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const qa = await realpath(process.argv[2]);
const expected = path.join(qa, 'desktop-data');
const port = await new Promise((resolve) => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1', () => {
    const value = socket.address().port;
    socket.close(() => resolve(value));
  });
});
const child = spawn(path.join(qa, 'PluginHandshakeQa.exe'), [], {
  cwd: qa,
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  },
});
let browser,
  page,
  safe = false;
const results = [],
  errors = [];
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
try {
  let endpoint;
  for (let attempt = 0; attempt < 100 && !endpoint; attempt++) {
    assert.equal(child.exitCode, null, 'QA exited before WebView2 was ready');
    try {
      endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch {}
    if (!endpoint) await delay(200);
  }
  assert(endpoint, 'QA WebView2 debugger unavailable');
  browser = await chromium.connectOverCDP(endpoint);
  for (let attempt = 0; attempt < 100 && !page; attempt++) {
    page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) await delay(100);
  }
  assert(page, 'QA main WebView unavailable');
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  assert.equal(
    path.resolve((await invoke('app_bootstrap')).dataDirectory),
    expected,
    'refuse daily data',
  );
  safe = true;
  let uploadedId;
  if (process.argv[3]) {
    const preview = await invoke('plugin_preview_info', { path: path.resolve(process.argv[3]) });
    const plugin = await invoke('plugin_install', {
      input: {
        path: path.resolve(process.argv[3]),
        developmentConfirmed: true,
        expectedVersion: null,
        expectedDigest: preview.packageDigest,
      },
    });
    assert.equal(plugin.enabled, false);
    assert.equal(plugin.source, 'user');
    uploadedId = plugin.manifest.id;
    await invoke('plugin_grant', {
      id: uploadedId,
      input: {
        expectedRevision: plugin.revision,
        permissions: plugin.manifest.permissions,
        operations: plugin.manifest.permissions,
        readRoots: [],
        writeRoots: [],
        confirmed: true,
      },
    });
    await invoke('plugin_set_enabled', { id: uploadedId, enabled: true });
    await page.evaluate(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      await pinia._s.get('plugins').refresh();
    });
  }
  const inventory = await invoke('plugin_inventory');
  assert.deepEqual(inventory.problems, []);
  const candidates = inventory.installed
    .filter((plugin) => !uploadedId || plugin.manifest.id === uploadedId)
    .map((plugin) => ({
      id: plugin.manifest.id,
      version: plugin.manifest.version,
      pageId: plugin.manifest.contributions.find((entry) => entry.kind !== 'settings').id,
    }));
  for (const candidate of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Exercise the production PluginView/PluginFrame with native package/WASM loading.
      // Only workspace selection is a fixture; there is deliberately no target host.
      await page.evaluate(async ({ id, pageId }) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const workspace = pinia._s.get('workspace');
        workspace.tabs = [];
        workspace.pluginPages = [];
        workspace.active = '';
        await new Promise((resolve) => setTimeout(resolve, 50));
        const key = `extension:${id}:${pageId}:`;
        const tab = { key, view: 'extension', hostId: '', pluginId: id, contributionId: pageId };
        workspace.pluginPages = [tab];
        workspace.tabs = [tab];
        workspace.active = key;
      }, candidate);
      const frame = page.frameLocator(
        `.plugin-frame-container[data-plugin-id="${candidate.id}"] iframe`,
      );
      await frame.locator('#app > *').first().waitFor({ timeout: 15000 });
      assert.equal(await page.getByText('插件界面加载超时', { exact: false }).count(), 0);
      assert.equal(
        await frame.locator('body').evaluate(async () => {
          if (typeof window.__TAURI_INTERNALS__?.invoke !== 'function') return true;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('native IPC probe had no observable result')),
              3000,
            );
            const finish = (blocked) => {
              clearTimeout(timer);
              document.removeEventListener('securitypolicyviolation', violation);
              resolve(blocked);
            };
            const violation = (event) => {
              if (event.effectiveDirective === 'connect-src') finish(true);
            };
            document.addEventListener('securitypolicyviolation', violation);
            window.__TAURI_INTERNALS__.invoke('app_bootstrap').then(
              () => finish(false),
              () => finish(true),
            );
          });
        }),
        true,
        'guest cannot call private native IPC',
      );
      assert.equal(
        await frame.locator('body').evaluate(() => {
          try {
            void parent.document.body;
            return false;
          } catch {
            return true;
          }
        }),
        true,
        'sandbox still rejects parent DOM access',
      );
      results.push({ ...candidate, attempt, mounted: true, sandboxPreserved: true });
      if (candidate.id.endsWith('.nginx'))
        await page.screenshot({ path: path.join(qa, `native-nginx-${attempt}.png`) });
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(await invoke('ops_connections'), []);
  assert.deepEqual(await invoke('files_connections'), []);
  await writeFile(
    path.join(qa, uploadedId ? 'native-upload-results.json' : 'native-results.json'),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results));
} finally {
  if (safe && child.exitCode === null) {
    await invoke('app_exit_confirm', { confirmed: false }).catch((error) => {
      console.error(`QA exit response: ${String(error)}`);
    });
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(10000).then(() => assert.notEqual(child.exitCode, null, 'QA did not exit normally')),
    ]);
  }
  await browser?.close();
}
