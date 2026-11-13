// Windows/WebView2 + real PowerShell and OS clipboard, using an isolated QA build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { closeNativeWindow } from './native-window-close.mjs';
import { withPreservedClipboard } from './clipboard-guard.mjs';

assert.equal(process.platform, 'win32');
const output = path.resolve('.local/qa/shortcuts/native');
const executable = path.join(output, 'ServerDeckShortcutsQA.exe');
const data = path.join(output, 'data');
await mkdir(output, { recursive: true });
let child, browser, page, failure;
const passed = [];
const errors = [];
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const rpc = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const active = () => page.locator('.split-pane.focused:not(.terminal-hidden) .terminal-pane');
const snapshot = () =>
  page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const terminals = pinia._s.get('terminals');
    return {
      active: terminals.active,
      focused: terminals.focused,
      tabs: terminals.tabs.map((tab) => ({
        key: tab.key,
        layout: tab.layout,
        panes: tab.panes.map((pane) => ({ key: pane.key, sessionId: pane.sessionId })),
      })),
      fontSize: pinia._s.get('application').state.config.terminalFontSize,
    };
  });
async function key(binding) {
  await active().locator('.xterm-helper-textarea').focus();
  await page.keyboard.press(binding);
}
async function command(text, marker) {
  await page.waitForFunction(() => {
    const store = document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia._s.get('terminals');
    return store.panes.find((pane) => pane.key === store.focused)?.sessionId;
  });
  await active().locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await active().locator('.xterm-rows').filter({ hasText: marker }).waitFor();
}
async function quit() {
  if (!child || child.exitCode !== null) return;
  assert(page, 'Need the isolated window to exit normally');
  closeNativeWindow(child.pid);
  const dialog = page.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true });
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  for (let n = 0; n < 100 && child.exitCode === null; n++) await delay(100);
  assert.equal(child.exitCode, 0, 'QA application must exit normally');
}
try {
  child = spawn(executable, [], {
    cwd: output,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  let websocket;
  for (let n = 0; n < 100; n++) {
    try {
      websocket = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch (error) {
      if (n === 99) throw error;
    }
    if (websocket) break;
    assert.equal(child.exitCode, null, 'QA process exited before CDP connection');
    await delay(100);
  }
  assert(websocket, 'WebView2 CDP unavailable');
  browser = await chromium.connectOverCDP(websocket);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  assert.equal(
    path.resolve((await rpc('app_bootstrap')).dataDirectory),
    data,
    'Refusing to mutate a non-QA profile',
  );
  assert.equal((await snapshot()).tabs.length, 0);
  await page
    .locator('.activity-rail')
    .getByRole('button', { name: '本地终端', exact: true })
    .click();
  await page.locator('.terminal-pane[data-state="connected"]').waitFor();
  await command(
    "$sdShortcutValue = 127; Write-Output ('SD_FIRST_' + $sdShortcutValue)",
    'SD_FIRST_127',
  );
  const first = await snapshot();
  await key('Control+Shift+L');
  await page.waitForFunction(
    () => document.querySelectorAll('.split-pane:not(.terminal-hidden)').length === 2,
  );
  await active().locator('.xterm-container[data-state="connected"]').waitFor();
  assert.equal((await snapshot()).tabs[0].layout.axis, 'columns');
  await command(
    "Write-Output ('SD_SECOND_' + [string]::IsNullOrEmpty($sdShortcutValue))",
    'SD_SECOND_True',
  );
  await page.screenshot({ path: path.join(output, 'columns.png') });
  await key('Control+Shift+H');
  await page.waitForFunction(
    () => document.querySelectorAll('.split-pane:not(.terminal-hidden)').length === 3,
  );
  await active().locator('.xterm-container[data-state="connected"]').waitFor();
  assert.equal((await snapshot()).tabs[0].layout.second.axis, 'rows');
  assert.deepEqual((await snapshot()).tabs[0].panes[0], first.tabs[0].panes[0]);
  await page.screenshot({ path: path.join(output, 'rows.png') });
  passed.push('Ctrl+Shift+L/H: real independent PowerShell split panes; original session retained');
  await key('Control+Shift+T');
  await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 2);
  await active().locator('.xterm-container[data-state="connected"]').waitFor();
  const second = (await snapshot()).active;
  await key('Control+Shift+ArrowLeft');
  assert.equal((await snapshot()).active, first.active);
  await key('Control+Shift+ArrowRight');
  assert.equal((await snapshot()).active, second);
  passed.push('Ctrl+Shift+T/Left/Right: new session and cycling');
  const size = (await snapshot()).fontSize;
  await key('Control+Shift+Equal');
  await page.waitForFunction(
    (size) =>
      document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('application').state.config
        .terminalFontSize ===
      size + 1,
    size,
  );
  await key('Control+Shift+Minus');
  await page.waitForFunction(
    (size) =>
      document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('application').state.config
        .terminalFontSize === size,
    size,
  );
  passed.push('Ctrl+Shift+=/-: font size saved through real Rust IPC');
  await command("Write-Output ('SD_SEARCH_' + 127)", 'SD_SEARCH_127');
  await key('Control+Shift+F');
  await page.getByRole('textbox', { name: '终端查找内容', exact: true }).fill('SD_SEARCH_127');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.terminal-find').count(), 0);
  passed.push('Ctrl+Shift+F: terminal output search and Escape');
  const token = 'SD_SHORTCUT_CLIPBOARD_QA';
  await withPreservedClipboard(token, async (readSystemText) => {
    await rpc('plugin:clipboard-manager|write_text', { text: `Write-Output ('${token}_' + 127)` });
    await key('Control+Shift+V');
    await active()
      .locator('.xterm-rows')
      .filter({ hasText: `${token}_` })
      .waitFor();
    await page.keyboard.press('Enter');
    const marker = `${token}_127`;
    const row = active().locator('.xterm-rows > div').filter({ hasText: marker }).last();
    await row.waitFor();
    const bounds = await row.boundingBox();
    assert(bounds);
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('Control+Shift+C');
    let copied = false;
    for (let n = 0; n < 50; n++) {
      if ((await readSystemText()).includes(marker)) {
        copied = true;
        break;
      }
      await delay(100);
    }
    assert(copied, 'Copy shortcut must reach the system clipboard');
  });
  passed.push('Ctrl+Shift+C/V: OS clipboard copy/paste with original clipboard preserved');
  await key('Control+k');
  await page.getByRole('dialog', { name: '全局搜索', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await key('Control+Shift+P');
  await page.locator('.settings-page').waitFor();
  await page
    .locator('.settings-navigation')
    .getByRole('button', { name: '快捷键', exact: true })
    .click();
  assert.equal(await page.locator('#settings-panel-shortcuts input').count(), 13);
  await page
    .locator('.activity-rail')
    .getByRole('button', { name: '本地终端', exact: true })
    .click();
  passed.push('Ctrl+K and Ctrl+Shift+P: global search and settings, all 13 bindings present');
  await key('Control+Shift+W');
  await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 1);
  assert.equal((await snapshot()).active, first.active);
  await page
    .locator('.split-pane')
    .first()
    .click({ position: { x: 20, y: 20 } });
  await command("Write-Output ('SD_STILL_' + $sdShortcutValue)", 'SD_STILL_127');
  passed.push('Ctrl+Shift+W: closes only the focused session; original PowerShell state survives');
  assert.deepEqual(errors, []);
  await quit();
} catch (error) {
  failure = error;
  if (page && !page.isClosed())
    await writeFile(
      path.join(output, 'failure-state.json'),
      JSON.stringify(await snapshot(), null, 2),
    );
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') });
} finally {
  try {
    await quit();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error]) : error;
  }
  await browser?.close();
  await writeFile(
    path.join(output, 'results.json'),
    JSON.stringify({ passed, errors, failure: failure?.message ?? null }, null, 2),
  );
}
if (failure) throw failure;
console.log(JSON.stringify({ passed, errors }, null, 2));
