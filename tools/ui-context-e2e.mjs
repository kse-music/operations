import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace, selectHostWorkspace } from './ui-navigation.mjs';

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
    const nav = (label) => navigateWorkspace(page, label);
    const assertHost = async (id, view) => {
      assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), id);
      assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-view'), view);
    };
    await page.getByRole('tab', { name: /会话 1/ }).waitFor();
    await assertHost('a', 'terminals');
    assert.equal(await page.locator('.terminal-tab').count(), 1);
    await selectHostWorkspace(page, 'b');
    await assertHost('b', 'terminals');
    assert.equal(await page.locator('.terminal-tab').count(), 1);
    assert.equal(await page.locator('.workspace-tab').count(), 2);
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
    await nav('全局设置');
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    assert.equal(await page.getByRole('navigation', { name: '当前主机工具' }).count(), 0);
    await selectHostWorkspace(page, 'a');
    await assertHost('a', 'files');
    await selectHostWorkspace(page, '');
    await assertHost('', 'terminals');
    assert.equal(await page.locator('.host-tools button').count(), 1);
    assert.equal(await page.getByLabel('当前工作区主机', { exact: true }).count(), 0);
    await nav('网络诊断');
    await page.getByLabel('诊断来源', { exact: true }).selectOption('remote');
    await page.getByLabel('诊断主机', { exact: true }).selectOption('b');
    await page.getByLabel('诊断目标', { exact: true }).fill('independent.example');
    await selectHostWorkspace(page, 'a');
    await nav('网络诊断');
    assert.equal(await page.getByLabel('诊断主机', { exact: true }).inputValue(), 'b');
    assert.equal(
      await page.getByLabel('诊断目标', { exact: true }).inputValue(),
      'independent.example',
    );
    assert.equal(await page.getByLabel('诊断来源', { exact: true }).inputValue(), 'remote');
    await nav('批量运维');
    await page.getByLabel('选择批量目标 Production b', { exact: true }).check();
    await page.getByLabel('批量统一命令', { exact: true }).fill('hostname');
    await selectHostWorkspace(page, 'a');
    await nav('批量运维');
    assert.equal(
      await page.getByLabel('选择批量目标 Production b', { exact: true }).isChecked(),
      true,
    );
    assert.equal(await page.getByLabel('批量统一命令', { exact: true }).inputValue(), 'hostname');
    await selectHostWorkspace(page, 'b');
    await nav('SSH 终端');
    await assertHost('b', 'terminals');
    await page.getByRole('tab', { name: /会话 1/ }).waitFor();
    const bounds = await page.locator('.workspace-tab.active').boundingBox();
    assert(bounds && bounds.width > 50 && bounds.x >= 0 && bounds.x + bounds.width <= width);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/${name}-terminal.png` });
    results.push({ name, width, height, theme, passed: true });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(`PASS ${results.length} host context and layout scenarios. Artifacts: ${output}`);
} finally {
  await browser.close();
}
