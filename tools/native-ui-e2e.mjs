import { hostContextAction } from './ui-navigation.mjs';
import { hostTreeAction, reloadHosts } from './ui-navigation.mjs';
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
import { withPreservedClipboard } from './clipboard-guard.mjs';
import { navigateWorkspace, selectHostWorkspace, showHostTree } from './ui-navigation.mjs';

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
    identifier: 'cn.hiboot.desktop.ui-e2e',
    app: { appDirectoriesOverride: artifacts },
  }),
);
const executable = path.join(artifacts, 'ServerDeckUiE2E.exe');
const buildDirectory = path.join(root, 'target');
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
  await page.getByRole('heading', { name: '欢迎使用 ServerDeck', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-tabs [role="tab"]').count(), 0);
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  assert.equal(await page.locator('.xterm-container[data-state="connected"]').count(), 0);
  await page.getByRole('button', { name: '本地终端', exact: true }).click();
  await page.locator('.terminal-pane:visible .xterm-container[data-state="connected"]').waitFor();
  assert.equal(await page.locator('.terminal-tab').count(), 1);
  assert.equal(await page.locator('.terminal-pane').count(), 1);
  assert.deepEqual(
    (await page.locator('.workspace-tabs [role="tab"]').allTextContents()).map((text) =>
      text.trim(),
    ),
    ['本地设备'],
  );
}
const active = () => page.locator('.terminal-pane:visible');
const hoverHost = async (name) => {
  await page.locator('.host-list-heading').hover({ position: { x: 4, y: 4 } });
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
  await page.waitForFunction(() => {
    const state =
      document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value
        .terminals;
    return state.tabs.flatMap((tab) => tab.panes).find((pane) => pane.key === state.focused)
      ?.sessionId;
  });
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
  assert.equal(await page.getByRole('button', { name: '关于', exact: true }).count(), 0);
  await page.locator('.module-navigation [data-module="system"]').click();
  const about = page.getByRole('button', { name: '关于', exact: true });
  await about.click();
  const aboutPage = page.getByRole('region', { name: '关于 ServerDeck', exact: true });
  await aboutPage.waitFor();
  const { appVersion } = await rpc('app_bootstrap');
  assert((await aboutPage.textContent()).includes(`v${appVersion}`));
  assert.equal(await page.getByRole('dialog', { name: '关于 ServerDeck', exact: true }).count(), 0);
  assert.equal(await about.getAttribute('aria-current'), 'page');
  await about.click();
  assert.equal(await page.locator('.workspace-tab[data-view="about"]').count(), 1);
  await page.screenshot({ path: path.join(artifacts, 'about.png') });
  await page.locator('.workspace-tab[data-view="about"] .tab-close').click();
  assert.equal(await aboutPage.count(), 0);
  assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), '');
  await page.locator('.module-navigation [data-module="hosts"]').click();
  assert.equal(await page.getByText(/已恢复布局，所有窗格保持未连接/).count(), 0);
  assert.equal(await page.locator('.sidebar-local-device .host-tools').count(), 1);
  assert.equal(
    await page
      .locator('.host-sidebar-controls + .sidebar-local-device + .host-tree-scroll')
      .count(),
    1,
  );
  assert.equal(await page.locator('.module-navigation button').count(), 4);
  assert.equal(
    await page.locator('.module-navigation [aria-current="page"]').textContent(),
    '主机运维',
  );
  assert.equal(await page.locator('.split-toolbar, [aria-label="会话操作"]').count(), 0);
  await page
    .locator('.sidebar-workspace-heading')
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
    'major modules appear above contextual sidebar; About shows backend version; sidebar collapse and expansion support keyboard focus',
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
  assert.equal(await page.locator('.topbar [aria-label="打开通用"]').count(), 0);
  passed.push(
    'welcome startup waits for local-menu click, then opens PowerShell with real input/output',
  );
  const clipboardToken = `SD_CLIPBOARD_${randomUUID().replaceAll('-', '')}`;
  await withPreservedClipboard(clipboardToken, async (readSystemText) => {
    const originalQuickPaste = await page.evaluate(() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const config = pinia.state.value.application.state.config;
      window.__sdOriginalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      window.__sdWebClipboardCalls = 0;
      const blocked = () => {
        window.__sdWebClipboardCalls++;
        throw new Error('Web clipboard is disabled in the native clipboard test');
      };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: blocked, writeText: blocked },
      });
      return config.terminal.quickCopyPaste;
    });
    try {
      const unicode = `${clipboardToken}_中文🙂\r\nsecond line`;
      await rpc('plugin:clipboard-manager|write_text', { text: unicode });
      assert(
        (await readSystemText()) === unicode,
        'Native text write did not reach the OS clipboard',
      );
      assert(
        (await rpc('plugin:clipboard-manager|read_text')) === unicode,
        'Native Unicode read failed',
      );
      let outputMarker;
      for (const mode of ['menu', 'quick', 'shortcut']) {
        await page.evaluate((quick) => {
          document.querySelector(
            '#app',
          ).__vue_app__.config.globalProperties.$pinia.state.value.application.state.config.terminal.quickCopyPaste =
            quick;
        }, mode === 'quick');
        outputMarker = `SD_NATIVE_${clipboardToken}_${mode}`;
        const input = `[Console]::WriteLine(('SD_NATIVE_' + '${clipboardToken}_${mode}'))`;
        await rpc('plugin:clipboard-manager|write_text', { text: input });
        if (mode === 'menu') await terminalAction(page, active(), '粘贴');
        else if (mode === 'quick')
          await active().locator('.xterm-container').click({ button: 'right' });
        else {
          await active().locator('.xterm-helper-textarea').focus();
          await page.keyboard.press('Control+Shift+V');
        }
        await page.waitForFunction(
          (text) =>
            [...document.querySelectorAll('.terminal-pane')].some(
              (pane) =>
                pane.getBoundingClientRect().width > 0 &&
                pane.textContent.replaceAll('\u00a0', ' ').includes(text),
            ),
          input,
        );
        await page.keyboard.press('Enter');
        await active().locator('.xterm-rows').filter({ hasText: outputMarker }).waitFor();
      }
      await page.evaluate(() => {
        document.querySelector(
          '#app',
        ).__vue_app__.config.globalProperties.$pinia.state.value.application.state.config.terminal.quickCopyPaste =
          true;
      });
      await rpc('plugin:clipboard-manager|write_text', { text: `${clipboardToken}_COPY_SEED` });
      const line = active().locator('.xterm-rows > div').filter({ hasText: outputMarker }).last();
      const bounds = await line.boundingBox();
      assert(bounds, 'Missing output row for native selection copy');
      await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2, {
        steps: 8,
      });
      await page.mouse.up();
      await page.waitForFunction(
        async (marker) =>
          (await window.__TAURI_INTERNALS__.invoke('plugin:clipboard-manager|read_text')).includes(
            marker,
          ),
        outputMarker,
      );
      assert(
        (await readSystemText()).includes(outputMarker),
        'Selection copy did not reach OS clipboard',
      );
      await rpc('plugin:clipboard-manager|write_text', { text: `${clipboardToken}_SHORTCUT_SEED` });
      await page.keyboard.press('Control+Shift+C');
      await page.waitForFunction(
        async (marker) =>
          (await window.__TAURI_INTERNALS__.invoke('plugin:clipboard-manager|read_text')).includes(
            marker,
          ),
        outputMarker,
      );
      assert(
        (await readSystemText()).includes(outputMarker),
        'Copy shortcut did not reach OS clipboard',
      );
      await rpc('plugin:clipboard-manager|write_text', { text: clipboardToken + 'x'.repeat(4096) });
      await active().locator('.xterm-container').click({ button: 'right' });
      const confirmation = page.getByRole('dialog', { name: '确认大文本粘贴', exact: true });
      await confirmation.waitFor();
      await confirmation.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__sdWebClipboardCalls), 0);
    } finally {
      await page.evaluate((quick) => {
        document.querySelector(
          '#app',
        ).__vue_app__.config.globalProperties.$pinia.state.value.application.state.config.terminal.quickCopyPaste =
          quick;
        if (window.__sdOriginalClipboard)
          Object.defineProperty(navigator, 'clipboard', window.__sdOriginalClipboard);
        else delete navigator.clipboard;
        delete window.__sdOriginalClipboard;
      }, originalQuickPaste);
    }
  });
  passed.push(
    'native OS clipboard handles Unicode, menu/right-click/shortcut paste and selection/shortcut copy with web clipboard disabled; large paste confirmation remains and the original clipboard is preserved',
  );
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
  const tabsBeforeModuleSwitch = await page.locator('.workspace-tab').count();
  for (const module of ['assets', 'system']) {
    await page.locator(`.module-navigation [data-module="${module}"]`).click();
    assert.equal(await page.getByRole('heading', { name: '请选择功能', exact: true }).count(), 0);
    assert.equal(await active().locator('.xterm-container[data-state="connected"]').count(), 1);
    await command("[Console]::WriteLine(('SD_MENU_' + $sdValue))", 'SD_MENU_323');
    assert.equal(await page.locator('.workspace-tab').count(), tabsBeforeModuleSwitch);
    assert.equal(await page.locator('.module-menu [aria-current="page"]').count(), 0);
  }
  await page.screenshot({ path: path.join(artifacts, 'module-without-default.png') });
  await navigateWorkspace(page, '通用');
  assert.equal(
    await page.locator('.module-navigation [aria-current="page"]').textContent(),
    '设置',
  );
  assert.deepEqual(
    (await page.locator('.module-menu .nav-label').allTextContents()).map((text) => text.trim()),
    ['通用', '终端', '快捷键', '数据与存储', '插件管理', '关于'],
  );
  assert.equal(await page.locator('.workspace-header .host-tools').count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'module-settings.png') });
  await page.locator('.module-navigation [data-module="hosts"]').click();
  assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-view'), 'settings');
  await page.getByRole('button', { name: '本地终端', exact: true }).click();
  await command("[Console]::WriteLine(('SD_MODULE_' + $sdValue))", 'SD_MODULE_323');
  await page.screenshot({ path: path.join(artifacts, 'module-hosts.png') });
  await page.locator('.workspace-tab[data-view="settings"] .tab-close').click();
  passed.push(
    'top-level modules only change sidebar menus; the visible PowerShell and its state survive every switch',
  );
  assert.equal(await page.locator('.statusbar [aria-label="任务中心"]').count(), 0);
  await page.keyboard.press('Control+Shift+J');
  assert.equal(await page.getByRole('dialog', { name: '任务中心', exact: true }).count(), 0);
  await command(
    "[Console]::WriteLine(('SD_WITHOUT_TASK_CENTER_' + $sdValue))",
    'SD_WITHOUT_TASK_CENTER_323',
  );
  passed.push('task center is removed; its retired shortcut preserves the real local shell');
  const groups = [];
  for (const name of ['UI A', 'UI B']) {
    await hostTreeAction(page, null, '新建文件夹');
    const dialog = page.getByRole('dialog', { name: '新建文件夹', exact: true });
    await assertNativeMenuSuppressed(dialog.getByLabel('文件夹名称', { exact: true }));
    await dialog.getByLabel('文件夹名称', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '新建文件夹', exact: true }).click();
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
  await reloadHosts(page);
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
  await dragHostTo(page.locator('.group-toggle').filter({ hasText: '根目录' }));
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
  assert.equal(await page.getByRole('menu', { name: '主机树操作', exact: true }).count(), 1);
  await page.keyboard.press('Escape');
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
  await active().locator('.xterm-container[data-state="failed"]').waitFor();
  await page
    .getByRole('alert')
    .filter({ hasText: /主机尚未绑定安全凭据/ })
    .waitFor();
  await terminalTabAction(page, '复制');
  await active().locator('.xterm-container[data-state="failed"]').waitFor();
  await page
    .getByRole('alert')
    .filter({ hasText: /主机尚未绑定安全凭据/ })
    .waitFor();
  assert.equal(await page.locator('.terminal-tab').count(), 2);
  await terminalAction(page, active(), '关闭终端');
  await page.locator(`.terminal-pane:visible[data-host-id="${host.id}"]`).waitFor();
  assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), host.id);
  assert.equal(await page.locator('.terminal-tab').count(), 1);
  await page.locator('.workspace-tab.active [role=tab]').click({ button: 'middle' });
  await page.waitForFunction(
    (id) => !document.querySelector(`.terminal-pane[data-host-id="${id}"]`),
    host.id,
  );
  passed.push(
    'host clicks reuse SSH; closing the host workspace closes all of its terminal sessions',
  );
  await selectHostWorkspace(page, '');
  await navigateWorkspace(page, 'SSH 终端');
  await command("[Console]::WriteLine(('SD_RETURN_' + $sdValue))", 'SD_RETURN_323');
  await page.screenshot({ path: path.join(artifacts, 'local-powershell.png') });
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: '新建终端会话', exact: true }).click();
    await active().locator('.xterm-container[data-state="connected"]').waitFor();
  }
  await page.getByRole('button', { name: '关闭标签 会话 3', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 2);
  await page.getByRole('button', { name: '新建终端会话', exact: true }).click();
  await active().locator('.xterm-container[data-state="connected"]').waitFor();
  assert.equal(await page.getByRole('tab', { name: /^会话 5/ }).count(), 1);
  const localSessions = await page.evaluate(() =>
    document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia.state.value.terminals.tabs.flatMap(
        (tab) => tab.panes,
      )
      .filter((pane) => !pane.host)
      .map((pane) => pane.sessionId),
  );
  assert.equal(localSessions.length, 3);
  assert(localSessions.every((id) => id?.startsWith('local:')));
  await page.locator('.workspace-tab.active .tab-close').click();
  await page.getByRole('heading', { name: '欢迎使用 ServerDeck', exact: true }).waitFor();
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  const closedCodes = await page.evaluate(
    async (ids) =>
      Promise.all(
        ids.map(async (id) => {
          try {
            await window.__TAURI_INTERNALS__.invoke('terminal_resize', {
              id,
              size: { cols: 80, rows: 24 },
            });
            return 'STILL_OPEN';
          } catch (error) {
            return error.code;
          }
        }),
      ),
    localSessions,
  );
  assert.deepEqual(
    closedCodes,
    localSessions.map(() => 'NOT_FOUND'),
  );
  assert.equal(await page.locator('.workspace-tabs [role=tab]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '打开本地工作区', exact: true }).count(), 0);
  await page.getByRole('button', { name: '打开本地终端', exact: true }).click();
  await command("[Console]::WriteLine(('SD_WELCOME_' + ($null -eq $sdValue)))", 'SD_WELCOME_True');
  assert.equal(await page.getByRole('tab', { name: /^会话 1/ }).count(), 1);
  passed.push(
    'workspace close frees all three local PTYs; numbering continues with surviving sessions and resets to one only when empty',
  );
  await showHostTree(page);
  await row.click();
  await active().locator('.xterm-container[data-state="failed"]').waitFor();
  await selectHostWorkspace(page, '');
  for (let index = 0; index < 3; index++) {
    await page.getByRole('button', { name: '新建终端会话', exact: true }).click();
    await active().locator('.xterm-container[data-state="connected"]').waitFor();
  }
  assert.equal(await page.locator('.terminal-tab').count(), 4);
  await command('$sdBeforeExit = 42', '42');
  const legacyTabs = Array.from({ length: 5 }, (_, index) => {
    const pane = randomUUID();
    return {
      key: randomUUID(),
      title: `旧会话 ${index + 1}`,
      panes: [{ key: pane, hostId: index === 4 ? host.id : null }],
      layout: { kind: 'leaf', pane },
    };
  });
  const legacyLayout = { version: 1, active: legacyTabs[0].key, tabs: legacyTabs };
  await rpc('workspace_save', { layout: legacyLayout });
  await quit();
  await start();
  await command(
    "[Console]::WriteLine(('SD_FRESH_' + ($null -eq $sdValue -and $null -eq $sdBeforeExit)))",
    'SD_FRESH_True',
  );
  const saved = await rpc('host_list');
  assert.equal(saved.groups.length, 2);
  assert.equal(saved.hosts.find((h) => h.id === host.id).groupId, null);
  passed.push(
    'exit with four local shells and a remote tab restarts on welcome; old five-tab layout is ignored and explicit local selection opens exactly one fresh shell',
  );
  assert.deepEqual(await rpc('workspace_load'), legacyLayout);
  assert.equal(await page.locator(`.terminal-pane[data-host-id="${host.id}"]`).count(), 0);
  await showHostTree(page);
  await page.locator(`.tree-host[data-host-id="${host.id}"]`).click();
  await active().locator('.xterm-container[data-state="failed"]').waitFor();
  await page
    .getByRole('alert')
    .filter({ hasText: /主机尚未绑定安全凭据/ })
    .waitFor();
  assert.equal(await page.locator('.terminal-tab').count(), 1);
  await page.locator(`.tree-host[data-host-id="${host.id}"]`).dblclick();
  assert.equal(await page.locator('.terminal-tab').count(), 1);
  await selectHostWorkspace(page, '');
  passed.push(
    'remote tabs are absent after restart; explicit host selection opens one fresh shell and repeated selection reuses it',
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
  assert.equal(await page.getByRole('button', { name: '主机管理', exact: true }).count(), 0);
  assert.equal((await page.locator('.sidebar-module-title').textContent()).trim(), '主机管理');
  assert.equal(await page.getByRole('button', { name: '主机工作区', exact: true }).count(), 0);
  assert.equal(await page.locator('.hosts-view').count(), 0);
  await page.getByLabel('搜索主机', { exact: true }).fill('UI Host');
  await hostTreeAction(page, groups[1].id, '新建主机');
  const createHost = page.getByRole('dialog', { name: '新建主机', exact: true });
  await createHost.getByLabel('主机名称（可选）', { exact: true }).fill('UI Created');
  await createHost.getByLabel('地址（IP / 域名）', { exact: true }).fill('192.0.2.20');
  await createHost.getByLabel('用户名', { exact: true }).fill('operator');
  assert.equal(await createHost.getByLabel('分组', { exact: true }).count(), 0);
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
  assert.equal(await page.locator('.tree-host-actions').count(), 0);
  assert.equal(await hostRow.getByRole('button').count(), 1);
  await hoverHost('UI Host');
  assert.equal(await hostRow.getByRole('button').count(), 1);
  await hostRow.locator('.tree-host').focus();
  assert.equal(
    await page.locator('[aria-label^="编辑主机 "], [aria-label^="删除主机 "]').count(),
    0,
  );
  await page.screenshot({ path: path.join(artifacts, 'host-row-no-icons.png') });
  await hostContextAction(page, hostRow.locator('.tree-host'), '编辑主机');
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
  await hostContextAction(page, hostRow.locator('.tree-host'), '删除主机');
  const deletion = page.getByRole('dialog', { name: '确认删除主机', exact: true });
  await deletion.getByText(/UI Host edited.*192\.0\.2\.33/).waitFor();
  await deletion.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await rpc('host_list')).hosts.length, 2);
  await hoverHost('UI Host edited');
  await hostContextAction(page, hostRow.locator('.tree-host'), '删除主机');
  await deletion.getByRole('button', { name: '确认删除主机', exact: true }).click();
  await deletion.waitFor({ state: 'hidden' });
  assert(!(await rpc('host_list')).hosts.some((item) => item.id === host.id));
  assert.equal((await page.locator('.host-count').textContent()).trim(), '1');
  passed.push(
    'host rows contain no inline action icons; context editing and confirmed deletion preserve sessions',
  );
  await showHostTree(page);
  await hostTreeAction(page, null, '导入 OpenSSH Config…');
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
  assert.equal((await rpc('host_list')).hosts.length, 2);
  assert.equal((await page.locator('.host-count').textContent()).trim(), '2');
  assert.equal(await page.locator('.host-list-heading button').count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'host-tree-crud.png') });
  for (const name of ['UI Created', 'tree-imported']) {
    await hoverHost(name);
    await hostContextAction(page, page.locator('.tree-host').filter({ hasText: name }), '删除主机');
    await deletion.getByRole('button', { name: '确认删除主机', exact: true }).click();
    await deletion.waitFor({ state: 'hidden' });
  }
  await page.getByText('尚未添加主机', { exact: true }).waitFor();
  assert.equal((await rpc('host_list')).hosts.length, 0);
  assert.equal((await page.locator('.host-count').textContent()).trim(), '0');
  passed.push(
    'host tree OpenSSH preview/import and host count work without JSON controls; isolated records cleaned via real IPC',
  );
  const unnamed = [];
  for (const port of [22, 2222]) {
    await hostTreeAction(page, null, '新建主机');
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
    await hostContextAction(
      page,
      page.locator('.tree-host').filter({ hasText: display }),
      '删除主机',
    );
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
