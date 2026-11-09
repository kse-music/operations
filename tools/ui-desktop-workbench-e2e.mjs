import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { navigateWorkspace, closeApplicationSettings } from './ui-navigation.mjs';

// Isolated browser fixtures verify the real Vue shell; no persisted data or remote operations.
const output = process.env.SERVERDECK_WORKBENCH_OUTPUT ?? '.local/qa/desktop-workbench/browser';
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: 'apps/desktop/vite.config.ts',
  root: 'apps/desktop',
  server: { host: '127.0.0.1', port: 15433, strictPort: true },
});
await server.listen();
let browser;
const results = [];
try {
  browser = await chromium.launch({
    executablePath:
      process.env.SERVERDECK_BROWSER ??
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  for (const [name, width, height, theme, size] of [
    ['desktop-dark', 1440, 900, 'dark', 'standard'],
    ['desktop-light', 1440, 900, 'light', 'standard'],
    ['small-large-type', 960, 600, 'dark', 'ultraLarge'],
    ['narrow-large-type', 390, 844, 'light', 'ultraLarge'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:15433');
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.evaluate(
      async ({ theme, size }) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const { useApplicationStore } = await import('/src/stores/application.ts');
        const { useHostsStore } = await import('/src/stores/hosts.ts');
        const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
        const { useTerminalsStore } = await import('/src/stores/terminals.ts');
        const { useFilesStore } = await import('/src/stores/files.ts');
        const { useNotificationsStore } = await import('/src/stores/notifications.ts');
        const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
        const { defaultProductPreferences } = await import('/src/types/product.ts');
        const { hostInput } = await import('/src/types/hosts.ts');
        const { pluginsApi } = await import('/src/services/plugins.ts');
        const { filesApi } = await import('/src/services/files.ts');
        const { aiApi } = await import('/src/services/ai.ts');
        const { systemPluginFixtures } = await import('/src/services/system-plugins.fixture.ts');
        Object.assign(pluginsApi, {
          list: async () => systemPluginFixtures(),
          permissions: async () => null,
          statuses: async () => [],
        });
        Object.assign(filesApi, {
          tasks: async () => [],
          connections: async () => [],
          clearTransfers: async () => {},
          close: async () => {},
        });
        aiApi.models = async () => [];
        useApplicationStore(pinia).state = {
          appVersion: 'layout-check',
          databaseVersion: 10,
          dataDirectory: 'D:/ServerDeck',
          logDirectory: 'D:/ServerDeck/logs',
          config: {
            version: 2,
            theme,
            interfaceFontSize: size,
            sidebarWidth: 248,
            terminalFontSize: 14,
            connectTimeoutSecs: 15,
            monitorIntervalSecs: 5,
            transferConcurrency: 3,
            logLevel: 'info',
            terminal: defaultTerminalPreferences(),
            product: defaultProductPreferences(),
          },
        };
        const hosts = useHostsStore(pinia),
          workspace = useWorkspaceStore(pinia),
          terminals = useTerminalsStore(pinia),
          files = useFilesStore(pinia);
        hosts.catalog = {
          hosts: ['a', 'b'].map((id) => ({
            ...hostInput(),
            id,
            name: id === 'a' ? '生产服务器' : 'API 服务器',
            hostname: id === 'a' ? '192.0.2.10' : '192.0.2.20',
            username: 'ops',
            createdAt: '',
            updatedAt: '',
          })),
          groups: [],
          credentials: [],
          pendingSecretDeletions: 0,
        };
        files.local = { path: 'D:/Deploy', parent: 'D:/', entries: [] };
        for (const host of hosts.catalog.hosts) {
          files.connections[host.id] = {
            host,
            id: 'files-' + host.id,
            state: 'connected',
            error: null,
            trust: null,
            path: '/srv/' + host.id,
            loading: false,
            listing: { path: '/srv/' + host.id, parent: '/srv', entries: [] },
          };
          terminals.open(host);
          terminals.update(terminals.focused, { state: 'connected', connectRequested: false });
          workspace.navigate('terminals', host.id);
        }
        workspace.activate('host:a');
        useNotificationsStore(pinia).items = [];
      },
      { theme, size },
    );
    await page.locator('.workspace-tab[data-host-id="a"].active').waitFor();
    await page.getByRole('tablist', { name: '终端标签', exact: true }).waitFor();
    const terminalGap = await page.evaluate(
      () =>
        document.querySelector('.split-area').getBoundingClientRect().top -
        document.querySelector('.terminal-session-header').getBoundingClientRect().bottom,
    );
    assert(terminalGap <= 4, name + ': terminal content must follow its session bar');
    const dismissNotices = async () => {
      for (const button of await page.getByRole('button', { name: '关闭通知', exact: true }).all())
        await button.click();
    };
    await dismissNotices();
    if (width <= 720) await page.getByRole('button', { name: '展开主机栏', exact: true }).click();
    assert.equal(await page.locator('.module-navigation, .workspace-group-tab').count(), 0);
    assert.equal(await page.locator('.app-menu, [aria-label="应用菜单"]').count(), 0);
    assert.equal(await page.locator('.workspace-tabs').count(), 1);
    assert.equal(await page.locator('.sidebar-app-actions button').count(), 1);
    assert.equal(await page.locator('.sidebar-work-actions [aria-label="本地终端"]').count(), 1);
    assert.equal(await page.locator('.activity-rail [aria-label="插件管理"]').count(), 0);
    assert(await page.locator('.host-tree-section').isVisible());
    const localPosition = await page.locator('.sidebar-work-actions').boundingBox();
    const treePosition = await page.locator('.host-tree-section').boundingBox();
    assert(localPosition.y + localPosition.height <= treePosition.y + 1);
    const hostSearch = page.getByRole('textbox', { name: '搜索主机', exact: true });
    await hostSearch.fill('生产');
    await page.getByRole('button', { name: '收起主机栏', exact: true }).click();
    const rail = page.locator('.activity-rail-collapsed');
    await rail.waitFor();
    assert.equal(await page.locator('.host-tree-section').isVisible(), false);
    assert.equal(await page.locator('.sidebar-resizer').count(), 0);
    assert.deepEqual(
      await rail.locator('.activity-group button').evaluateAll((buttons) =>
        buttons.map((button) => ({
          label: button.ariaLabel,
          title: button.title,
        })),
      ),
      ['展开主机列表', '本地终端', '设置'].map((label) => ({
        label,
        title: label,
      })),
    );
    const railGeometry = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const main = document.querySelector('.main-content').getBoundingClientRect();
      return {
        width: sidebar.width,
        mainClear: main.left >= sidebar.right - 1,
        buttonsFit: [
          ...document.querySelectorAll('.activity-rail-collapsed .activity-group button'),
        ].every((button) => {
          const box = button.getBoundingClientRect();
          return (
            box.left >= sidebar.left &&
            box.right <= sidebar.right &&
            box.top >= sidebar.top &&
            box.bottom <= sidebar.bottom &&
            box.height >= 40
          );
        }),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.equal(railGeometry.width, 52, name + ': collapsed rail width');
    assert(
      railGeometry.mainClear && railGeometry.buttonsFit && !railGeometry.horizontalOverflow,
      JSON.stringify({ name, railGeometry }),
    );
    assert.equal(await page.getByRole('button', { name: '全局搜索', exact: true }).count(), 1);
    await page
      .locator('.app-header')
      .getByRole('button', { name: '全局搜索', exact: true })
      .click();
    const searchDialog = page.getByRole('dialog', { name: '全局搜索', exact: true });
    await searchDialog.getByRole('textbox', { name: '全局搜索内容', exact: true }).fill('生产');
    await searchDialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await rail.getByRole('button', { name: '设置', exact: true }).click();
    await closeApplicationSettings(page);
    assert.equal(await page.locator('.workspace-tab[data-host-id="a"].active').count(), 1);
    await navigateWorkspace(page, '插件管理');
    await page.locator('.plugin-manager').waitFor();
    assert(await rail.isVisible());
    assert.equal(await page.locator('.workspace-tab').count(), 2);
    assert.equal(await page.locator('.workspace-tab[data-host-id="a"].active').count(), 1);
    await page.screenshot({ path: output + '/' + name + '-plugins.png' });
    const pluginDialog = page.getByRole('dialog', { name: '设置', exact: true });
    const pluginSearch = pluginDialog.getByRole('searchbox', { name: '搜索插件', exact: true });
    await pluginSearch.fill('Docker');
    await pluginDialog.getByRole('button', { name: '配置 Docker 管理', exact: true }).click();
    await pluginDialog.getByRole('region', { name: 'Docker 管理 · 配置', exact: true }).waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 1);
    assert.equal(await page.locator('.workspace-tab[data-host-id="a"].active').count(), 1);
    await page.screenshot({ path: output + '/' + name + '-plugin-details.png' });
    await pluginDialog.getByRole('button', { name: '返回插件列表', exact: true }).click();
    assert.equal(await pluginSearch.inputValue(), 'Docker');
    await pluginSearch.fill('');
    await closeApplicationSettings(page);
    await rail.getByRole('button', { name: '展开主机列表', exact: true }).click();
    assert.equal(await hostSearch.inputValue(), '生产');
    assert.equal(await page.locator('.tree-host').count(), 1);
    await hostSearch.fill('');
    assert.equal(await page.locator('.tree-host').count(), 2);
    await page.getByRole('button', { name: '收起主机栏', exact: true }).click();
    await page.screenshot({ path: output + '/' + name + '-workspace.png' });
    await navigateWorkspace(page, 'SFTP 文件');
    await page.locator('.files-view').waitFor();
    await page.locator('.workspace-tab[data-host-id="b"] [role="tab"]').click();
    await page.locator('.workspace-tab[data-host-id="a"] [role="tab"]').click();
    await dismissNotices();
    assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-view'), 'files');
    await navigateWorkspace(page, '插件管理');
    await page.locator('.plugin-manager').waitFor();
    assert.equal(await page.locator('.workspace-tab').count(), 2);
    const tabRows = await page
      .locator('.workspace-tab')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
    assert(tabRows.every((y) => Math.abs(y - tabRows[0]) < 1));
    await closeApplicationSettings(page);
    if (!(await page.locator('.host-tree-section').isVisible()))
      await page.getByRole('button', { name: '展开主机栏', exact: true }).click();
    assert(await page.locator('.host-tree-section').isVisible());
    await navigateWorkspace(page, '通用');
    await dismissNotices();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    assert.equal(await page.locator('.workspace-tab').count(), 2);
    const dirty = settings.getByLabel('侧边栏宽度', { exact: true });
    await dirty.evaluate((input) => {
      input.value = '300';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await navigateWorkspace(page, '关于');
    await settings.locator('.about-view').waitFor();
    await navigateWorkspace(page, '模型');
    await settings.getByRole('region', { name: '模型', exact: true }).waitFor();
    await navigateWorkspace(page, '通用');
    assert.equal(await dirty.inputValue(), '300');
    const geometry = await settings.evaluate((dialog) => {
      const content = dialog.querySelector('.settings-dialog-content');
      const bounds = dialog.getBoundingClientRect();
      const save = dialog.querySelector('.form-footer [type="submit"]').getBoundingClientRect();
      return {
        horizontalOverflow:
          document.documentElement.scrollWidth > innerWidth ||
          dialog.scrollWidth > dialog.clientWidth,
        contentOverflow: content.scrollWidth > content.clientWidth,
        dialogInViewport: bounds.top >= 0 && bounds.bottom <= innerHeight + 1,
        saveInViewport: save.top >= bounds.top && save.bottom <= bounds.bottom + 1,
      };
    });
    assert(
      !geometry.horizontalOverflow && !geometry.contentOverflow,
      JSON.stringify({ name, geometry }),
    );
    assert(
      geometry.dialogInViewport && geometry.saveInViewport,
      JSON.stringify({ name, geometry }),
    );
    await page.screenshot({ path: output + '/' + name + '-settings.png' });
    await settings
      .locator(':scope > .modal-heading')
      .getByRole('button', { name: '关闭对话框', exact: true })
      .click();
    const unsaved = page.getByRole('dialog', { name: '设置尚未保存', exact: true });
    await unsaved.getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await dirty.inputValue(), '300');
    await settings.press('Escape');
    await unsaved.getByRole('button', { name: '放弃更改并关闭', exact: true }).click();
    await settings.waitFor({ state: 'hidden' });
    await navigateWorkspace(page, '关于');
    await closeApplicationSettings(page);
    assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-view'), 'files');
    assert.deepEqual(errors, []);
    results.push({ name, railGeometry, geometry, passed: true });
    await page.close();
  }
  await writeFile(output + '/results.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
