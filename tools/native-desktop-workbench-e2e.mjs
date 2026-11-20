import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { closeNativeWindow } from './native-window-close.mjs';
import { navigateWorkspace, closeApplicationSettings, reloadHosts } from './ui-navigation.mjs';

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
  const sessions = page.locator('#local-terminal-session-list .terminal-tab');
  await terminal.locator('.xterm-container[data-state="connected"]').waitFor();
  assert.equal(await sessions.count(), 1);
  const sessionKey = await sessions.getAttribute('data-session-key');
  assert(sessionKey);
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
  assert(await page.getByRole('navigation', { name: '设置分类', exact: true }).isVisible());
  await navigateWorkspace(page, '通用');
  const settings = page.locator('.settings-page:visible');
  const theme = settings.getByTestId('theme-select');
  const originalTheme = await theme.inputValue();
  const nextTheme = originalTheme === 'dark' ? 'light' : 'dark';
  await theme.selectOption(nextTheme);
  await settings.locator('.settings-panel .form-footer').waitFor({ state: 'hidden' });
  assert.equal((await bootstrap()).config.theme, nextTheme);
  assert.equal(await page.locator('.toast[role="status"]').count(), 0);
  await navigateWorkspace(page, '关于');
  await navigateWorkspace(page, '模型');
  await navigateWorkspace(page, '通用');
  assert.equal(await theme.inputValue(), nextTheme);
  assert.equal(await sessions.count(), 1);
  assert.equal(await sessions.getAttribute('data-session-key'), sessionKey);
  await navigateWorkspace(page, '数据与存储');
  const directory = settings.getByLabel('数据根目录', { exact: true });
  const originalDirectory = await directory.inputValue();
  await directory.fill('');
  const closing = closeApplicationSettings(page);
  const prompt = page.getByRole('dialog', { name: '设置尚未保存', exact: true });
  await prompt.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await directory.inputValue(), '');
  await directory.fill(originalDirectory);
  await closeApplicationSettings(page);
  await closing;
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
  await sessions.locator('.terminal-session-close').click();
  await terminal.waitFor({ state: 'detached' });
  await page
    .getByRole('navigation', { name: '应用导航', exact: true })
    .getByRole('button', { name: '首页', exact: true })
    .click();
  await page.getByRole('region', { name: '欢迎页面', exact: true }).waitFor();
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  results.push('closing the local terminal releases its real PTY and allows return to welcome');
  const invoke = (command, args) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  const tagged = await invoke('host_create', {
    input: {
      name: '环境标签验收主机',
      hostname: '127.0.0.1',
      port: 22,
      username: 'qa',
      authType: 'agent',
      credentialId: null,
      groupId: null,
      description: '',
      favorite: false,
      connectTimeoutSecs: 3,
    },
  });
  await reloadHosts(page);
  await page.evaluate((id) => {
    // Open the local forwarding page without starting any remote connection.
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    pinia._s.get('workspace').navigate('forwarding', id);
  }, tagged.id);
  await navigateWorkspace(page, '标签');
  const tagSettings = page.getByRole('region', { name: '标签', exact: true });
  await tagSettings.getByRole('button', { name: '新建标签', exact: true }).click();
  const createTag = page.getByRole('dialog', { name: '新建标签', exact: true });
  await createTag.getByLabel('名称', { exact: true }).fill('验收灰度');
  await createTag.getByRole('radio', { name: '紫色', exact: true }).check();
  await createTag.getByRole('button', { name: '保存', exact: true }).click();
  await createTag.waitFor({ state: 'hidden' });
  const tagCatalog = (await invoke('host_list')).environmentTags;
  const tag = tagCatalog.tags.find((entry) => entry.name === '验收灰度');
  assert.equal(tag?.color, 'violet');
  await closeApplicationSettings(page);
  const taggedRow = page.locator(`.tree-host[data-host-id="${tagged.id}"]`);
  const taggedTab = page.locator(`.workspace-tab[data-host-id="${tagged.id}"]`);
  const hostMenu = page.getByRole('menu', { name: '主机树操作', exact: true });
  const tagEntry = hostMenu.getByRole('menuitem', { name: '标签', exact: true });
  const tagMenu = page.getByRole('menu', { name: '标签', exact: true });
  await taggedRow.click({ button: 'right' });
  assert.equal(await hostMenu.getByRole('menuitemradio').count(), 0);
  await tagEntry.hover();
  await tagMenu.getByRole('menuitemradio', { name: '验收灰度', exact: true }).click();
  await taggedRow.getByText('验收灰度', { exact: true }).waitFor();
  await taggedTab.getByText('验收灰度', { exact: true }).waitFor();
  assert.equal((await invoke('host_list')).environmentTags.assignments[tagged.id], tag.id);
  await taggedRow.click({ button: 'right' });
  await hostMenu.getByRole('menuitem', { name: '删除', exact: true }).click();
  const deleteHost = page.getByRole('dialog', { name: '确认删除主机', exact: true });
  await deleteHost.getByText('验收灰度', { exact: true }).waitFor();
  await deleteHost.getByRole('button', { name: '取消', exact: true }).click();
  await taggedRow.click({ button: 'right' });
  await tagEntry.press('ArrowRight');
  await tagMenu
    .getByRole('menuitemradio', { name: '验收灰度', exact: true, checked: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await tagMenu.waitFor({ state: 'hidden' });
  assert.equal(await tagEntry.evaluate((element) => element === document.activeElement), true);
  await tagEntry.press('ArrowRight');
  await tagMenu.getByRole('menuitem', { name: '清除标签', exact: true }).click();
  await taggedTab.locator('.environment-tag').waitFor({ state: 'hidden' });
  assert.equal((await invoke('host_list')).environmentTags.assignments[tagged.id], undefined);
  results.push(
    'real environment tag creation, assignment, workbench tabs, host confirmation and clearing',
  );
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
