import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { closeNativeWindow } from './native-window-close.mjs';
import { navigateWorkspace, closeApplicationSettings } from './ui-navigation.mjs';

assert.equal(process.platform, 'win32');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(
  root,
  '.local',
  'qa',
  'desktop-workbench',
  'native',
  String(Date.now()),
);
await mkdir(artifacts, { recursive: true });
const config = path.join(artifacts, 'tauri-qa.json');
await writeFile(
  config,
  JSON.stringify({
    identifier: 'cn.hiboot.desktop.workbench-qa',
    app: { appDirectoriesOverride: artifacts },
  }),
);
const executable = path.join(artifacts, 'ServerDeckWorkbenchQA.exe');
function build(extra) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'tools', 'tauri.mjs'), 'build', '--debug', '--no-bundle', ...extra],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'native build failed');
}
try {
  build(['--config', config]);
  await copyFile(path.join(root, 'target', 'debug', 'serverdeck-desktop.exe'), executable);
} finally {
  // Leave the shared target executable configured for normal application use.
  build([]);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const child = spawn(executable, [], {
  cwd: artifacts,
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      '--remote-debugging-port=' + port + ' --remote-debugging-address=127.0.0.1',
    WEBVIEW2_USER_DATA_FOLDER: path.join(artifacts, 'webview'),
  },
});
let browser,
  page,
  safe = false;
const results = [];
try {
  let websocket;
  for (let index = 0; index < 100; index += 1) {
    try {
      websocket = (await (await fetch('http://127.0.0.1:' + port + '/json/version')).json())
        .webSocketDebuggerUrl;
    } catch (error) {
      if (index === 99) throw error;
    }
    if (websocket) break;
    assert.equal(child.exitCode, null, 'QA application exited before CDP');
    await delay(200);
  }
  assert(websocket);
  browser = await chromium.connectOverCDP(websocket);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const bootstrap = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_bootstrap'));
  assert.equal(path.resolve((await bootstrap()).dataDirectory), artifacts, 'refusing non-QA data');
  safe = true;
  await page.getByRole('button', { name: '本地终端', exact: true }).click();
  const terminal = page.locator('.terminal-pane:visible');
  await terminal.locator('.xterm-container[data-state="connected"]').waitFor();
  assert.deepEqual(
    (await page.locator('.workspace-tabs [role="tab"]').allTextContents()).map((text) =>
      text.trim(),
    ),
    ['本地终端'],
  );
  assert.equal(await page.locator('.module-navigation, .workspace-group-tab').count(), 0);
  const command = async (text, marker) => {
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.insertText(text);
    await page.keyboard.press('Enter');
    await terminal.locator('.xterm-rows').filter({ hasText: marker }).waitFor();
  };
  await command(
    "$sdLayoutValue = 52; [Console]::WriteLine(('SD_LAYOUT_' + $sdLayoutValue))",
    'SD_LAYOUT_52',
  );
  await navigateWorkspace(page, '插件管理');
  assert.equal(await page.locator('.workspace-tab').count(), 1);
  assert(await page.locator('.host-tree-section').isVisible());
  await navigateWorkspace(page, '通用');
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  const theme = settings.getByTestId('theme-select');
  const originalTheme = await theme.inputValue();
  const nextTheme = originalTheme === 'dark' ? 'light' : 'dark';
  await theme.selectOption(nextTheme);
  await navigateWorkspace(page, '关于');
  await navigateWorkspace(page, '模型');
  await navigateWorkspace(page, '通用');
  assert.equal(await theme.inputValue(), nextTheme);
  assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-view'), 'terminals');
  assert.equal(await page.locator('.workspace-tab').count(), 1);
  await settings
    .locator(':scope > .modal-heading')
    .getByRole('button', { name: '关闭对话框', exact: true })
    .click();
  const prompt = page.getByRole('dialog', { name: '设置尚未保存', exact: true });
  await prompt.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await theme.inputValue(), nextTheme);
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('设置已保存', { exact: false }).first().waitFor();
  assert.equal((await bootstrap()).config.theme, nextTheme);
  await closeApplicationSettings(page);
  await command("[Console]::WriteLine(('SD_RETAINED_' + $sdLayoutValue))", 'SD_RETAINED_52');
  await navigateWorkspace(page, '插件管理');
  await closeApplicationSettings(page);
  await command(
    "[Console]::WriteLine(('SD_PLUGIN_CLOSED_' + $sdLayoutValue))",
    'SD_PLUGIN_CLOSED_52',
  );
  results.push(
    'real PowerShell survives plugin management and all settings categories; settings persist through real IPC',
  );
  await page.screenshot({ path: path.join(artifacts, 'native-workbench.png') });
  await navigateWorkspace(page, '通用');
  await page.screenshot({ path: path.join(artifacts, 'native-settings.png') });
  await closeApplicationSettings(page);
  await page.locator('.workspace-tab[data-host-id=""] .tab-close').click();
  await page.getByRole('heading', { name: '欢迎使用 ServerDeck', exact: true }).waitFor();
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  results.push('closing the local workspace releases its real PTY and restores welcome');
  await writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify({ artifacts, results, passed: true }, null, 2),
  );
  console.log(JSON.stringify({ artifacts, results, passed: true }));
} finally {
  if (safe && child.exitCode === null && page) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    closeNativeWindow(child.pid);
    const dialog = page.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    await Promise.race([exited, delay(15000)]);
    assert.equal(child.exitCode, 0, 'QA application must exit normally');
  }
  await browser?.close();
}
