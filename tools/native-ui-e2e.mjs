import { terminalAction, terminalTabAction } from './ui-navigation.mjs';
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
  await page.locator('.terminal-pane:visible .xterm-container[data-state="connected"]').waitFor();
  assert.deepEqual(
    (await page.locator('.workspace-tabs [role="tab"]').allTextContents()).map((text) =>
      text.trim(),
    ),
    ['本地设备'],
  );
}
const active = () => page.locator('.terminal-pane:visible');
const hoverHost = async (name) => {
  await page.locator('.host-sidebar-heading').hover({ position: { x: 4, y: 4 } });
  await page
    .locator('.tree-host-row')
    .filter({ has: page.getByText(name, { exact: true }) })
    .hover();
};
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
  assert.equal(await page.locator('.activity-rail [aria-label="主机管理"] .nav-badge').count(), 0);
  assert.equal((await page.locator('.host-count').textContent()).trim(), '0');
  assert.equal(await page.locator('.topbar').count(), 0);
  assert.equal(await page.getByRole('button', { name: '打开全局搜索', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '打开本地工作区', exact: true }).count(), 0);
  const about = page.getByRole('button', { name: '关于', exact: true });
  await about.click();
  const aboutDialog = page.getByRole('dialog', { name: '关于 ServerDeck', exact: true });
  const { appVersion } = await rpc('app_bootstrap');
  assert((await aboutDialog.textContent()).includes(`v${appVersion}`));
  await page.screenshot({ path: path.join(artifacts, 'about.png') });
  await aboutDialog.press('Escape');
  assert.equal(await aboutDialog.count(), 0);
  assert.equal(await about.evaluate((button) => document.activeElement === button), true);
  assert.equal(await page.getByText(/已恢复布局，所有窗格保持未连接/).count(), 0);
  assert.equal(await page.locator('.workspace-header .host-tools').count(), 1);
  assert.equal(await page.locator('.split-toolbar, [aria-label="会话操作"]').count(), 0);
  await page
    .locator('.host-sidebar-title')
    .getByRole('button', { name: '收起主机栏', exact: true })
    .click();
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  const expandHosts = page
    .locator('.workspace-tabs')
    .getByRole('button', { name: '展开主机栏', exact: true });
  assert.equal(await expandHosts.evaluate((button) => document.activeElement === button), true);
  await expandHosts.press('Enter');
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  assert.equal(
    await page
      .getByRole('button', { name: '收起主机栏', exact: true })
      .evaluate((button) => document.activeElement === button),
    true,
  );
  await page.screenshot({ path: path.join(artifacts, 'header-host-toggle.png') });
  passed.push(
    'brand header removed; About shows backend version; host collapse and expansion support keyboard focus',
  );
  for (const target of [
    page.locator('.activity-rail'),
    page.locator('.sidebar'),
    page.locator('.sidebar input'),
    active().locator('.terminal-footnote'),
  ])
    await assertNativeMenuSuppressed(target);
  assert.equal(await page.getByRole('menu').count(), 0);
  await assertNativeMenuSuppressed(active().locator('.xterm-screen'));
  await page.getByRole('menu', { name: '终端操作', exact: true }).waitFor();
  await page
    .getByRole('button', { name: '关闭终端菜单', exact: true })
    .click({ position: { x: 2, y: 2 } });
  await assertNativeMenuSuppressed(page.locator('.terminal-tab.active [role=tab]'));
  assert.deepEqual(
    await page
      .getByRole('menuitem')
      .allTextContents()
      .then((items) => items.map((text) => text.trim())),
    ['复制', '重命名', '关闭所有', '关闭'],
  );
  await page.screenshot({ path: path.join(artifacts, 'session-menu.png') });
  await page.getByRole('button', { name: '关闭标签菜单', exact: true }).click({
    position: { x: 2, y: 2 },
  });
  passed.push('native context menus suppressed across shell, inputs and xterm; tab menu retained');
  assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), '');
  await command("$sdValue = 17*19; [Console]::WriteLine(('SD_VALUE_' + $sdValue))", 'SD_VALUE_323');
  await active().locator('.xterm-helper-textarea').press('Shift+F10');
  assert.equal(
    await page
      .getByRole('menu', { name: '终端操作' })
      .getByRole('menuitem', { name: '自动化', exact: true })
      .count(),
    0,
  );
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.topbar [aria-label="退出应用"]').count(), 0);
  assert.equal(await page.locator('.topbar [aria-label="打开全局设置"]').count(), 0);
  passed.push('default local PowerShell with real input/output and no remote actions');
  await terminalTabAction(page, '复制');
  await active().locator('.xterm-container[data-state="connected"]').waitFor();
  assert.equal(await page.locator('.terminal-tab').count(), 2);
  await command("[Console]::WriteLine(('SD_FRESH_' + ($null -eq $sdValue)))", 'SD_FRESH_True');
  await page.locator('.terminal-tab.active [role=tab]').click({ button: 'middle' });
  await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 1);
  await command("[Console]::WriteLine(('SD_SURVIVED_' + $sdValue))", 'SD_SURVIVED_323');
  passed.push(
    'duplicate creates an independent PowerShell; middle-click close preserves the original',
  );
  await navigateWorkspace(page, '自动运维');
  const templateCatalog = await rpc('automation_catalog');
  const templateDrawers = page.locator('.automation-template-drawer');
  await templateDrawers.first().waitFor();
  assert.equal(await templateDrawers.count(), templateCatalog.templates.length);
  assert.equal(await page.locator('.automation-template-drawer[open]').count(), 0);
  assert.equal(await templateDrawers.getByRole('button').first().isVisible(), false);
  await page.screenshot({ path: path.join(artifacts, 'template-drawers-collapsed.png') });
  const scriptTemplate = templateCatalog.templates.find((template) => template.parameters.length);
  assert(scriptTemplate, 'a parameterized template is required for editor verification');
  const templateDrawer = templateDrawers.filter({
    has: page.getByText(scriptTemplate.name, { exact: true }),
  });
  await templateDrawer.locator('summary').press('Enter');
  assert.equal(await templateDrawer.getAttribute('open'), '');
  assert.equal(await templateDrawer.locator('pre').innerText(), scriptTemplate.body);
  assert.equal(await page.locator('.automation-template-drawer[open]').count(), 1);
  await page.screenshot({ path: path.join(artifacts, 'template-drawer-expanded.png') });
  await templateDrawer.getByRole('button', { name: `使用“${scriptTemplate.name}”模板` }).click();
  const templateEditor = page.getByRole('dialog', { name: '新建命令 / 脚本', exact: true });
  await templateEditor.waitFor();
  assert.equal(
    await templateEditor.getByLabel('自动化条目正文', { exact: true }).inputValue(),
    scriptTemplate.body,
  );
  assert.equal(
    await templateEditor.locator('.automation-param').count(),
    scriptTemplate.parameters.length,
  );
  await templateEditor.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await templateDrawer.locator('summary').press('Space');
  assert.equal(await templateDrawer.getAttribute('open'), null);
  assert.deepEqual((await rpc('automation_catalog')).entries, templateCatalog.entries);
  assert.deepEqual(await rpc('automation_history', { query: {} }), []);
  await selectHostWorkspace(page, '');
  await page
    .locator('.workspace-tab[data-view="automation"] [role="tab"]')
    .click({ button: 'middle' });
  passed.push(
    'template drawers start collapsed; keyboard disclosure and full template editor leave stored entries and history unchanged',
  );
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
  await page.locator(`.terminal-pane:visible[data-host-id="${host.id}"]`).waitFor();
  assert.equal(
    await page.locator('.terminal-tab').count(),
    1,
    'single/double click must reuse one SSH pane',
  );
  await active()
    .getByText(/主机尚未绑定安全凭据/)
    .waitFor();
  await terminalTabAction(page, '复制');
  await active()
    .getByText(/主机尚未绑定安全凭据/)
    .waitFor();
  assert.equal(await page.locator('.terminal-tab').count(), 2);
  await terminalAction(page, active(), '关闭终端');
  await page.locator(`.terminal-pane:visible[data-host-id="${host.id}"]`).waitFor();
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
  assert.equal(await page.getByRole('button', { name: '打开本地工作区', exact: true }).count(), 0);
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
  const restoredHost = page.locator(`.terminal-pane[data-host-id="${host.id}"]`);
  assert.equal(await restoredHost.getAttribute('data-state'), 'idle');
  await showHostTree(page);
  await page.locator(`.tree-host[data-host-id="${host.id}"]`).click();
  await active()
    .getByText(/主机尚未绑定安全凭据/)
    .waitFor();
  assert.equal(await page.locator('.terminal-tab').count(), 1);
  await page.locator(`.tree-host[data-host-id="${host.id}"]`).dblclick();
  assert.equal(await page.locator('.terminal-tab').count(), 1);
  await selectHostWorkspace(page, '');
  passed.push(
    'restored SSH stays idle until explicit host selection, then opens without pressing Connect and reuses the saved pane',
  );
  await terminalTabAction(page, '关闭所有');
  // Other hosts remain in the background; closing the last local session must not switch host.
  assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), '');
  await page.getByRole('heading', { name: '没有打开的终端', exact: true }).waitFor();
  await selectHostWorkspace(page, host.id);
  await terminalAction(page, active(), '关闭终端');
  await page.getByRole('heading', { name: '欢迎使用 ServerDeck', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-tabs [role=tab]').count(), 0);
  assert.equal(await page.locator('.terminal-tab').count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'welcome.png') });
  passed.push(
    'host workspace tabs switch independently; local close preserves remote sessions; final close shows welcome',
  );
  await showHostTree(page);
  assert.equal(await page.getByRole('button', { name: '主机管理', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '主机工作区', exact: true }).count(), 0);
  assert.equal(await page.locator('.hosts-view').count(), 0);
  await page.getByLabel('搜索主机', { exact: true }).fill('UI Host');
  await page
    .locator('.host-sidebar-actions')
    .getByRole('button', { name: '新建主机', exact: true })
    .click();
  const createHost = page.getByRole('dialog', { name: '新建主机', exact: true });
  await createHost.getByLabel('主机名称（可选）', { exact: true }).fill('UI Created');
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
  assert.equal((await page.locator('.host-count').textContent()).trim(), '2');
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
  const hostRow = page
    .locator('.tree-host-row')
    .filter({ has: page.locator(`.tree-host[data-host-id="${host.id}"]`) });
  const hostActions = hostRow.locator('.tree-host-actions');
  const hostActionsVisible = () =>
    hostActions.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.opacity === '1' && style.pointerEvents === 'auto';
    });
  assert.equal(await page.locator('[aria-label^="复制主机 "]').count(), 0);
  assert.equal(await hostActions.locator('button').count(), 2);
  await page.locator('.host-sidebar-heading').click({ position: { x: 4, y: 4 } });
  assert.equal(await hostActionsVisible(), false);
  assert.equal(await hostActions.evaluate((element) => getComputedStyle(element).opacity), '0');
  assert.equal(
    await hostActions.evaluate((element) => getComputedStyle(element).pointerEvents),
    'none',
  );
  await hoverHost('UI Host');
  assert.equal(await hostActionsVisible(), true);
  await page.screenshot({ path: path.join(artifacts, 'host-actions-hover.png') });
  await page.locator('.host-sidebar-heading').click({ position: { x: 4, y: 4 } });
  assert.equal(await hostActionsVisible(), false);
  await hostRow.locator('.tree-host').press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert.equal(
    await hostRow.locator('.tree-host').evaluate((button) => document.activeElement === button),
    true,
  );
  assert.equal(await hostActionsVisible(), true);
  await page.keyboard.press('Tab');
  assert.equal(
    await page
      .getByRole('button', { name: '编辑主机 UI Host', exact: true })
      .evaluate((button) => document.activeElement === button),
    true,
  );
  await page.keyboard.press('Tab');
  assert.equal(
    await page
      .getByRole('button', { name: '删除主机 UI Host', exact: true })
      .evaluate((button) => document.activeElement === button),
    true,
  );
  await page.locator('.host-sidebar-heading').click({ position: { x: 4, y: 4 } });
  assert.equal(await hostActionsVisible(), false);
  await page.screenshot({ path: path.join(artifacts, 'host-actions-hidden.png') });
  await hoverHost('UI Host');
  await page.getByRole('button', { name: '编辑主机 UI Host', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑主机', exact: true });
  assert.equal(
    await edit.getByLabel('地址（IP / 域名）', { exact: true }).inputValue(),
    '192.0.2.12',
  );
  await edit.getByLabel('主机名称（可选）', { exact: true }).fill('UI Host edited');
  await edit.getByLabel('地址（IP / 域名）', { exact: true }).fill('192.0.2.33');
  await edit.getByRole('button', { name: '保存主机', exact: true }).click();
  await edit.waitFor({ state: 'hidden' });
  assert.equal(
    (await rpc('host_list')).hosts.find((item) => item.id === host.id).hostname,
    '192.0.2.33',
  );
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  assert.equal(await page.locator('.workspace-tab').count(), currentTabs);
  await hoverHost('UI Host edited');
  await page.getByRole('button', { name: '删除主机 UI Host edited', exact: true }).press('Enter');
  const deletion = page.getByRole('dialog', { name: '确认删除主机', exact: true });
  await deletion.getByText(/UI Host edited.*192\.0\.2\.33/).waitFor();
  await deletion.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await rpc('host_list')).hosts.length, 2);
  await hoverHost('UI Host edited');
  await page.getByRole('button', { name: '删除主机 UI Host edited', exact: true }).press('Enter');
  await deletion.getByRole('button', { name: '确认删除主机', exact: true }).click();
  await deletion.waitFor({ state: 'hidden' });
  assert(!(await rpc('host_list')).hosts.some((item) => item.id === host.id));
  assert.equal((await page.locator('.host-count').textContent()).trim(), '1');
  passed.push(
    'host tree has no copy; hover/keyboard reveal edit/delete, hidden actions stay out of mouse interaction, real IPC edits and confirmed deletion preserve sessions',
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
  assert.equal(JSON.parse(exportText).hosts.length, 2);
  assert.equal((await page.locator('.host-count').textContent()).trim(), '2');
  for (const forbidden of ['credentialId', 'secretRef', 'keyPath'])
    assert(!exportText.includes(forbidden));
  await exportHosts.getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, 'host-tree-crud.png') });
  for (const name of ['UI Created', 'tree-imported']) {
    await hoverHost(name);
    await page.getByRole('button', { name: `删除主机 ${name}`, exact: true }).press('Enter');
    await deletion.getByRole('button', { name: '确认删除主机', exact: true }).click();
    await deletion.waitFor({ state: 'hidden' });
  }
  await page.getByText('尚未添加主机', { exact: true }).waitFor();
  assert.equal((await rpc('host_list')).hosts.length, 0);
  assert.equal((await page.locator('.host-count').textContent()).trim(), '0');
  passed.push(
    'host tree OpenSSH preview/import and non-sensitive export remain available; isolated records cleaned via real IPC',
  );
  const unnamed = [];
  for (const port of [22, 2222]) {
    await page
      .locator('.host-sidebar-actions')
      .getByRole('button', { name: '新建主机', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '新建主机', exact: true });
    const name = dialog.getByLabel('主机名称（可选）', { exact: true });
    assert.equal(await name.getAttribute('required'), null);
    assert.equal(await name.inputValue(), '');
    await dialog.getByLabel('地址（IP / 域名）', { exact: true }).fill('192.0.2.40');
    await dialog.getByLabel('SSH 端口', { exact: true }).fill(String(port));
    await dialog.getByLabel('用户名', { exact: true }).fill('operator');
    await dialog.getByRole('button', { name: '保存主机', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const saved = (await rpc('host_list')).hosts.find(
      (h) => h.hostname === '192.0.2.40' && h.port === port,
    );
    assert(saved, 'unnamed host must be persisted');
    assert.equal(saved.name, '');
    const display = port === 22 ? saved.hostname : `${saved.hostname}:${port}`;
    assert.equal(
      await page.locator(`[data-host-id="${saved.id}"] .host-name`).textContent(),
      display,
    );
    unnamed.push({ id: saved.id, display });
  }
  await page.screenshot({ path: path.join(artifacts, 'optional-host-name.png') });
  await quit();
  await start();
  await showHostTree(page);
  const unnamedDeletion = page.getByRole('dialog', { name: '确认删除主机', exact: true });
  for (const { id, display } of unnamed) {
    assert.equal((await rpc('host_list')).hosts.find((h) => h.id === id).name, '');
    assert.equal(await page.locator(`[data-host-id="${id}"] .host-name`).textContent(), display);
    await hoverHost(display);
    await page.getByRole('button', { name: `删除主机 ${display}`, exact: true }).press('Enter');
    await unnamedDeletion.getByRole('button', { name: '确认删除主机', exact: true }).click();
    await unnamedDeletion.waitFor({ state: 'hidden' });
  }
  assert.equal((await rpc('host_list')).hosts.length, 0);
  passed.push(
    'unnamed hosts persist through real form/IPC/SQLite and restart; port 22 is hidden and custom ports are displayed',
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
