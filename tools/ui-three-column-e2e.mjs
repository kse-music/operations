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
async function checkDeleteIcon(button) {
  const icon = button.locator('svg.lucide-trash-2');
  await icon.waitFor();
  const colors = await icon.evaluate((svg) => {
    const sample = document.createElement('span');
    sample.style.color = 'var(--error)';
    svg.parentElement.append(sample);
    const expected = getComputedStyle(sample).color;
    sample.remove();
    return { actual: getComputedStyle(svg).stroke, expected };
  });
  assert.equal(colors.actual, colors.expected);
}
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath:
      process.env.SERVERDECK_BROWSER ??
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  for (const [name, width, height, theme, size] of [
    ['desktop-dark', 1280, 820, 'dark', 100],
    ['desktop-light', 1280, 820, 'light', 100],
    ['minimum-large', 960, 600, 'light', 145],
    ['narrow', 390, 844, 'dark', 100],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:19452');
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.evaluate(
      async ({ theme, size, name }) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const { defaultProductPreferences } = await import('/src/types/product.ts');
        const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
        const { hostInput } = await import('/src/types/hosts.ts');
        const { terminalApi } = await import('/src/services/terminal.ts');
        const { batchApi } = await import('/src/services/batch.ts');
        const { pluginsApi } = await import('/src/services/plugins.ts');
        const { filesApi } = await import('/src/services/files.ts');
        const application = pinia._s.get('application');
        application.state = {
          appVersion: 'QA',
          databaseVersion: 10,
          dataDirectory: '',
          logDirectory: '',
          config: {
            version: 5,
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
          environmentTags: { tags: [], assignments: {} },
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
        terminalApi.savedLocalSessions = async () => [
          {
            id: 'local-qa',
            title: '本地保存项',
            panes: [{ directory: 'C:/', elevated: false }],
            layout: { kind: 'leaf', pane: 0 },
          },
        ];
        terminalApi.savedSshSessions = async (hostId) =>
          name === 'narrow'
            ? []
            : [
                {
                  id: 'ssh-qa',
                  title: `SSH 保存项 ${hostId}`,
                  paneCount: 1,
                  layout: { kind: 'leaf', pane: 0 },
                },
              ];
        terminalApi.input = terminalApi.resize = terminalApi.ack = async () => {};
        batchApi.list = async () => [
          {
            id: 'command-qa',
            name: '示例命令',
            command: 'echo qa',
            hostIds: [],
            concurrency: 1,
            revision: 1,
          },
        ];
        batchApi.status = async () => null;
        pluginsApi.inventory = async () => ({ installed: [], problems: [], availableBundled: [] });
        pluginsApi.list = pluginsApi.statuses = async () => [];
        filesApi.tasks = filesApi.connections = async () => [];
        window.threeColumnQA = { pinia, counts: () => ({ opened, closed }) };
      },
      { theme, size, name },
    );
    const rail = page.locator('.activity-rail');
    assert.deepEqual(
      await rail
        .locator('button')
        .evaluateAll((buttons) => buttons.map((button) => button.ariaLabel)),
      ['首页', '本地终端', '批量命令', '设置'],
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
    const unpin = page.getByRole('button', { name: '取消固定主机栏', exact: true });
    const pin = page.getByRole('button', { name: '固定主机栏', exact: true });
    const reveal = page.getByRole('button', { name: '展开主机列表', exact: true });
    const sidePanel = page.locator('.sidebar');
    assert.equal((await unpin.innerText()).trim(), '');
    assert.equal(await unpin.locator('svg').count(), 1);
    assert.equal(await unpin.getAttribute('title'), '取消固定主机栏');
    await unpin.click();
    await sidePanel.waitFor({ state: 'hidden' });
    const hidden = await geometry();
    assert(Math.abs(hidden.main.left - hidden.rail.right) < 1, 'no blank track after unpinning');
    const markerHeight = await reveal.evaluate(
      (button) => getComputedStyle(button, '::before').height,
    );
    assert.equal(markerHeight, '128px', 'the edge marker is visibly longer');
    await reveal.hover({ position: { x: 6, y: 180 } });
    await pin.waitFor();
    assert.equal((await pin.innerText()).trim(), '');
    assert.equal(await pin.locator('svg').count(), 1);
    assert.equal(await pin.getAttribute('title'), '固定主机栏');
    const peek = await geometry();
    assert(Math.abs(peek.sidebar.left - peek.rail.right) < 1, 'preview aligns with the rail');
    assert.equal(peek.sidebar.width, initial.sidebar.width);
    assert.equal(peek.main.left, hidden.main.left, 'hover preview does not reflow the workspace');
    assert.equal(peek.overflow, false);
    await page.mouse.move(width - 24, 100);
    await sidePanel.waitFor({ state: 'hidden' });
    await reveal.hover();
    await pin.click();
    await page.mouse.move(width - 24, 100);
    assert(await unpin.isVisible());
    assert.equal((await geometry()).main.left, initial.main.left, 'pin restores the docked width');
    await page.screenshot({ path: path.join(output, `${name}-home.png`) });
    const hostRow = page.locator('.tree-host').first();
    const hostId = await hostRow.getAttribute('data-host-id');
    if (name === 'narrow') {
      await hostRow.dispatchEvent('contextmenu', {
        clientX: width - 2,
        clientY: height - 2,
        bubbles: true,
        cancelable: true,
      });
    } else {
      await hostRow.click({ button: 'right' });
    }
    const savedTrigger = page.getByRole('menuitem', { name: '已保存会话', exact: true });
    await savedTrigger.press('ArrowRight');
    const savedSessionsMenu = page.locator('#host-saved-sessions-menu');
    if (name === 'narrow') await savedSessionsMenu.getByText('没有已保存的会话').waitFor();
    else
      await savedSessionsMenu
        .getByRole('menuitem', { name: `SSH 保存项 ${hostId}`, exact: true })
        .waitFor();
    const hostMenu = await page.locator('.host-tree-menu').boundingBox();
    const savedMenu = await savedSessionsMenu.boundingBox();
    assert.equal(savedMenu.width, hostMenu.width, 'saved sessions match the host menu width');
    if (name === 'narrow') {
      const right = savedMenu.x + savedMenu.width;
      const bottom = savedMenu.y + savedMenu.height;
      assert(
        savedMenu.x >= 8 && right <= width - 8 && savedMenu.y >= 8 && bottom <= height - 8,
        JSON.stringify({ hostMenu, savedMenu }),
      );
      assert(
        right <= hostMenu.x + 1 ||
          savedMenu.x >= hostMenu.x + hostMenu.width - 1 ||
          bottom <= hostMenu.y + 1 ||
          savedMenu.y >= hostMenu.y + hostMenu.height - 1,
        JSON.stringify({ hostMenu, savedMenu }),
      );
    }
    assert.equal((await page.evaluate(() => window.threeColumnQA.counts())).opened, 0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await hostRow.dblclick();
    await page.locator('.terminal-pane[data-state="connected"] .xterm-screen').waitFor();
    assert(await page.locator('.workspace-header .host-tools').isVisible());
    const remoteHeader = page.locator('#terminal-session-tools .terminal-session-header');
    const remoteHeaderBounds = await remoteHeader.boundingBox();
    await remoteHeader.click({
      button: 'right',
      position: { x: remoteHeaderBounds.width - 4, y: 10 },
    });
    assert.equal(await page.getByRole('menu', { name: '终端会话操作' }).count(), 0);
    const remote = await page.locator('.split-pane:visible').elementHandle();
    await rail.getByRole('button', { name: '本地终端', exact: true }).click();
    const localHeader = page.locator('.terminal-primary .terminal-session-header');
    const localTabs = localHeader.getByRole('tablist');
    await localTabs.getByRole('tab').waitFor();
    await page.locator('.terminal-pane[data-state="connected"]:visible').waitFor();
    const local = await page.locator('.split-pane:visible').elementHandle();
    assert.equal(await page.locator('.workspace-header').count(), 0);
    const localBounds = await page.evaluate(() => {
      const main = document.querySelector('.main-content').getBoundingClientRect();
      const terminal = document.querySelector('.terminal-workspace').getBoundingClientRect();
      return {
        mainTop: main.top,
        mainBottom: main.bottom,
        top: terminal.top,
        bottom: terminal.bottom,
      };
    });
    assert(
      Math.abs(localBounds.top - localBounds.mainTop) <= 1,
      `${name}: local terminal starts at the top of the content area`,
    );
    assert(
      Math.abs(localBounds.bottom - localBounds.mainBottom) <= 1,
      `${name}: local terminal fills the content area`,
    );
    const localSidebar = page.locator('.local-session-sidebar');
    const localSavedRecord = localSidebar.getByRole('button', { name: '本地保存项', exact: true });
    assert.equal(await localTabs.getAttribute('aria-orientation'), 'horizontal');
    await localSavedRecord.waitFor();
    await checkDeleteIcon(localSidebar.getByRole('button', { name: '删除“本地保存项”的保存记录' }));
    const localDocked = await geometry();
    assert.equal(
      localDocked.main.left,
      localDocked.sidebar.right,
      'local saved list starts docked',
    );
    await localSidebar.getByRole('button', { name: '取消固定已保存会话栏', exact: true }).click();
    await localSidebar.waitFor({ state: 'hidden' });
    const beforeLocalPeek = await geometry();
    assert.equal(beforeLocalPeek.main.left, beforeLocalPeek.rail.right);
    await page.getByRole('button', { name: '展开已保存会话', exact: true }).hover();
    await localSavedRecord.waitFor();
    assert.equal(await localSidebar.getByRole('tab').count(), 0);
    assert.equal((await geometry()).main.left, beforeLocalPeek.main.left);
    await page.mouse.move(width - 24, 100);
    await localSidebar.waitFor({ state: 'hidden' });
    const tabMenu = page.getByRole('menu', { name: '终端会话操作', exact: true });
    const createMenu = page.getByRole('menu', { name: '新建终端会话', exact: true });
    const regular = createMenu.getByRole('menuitem', { name: '新建', exact: true });
    const administrator = createMenu.getByRole('menuitem', { name: '新建(管理员)', exact: true });
    assert.equal(
      await localSidebar.getByRole('button', { name: '新建终端会话', exact: true }).count(),
      0,
    );
    await localTabs.getByRole('tab').click({ button: 'right' });
    await tabMenu.getByRole('menuitem', { name: '关闭所有', exact: true }).waitFor();
    assert.equal(await tabMenu.getByRole('menuitem', { name: /^新建/ }).count(), 0);
    await page.keyboard.press('Escape');
    const bounds = await localHeader.boundingBox();
    assert(bounds);
    const position = { x: bounds.width - 4, y: bounds.height - 4 };
    await localHeader.click({ button: 'right', position });
    assert.equal(await page.locator('.terminal-session-menu').count(), 0);
    const windows = await page.evaluate(() => navigator.platform.startsWith('Win'));
    const plus = localHeader.getByRole('button', { name: '新建终端会话', exact: true });
    const plusBounds = await plus.boundingBox();
    assert(plusBounds);
    await plus.press('Enter');
    if (windows) {
      await regular.waitFor();
      assert(await administrator.isVisible());
      assert.equal(await createMenu.getByRole('menuitem').count(), 2);
      assert.equal(await localTabs.getByRole('tab').count(), 1);
      assert.equal(await plus.getAttribute('aria-expanded'), 'true');
      const menuBounds = await createMenu.boundingBox();
      assert(menuBounds);
      assert(
        Math.abs(
          menuBounds.x - Math.max(8, Math.min(plusBounds.x, width - menuBounds.width - 8)),
        ) <= 1,
        `${name}: creation menu must align with plus horizontally`,
      );
      assert(
        Math.abs(menuBounds.y - (plusBounds.y + plusBounds.height)) <= 1,
        `${name}: creation menu must open below plus`,
      );
      await page.screenshot({ path: path.join(output, `${name}-new-session-menu.png`) });
      await regular.click();
    }
    await localTabs.getByRole('tab').nth(1).waitFor();
    assert.equal(await localTabs.getByRole('tab').count(), 2);
    await localTabs.getByRole('tab').nth(1).press('ArrowLeft');
    assert.equal(await localTabs.getByRole('tab').first().getAttribute('aria-selected'), 'true');
    await page.screenshot({ path: path.join(output, `${name}-local.png`) });
    await rail.getByRole('button', { name: '批量命令', exact: true }).click();
    await checkDeleteIcon(page.getByRole('button', { name: '删除命令 示例命令', exact: true }));
    await rail.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.settings-page:visible').waitFor();
    assert.equal(await page.locator('dialog[aria-label="设置"]').count(), 0);
    assert.equal(await page.locator('.settings-navigation button').count(), 8);
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
    assert.equal(await localTabs.getByRole('tab').count(), 2);
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
