import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = process.env.SERVERDECK_PLUGIN_ICONS_OUTPUT ?? '.local/plugin-icons/browser';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.SERVERDECK_BROWSER ?? '/opt/google/chrome/chrome',
  headless: true,
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
      const items = [...toolPluginState().installed, ...systemPluginFixtures()];
      const expected = items.map((item) => [item.manifest.id, item.manifest.icon]);
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
      useWorkspaceStore().selectModule('plugins');
      useNotificationsStore().items = [];
      document.documentElement.dataset.theme = theme;
      return [
        ...expected,
        ...uploaded.map((item) => [
          item.manifest.id,
          item.manifest.icon === 'rocket' ? 'rocket' : 'boxes',
        ]),
      ];
    }, theme);
    if (!(await page.locator('.sidebar').isVisible()))
      await page.getByRole('button', { name: '展开主机栏', exact: true }).click();
    for (const [id, icon] of expected) {
      assert.equal(
        await page.locator(`.activity-rail [data-plugin-id="${id}"] svg.lucide-${icon}`).count(),
        1,
      );
    }
    assert.equal(
      await page.locator('.activity-rail [data-plugin-id] svg[aria-hidden=true]').count(),
      12,
    );
    await page.screenshot({ path: `${output}/${name}-navigation.png` });
    if (width <= 720) await page.getByRole('button', { name: '收起主机栏', exact: true }).click();
    await page.locator('.host-tools [aria-haspopup=menu]').click();
    const menu = page.getByRole('menu', { name: '已启用的插件', exact: true });
    for (const [id, icon] of expected) {
      assert.equal(await menu.locator(`[data-plugin-id="${id}"] svg.lucide-${icon}`).count(), 1);
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `${output}/${name}-host-tools.png` });
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    results.push({ name, width, height, theme, passed: true });
    await page.close();
  }
  await writeFile(`${output}/result.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
