import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Browser-only rendering fixtures; no persisted data or remote operations.
const output = process.env.SERVERDECK_TABS_OUTPUT ?? '.local/workspace-tab-menu';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.SERVERDECK_BROWSER ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const results = [];
try {
  for (const [name, width, height, theme] of [
    ['desktop-dark', 1440, 900, 'dark'],
    ['desktop-light', 1440, 900, 'light'],
    ['small-window', 900, 600, 'dark'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.SERVERDECK_TABS_URL ?? 'http://127.0.0.1:1421');
    await page.getByText('后端未连接', { exact: true }).waitFor();
    const seed = async () => {
      await page.evaluate(async (theme) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
        const { useNotificationsStore } = await import('/src/stores/notifications.ts');
        const { filesApi } = await import('/src/services/files.ts');
        // Supply empty file-connection metadata for these in-memory workspace fixtures.
        Object.assign(filesApi, {
          tasks: async () => [],
          connections: async () => [],
          clearTransfers: async () => {},
        });
        const workspace = useWorkspaceStore(pinia);
        workspace.tabs = [];
        workspace.active = '';
        workspace.navigate('terminals', '');
        workspace.navigate('terminals', 'a');
        workspace.navigate('settings');
        workspace.navigate('credentials');
        workspace.activate('host:');
        useNotificationsStore(pinia).items = [];
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.locator('.workspace-tab[data-host-id=""].active').waitFor();
    };
    const menu = page.getByRole('menu', { name: '工作区标签操作', exact: true });
    const target = page.locator('.workspace-tab[data-host-id="a"]');
    const local = page.locator('.workspace-tab[data-host-id=""]');
    const keys = () =>
      page.evaluate(async () => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
        return useWorkspaceStore(pinia).tabs.map((tab) => tab.key);
      });
    for (const [action, expected] of [
      ['关闭', ['host:', 'settings:', 'credentials:']],
      ['关闭右侧', ['host:', 'settings:', 'credentials:']],
      ['关闭其它', ['host:a']],
      ['关闭所有', []],
    ]) {
      await seed();
      await (action === '关闭右侧' ? local : target).click({ button: 'right' });
      await menu.waitFor();
      assert.equal(await local.getByRole('tab').getAttribute('aria-selected'), 'true');
      assert.deepEqual(
        (await menu.getByRole('menuitem').allTextContents()).map((text) => text.trim()),
        ['关闭', '关闭右侧', '关闭其它', '关闭所有'],
      );
      if (action === '关闭') await page.screenshot({ path: `${output}/${name}.png` });
      await menu.getByRole('menuitem', { name: action, exact: true }).click();
      await menu.waitFor({ state: 'hidden' });
      await page.waitForFunction(
        (count) => document.querySelectorAll('.workspace-tab').length === count,
        expected.length,
      );
      assert.deepEqual(await keys(), expected);
      if (!expected.length) await page.getByRole('region', { name: '欢迎页面' }).waitFor();
    }
    // The rightmost tab has no right range; an only tab also has no other range.
    await seed();
    await page.locator('.workspace-tab[data-view="credentials"]').click({ button: 'right' });
    assert.equal(
      await menu.getByRole('menuitem', { name: '关闭右侧', exact: true }).isDisabled(),
      true,
    );
    await menu.getByRole('menuitem', { name: '关闭其它', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.workspace-tab').length === 1);
    await page.locator('.workspace-tab').click({ button: 'right' });
    assert.equal(
      await menu.getByRole('menuitem', { name: '关闭其它', exact: true }).isDisabled(),
      true,
    );
    await page.mouse.click(width - 30, height - 30);
    await menu.waitFor({ state: 'hidden' });
    // Keyboard opening, wrapping and focus restoration on an inactive tab.
    await seed();
    const tabButton = target.getByRole('tab');
    await tabButton.focus();
    await page.keyboard.press('Shift+F10');
    await menu.waitFor();
    await page.keyboard.press('End');
    assert.equal(
      await menu
        .getByRole('menuitem', { name: '关闭所有', exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.keyboard.press('ArrowDown');
    assert.equal(
      await menu
        .getByRole('menuitem', { name: '关闭', exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await tabButton.evaluate((el) => el === document.activeElement), true);
    // A menu opened at the viewport edge remains fully visible.
    await target.dispatchEvent('contextmenu', { clientX: width - 1, clientY: height - 1 });
    await menu.waitFor();
    const bounds = await menu.boundingBox();
    assert(bounds && bounds.x >= 8 && bounds.y >= 8);
    assert(bounds.x + bounds.width <= width - 7);
    assert(bounds.y + bounds.height <= height - 7);
    await page.screenshot({ path: `${output}/${name}-edge.png` });
    await page.setViewportSize({ width: width - 50, height });
    await menu.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    results.push({ name, passed: true });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
