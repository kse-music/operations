import { showHostTree } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import {
  navigateWorkspace,
  selectHostWorkspace,
  closeApplicationSettings,
} from './ui-navigation.mjs';

// Rendering fixtures are confined to these browser pages; no persisted data or remote operations.
const output = process.env.SERVERDECK_CONTEXT_OUTPUT ?? '.local/ui-context';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.SERVERDECK_BROWSER ?? '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const results = [];
try {
  for (const [name, width, height, theme] of [
    ['desktop-dark', 1440, 900, 'dark'],
    ['desktop-light', 1440, 900, 'light'],
    ['small-window', 900, 600, 'dark'],
    ['mobile', 390, 844, 'light'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.SERVERDECK_CONTEXT_URL ?? 'http://127.0.0.1:1421');
    await page.getByText('后端未连接', { exact: true }).waitFor();
    const workspaceTitle = page.locator('.workspace-group-tab');
    const hostTabs = page.getByRole('tablist', { name: '工作区', exact: true });
    const welcome = page.getByRole('heading', { name: '欢迎使用 ServerDeck', exact: true });
    await welcome.waitFor();
    assert.equal(await workspaceTitle.count(), 0);
    const expand = page.getByRole('button', { name: '展开主机列表', exact: true });
    if (width <= 720) await expand.click();
    const tree = page.getByRole('region', { name: '主机树', exact: true });
    assert.equal(await tree.locator('.host-sidebar-footer').count(), 0);
    const listFillsTree = await tree.evaluate((element) => {
      const list = element.querySelector('.host-tree-scroll');
      return (
        Math.abs(element.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom) < 1
      );
    });
    assert(listFillsTree, `${name}: the host list must fill the tree to its bottom edge`);
    const listHeading = page.locator('.host-list-heading');
    const localTerminal = page
      .locator('.sidebar-work-actions')
      .getByRole('button', { name: '本地终端', exact: true });
    assert.equal(await localTerminal.count(), 1);
    await localTerminal.click();
    await page.locator('.terminal-pane:visible[data-host-id=""]').waitFor();
    assert.equal(await localTerminal.getAttribute('aria-current'), 'page');
    await showHostTree(page);
    assert.equal(await hostTabs.getByRole('tab', { name: '本地终端', exact: true }).count(), 1);
    if (name === 'desktop-dark')
      await page.screenshot({
        path: `${output}/${name}-local-only.png`,
        clip: { x: 0, y: 0, width, height: 230 },
      });
    await page.locator('.workspace-tab[data-host-id=""] .tab-close').click();
    await welcome.waitFor();
    assert.equal(await workspaceTitle.count(), 0);
    await page.evaluate(async (theme) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const { useHostsStore } = await import('/src/stores/hosts.ts');
      const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      const { useFilesStore } = await import('/src/stores/files.ts');
      const { useNotificationsStore } = await import('/src/stores/notifications.ts');
      const { hostInput } = await import('/src/types/hosts.ts');
      const hosts = useHostsStore(pinia),
        workspace = useWorkspaceStore(pinia),
        terminals = useTerminalsStore(pinia),
        files = useFilesStore(pinia);
      hosts.catalog = {
        hosts: ['a', 'b'].map((id) => ({
          ...hostInput(),
          id,
          name: `Production ${id}`,
          hostname: `${id}.example`,
          username: 'operator',
          createdAt: '',
          updatedAt: '',
        })),
        groups: [],
        credentials: [],
        pendingSecretDeletions: 0,
      };
      files.local = { path: 'C:/', parent: null, entries: [] };
      for (const host of hosts.catalog.hosts) {
        files.connections[host.id] = {
          host,
          id: `files-${host.id}`,
          state: 'connected',
          error: null,
          trust: null,
          path: `/${host.id}`,
          loading: false,
          listing: { path: `/${host.id}`, parent: '/', entries: [] },
        };
        terminals.open(host);
        // Retain disconnected terminal metadata without invoking SSH in this rendering suite.
        terminals.update(terminals.focused, { state: 'idle', connectRequested: false });
      }
      terminals.activateHost('a');
      workspace.navigate('terminals', 'a');
      useNotificationsStore(pinia).items = [];
      document.documentElement.dataset.theme = theme;
    }, theme);
    const nav = async (label) => {
      for (const close of await page.getByRole('button', { name: '关闭通知', exact: true }).all())
        await close.click();
      await navigateWorkspace(page, label);
    };
    const assertHost = async (id, view) => {
      assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), id);
      assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-view'), view);
    };
    await page.getByRole('tab', { name: /会话 1/ }).waitFor();
    await assertHost('a', 'terminals');
    const existingTabs = await page.locator('.workspace-tab').count();
    const treeVisibleBeforeSettings = await page.locator('.host-tree-section').isVisible();
    for (const category of ['通用', '终端', '关于']) {
      await nav(category);
      await assertHost('a', 'terminals');
      assert.equal(await hostTabs.isVisible(), true);
      assert.equal(await page.locator('.terminal-pane:visible[data-host-id="a"]').count(), 1);
      assert.equal(await page.locator('.workspace-tab').count(), existingTabs);
      assert.equal(await page.locator('.workspace-tab.active').count(), 1);
      assert.equal(await page.locator('.host-tree-section').isVisible(), treeVisibleBeforeSettings);
      assert.equal(
        await page.locator('.settings-navigation [aria-current="page"]').getAttribute('aria-label'),
        category,
      );
    }
    await page.screenshot({ path: `${output}/${name}-settings-preserve-context.png` });
    await closeApplicationSettings(page);
    assert.equal(await page.locator('[aria-controls="workspace-file-panel"]').count(), 0);
    assert.equal(await page.locator('.workspace-file-panel').count(), 0);
    assert.equal(await page.locator('.sidebar [aria-label="当前主机工具"]').count(), 0);
    await nav('SFTP 文件');
    assert.equal(await page.getByLabel('远程路径', { exact: true }).inputValue(), '/a');
    assert.equal(await page.getByLabel('本地路径', { exact: true }).count(), 1);
    assert.equal(await page.locator('.files-view').count(), 1);
    await nav('SSH 终端');
    assert.equal(await page.locator('.files-view').count(), 0);
    await page.evaluate(async () => {
      const { useFilesStore } = await import('/src/stores/files.ts');
      if (useFilesStore().connections.a.id !== 'files-a')
        throw new Error('switching tools disconnected SFTP');
    });
    assert.equal(await page.locator('.workspace-context').count(), 0);
    assert.deepEqual(
      (await page.locator('.workspace-header .host-tools button').allTextContents()).map((text) =>
        text.trim(),
      ),
      ['SSH 终端', 'SFTP 文件'],
    );
    assert.equal(await page.locator('.terminal-tab').count(), 1);
    assert.equal(await page.getByText(/已恢复布局，所有窗格保持未连接/).count(), 0);
    const sessionActions = page.getByRole('toolbar', { name: '会话操作', exact: true });
    assert.equal(await sessionActions.count(), 0);
    assert.equal(await page.locator('.split-toolbar').count(), 0);
    await page.getByRole('button', { name: '新建终端会话', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 2);
    await page.evaluate(async () => {
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      const store = useTerminalsStore();
      const added = store.tabs.find((tab) => tab.key === store.active);
      const pane = added.panes[0];
      if (pane.host?.id !== 'a' || added.panes.length !== 1 || pane.key !== store.focused)
        throw new Error('plus must open and focus a single new session for the current host');
      store.rename(store.hostTabs('a')[0].key, '长会话名称'.repeat(24));
    });
    const scrollable = page.getByRole('tablist', { name: '终端标签', exact: true });
    assert(await scrollable.evaluate((tabs) => tabs.scrollWidth > tabs.clientWidth));
    assert(
      await page
        .getByRole('button', { name: '新建终端会话', exact: true })
        .evaluate(
          (button) =>
            button.getBoundingClientRect().right <=
            button.parentElement.getBoundingClientRect().right,
        ),
    );
    await scrollable.evaluate((tabs) => {
      tabs.scrollLeft = 0;
    });
    assert.equal(await page.getByRole('menu').count(), 0);
    await page.locator('.terminal-tab').first().click({ button: 'right' });
    assert.equal(await page.getByRole('menu').count(), 0);
    await page.locator('.terminal-tab [aria-label^="关闭标签 "]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 1);
    const compactHeader = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const host = box('.workspace-header'),
        sessions = box('.terminal-session-header'),
        area = box('.split-area'),
        workspace = box('.workspace-tabs'),
        tools = box('.workspace-header .host-tools'),
        add = box('[aria-label="新建终端会话"]'),
        lastTab = box('.terminal-tab:last-child');
      return {
        hostHeight: host.height,
        toolsInsideToolbar:
          tools.left >= host.left &&
          tools.right <= host.right &&
          tools.top >= host.top &&
          tools.bottom <= host.bottom,
        toolsBeforeSessions: tools.bottom <= sessions.top,
        plusNextToTabs: add.left >= lastTab.right && add.left - lastTab.right <= 8,
        plusVisible: add.right <= sessions.right,
        sessionsBelowTools: sessions.top >= host.bottom,
        sessionHeight: sessions.height,
        terminalGap: area.top - sessions.bottom,
        sessionsOutsideToolbar: sessions.top >= host.bottom,
        totalHeight: area.top - workspace.bottom,
      };
    });
    assert(compactHeader.toolsInsideToolbar, JSON.stringify({ name, compactHeader }));
    assert(compactHeader.toolsBeforeSessions, JSON.stringify({ name, compactHeader }));
    assert(
      compactHeader.plusNextToTabs && compactHeader.plusVisible,
      JSON.stringify({ name, compactHeader }),
    );
    if (width >= 900)
      assert(compactHeader.sessionsBelowTools, JSON.stringify({ name, compactHeader }));
    assert(compactHeader.terminalGap <= 4, JSON.stringify({ name, compactHeader }));
    assert(compactHeader.sessionsOutsideToolbar, JSON.stringify({ name, compactHeader }));
    assert(compactHeader.sessionHeight <= 40, JSON.stringify({ name, compactHeader }));
    assert(
      compactHeader.totalHeight <= (width >= 1200 ? 84 : width > 720 ? 116 : 200),
      JSON.stringify({ name, compactHeader }),
    );
    await page.screenshot({ path: `${output}/${name}-compact-header.png` });
    await selectHostWorkspace(page, 'b');
    await assertHost('b', 'terminals');
    assert.equal(await page.locator('.terminal-tab').count(), 1);
    assert.equal(await page.locator('.workspace-tab').count(), 2);
    const tabsBox = await hostTabs.boundingBox();
    const toolbarBox = await page.locator('.workspace-header').boundingBox();
    assert(
      tabsBox && toolbarBox && tabsBox.y + tabsBox.height <= toolbarBox.y,
      'Host tabs must precede their tools',
    );
    await nav('SFTP 文件');
    await page.getByLabel('远程路径', { exact: true }).waitFor();
    await assertHost('b', 'files');
    assert.equal(await page.getByLabel('远程路径', { exact: true }).inputValue(), '/b');
    await selectHostWorkspace(page, 'a');
    await assertHost('a', 'terminals');
    await nav('SFTP 文件');
    await page.waitForFunction(
      () => document.querySelector('[aria-label="远程路径"]')?.value === '/a',
    );
    assert.equal(await page.locator('.files-host-tabs, [aria-label="文件管理主机"]').count(), 0);
    await page.screenshot({ path: `${output}/${name}-files.png` });
    await selectHostWorkspace(page, 'b');
    await assertHost('b', 'files');
    assert.equal(await page.getByLabel('远程路径', { exact: true }).inputValue(), '/b');
    await nav('通用');
    assert.equal(await page.locator('.settings-page:visible').count(), 1);
    assert.equal(await hostTabs.isVisible(), true);
    assert.equal(await page.getByRole('navigation', { name: '当前主机工具' }).count(), 1);
    await closeApplicationSettings(page);
    await assertHost('b', 'files');
    assert.equal(await page.getByLabel('远程路径', { exact: true }).inputValue(), '/b');
    await selectHostWorkspace(page, 'a');
    await assertHost('a', 'files');
    await selectHostWorkspace(page, '');
    await assertHost('', 'terminals');
    assert.equal(await page.locator('.workspace-header .host-tools').count(), 0);
    assert.equal(await page.getByLabel('当前工作区主机', { exact: true }).count(), 0);
    await selectHostWorkspace(page, 'b');
    await nav('SSH 终端');
    await assertHost('b', 'terminals');
    await page.getByRole('tab', { name: /会话 1/ }).waitFor();
    await page.waitForFunction(
      () => {
        const bounds = document.querySelector('.workspace-tab.active')?.getBoundingClientRect();
        return bounds && bounds.width > 50 && bounds.left >= 0 && bounds.right <= innerWidth;
      },
      undefined,
      { timeout: 3000 },
    );
    const bounds = await page.locator('.workspace-tab.active').boundingBox();
    assert(
      bounds && bounds.width > 50 && bounds.x >= 0 && bounds.x + bounds.width <= width,
      JSON.stringify({ name, width, bounds }),
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/${name}-terminal.png` });
    await page.locator('.terminal-tab.active [aria-label^="关闭标签 "]').click();
    await page.getByRole('heading', { name: '没有打开的终端', exact: true }).waitFor();
    await page.evaluate(async () => {
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      const store = useTerminalsStore();
      if (store.hostTabs('a').length !== 1 || store.hostTabs('b').length !== 0)
        throw new Error('closing a session must leave other hosts running');
    });
    await page.screenshot({ path: `${output}/${name}-closed-session.png` });
    await nav('模型');
    assert.equal(
      await page.locator('.settings-navigation [aria-current="page"]').getAttribute('aria-label'),
      '模型',
    );
    await page.screenshot({ path: `${output}/${name}-models-settings.png` });
    await nav('关于');
    await closeApplicationSettings(page);
    await nav('插件管理');
    assert.equal(
      await page.locator('.settings-navigation [aria-current="page"]').getAttribute('aria-label'),
      '插件',
    );
    await selectHostWorkspace(page, 'b');
    await assertHost('b', 'terminals');
    await page.locator('.terminal-pane:visible[data-host-id="b"]').waitFor();
    assert.deepEqual(
      await page
        .locator('.sidebar-app-actions button')
        .evaluateAll((buttons) => buttons.map((button) => button.ariaLabel)),
      ['设置'],
    );
    assert.equal(await page.locator('.workspace-header .host-tools').count(), 1);
    assert.deepEqual(errors, []);
    results.push({ name, width, height, theme, compactHeader, passed: true });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(`PASS ${results.length} host context and layout scenarios. Artifacts: ${output}`);
} finally {
  await browser.close();
}
