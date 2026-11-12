import { showHostTree } from './ui-navigation.mjs';
// Real Windows/WebView2 and Rust window APIs, with a separate QA profile and executable.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace, closeApplicationSettings } from './ui-navigation.mjs';

assert.equal(process.platform, 'win32', 'titlebar QA requires Windows/WebView2');
const root = fileURLToPath(new URL('../', import.meta.url));
const reuse = process.argv[2] === '--reuse';
const artifacts = reuse
  ? path.resolve(process.argv[3])
  : path.join(root, '.local/qa/titlebar', String(Date.now()));
assert.equal(path.dirname(artifacts), path.join(root, '.local/qa/titlebar'));
await mkdir(artifacts, { recursive: true });
const config = path.join(artifacts, 'tauri-qa.json');
await writeFile(
  config,
  JSON.stringify({
    identifier: 'cn.hiboot.desktop.titlebar-qa',
    app: {
      appDirectoriesOverride: artifacts,
      security: {
        capabilities: [
          'main',
          'remote-editor',
          {
            identifier: 'titlebar-test',
            windows: ['main'],
            permissions: [
              'core:window:allow-is-decorated',
              'core:window:allow-is-minimized',
              'core:window:allow-set-size',
            ],
          },
        ],
      },
    },
  }),
);
const executable = path.join(artifacts, 'ServerDeckTitlebarQA.exe');
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
    // The ordinary build must not retain QA paths, identifier or extra query permissions.
    build([]);
  }
}

let child, browser, page, invoke;
const errors = [],
  passed = [];
async function launch() {
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
  let endpoint, connectionError;
  for (let attempt = 0; attempt < 100 && !endpoint; attempt++) {
    assert.equal(child.exitCode, null, 'QA exited before WebView2 was ready');
    try {
      endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch (error) {
      // WebView2 has not opened its local debugging endpoint yet.
      connectionError = error;
    }
    if (!endpoint) await delay(200);
  }
  assert(endpoint, `WebView2 debugger unavailable: ${connectionError?.message}`);
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts().flatMap((context) => context.pages())[0];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  assert.equal(path.resolve((await invoke('app_bootstrap')).dataDirectory), artifacts);
}
async function windowState(command, expected) {
  await page.waitForFunction(
    async ({ command, expected }) =>
      (await window.__TAURI_INTERNALS__.invoke(`plugin:window|${command}`, { label: 'main' })) ===
      expected,
    { command, expected },
  );
}
async function appearance(theme, font = '标准') {
  await navigateWorkspace(page, '通用');
  const settings = page.locator('.settings-page:visible');
  await settings.getByTestId('theme-select').selectOption(theme);
  await settings
    .locator('.interface-font-ticks')
    .getByRole('button', { name: font, exact: true })
    .click();
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('设置已保存', { exact: false }).first().waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value
        .application.saving,
  );
  const saved = (await invoke('app_bootstrap')).config;
  assert.equal(saved.theme, theme);
  assert.equal(saved.interfaceFontSize, font === '超大' ? 'ultraLarge' : 'standard');
  await closeApplicationSettings(page);
}
async function confirmClose() {
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  const review = page.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true });
  await review.getByRole('button', { name: '确认', exact: true }).click();
  for (let attempt = 0; attempt < 150 && child.exitCode === null; attempt++) await delay(100);
  assert.equal(child.exitCode, 0, 'confirmed exit must finish normally');
  await browser.close();
  browser = undefined;
}
async function sidebarLayout() {
  const layout = await page.evaluate(() => {
    const rail = document.querySelector('.activity-rail').getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    const main = document.querySelector('.main-content').getBoundingClientRect();
    const settings = document.querySelector('.sidebar-app-actions button').getBoundingClientRect();
    return {
      railWidth: rail.width,
      columnsFit: rail.right <= sidebar.left + 1 && sidebar.right <= main.left + 1,
      footerPinned: settings.bottom <= rail.bottom && rail.bottom - settings.bottom <= 18,
      noCollapse: !document.querySelector('[aria-label="收起主机栏"], [aria-label="展开主机列表"]'),
      noOverflow: document.documentElement.scrollWidth <= innerWidth,
    };
  });
  assert.equal(layout.railWidth, 52);
  assert(
    layout.columnsFit && layout.footerPinned && layout.noCollapse && layout.noOverflow,
    JSON.stringify(layout),
  );
}

try {
  await launch();
  assert.equal(await invoke('plugin:window|is_decorated', { label: 'main' }), false);
  await windowState('is_maximized', false);
  // Nested icons/text must not turn interactive buttons into drag or double-click regions.
  await page.locator('.app-search-button svg').dispatchEvent('mousedown', { button: 0, detail: 2 });
  await windowState('is_maximized', false);
  await page.getByRole('button', { name: '全局搜索', exact: true }).click();
  await page.getByRole('dialog', { name: '全局搜索', exact: true }).press('Escape');
  await sidebarLayout();
  await page.locator('.activity-rail').getByRole('button', { name: '设置', exact: true }).click();
  await sidebarLayout();
  await closeApplicationSettings(page);
  await sidebarLayout();
  passed.push('native decorations removed; search and sidebar retain independent clicks');

  await page.getByRole('button', { name: '最大化窗口', exact: true }).click();
  await windowState('is_maximized', true);
  await page.getByRole('button', { name: '还原窗口', exact: true }).click();
  await windowState('is_maximized', false);
  await page.locator('.app-brand strong').dispatchEvent('mousedown', { button: 0, detail: 2 });
  await windowState('is_maximized', true);
  await page.getByRole('button', { name: '还原窗口', exact: true }).click();
  await windowState('is_maximized', false);
  passed.push('maximize/restore buttons and native double-click handling synchronize state');

  await page.getByRole('button', { name: '最小化窗口', exact: true }).click();
  await windowState('is_minimized', true);
  const second = spawn(executable, [], { cwd: artifacts, stdio: 'ignore', windowsHide: true });
  for (let attempt = 0; attempt < 100 && second.exitCode === null; attempt++) await delay(100);
  assert.equal(second.exitCode, 0);
  await windowState('is_minimized', false);
  passed.push('minimize and single-instance activation restore the same window');

  await invoke('plugin:window|set_size', {
    label: 'main',
    value: { Logical: { width: 800, height: 500 } },
  });
  await page.waitForFunction(() => innerWidth === 960 && innerHeight === 600);
  const colors = {};
  for (const theme of ['dark', 'light']) {
    for (const font of ['标准', '超大']) {
      await appearance(theme, font);
      const layout = await page.locator('.app-header').evaluate((header) => {
        const bounds = header.getBoundingClientRect();
        const buttons = [...header.querySelectorAll('button')].map((button) =>
          button.getBoundingClientRect(),
        );
        return {
          top: bounds.top,
          background: getComputedStyle(header).backgroundColor,
          sidebarBackground: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
          foreground: getComputedStyle(header).color,
          controlsForeground: getComputedStyle(header.querySelector('.window-control')).color,
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
          reachable: buttons.every(
            (r, i) =>
              r.width > 0 &&
              r.height > 0 &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              r.top >= 0 &&
              r.bottom <= bounds.bottom &&
              (i === 0 || buttons[i - 1].right <= r.left),
          ),
        };
      });
      assert.equal(layout.top, 0);
      assert.equal(layout.background, layout.sidebarBackground);
      assert.equal(layout.foreground, layout.controlsForeground);
      assert(layout.noOverflow && layout.reachable, JSON.stringify(layout));
      colors[theme] = layout.background;
      await sidebarLayout(false);
      await page.screenshot({ path: path.join(artifacts, `${theme}-${font}.png`) });
      await sidebarLayout();
      await sidebarLayout(true);
      await page.screenshot({ path: path.join(artifacts, `${theme}-${font}-collapsed.png`) });
      await showHostTree(page);
    }
  }
  assert.notEqual(colors.dark, colors.light);
  await appearance('system');
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      colorScheme,
    );
    assert.equal(
      await page
        .locator('.app-header')
        .evaluate((header) => getComputedStyle(header).backgroundColor),
      colors[colorScheme],
    );
  }
  passed.push(
    'minimum size, dark/light/system themes and largest interface font keep all header controls reachable',
  );

  await appearance('dark');
  await page.getByRole('button', { name: '本地终端', exact: true }).click();
  await page.locator('.terminal-pane:visible .xterm-container[data-state="connected"]').waitFor();
  const sessions = () =>
    page.evaluate(() =>
      document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia.state.value.terminals.tabs.flatMap((tab) =>
          tab.panes.map((pane) => pane.sessionId),
        ),
    );
  const before = await sessions();
  assert(before.length > 0 && before.every(Boolean));
  await sidebarLayout();
  await page.getByRole('button', { name: '本地终端', exact: true }).click();
  assert.deepEqual(await sessions(), before, 'local action must reuse the current session');
  await showHostTree(page);
  assert.deepEqual(await sessions(), before, 'home navigation must retain the live session');
  passed.push(
    'fixed rail, context sidebar and pinned settings work in both themes and font sizes without replacing sessions',
  );
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  const review = page.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true });
  await review.waitFor();
  await review.press('Escape');
  await review.waitFor({ state: 'detached' });
  assert.equal(child.exitCode, null);
  assert.deepEqual(await sessions(), before);
  await page.locator('.terminal-pane:visible .xterm-container[data-state="connected"]').waitFor();
  await page.getByRole('button', { name: '最大化窗口', exact: true }).click();
  await windowState('is_maximized', true);
  await confirmClose();
  passed.push(
    'cancelled close retains live terminal; confirmed close drains resources and exits normally',
  );

  await launch();
  await windowState('is_maximized', true);
  await page.getByRole('button', { name: '还原窗口', exact: true }).waitFor();
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  await page.getByRole('button', { name: '还原窗口', exact: true }).click();
  await windowState('is_maximized', false);
  await confirmClose();
  passed.push(
    'restart restores maximized geometry and correct titlebar state without restoring terminal sessions',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify({ passed, errors }, null, 2),
  );
  console.log(JSON.stringify({ artifacts, passed }));
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (child?.exitCode === null && browser?.isConnected()) {
    await invoke('app_exit_confirm', { confirmed: true });
    for (let attempt = 0; attempt < 150 && child.exitCode === null; attempt++) await delay(100);
    assert.equal(child.exitCode, 0, 'QA cleanup must exit normally');
  }
  await browser?.close();
}
