import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace } from './ui-navigation.mjs';

const output = process.env.SERVERDECK_PAGES_OUTPUT ?? '/tmp/serverdeck-pages';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.SERVERDECK_BROWSER ?? '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const pages = [
  ['SSH 终端', 'terminals'],
  ['SFTP 文件', 'files'],
  ['服务器管理', 'server'],
  ['安全凭据', 'credentials'],
  ['备份恢复', 'backup'],
  ['关于', 'about'],
  ['通用', 'settings'],
  ['终端', 'settingsTerminal'],
  ['快捷键', 'settingsShortcuts'],
  ['工作区与连接', 'settingsWorkspace'],
];

// Browser-only rendering fixtures; no production fallback, disk changes, or remote commands.
async function fixtures(page, theme) {
  await page.evaluate(async (theme) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    const { useApplicationStore } = await import('/src/stores/application.ts');
    const { useHostsStore } = await import('/src/stores/hosts.ts');
    const { useNotificationsStore } = await import('/src/stores/notifications.ts');
    const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
    const { defaultProductPreferences } = await import('/src/types/product.ts');
    const { hostInput } = await import('/src/types/hosts.ts');
    const hosts = useHostsStore(pinia),
      application = useApplicationStore(pinia);
    hosts.catalog = {
      hosts: ['API production', 'Database primary', 'Staging server'].map((name, n) => ({
        ...hostInput(),
        id: `ui-${n}`,
        name,
        hostname: `192.0.2.${n + 1}`,
        username: 'operator',
        favorite: n === 0,
        createdAt: '',
        updatedAt: '',
      })),
      groups: [],
      credentials: [
        {
          id: 'ui-credential',
          name: 'Operations credential',
          kind: 'password',
          keyPath: null,
          hasSecret: true,
          hostCount: 2,
          revision: 1,
        },
      ],
      pendingSecretDeletions: 0,
    };
    hosts.selectedId = 'ui-0';
    application.error = null;
    application.state = {
      appVersion: '0.1.0-beta.1',
      databaseVersion: 5,
      dataDirectory: '/ui-fixture/data',
      logDirectory: '/ui-fixture/logs',
      config: {
        version: 1,
        theme,
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
    useNotificationsStore(pinia).items = [];
    const host = hosts.catalog.hosts[0];
    const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
    useWorkspaceStore(pinia).selectHost(host.id);
    const session = {
      id: 'ui-session',
      hostId: host.id,
      transportId: 'ui-transport',
      routeHostIds: [],
      state: 'connected',
    };
    const { opsApi } = await import('/src/services/ops.ts');
    const { useOpsStore } = await import('/src/stores/ops.ts');
    useOpsStore(pinia).connections[host.id] = {
      host,
      state: 'connected',
      session,
      error: null,
      trust: null,
    };
    opsApi.connections = async () => [session];
    opsApi.feedback = async () => [];
    opsApi.query = async (_id, request) => ({
      success: true,
      records:
        request.kind === 'containers'
          ? [
              {
                ID: 'ui-container',
                Names: 'application-api',
                Image: 'application:stable',
                State: 'running',
                Status: 'Up 2 hours',
                Ports: '127.0.0.1:8080',
              },
            ]
          : [],
      detail:
        request.kind === 'capabilities'
          ? { dockerState: 'running', dockerInstalled: true, systemd: true }
          : {},
    });
    const { filesApi } = await import('/src/services/files.ts');
    const listing = {
      path: '/srv/application',
      parent: '/srv',
      entries: ['config', 'application.log', 'compose.yaml'].map((name, n) => ({
        name,
        path: `/srv/application/${name}`,
        kind: n ? 'file' : 'directory',
        size: n ? 2048 : null,
        modified: 1700000000,
        permissions: n ? 0o644 : 0o755,
        uid: 0,
        owner: 'root',
        gid: 1000,
      })),
    };
    filesApi.local = async () => listing;
    filesApi.list = async () => listing;
    filesApi.connections = async () => [session];
    filesApi.tasks = async () => [];
    const { useFilesStore } = await import('/src/stores/files.ts');
    const files = useFilesStore(pinia);
    files.local = listing;
    files.active = host.id;
    files.connections[host.id] = {
      host,
      state: 'connected',
      id: session.id,
      path: listing.path,
      listing,
      loading: false,
      error: null,
      trust: null,
    };
    const { monitorApi } = await import('/src/services/monitor.ts');
    monitorApi.open = async () => session;
    monitorApi.visible = async () => {};
    monitorApi.snapshot = async () => ({
      hostId: host.id,
      sessionId: session.id,
      revision: 1,
      state: 'running',
      intervalSecs: 3,
      error: null,
      sample: {
        sampledAt: 1700000000000,
        uptime: 86400,
        load: [0.2, 0.4, 0.3],
        cpus: [{ name: 'cpu', usage: 24, iowait: 0.3 }],
        memory: {
          total: 8589934592,
          used: 2147483648,
          available: 6442450944,
          usage: 25,
          approximate: false,
          swapTotal: 0,
          swapUsed: 0,
          swapUsage: null,
        },
        disks: [
          {
            mount: '/',
            source: '/dev/sda1',
            filesystem: 'ext4',
            device: '8:1',
            total: 107374182400,
            used: 21474836480,
            available: 85899345920,
            usage: 20,
            pseudo: false,
            image: false,
            container: false,
            duplicateOf: null,
            error: null,
          },
        ],
        network: [
          {
            name: 'eth0',
            index: 1,
            addresses: ['192.0.2.1'],
            received: 2048,
            sent: 1024,
            receiveRate: 256,
            sendRate: 128,
          },
        ],
        warnings: [],
        rateStatus: 'ready',
        system: {
          hostname: 'ui-server',
          distribution: 'Linux',
          kernel: '6.8',
          architecture: 'x86_64',
          cpuModel: 'UI rendering fixture',
          cores: 4,
          systemTime: '2026-11-02',
          timezone: 'UTC',
        },
      },
      history: [0, 1, 2].map((n) => ({
        sampledAt: 1700000000000 + n * 3000,
        uptime: 86400 + n * 3,
        cpu: 24 + n,
        memory: 25,
        receiveRate: 256,
        sendRate: 128,
      })),
    });
    const { productApi } = await import('/src/services/product.ts');
    productApi.preview = async () => ({
      version: 1,
      warnings: [],
      items: [
        {
          id: 'restore-ui',
          kind: 'host',
          name: 'Restored host',
          detail: '192.0.2.100',
          duplicate: false,
          blocked: false,
          warnings: [],
        },
      ],
    });
    const { useTerminalsStore } = await import('/src/stores/terminals.ts');
    const terminals = useTerminalsStore(pinia);
    terminals.open(host);
    terminals.update(terminals.focused, { state: 'idle', connectRequested: false });
  }, theme);
}

async function inspect(page, name) {
  const issues = await page.evaluate(() => {
    const issues = [];
    const root = document.querySelector('dialog[open]') ?? document.querySelector('main');
    const visible = (el) =>
      el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    if (root.matches('dialog') && root.scrollWidth > root.clientWidth + 2)
      issues.push('dialog horizontal overflow');
    for (const el of root.querySelectorAll('button.button, button.tool-button')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const label = el.getAttribute('aria-label') ?? el.textContent.trim();
      if (r.height < 27 || r.height > 39) issues.push(`button height ${r.height}: ${label}`);
      if (el.scrollWidth > el.clientWidth + 2) issues.push(`clipped button: ${label}`);
      const next = el.nextElementSibling;
      if (
        next?.matches('button') &&
        visible(next) &&
        !el.closest('[role=tablist], .terminal-tab')
      ) {
        const n = next.getBoundingClientRect();
        if (Math.abs(n.top - r.top) < 2 && n.left - r.right < 4)
          issues.push(`joined buttons: ${label}`);
      }
    }
    if (document.documentElement.scrollWidth > innerWidth) issues.push('page horizontal overflow');
    const content = document.querySelector('.content-scroll');
    if (visible(content) && content.scrollWidth > content.clientWidth + 2)
      issues.push('workspace horizontal overflow');
    return issues;
  });
  assert.deepEqual(issues, [], name);
}

const results = [];
try {
  for (const [variant, width, height, theme] of [
    ['desktop', 1440, 1000, 'dark'],
    ['small', 900, 700, 'light'],
    ['mobile', 390, 844, 'light'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.SERVERDECK_LAYOUT_URL ?? 'http://127.0.0.1:1421');
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await fixtures(page, theme);
    for (const [label, view] of pages) {
      await navigateWorkspace(page, label);
      await page.waitForFunction((view) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        return pinia._s.get('workspace').current?.view === view;
      }, view);
      await page
        .locator(view === 'terminals' ? '.terminal-pane:visible' : '.page-view:visible')
        .waitFor({ state: 'visible' });
      await page.evaluate(() => (document.querySelector('.content-scroll').scrollTop = 0));
      if (view === 'files') {
        const remote = page.getByRole('table', { name: '远程文件', exact: true });
        assert.equal(
          await remote.getByRole('columnheader', { name: '权限', exact: true }).count(),
          1,
        );
        assert.equal(
          await remote.getByRole('columnheader', { name: '拥有者', exact: true }).count(),
          1,
        );
        assert.deepEqual(
          await remote.locator('tbody tr').first().locator('.file-metadata').allTextContents(),
          ['rwxr-xr-x', 'root'],
        );
        assert.equal(
          await page
            .getByRole('table', { name: '本地文件', exact: true })
            .locator('.file-metadata')
            .count(),
          0,
        );
        // A plain browser cannot register Tauri's native drag/drop listener.
        await page
          .getByText(/^拖放入口不可用/)
          .first()
          .waitFor();
        await inspect(page, `${variant}/files-native-unavailable`);
        await page.getByRole('button', { name: '关闭提示', exact: true }).click();
        await page.evaluate(async () => {
          const { useNotificationsStore } = await import('/src/stores/notifications.ts');
          useNotificationsStore().items = [];
        });
        const columns = await page
          .locator('.file-columns')
          .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
        if (columns === 2) {
          const tops = await page
            .locator('.file-table')
            .evaluateAll((tables) => tables.map((table) => table.getBoundingClientRect().top));
          assert.equal(tops[0], tops[1], `${variant}: file lists aligned`);
        }
      }
      await page.mouse.move(width - 8, height - 8);
      await inspect(page, `${variant}/${view}`);
      await page.screenshot({ path: `${output}/${variant}-${view}.png` });
      if (view === 'credentials') {
        await page
          .locator('.page-view')
          .getByRole('button', { name: /新建凭据/ })
          .click();
        await page.getByRole('dialog').waitFor();
        await inspect(page, `${variant}/${view}-dialog`);
        await page.screenshot({ path: `${output}/${variant}-${view}-dialog.png` });
        await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      }
      if (view === 'server') {
        const tabs = page.locator('.page-view [role=tablist]').getByRole('tab');
        for (let n = 0; n < (await tabs.count()); n++) {
          await tabs.nth(n).click();
          await inspect(page, `${variant}/${view}-tab-${n}`);
        }
        await page.screenshot({ path: `${output}/${variant}-${view}-last-tab.png` });
      }
      if (view === 'backup') {
        await page.getByLabel('待恢复备份 JSON').fill('{}');
        await page.getByRole('button', { name: '校验并预览备份', exact: true }).click();
        await page.getByLabel('确认备份恢复').waitFor();
        await inspect(page, `${variant}/restore-preview`);
        await page.screenshot({ path: `${output}/${variant}-restore-preview.png` });
      }
      if (view === 'settingsWorkspace') {
        await page.getByLabel('全局默认代理').selectOption('socks5');
        await page.getByText('代理需要认证', { exact: true }).click();
        await inspect(page, `${variant}/proxy-settings`);
        await page.getByRole('button', { name: '保存设置', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${variant}-settings-bottom.png` });
      }
      results.push(`${variant}/${view}`);
    }
    assert.deepEqual(errors, [], `${variant}: browser errors`);
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(
    `Passed ${results.length} menu pages plus form/dialog states. Screenshots: ${output}`,
  );
} finally {
  await browser.close();
}
