import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace } from './ui-navigation.mjs';

const output = process.env.SERVERDECK_TASK_CENTER_OUTPUT ?? '.local/task-center-footer/browser';
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
    await page.goto(process.env.SERVERDECK_TASK_CENTER_URL ?? 'http://127.0.0.1:1420');
    await page.getByText('后端未连接', { exact: true }).waitFor();
    // Browser-only fixtures exercise the real shell and dialog; no IPC or persisted changes.
    await page.evaluate(async (theme) => {
      const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      const { useBackgroundStore } = await import('/src/stores/background.ts');
      const { usePluginsStore } = await import('/src/stores/plugins.ts');
      const { useNotificationsStore } = await import('/src/stores/notifications.ts');
      const terminals = useTerminalsStore();
      terminals.open(null);
      terminals.update(terminals.focused, { state: 'idle', connectRequested: false });
      useWorkspaceStore().navigate('terminals', '');
      useWorkspaceStore().selectModule('assets');
      useBackgroundStore().connections = [];
      usePluginsStore().loaded = true;
      useNotificationsStore().items = [];
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.locator('.terminal-pane').waitFor();
    const snapshot = () =>
      page.evaluate(() => {
        const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
        const workspace = stores.get('workspace');
        return JSON.stringify({
          active: workspace.active,
          module: workspace.module,
          tabs: workspace.tabs,
          terminals: stores.get('terminals').tabs,
        });
      });
    const original = await snapshot();
    assert.equal(await page.locator('.activity-rail [aria-label="任务中心"]').count(), 0);
    await navigateWorkspace(page, '任务中心');
    const dialog = page.getByRole('dialog', { name: '任务中心', exact: true });
    await dialog.getByText('没有网络诊断任务', { exact: true }).waitFor();
    assert.equal(await dialog.count(), 1);
    assert.equal(await page.locator('.workspace-tab[data-view="tasks"]').count(), 0);
    assert.equal(await snapshot(), original);
    assert.equal(await dialog.getByRole('region', { name: '传输任务', exact: true }).count(), 1);
    assert.equal(
      await dialog.getByRole('region', { name: '网络诊断任务', exact: true }).count(),
      1,
    );
    await page.screenshot({ path: `${output}/${name}-empty.png` });
    await page.evaluate(async () => {
      const { useBackgroundStore } = await import('/src/stores/background.ts');
      useBackgroundStore().tasks = [
        {
          id: 'browser-diagnostic',
          kind: 'diagnostic',
          hostIds: [],
          state: 'running',
          label: '本机网络诊断',
          active: true,
        },
      ];
    });
    await dialog.getByRole('button', { name: '请求停止此任务', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '确认停止后台任务', exact: true });
    await confirmation.waitFor();
    await page.keyboard.press('Escape');
    await confirmation.waitFor({ state: 'hidden' });
    assert(await dialog.isVisible(), 'Escape dismisses only the top confirmation');
    assert.equal(await snapshot(), original);
    assert(
      await page.evaluate(() => {
        const dialog = document.querySelector('dialog[aria-label="任务中心"]');
        const bounds = dialog.getBoundingClientRect();
        return (
          bounds.left >= 0 &&
          bounds.right <= innerWidth + 1 &&
          bounds.top >= 0 &&
          bounds.bottom <= innerHeight + 1 &&
          dialog.scrollWidth <= dialog.clientWidth + 1 &&
          document.documentElement.scrollWidth <= innerWidth + 1
        );
      }),
      'dialog fits the viewport and scrolls vertically without horizontal overflow',
    );
    await page.screenshot({ path: `${output}/${name}-active.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await snapshot(), original);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      '任务中心',
    );
    await navigateWorkspace(page, '任务中心');
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await snapshot(), original);
    assert.deepEqual(errors, []);
    results.push({ name, width, height, theme, passed: true });
    await page.close();
  }
  await writeFile(`${output}/result.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
