import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Real Vue/xterm in an isolated browser, with in-memory APIs; no SSH, native Shell or disk writes.
const repository = process.cwd();
const output = path.join(repository, '.local/qa/three-column');
await mkdir(output, { recursive: true });
const server = await createServer({
  root: path.join(repository, 'apps/desktop'),
  configFile: path.join(repository, 'apps/desktop/vite.config.ts'),
  mode: 'test',
  server: { host: '127.0.0.1', port: 19452, strictPort: true },
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
  for (const [name, width, height, theme, size] of [
    ['desktop-dark', 1280, 820, 'dark', 'standard'],
    ['desktop-light', 1280, 820, 'light', 'standard'],
    ['minimum-large', 960, 600, 'light', 'ultraLarge'],
    ['narrow', 390, 844, 'dark', 'standard'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:19452');
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.evaluate(
      async ({ theme, size }) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const { defaultProductPreferences } = await import('/src/types/product.ts');
        const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
        const { hostInput } = await import('/src/types/hosts.ts');
        const { terminalApi } = await import('/src/services/terminal.ts');
        const { pluginsApi } = await import('/src/services/plugins.ts');
        const { filesApi } = await import('/src/services/files.ts');
        const application = pinia._s.get('application');
        application.state = {
          appVersion: 'QA',
          databaseVersion: 10,
          dataDirectory: '',
          logDirectory: '',
          config: {
            version: 2,
            theme,
            interfaceFontSize: size,
            sidebarWidth: 248,
            terminalFontSize: 14,
            connectTimeoutSecs: 15,
            monitorIntervalSecs: 3,
            transferConcurrency: 2,
            logLevel: 'info',
            terminal: defaultTerminalPreferences(),
            product: defaultProductPreferences(),
          },
        };
        application.error = null;
        pinia._s.get('notifications').items = [];
        pinia._s.get('hosts').catalog = {
          hosts: ['192.0.2.10', '192.0.2.20'].map((hostname, index) => ({
            ...hostInput(),
            id: `qa-${index}`,
            hostname,
            groupId: null,
            createdAt: '',
            updatedAt: '',
          })),
          groups: [],
          credentials: [],
          pendingSecretDeletions: 0,
        };
        let sequence = 0;
        let opened = 0;
        let closed = 0;
        const open = (receive) => {
          const id = `qa-session-${++sequence}`;
          opened += 1;
          queueMicrotask(() => {
            receive({ type: 'state', state: 'connected', code: null, message: null });
            receive({
              type: 'data',
              sequence: 1,
              data: Array.from(new TextEncoder().encode('QA terminal fixture\r\n$ ')),
            });
          });
          return id;
        };
        terminalApi.openLocal = async (_size, receive) => ({
          id: open(receive),
          shell: 'QA Shell',
        });
        terminalApi.open = async (hostId, _size, receive) => ({
          id: open(receive),
          hostId,
          transportId: 'qa-transport',
          routeHostIds: [],
        });
        terminalApi.close = async () => {
          closed += 1;
        };
        terminalApi.input = terminalApi.resize = terminalApi.ack = async () => {};
        pluginsApi.inventory = async () => ({ installed: [], problems: [], availableBundled: [] });
        pluginsApi.list = pluginsApi.statuses = async () => [];
        filesApi.tasks = filesApi.connections = async () => [];
        window.threeColumnQA = { pinia, counts: () => ({ opened, closed }) };
      },
      { theme, size },
    );
    const rail = page.locator('.activity-rail');
    assert.deepEqual(
      await rail
        .locator('button')
        .evaluateAll((buttons) => buttons.map((button) => button.ariaLabel)),
      ['首页', '本地终端', '设置'],
    );
    const geometry = async () =>
      page.evaluate(() => {
        const rect = (selector) =>
          document.querySelector(selector).getBoundingClientRect().toJSON();
        return {
          rail: rect('.activity-rail'),
          sidebar: rect('.sidebar'),
          main: rect('.main-content'),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
    const initial = await geometry();
    assert.equal(initial.overflow, false);
    assert(Math.abs(initial.rail.right - initial.sidebar.left) < 1);
    assert(Math.abs(initial.sidebar.right - initial.main.left) < 1);
    assert.equal(await page.getByRole('button', { name: '收起主机栏', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, `${name}-home.png`) });
    await page.locator('.tree-host').first().dblclick();
    await page.locator('.terminal-pane[data-state="connected"] .xterm-screen').waitFor();
    const remote = await page.locator('.split-pane:visible').elementHandle();
    await rail.getByRole('button', { name: '本地终端', exact: true }).click();
    await page.locator('.local-session-sidebar .terminal-tab').waitFor();
    await page.locator('.terminal-pane[data-state="connected"]:visible').waitFor();
    const local = await page.locator('.split-pane:visible').elementHandle();
    const newSession = async () => {
      const trigger = page
        .locator('.local-session-sidebar')
        .getByRole('button', { name: '新建终端会话', exact: true });
      const bounds = await trigger.boundingBox();
      assert(bounds);
      const position = { x: bounds.width * 0.75, y: bounds.height / 2 };
      await trigger.click({ position });
      const menu = page.getByRole('menu', { name: '新建终端会话', exact: true });
      if (await menu.isVisible()) {
        const menuBounds = await menu.boundingBox();
        assert(menuBounds);
        assert(
          Math.abs(
            menuBounds.x -
              Math.max(8, Math.min(bounds.x + position.x, width - menuBounds.width - 8)),
          ) <= 1,
          `${name}: new session menu must follow the click horizontally`,
        );
        assert(
          Math.abs(
            menuBounds.y -
              Math.max(8, Math.min(bounds.y + position.y, height - menuBounds.height - 8)),
          ) <= 1,
          `${name}: new session menu must follow the click vertically`,
        );
        await page.screenshot({ path: path.join(output, `${name}-new-session-menu.png`) });
        await menu.getByRole('menuitem', { name: '新建普通会话', exact: true }).click();
      }
    };
    await newSession();
    await page.locator('.local-session-sidebar .terminal-tab').nth(1).waitFor();
    assert.equal(await page.locator('.local-session-sidebar .terminal-tab').count(), 2);
    await page.screenshot({ path: path.join(output, `${name}-local.png`) });
    await rail.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.settings-page:visible').waitFor();
    assert.equal(await page.locator('dialog[aria-label="设置"]').count(), 0);
    assert.equal(await page.locator('.settings-navigation button').count(), 7);
    const widthField = page.getByLabel('侧边栏宽度', { exact: true });
    assert.equal(
      await page
        .locator('.settings-page')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
    );
    const languageField = page.getByLabel('界面语言', { exact: true });
    await languageField.scrollIntoViewIfNeeded();
    assert.equal(
      await languageField.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2),
        );
      }),
      true,
      `${name}: settings fields must remain reachable below the sticky save footer`,
    );
    await widthField.fill('300');
    await widthField.dispatchEvent('input');
    await page.screenshot({ path: path.join(output, `${name}-settings.png`) });
    await rail.getByRole('button', { name: '首页', exact: true }).click();
    assert(
      await remote.evaluate(
        (element) => element.isConnected && !element.classList.contains('terminal-hidden'),
      ),
    );
    await rail.getByRole('button', { name: '本地终端', exact: true }).click();
    assert(await local.evaluate((element) => element.isConnected));
    assert.equal(await page.locator('.local-session-sidebar .terminal-tab').count(), 2);
    await rail.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await widthField.inputValue(), '300');
    await page
      .getByRole('navigation', { name: '设置分类', exact: true })
      .getByRole('button', { name: '终端', exact: true })
      .click();
    await page
      .locator('.settings-page')
      .getByRole('heading', { name: '终端', exact: true })
      .waitFor();
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    const after = await geometry();
    assert.deepEqual(after, initial);
    assert.deepEqual(await page.evaluate(() => window.threeColumnQA.counts()), {
      opened: 3,
      closed: 0,
    });
    assert.deepEqual(errors, []);
    await page.evaluate(() => {
      window.onbeforeunload = null;
    });
    results.push({ name, width, height, theme, size, geometry: initial, stateRetention: 'passed' });
    console.log(`${name}: passed`);
    await page.close({ runBeforeUnload: false });
  }
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
