import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright-core';

// Browser-only failure fixtures. No remote operations or persisted user settings are used.
const url = process.env.SERVERDECK_ERRORS_URL ?? 'http://127.0.0.1:1422';
const output = '.local/error-notifications';
await mkdir(output, { recursive: true });
const server = process.env.SERVERDECK_ERRORS_URL
  ? null
  : spawn(
      process.execPath,
      [
        '../../node_modules/vite/bin/vite.js',
        '--host',
        '127.0.0.1',
        '--port',
        '1422',
        '--strictPort',
      ],
      { cwd: new URL('../apps/desktop/', import.meta.url), windowsHide: true, stdio: 'pipe' },
    );
let serverLog = '';
server?.stdout.on('data', (data) => {
  serverLog = (serverLog + data).slice(-2000);
});
server?.stderr.on('data', (data) => {
  serverLog = (serverLog + data).slice(-2000);
});
let browser;
const results = [];
try {
  for (let attempt = 0; server; attempt++) {
    if (server.exitCode !== null || attempt === 100)
      throw new Error(`Preview did not start: ${serverLog}`);
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      // Vite is still starting; retry only within the bounded startup window.
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({
    executablePath:
      process.env.SERVERDECK_BROWSER ??
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  for (const view of [
    'terminals',
    'files',
    'server',
    'automation',
    'batch',
    'network',
    'credentials',
    'backup',
    'settings',
    'settingsTerminal',
    'settingsShortcuts',
    'settingsWorkspace',
    'about',
  ]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText('后端未连接', { exact: true }).waitFor();
    const message = `${view}：测试操作失败`;
    await page.evaluate(
      async ({ view, message }) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const { useApplicationStore } = await import('/src/stores/application.ts');
        const { useHostsStore } = await import('/src/stores/hosts.ts');
        const { useTerminalsStore } = await import('/src/stores/terminals.ts');
        const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
        const { useNotificationsStore } = await import('/src/stores/notifications.ts');
        const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
        const { defaultProductPreferences } = await import('/src/types/product.ts');
        const { hostInput } = await import('/src/types/hosts.ts');
        const { tasksApi } = await import('/src/services/tasks.ts');
        const { automationApi } = await import('/src/services/automation.ts');
        const { filesApi } = await import('/src/services/files.ts');
        const { monitorApi } = await import('/src/services/monitor.ts');
        const { opsApi } = await import('/src/services/ops.ts');
        const { productApi } = await import('/src/services/product.ts');
        const { terminalApi } = await import('/src/services/terminal.ts');
        const { hostsApi } = await import('/src/services/hosts.ts');
        const fail = async () => {
          throw new Error(message);
        };
        tasksApi.diagnostics = view === 'network' ? fail : async () => [];
        tasksApi.batches = view === 'batch' ? fail : async () => [];
        automationApi.catalog =
          view === 'automation'
            ? fail
            : async () => ({
                entries: [],
                groups: [],
                schedules: [],
                templates: [],
              });
        automationApi.history = async () => [];
        filesApi.open = fail;
        filesApi.local = async () => ({
          path: 'C:/test',
          parent: null,
          entries: [],
          truncated: false,
        });
        monitorApi.open = fail;
        opsApi.open = fail;
        opsApi.feedback = async () => [];
        opsApi.connections = async () => [];
        productApi.preview = fail;
        terminalApi.openLocal = fail;
        hostsApi.status = async () => ({ available: false, message });
        const application = useApplicationStore(pinia);
        application.state = {
          appVersion: 'browser-ui-test',
          databaseVersion: 6,
          dataDirectory: '',
          logDirectory: '',
          config: {
            version: 1,
            theme: 'dark',
            sidebarWidth: 248,
            terminalFontSize: 14,
            connectTimeoutSecs: 15,
            monitorIntervalSecs: 3,
            transferConcurrency: 3,
            logLevel: 'info',
            terminal: defaultTerminalPreferences(),
            product: defaultProductPreferences(),
          },
        };
        application.error = null;
        const host = {
          ...hostInput(),
          id: 'test-host',
          name: 'UI fixture',
          hostname: 'test.invalid',
          createdAt: '',
          updatedAt: '',
        };
        useHostsStore(pinia).catalog = {
          hosts: [host],
          groups: [],
          credentials: [],
          pendingSecretDeletions: 0,
        };
        useNotificationsStore(pinia).items = [];
        if (view === 'terminals') useTerminalsStore(pinia).open(null);
        useWorkspaceStore(pinia).navigate(view, ['files', 'server'].includes(view) ? host.id : '');
        if (view === 'about') application.error = message;
      },
      { view, message },
    );
    if (view === 'credentials')
      await page.getByRole('button', { name: '检查系统凭据库', exact: true }).click();
    if (view === 'backup') {
      await page.getByLabel('待恢复备份 JSON', { exact: true }).fill('invalid');
      await page.getByRole('button', { name: '校验并预览备份', exact: true }).click();
    }
    if (view.startsWith('settings')) {
      // Real browser preview has no Tauri IPC; saving must surface the safe desktop error.
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
    }
    const expected = view.startsWith('settings') ? '当前为浏览器预览，未连接 Rust 后端。' : message;
    const toast = page.locator('.toast[role="alert"]').filter({ hasText: expected });
    await toast.waitFor({ state: 'visible' });
    assert.equal(await toast.count(), 1, `${view}: duplicate toast`);
    assert.equal(
      await page.locator('[role="alert"]:not(.toast)').count(),
      0,
      `${view}: inline alert remains`,
    );
    assert.equal(
      await page.locator('.app-shell').getByText(expected, { exact: false }).count(),
      0,
      `${view}: inline error remains`,
    );
    const box = await toast.boundingBox();
    assert.ok(box.x > 900 && box.y > 650, `${view}: toast is not bottom-right`);
    await page.screenshot({ path: `${output}/${view}.png` });
    await toast.getByRole('button', { name: '关闭通知', exact: true }).click();
    assert.equal(await toast.count(), 0, `${view}: dismiss did not remove toast`);
    assert.deepEqual(errors, [], `${view}: browser runtime errors`);
    results.push({ view, passed: true });
    await page.close();
  }

  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['narrow', 390, 844],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(url);
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.evaluate(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const { useNotificationsStore } = await import('/src/stores/notifications.ts');
      useNotificationsStore(pinia).items = [];
    });
    await page
      .locator('.workspace-empty')
      .getByRole('button', { name: '新建主机', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '新建主机', exact: true });
    await dialog.waitFor();
    await dialog.locator('form').evaluate((form) => form.reportValidity());
    const toast = dialog.locator('.toast[role="alert"]');
    await toast.waitFor({ state: 'visible' });
    assert.equal(await page.locator('[role="alert"]:not(.toast)').count(), 0);
    assert.equal(await dialog.locator('input:focus').count(), 1);
    assert.equal(
      await page.locator('.toast-stack:popover-open').count(),
      1,
      `${name}: toast is outside native top layer`,
    );
    const box = await toast.boundingBox();
    assert.ok(
      box.x >= 0 && box.x + box.width <= width && box.y + box.height <= height,
      `${name}: clipped toast`,
    );
    await page.screenshot({ path: `${output}/modal-${name}.png` });
    await toast.getByRole('button', { name: '关闭通知', exact: true }).click();
    assert.equal(await page.locator('.toast').count(), 0);
    assert.equal(await dialog.count(), 1, `${name}: closing a toast closed its dialog`);
    results.push({ view: `modal-${name}`, passed: true });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
  await browser?.close();
  server?.kill();
}
