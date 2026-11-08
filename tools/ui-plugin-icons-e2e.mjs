import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace, selectHostWorkspace } from './ui-navigation.mjs';

const output = process.env.SERVERDECK_PLUGIN_ICONS_OUTPUT ?? '.local/plugin-icons/browser';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.SERVERDECK_BROWSER ?? '/opt/google/chrome/chrome',
  headless: true,
});
const results = [];
try {
  for (const [name, width, height, theme] of [
    ['wide-dark', 2400, 1400, 'dark'],
    ['wide-light', 2400, 1400, 'light'],
    ['desktop-dark', 1440, 900, 'dark'],
    ['desktop-light', 1440, 900, 'light'],
    ['small-window', 900, 600, 'dark'],
    ['mobile', 390, 844, 'light'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.SERVERDECK_PLUGIN_ICONS_URL ?? 'http://127.0.0.1:1420');
    await page.getByText('后端未连接', { exact: true }).waitFor();
    // Isolated rendering fixtures only: no persisted changes, real servers or plugin execution.
    const expected = await page.evaluate(async (theme) => {
      const { systemPluginFixtures, toolPluginState } =
        await import('/src/services/system-plugins.fixture.ts');
      const { usePluginsStore } = await import('/src/stores/plugins.ts');
      const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
      const { useHostsStore } = await import('/src/stores/hosts.ts');
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      const { useNotificationsStore } = await import('/src/stores/notifications.ts');
      const { hostInput } = await import('/src/types/hosts.ts');
      const items = [
        ...new Map(
          [...toolPluginState().installed, ...systemPluginFixtures()].map((item) => [
            item.manifest.id,
            item,
          ]),
        ).values(),
      ].map((item) => ({ ...item, manifest: { ...item.manifest } }));
      const expected = items.map((item) => [item.manifest.id, item.manifest.icon, true]);
      // Existing installed system records must receive configured icons without reinstalling.
      for (const item of items) delete item.manifest.icon;
      const uploaded = ['rocket', undefined, 'future-icon'].map((icon, i) => ({
        ...items[0],
        source: 'user',
        manifest: {
          ...items[0].manifest,
          id: `dev.uploaded-${i}`,
          name: ['自选图标', '默认图标', '未知图标'][i],
          icon,
          contributions: [],
        },
      }));
      const plugins = usePluginsStore();
      plugins.installed = [...items, ...uploaded].map((item) => ({ ...item, enabled: true }));
      plugins.loaded = true;
      const host = {
        ...hostInput(),
        id: 'icon-host',
        name: '图标验证主机',
        hostname: 'example.test',
        createdAt: '',
        updatedAt: '',
      };
      useHostsStore().catalog = {
        hosts: [host],
        groups: [],
        credentials: [],
        pendingSecretDeletions: 0,
      };
      const terminals = useTerminalsStore();
      terminals.open(host);
      terminals.update(terminals.focused, { state: 'idle', connectRequested: false });
      useWorkspaceStore().navigate('terminals', host.id);
      useNotificationsStore().items = [];
      document.documentElement.dataset.theme = theme;
      return [
        ...expected,
        ...uploaded.map((item) => [
          item.manifest.id,
          item.manifest.icon === 'rocket' ? 'rocket' : 'boxes',
          false,
        ]),
      ];
    }, theme);
    if (!(await page.locator('.host-tree-section').isVisible()))
      await page.getByRole('button', { name: '展开主机栏', exact: true }).click();
    assert.deepEqual(
      (await page.locator('.sidebar-app-actions button').allTextContents()).map((text) =>
        text.trim(),
      ),
      ['设置'],
    );
    assert.equal(await page.locator('.activity-rail [data-plugin-id]').count(), 0);
    await navigateWorkspace(page, '插件管理');
    await page.locator('.plugin-installed-row').first().waitFor();
    const geometry = await page.locator('.plugin-manager').evaluate((element) => {
      const content = element.closest('.content-scroll');
      const style = getComputedStyle(content);
      const paddingLeft = parseFloat(style.paddingLeft);
      const cards = element.querySelectorAll('.plugin-installed-row');
      return {
        managerWidth: element.clientWidth,
        availableWidth: content.clientWidth - paddingLeft - parseFloat(style.paddingRight),
        leftInset:
          element.getBoundingClientRect().left -
          content.getBoundingClientRect().left -
          content.clientLeft -
          paddingLeft,
        sameRow:
          Math.abs(cards[0].getBoundingClientRect().top - cards[1].getBoundingClientRect().top) < 1,
        overflow: content.scrollWidth > content.clientWidth + 1,
      };
    });
    assert(
      Math.abs(geometry.managerWidth - geometry.availableWidth) < 1 &&
        Math.abs(geometry.leftInset) < 1,
      `Plugin manager must fill the shared content area: ${JSON.stringify(geometry)}`,
    );
    assert.equal(
      geometry.sameRow,
      geometry.managerWidth > 840,
      'Cards must adapt to content width',
    );
    assert.equal(geometry.overflow, false, 'Plugin manager must not overflow horizontally');
    for (const [id, icon] of expected) {
      assert.equal(
        await page
          .locator(`.plugin-installed-row[data-plugin-id="${id}"] svg.lucide-${icon}`)
          .count(),
        1,
        `management icon for ${id} should be ${icon}`,
      );
    }
    assert.equal(
      await page.locator('.plugin-installed-row svg[aria-hidden=true]').count(),
      expected.length * 3,
    );
    await page.screenshot({ path: `${output}/${name}-manager.png` });
    await page
      .locator('.plugin-installed-row[data-plugin-id="dev.uploaded-0"] .plugin-name-button')
      .click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.waitFor();
    assert.equal(await settings.locator('.plugin-configuration').count(), 1);
    assert.equal(
      await page.locator('.activity-rail [aria-current="page"]').getAttribute('aria-label'),
      '设置',
    );
    assert.equal(await page.locator('[aria-label="选择使用工具的主机"]').count(), 0);
    await page.screenshot({ path: `${output}/${name}-settings.png` });
    await settings.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await settings.waitFor({ state: 'hidden' });
    await selectHostWorkspace(page, 'icon-host');
    assert.notEqual(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), null);
    const toolbar = page.getByRole('navigation', { name: '当前主机工具', exact: true });
    assert.equal(await toolbar.locator('[aria-haspopup]').count(), 0);
    assert.equal(await page.locator('.host-plugin-menu').count(), 0);
    for (const [id, icon, functional] of expected) {
      assert.equal(
        await toolbar.locator(`[data-plugin-id="${id}"] svg.lucide-${icon}`).count(),
        functional ? 1 : 0,
      );
    }
    for (const button of await toolbar.getByRole('button').all()) {
      assert(await button.isVisible());
      const box = await button.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width + 1);
    }
    assert.equal(
      await toolbar.getByRole('button').count(),
      2 + expected.filter(([, , functional]) => functional).length,
    );
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `${output}/${name}-host-tools.png` });
    assert.deepEqual(errors, []);
    results.push({ name, width, height, theme, ...geometry, passed: true });
    await page.close();
  }
  await writeFile(`${output}/result.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
