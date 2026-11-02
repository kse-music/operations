import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { closeNativeWindow } from './native-window-close.mjs';
import {
  navigateWorkspace,
  selectHostWorkspace,
  showHostTree,
  openHostTreeTools,
} from './ui-navigation.mjs';

assert.equal(process.platform, 'win32', 'native UI suite requires Windows/WebView2');
const root = fileURLToPath(new URL('../', import.meta.url));
const reuse = process.argv[2] === '--reuse';
const artifacts = reuse
  ? path.resolve(process.argv[3])
  : path.join(root, '.local', 'native-ui-e2e', randomUUID());
assert.equal(path.dirname(artifacts), path.join(root, '.local', 'native-ui-e2e'));
await mkdir(artifacts, { recursive: true });
const config = path.join(artifacts, 'tauri-e2e.json');
await writeFile(
  config,
  JSON.stringify({
    identifier: 'io.serverdeck.desktop.ui-e2e',
    app: { appDirectoriesOverride: artifacts },
  }),
);
const executable = path.join(artifacts, 'ServerDeckUiE2E.exe');
const buildDirectory = path.join(root, '.local', 'native-ui-build');
function build(args) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'tools', 'tauri.mjs'), 'build', '--debug', '--no-bundle', ...args],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, CARGO_TARGET_DIR: buildDirectory },
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'native build failed');
}
if (!reuse) {
  build(['--config', config]);
  await copyFile(path.join(buildDirectory, 'debug', 'serverdeck-desktop.exe'), executable);
  build([]);
}
let child,
  browser,
  page,
  safe = false;
const passed = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rpc = (name, args = {}) =>
  page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
async function start() {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
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
      WEBVIEW2_USER_DATA_FOLDER: path.join(artifacts, 'webview'),
    },
  });
  let websocket;
  for (let n = 0; n < 100; n++) {
    try {
      websocket = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch {}
    if (websocket) break;
    assert.equal(child.exitCode, null, 'native app exited before connecting');
    await delay(200);
  }
  assert(websocket, 'WebView2 CDP unavailable');
  browser = await chromium.connectOverCDP(websocket);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const bootstrap = await rpc('app_bootstrap');
  assert.equal(path.resolve(bootstrap.dataDirectory), artifacts, 'refusing to write non-test data');
  safe = true;
  await page
    .locator('.terminal-pane:visible .session-state')
    .filter({ hasText: '已连接' })
    .waitFor();
  assert.deepEqual(
    (await page.locator('.workspace-tabs [role="tab"]').allTextContents()).map((text) =>
      text.trim(),
    ),
    ['本地设备'],
  );
}
const active = () => page.locator('.terminal-pane:visible');
async function assertNativeMenuSuppressed(target) {
  await page.evaluate(() => {
    window.__nativeMenuPrevented = null;
    document.addEventListener(
      'contextmenu',
      (event) => {
        window.__nativeMenuPrevented = event.defaultPrevented;
      },
      { capture: true, once: true },
    );
  });
  await target.click({ button: 'right', position: { x: 5, y: 5 } });
  assert.equal(await page.evaluate(() => window.__nativeMenuPrevented), true);
}
async function command(text, marker) {
  await active().locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await active().locator('.xterm-rows').filter({ hasText: marker }).waitFor();
}
async function quit() {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  closeNativeWindow(child.pid);
  const dialog = page.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '取消任务并退出', exact: true }).click();
  await Promise.race([exited, delay(15000)]);
  assert.equal(child.exitCode, 0, 'confirmed native exit must finish cleanly');
  await browser.close().catch(() => {});
  browser = null;
}
try {
  await start();
  for (const target of [
    page.locator('.topbar'),
    page.locator('.sidebar'),
    page.locator('.sidebar input'),
    active().locator('.xterm-screen'),
    active().locator('.terminal-toolbar'),
  ])
    await assertNativeMenuSuppressed(target);
  assert.equal(await page.getByRole('menu').count(), 0);
  await assertNativeMenuSuppressed(page.locator('.terminal-tab.active [role=tab]'));
  await page.getByRole('menuitem', { name: '关闭其他标签', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭标签菜单', exact: true }).click({
    position: { x: 2, y: 2 },
  });
  passed.push('native context menus suppressed across shell, inputs and xterm; tab menu retained');
  assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), '');
  await command("$sdValue = 17*19; [Console]::WriteLine(('SD_VALUE_' + $sdValue))", 'SD_VALUE_323');
  assert.equal(await active().getByRole('button', { name: '自动化', exact: true }).count(), 0);
  assert.equal(await page.locator('.topbar [aria-label="退出应用"]').count(), 0);
  assert.equal(await page.locator('.topbar [aria-label="打开全局设置"]').count(), 0);
  passed.push('default local PowerShell with real input/output and no remote actions');
  await page.getByRole('button', { name: '新建本地终端', exact: true }).click();
  await active().locator('.session-state').filter({ hasText: '已连接' }).waitFor();
  assert.equal(await page.locator('.terminal-tab').count(), 2);
  await page.locator('.terminal-tab.active [role=tab]').click({ button: 'middle' });
  await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 1);
  await command("[Console]::WriteLine(('SD_SURVIVED_' + $sdValue))", 'SD_SURVIVED_323');
  passed.push('middle-click terminal close preserves the other live PowerShell');
  const groups = [];
  for (const name of ['UI A', 'UI B']) {
    await page.getByRole('button', { name: '管理分组', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '管理主机分组', exact: true });
    await assertNativeMenuSuppressed(dialog.getByLabel('分组名称', { exact: true }));
    await dialog.getByLabel('分组名称', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '新建分组', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    groups.push((await rpc('host_list')).groups.find((group) => group.name === name));
  }
  passed.push('group creation closes the actual dialog after SQLite save');
  const host = await rpc('host_create', {
    input: {
      name: 'UI Host',
      hostname: '192.0.2.12',
      port: 22,
      username: 'ops',
      authType: 'password',
      credentialId: null,
      groupId: groups[0].id,
      tags: [],
      description: '',
      favorite: false,
      connectTimeoutSecs: 15,
    },
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const row = page.locator('.tree-host').filter({ hasText: 'UI Host' });
  const target = page.locator('.group-toggle').filter({ hasText: 'UI B' });
  async function dragHostTo(target, cancel = false) {
    const from = await row.boundingBox(),
      to = await target.boundingBox();
    assert(from && to);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await page.locator('.host-drag-preview').waitFor();
    assert.equal(
      await target.evaluate((el) => el.parentElement.classList.contains('drop-target')),
      true,
    );
    if (cancel) await page.keyboard.press('Escape');
    else await page.screenshot({ path: path.join(artifacts, 'host-drag.png') });
    await page.mouse.up();
    await page.locator('.host-drag-preview').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), '');
    assert.equal(await page.locator('.terminal-tab').count(), 1, 'dragging must not open SSH');
  }
  await dragHostTo(target, true);
  assert.equal((await rpc('host_list')).hosts.find((h) => h.id === host.id).groupId, groups[0].id);
  await target.click();
  assert.equal(await target.getAttribute('aria-expanded'), 'false');
  await dragHostTo(target);
  await page.waitForFunction(
    async ({ id, groupId }) =>
      (await window.__TAURI_INTERNALS__.invoke('host_list')).hosts.find((h) => h.id === id)
        ?.groupId === groupId,
    { id: host.id, groupId: groups[1].id },
  );
  await target.click();
  await dragHostTo(page.locator('.group-toggle').filter({ hasText: '未分组' }));
  await page.waitForFunction(
    async (id) =>
      (await window.__TAURI_INTERNALS__.invoke('host_list')).hosts.find((h) => h.id === id)
        ?.groupId === null,
    host.id,
  );
  passed.push(
    'native pointer dragging supports collapsed/empty/ungrouped targets, Escape cancellation and persisted group moves without opening SSH',
  );
  await assertNativeMenuSuppressed(row);
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(
    await page.locator('.tree-host-more, .host-tree-scroll [aria-haspopup=menu]').count(),
    0,
  );
  assert.equal(await page.getByRole('button', { name: '关闭操作菜单', exact: true }).count(), 0);
  await page.mouse.move(800, 24);
  await page.screenshot({ path: path.join(artifacts, 'host-no-menu.png') });
  await row.dblclick();
  await active().locator('.terminal-identity strong').filter({ hasText: 'UI Host' }).waitFor();
  assert.equal(
    await page.locator('.terminal-tab').count(),
    1,
    'single/double click must reuse one SSH pane',
  );
  await active()
    .getByText(/主机尚未绑定安全凭据/)
    .waitFor();
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await active()
    .getByText(/主机尚未绑定安全凭据/)
    .waitFor();
  assert.equal(await page.locator('.terminal-tab').count(), 2);
  await active().getByRole('button', { name: '关闭终端', exact: true }).click();
  await active().locator('.terminal-identity strong').filter({ hasText: 'UI Host' }).waitFor();
  assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), host.id);
  assert.equal(await page.locator('.terminal-tab').count(), 1);
  await page.locator('.workspace-tab.active [role=tab]').click({ button: 'middle' });
  assert.equal(
    await page.locator('.terminal-tab').count(),
    1,
    'navigation close must retain sessions',
  );
  passed.push(
    'host clicks reuse SSH; last-pane close stays on the same host; navigation close retains sessions',
  );
  await selectHostWorkspace(page, '');
  await navigateWorkspace(page, 'SSH 终端');
  await command("[Console]::WriteLine(('SD_RETURN_' + $sdValue))", 'SD_RETURN_323');
  await page.screenshot({ path: path.join(artifacts, 'local-powershell.png') });
  await page.locator('.workspace-tab.active [role=tab]').click({ button: 'middle' });
  await page.getByRole('heading', { name: '欢迎使用 ServerDeck', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-tabs [role=tab]').count(), 0);
  await page.getByRole('button', { name: '打开本地终端', exact: true }).click();
  await command("[Console]::WriteLine(('SD_WELCOME_' + $sdValue))", 'SD_WELCOME_323');
  await quit();
  await start();
  await command(
    "[Console]::WriteLine(('SD_FRESH_' + [string]::IsNullOrEmpty($sdValue)))",
    'SD_FRESH_True',
  );
  const saved = await rpc('host_list');
  assert.equal(saved.groups.length, 2);
  assert.equal(saved.hosts.find((h) => h.id === host.id).groupId, null);
  passed.push(
    'restart retains groups/moves and starts a fresh local Shell without replaying commands',
  );
  await page.getByRole('button', { name: '关闭其他标签', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 1);
  await active().getByRole('button', { name: '关闭终端', exact: true }).click();
  // Other hosts remain in the background; closing the last local session must not switch host.
  assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), '');
  await page.getByRole('heading', { name: '没有打开的终端', exact: true }).waitFor();
  await selectHostWorkspace(page, host.id);
  await active().getByRole('button', { name: '关闭终端', exact: true }).click();
  await page.getByRole('heading', { name: '欢迎使用 ServerDeck', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-tabs [role=tab]').count(), 0);
  assert.equal(await page.locator('.terminal-tab').count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'welcome.png') });
  passed.push(
    'host workspace tabs switch independently; local close preserves remote sessions; final close shows welcome',
  );
  await showHostTree(page);
  assert.equal(await page.getByRole('button', { name: '主机管理', exact: true }).count(), 0);
  assert.equal(await page.locator('.hosts-view').count(), 0);
  await page.getByLabel('搜索主机', { exact: true }).fill('UI Host');
  await page
    .locator('.host-sidebar-actions')
    .getByRole('button', { name: '新建主机', exact: true })
    .click();
  const createHost = page.getByRole('dialog', { name: '新建主机', exact: true });
  await createHost.getByLabel('主机名称', { exact: true }).fill('UI Created');
  await createHost.getByLabel('地址（IP / 域名）', { exact: true }).fill('192.0.2.20');
  await createHost.getByLabel('用户名', { exact: true }).fill('operator');
  await createHost.getByLabel('分组', { exact: true }).selectOption(groups[1].id);
  await createHost.getByRole('button', { name: '保存主机', exact: true }).click();
  await createHost.waitFor({ state: 'hidden' });
  await page.locator('.tree-host').filter({ hasText: 'UI Created' }).waitFor();
  assert.equal(await page.getByLabel('搜索主机', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  const created = (await rpc('host_list')).hosts.find((item) => item.name === 'UI Created');
  assert.equal(created.groupId, groups[1].id);
  assert.equal(created.hostname, '192.0.2.20');
  const currentTabs = await page.locator('.workspace-tab').count();
  for (const item of await page.locator('.tree-host').all()) {
    await assertNativeMenuSuppressed(item);
    assert.equal(await page.getByRole('menu').count(), 0);
    assert.equal(await page.getByRole('button', { name: '关闭操作菜单', exact: true }).count(), 0);
  }
  assert.equal(
    await page.locator('.tree-host-more, .host-tree-scroll [aria-haspopup=menu]').count(),
    0,
  );
  assert.equal(await page.locator('.workspace-tab').count(), currentTabs);
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  assert.equal((await rpc('host_list')).hosts.length, 2);
  passed.push(
    'sidebar creation persists through SQLite; right-click has no menu or session/navigation effects',
  );
  await page.getByRole('button', { name: '编辑主机 UI Host', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑主机', exact: true });
  assert.equal(
    await edit.getByLabel('地址（IP / 域名）', { exact: true }).inputValue(),
    '192.0.2.12',
  );
  await edit.getByLabel('主机名称', { exact: true }).fill('UI Host edited');
  await edit.getByLabel('地址（IP / 域名）', { exact: true }).fill('192.0.2.33');
  await edit.getByRole('button', { name: '保存主机', exact: true }).click();
  await edit.waitFor({ state: 'hidden' });
  assert.equal(
    (await rpc('host_list')).hosts.find((item) => item.id === host.id).hostname,
    '192.0.2.33',
  );
  await page.getByRole('button', { name: '复制主机 UI Host edited', exact: true }).click();
  await page.getByRole('button', { name: '编辑主机 UI Host edited 副本', exact: true }).waitFor();
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  assert.equal(await page.locator('.workspace-tab').count(), currentTabs);
  await page.getByRole('button', { name: '删除主机 UI Host edited', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '确认删除主机', exact: true });
  await deletion.getByText(/UI Host edited.*192\.0\.2\.33/).waitFor();
  await deletion.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await rpc('host_list')).hosts.length, 3);
  await page.getByRole('button', { name: '删除主机 UI Host edited', exact: true }).click();
  await deletion.getByRole('button', { name: '确认删除主机', exact: true }).click();
  await deletion.waitFor({ state: 'hidden' });
  assert(!(await rpc('host_list')).hosts.some((item) => item.id === host.id));
  passed.push(
    'direct host tree buttons edit/copy/delete exact hosts through real IPC, preserve workspace sessions and require deletion confirmation',
  );
  await openHostTreeTools(page);
  await page.getByRole('button', { name: '导入 OpenSSH', exact: true }).click();
  const importHosts = page.getByRole('dialog', { name: '导入 OpenSSH Config', exact: true });
  await importHosts
    .getByLabel('OpenSSH Config 内容', { exact: true })
    .fill('Host tree-imported\n HostName imported.example\n User operator');
  await importHosts.getByRole('button', { name: '生成导入预览', exact: true }).click();
  await importHosts
    .getByLabel('已检查预览、认证方式与警告，确认只导入选中的条目。', { exact: true })
    .check();
  await importHosts.getByRole('button', { name: '导入 1 台主机', exact: true }).click();
  await importHosts.waitFor({ state: 'hidden' });
  await page.locator('.tree-host').filter({ hasText: 'tree-imported' }).waitFor();
  await page.getByRole('button', { name: '导出配置', exact: true }).click();
  const exportHosts = page.getByRole('dialog', { name: '导出非敏感主机配置', exact: true });
  const exportText = await exportHosts.getByLabel('导出内容', { exact: true }).inputValue();
  assert.equal(JSON.parse(exportText).hosts.length, 3);
  for (const forbidden of ['credentialId', 'secretRef', 'keyPath'])
    assert(!exportText.includes(forbidden));
  await exportHosts.getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, 'host-tree-crud.png') });
  for (const name of ['UI Created', 'UI Host edited 副本', 'tree-imported']) {
    await page.getByRole('button', { name: `删除主机 ${name}`, exact: true }).click();
    await deletion.getByRole('button', { name: '确认删除主机', exact: true }).click();
    await deletion.waitFor({ state: 'hidden' });
  }
  await page.getByText('尚未添加主机', { exact: true }).waitFor();
  assert.equal((await rpc('host_list')).hosts.length, 0);
  passed.push(
    'host tree OpenSSH preview/import and non-sensitive export remain available; isolated records cleaned via real IPC',
  );
  await quit();
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ passed }, null, 2));
  console.log(`PASS ${passed.length} native UI scenarios. Artifacts: ${artifacts}`);
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (safe && child?.exitCode === null && browser?.isConnected()) {
    await rpc('app_exit_confirm', { confirmed: true }).catch(() => {});
    for (let n = 0; n < 50 && child.exitCode === null; n++) await delay(100);
  }
  await browser?.close().catch(() => {});
  if (child?.exitCode === null) child.kill();
}
