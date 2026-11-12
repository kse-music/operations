// Real WebView2, an isolated profile and a copied executable; no remote connections.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { closeNativeWindow } from './native-window-close.mjs';
import { navigateWorkspace, closeApplicationSettings } from './ui-navigation.mjs';

assert.equal(process.platform, 'win32', 'context menu QA requires Windows/WebView2');
const root = fileURLToPath(new URL('../', import.meta.url));
const reuse = process.argv[2] === '--reuse';
const artifacts = reuse
  ? path.resolve(process.argv[3])
  : path.join(root, '.local/qa/context-menu', String(Date.now()));
assert.equal(path.dirname(artifacts), path.join(root, '.local/qa/context-menu'));
await mkdir(artifacts, { recursive: true });
const config = path.join(artifacts, 'tauri-qa.json');
await writeFile(
  config,
  JSON.stringify({
    identifier: 'cn.hiboot.desktop.context-menu-qa',
    app: { appDirectoriesOverride: artifacts },
  }),
);
const executable = path.join(artifacts, 'ServerDeckContextMenuQA.exe');
function build(extra) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'tools/tauri.mjs'), 'build', '--debug', '--no-bundle', ...extra],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'native build failed');
}
if (!reuse) {
  try {
    build(['--config', config]);
    await copyFile(path.join(root, 'target/debug/serverdeck-desktop.exe'), executable);
  } finally {
    build([]);
  }
}

let child, browser, page, failure;
const passed = [];
async function checkMenu(scope, target, options = {}) {
  await scope.evaluate(() => {
    window.__contextMenuPrevented = null;
    document.addEventListener(
      'contextmenu',
      (event) => {
        window.__contextMenuPrevented = event.defaultPrevented;
      },
      { capture: true, once: true },
    );
  });
  const { key, ...mouse } = options;
  if (key) await target.press(key);
  else await target.click({ button: 'right', ...mouse });
  assert.equal(await scope.evaluate(() => window.__contextMenuPrevented), true);
}
async function quit() {
  if (!child || child.exitCode !== null) return;
  assert(page, 'cannot confirm QA application exit before CDP is connected');
  closeNativeWindow(child.pid);
  const dialog = page.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true });
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  for (let n = 0; n < 150 && child.exitCode === null; n++) await delay(100);
  assert.equal(child.exitCode, 0, 'isolated QA application must exit normally');
}
try {
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  child = spawn(executable, [], {
    cwd: artifacts,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  await writeFile(path.join(artifacts, 'runtime.json'), JSON.stringify({ pid: child.pid, port }));
  let websocket;
  for (let n = 0; n < 150; n++) {
    try {
      websocket = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch (error) {
      if (n === 149) throw error;
    }
    if (websocket) break;
    assert.equal(child.exitCode, null, 'native app exited before CDP connection');
    await delay(100);
  }
  assert(websocket, 'WebView2 CDP unavailable');
  browser = await chromium.connectOverCDP(websocket);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const invoke = (name, args = {}) =>
    page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), {
      name,
      args,
    });
  assert.equal(path.resolve((await invoke('app_bootstrap')).dataDirectory), artifacts);

  await checkMenu(page, page.locator('.workspace-empty'));
  await checkMenu(page, page.locator('.sidebar input').first());
  await checkMenu(page, page.locator('.group-toggle').first());
  await page.getByRole('menu', { name: '主机树操作', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await navigateWorkspace(page, '通用');
  await checkMenu(page, page.locator('.settings-page:visible').locator('h2').first());
  await closeApplicationSettings(page);
  passed.push(
    'Main window blank areas, inputs and teleported settings suppress the browser menu; host tree menu still opens',
  );

  await page.getByRole('button', { name: '本地终端', exact: true }).click();
  const terminal = page.locator('.terminal-pane:visible .xterm-container[data-state="connected"]');
  await terminal.waitFor();
  await checkMenu(page, terminal, { position: { x: 20, y: 20 } });
  await page.getByRole('menu', { name: '终端操作', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await checkMenu(page, page.locator('.workspace-tab [role="tab"]').first());
  await page.getByRole('menu', { name: '工作区标签操作', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  passed.push('Real local terminal and workspace tab business menus remain available');

  // Load the real installed plugin documents without a bridge: suppression must
  // work before SDK handshake, independently of plugin code and package age.
  const plugins = await invoke('plugin_list');
  assert(plugins.length > 0, 'bundled plugins required');
  for (const plugin of plugins) {
    const ui = await invoke('plugin_ui', { id: plugin.manifest.id, revision: plugin.revision });
    for (const entry of ui.pages) {
      const src = `http://sdplugin.localhost/${plugin.manifest.id}/${plugin.revision}/${entry.id}/index.html`;
      const element = await page.evaluateHandle((src) => {
        const iframe = document.createElement('iframe');
        iframe.id = 'context-menu-qa';
        iframe.sandbox = 'allow-scripts allow-forms';
        iframe.style.cssText =
          'position:fixed;inset:120px auto auto 320px;width:500px;height:300px;z-index:9999;background:white';
        iframe.src = src;
        document.body.append(iframe);
        return iframe;
      }, src);
      const frame = await element.asElement().contentFrame();
      await frame.waitForURL(src, { waitUntil: 'domcontentloaded' });
      assert.equal(await frame.evaluate(() => location.origin), 'http://sdplugin.localhost');
      assert.equal(
        await frame.evaluate(() => {
          try {
            return Boolean(parent.document);
          } catch {
            return false;
          }
        }),
        false,
        'plugin sandbox must still block access to the host document',
      );
      await frame.evaluate(() => {
        const target = document.createElement('button');
        target.id = 'business-menu-trigger';
        target.textContent = 'Business menu';
        target.style.cssText = 'position:fixed;left:20px;top:20px;z-index:1';
        target.addEventListener('contextmenu', (event) => {
          event.stopPropagation();
          target.dataset.open = 'true';
        });
        document.body.append(target);
      });
      await checkMenu(frame, frame.locator('#business-menu-trigger'));
      assert.equal(await frame.locator('#business-menu-trigger').getAttribute('data-open'), 'true');
      await checkMenu(frame, frame.locator('#business-menu-trigger'), { modifiers: ['Shift'] });
      await checkMenu(frame, frame.locator('#business-menu-trigger'), { key: 'Shift+F10' });
      // A fresh navigation must receive the same initialization script.
      await frame.evaluate(() => location.reload());
      await frame.waitForLoadState('domcontentloaded');
      await frame.waitForFunction(() => !document.querySelector('#business-menu-trigger'));
      await checkMenu(frame, frame.locator('body'), { position: { x: 2, y: 2 } });
      await page.locator('#context-menu-qa').evaluate((iframe) => iframe.remove());
      await element.dispose();
      passed.push(
        `${plugin.manifest.id}/${entry.id}: sandboxed plugin document, Shift+right click, business handler and reloaded document`,
      );
    }
  }
  await page.screenshot({ path: path.join(artifacts, 'context-menu.png') });
  await quit();
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ passed }, null, 2));
  console.log(JSON.stringify({ artifacts, passed }, null, 2));
} catch (error) {
  failure = error;
} finally {
  try {
    await quit();
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], 'Native QA and normal exit failed')
      : error;
  } finally {
    await browser?.close();
  }
}
if (failure) throw failure;
