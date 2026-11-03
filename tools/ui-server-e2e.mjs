import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// UI-only fixtures. Does not connect to a server or replace production data.
const output = process.env.SERVERDECK_SERVER_OUTPUT ?? '.local/server-management/browser';
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
    ['mobile', 390, 844, 'light'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.SERVERDECK_SERVER_URL ?? 'http://127.0.0.1:1429');
    await page.getByRole('heading', { name: '欢迎使用 ServerDeck', exact: true }).waitFor();
    await page.evaluate(
      async ({ theme }) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const { useHostsStore } = await import('/src/stores/hosts.ts');
        const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
        const { useOpsStore } = await import('/src/stores/ops.ts');
        const { hostInput } = await import('/src/types/hosts.ts');
        const { useNotificationsStore } = await import('/src/stores/notifications.ts');
        const { monitorApi } = await import('/src/services/monitor.ts');
        const { opsApi } = await import('/src/services/ops.ts');
        const host = {
          ...hostInput(),
          id: 'server-ui',
          name: '生产应用服务器',
          hostname: '192.0.2.10',
          username: 'operator',
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
        useOpsStore(pinia).connections[host.id] = {
          host,
          state: 'connected',
          error: null,
          trust: null,
          session: { id: 'ops-ui', hostId: host.id, transportId: 'ui', routeHostIds: [host.id] },
        };
        const now = Date.now(),
          gb = 1024 ** 3;
        monitorApi.open = async () => ({ id: 'monitor-ui' });
        monitorApi.visible = async () => {};
        monitorApi.snapshot = async () => ({
          hostId: host.id,
          sessionId: 'monitor-ui',
          state: 'running',
          revision: 1,
          intervalSecs: 3,
          error: null,
          sample: {
            sampledAt: now,
            uptime: 1276000,
            load: [0.42, 0.68, 0.53],
            rateStatus: 'ok',
            warnings: [],
            cpus: [
              { name: 'cpu', usage: 23.4, iowait: 0.8 },
              ...Array.from({ length: 8 }, (_, n) => ({
                name: `cpu${n}`,
                usage: 20 + n,
                iowait: 0,
              })),
            ],
            memory: {
              total: 16 * gb,
              used: 6.2 * gb,
              available: 9.8 * gb,
              usage: 38.75,
              approximate: false,
              swapTotal: 2 * gb,
              swapUsed: 0,
              swapUsage: 0,
            },
            disks: [
              ...Array.from({ length: 24 }, (_, n) => ({
                mount: n ? `/data/volume-${n}` : '/',
                source: `/dev/vd${n}`,
                filesystem: 'ext4',
                device: String(n),
                total: 100 * gb,
                used: 42 * gb,
                available: 58 * gb,
                usage: 42,
                pseudo: false,
                image: false,
                container: false,
                duplicateOf: null,
                error: null,
              })),
              ...[
                { mount: '/proc', filesystem: 'proc', pseudo: true },
                { mount: '/snap/base', filesystem: 'squashfs', image: true },
                { mount: '/bind', filesystem: 'ext4', duplicateOf: '/' },
              ].map((mount) => ({
                source: 'fixture',
                device: '0:1',
                pseudo: false,
                image: false,
                container: false,
                duplicateOf: null,
                total: null,
                used: null,
                available: null,
                usage: null,
                error: 'df 未返回该挂载点：可能是伪文件系统、重复挂载、无权限或不可访问',
                ...mount,
              })),
            ],
            network: [
              {
                name: 'eth0',
                index: 1,
                addresses: ['192.0.2.10/24'],
                received: 4 * gb,
                sent: gb,
                receiveRate: 16384,
                sendRate: 8192,
              },
            ],
            system: {
              hostname: 'app-prod-01',
              distribution: 'Ubuntu 24.04 LTS',
              kernel: '6.8.0',
              architecture: 'x86_64',
              cpuModel: 'Intel Xeon',
              cores: 8,
              systemTime: new Date(now).toISOString(),
              timezone: 'Asia/Shanghai',
            },
          },
          history: Array.from({ length: 60 }, (_, n) => ({
            sampledAt: now - (60 - n) * 3000,
            uptime: n * 3,
            cpu: 22 + Math.sin(n / 4) * 8,
            memory: 38 + Math.sin(n / 6),
            receiveRate: 16384 + Math.sin(n / 4) * 1024,
            sendRate: 8192 + Math.cos(n / 3) * 2048,
          })),
        });
        opsApi.connections = async () => [];
        opsApi.feedback = async () => [];
        opsApi.query = async (_id, request) => ({
          success: true,
          code: null,
          message: null,
          detail:
            request.kind === 'capabilities'
              ? { dockerState: 'running', systemd: true }
              : request.kind === 'process_details'
                ? {
                    pid: request.pid,
                    startTicks: '7182',
                    bootId: 'ui-fixture',
                    executable: '/usr/sbin/nginx',
                    status: {
                      Name: 'nginx',
                      State: 'S (sleeping)',
                      Threads: '4',
                      VmRSS: '18432 kB',
                      Uid: '33 33 33 33',
                    },
                  }
                : null,
          records:
            request.kind === 'processes'
              ? Array.from({ length: 160 }, (_, n) => ({
                  pid: n + 1000,
                  user: n ? 'www-data' : 'root',
                  cpu: Math.round((20 - n / 8) * 10) / 10,
                  memory: 1.2,
                  elapsed: 3600,
                  command: n % 2 ? 'nginx' : 'node',
                }))
              : [],
        });
        document.documentElement.dataset.theme = theme;
        useWorkspaceStore(pinia).navigate('server', host.id);
      },
      { theme },
    );
    await page.getByTestId('monitor-cpu').waitFor();
    assert.equal(
      await page.locator('.toast.error').count(),
      0,
      'expected missing capacity must not trigger error notifications',
    );
    if (width <= 720) {
      const collapse = page.getByRole('button', { name: '收起主机栏', exact: true });
      if (await collapse.isVisible()) await collapse.click();
    }
    assert.deepEqual(
      (await page.locator('.workspace-header .host-tools button').allTextContents()).map((x) =>
        x.trim(),
      ),
      ['SSH 终端', 'SFTP 文件', '服务器管理'],
    );
    assert.equal(await page.locator('.server-tabs [role=tab]').count(), 9);
    assert.equal(await page.locator('.trend-chart').count(), 2);
    assert.equal(await page.getByRole('heading', { name: '磁盘与挂载点', exact: true }).count(), 0);
    const overviewScroll = await page
      .locator('.content-scroll')
      .evaluate((el) => el.scrollHeight - el.clientHeight);
    if (width === 1440)
      assert(overviewScroll <= 10, `${name}: overview unnecessarily scrolls (${overviewScroll}px)`);
    await page.screenshot({ path: `${output}/${name}-overview.png` });
    await page.getByRole('button', { name: '系统信息', exact: true }).click();
    await page.getByRole('dialog', { name: '系统信息', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.getByRole('tab', { name: '磁盘', exact: true }).click();
    assert.equal(await page.locator('.trend-chart').count(), 0);
    assert(
      await page.locator('.monitor-table').evaluate((el) => el.scrollHeight > el.clientHeight),
      'mounts must scroll inside their table',
    );
    await page.getByRole('tab', { name: '网络', exact: true }).click();
    assert.equal(await page.locator('.trend-chart').count(), 2);
    await page.getByRole('tab', { name: '进程', exact: true }).click();
    await page.locator('[data-ops-target="1000"]').waitFor();
    assert(
      await page.locator('.ops-table').evaluate((el) => el.scrollHeight > el.clientHeight),
      'process list must have bounded height',
    );
    await page.screenshot({ path: `${output}/${name}-processes.png` });
    await page
      .locator('[data-ops-target="1000"]')
      .getByRole('button', { name: '进程详情 / 信号', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '进程详情', exact: true });
    await dialog.getByText('/usr/sbin/nginx', { exact: true }).waitFor();
    assert.equal(await page.locator('.server-view [data-testid=operations-detail]').count(), 0);
    const box = await dialog.boundingBox();
    assert(box.width <= width && box.height <= height);
    await page.screenshot({ path: `${output}/${name}-process-detail.png` });
    await dialog.getByRole('button', { name: '发送信号…', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '确认主机运维操作', exact: true });
    await confirm.waitFor();
    assert(await confirm.getByRole('button', { name: '确认执行', exact: true }).isDisabled());
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual(errors, []);
    results.push({
      name,
      overviewScroll,
      tabs: 9,
      dialogs: 'passed',
      boundedLists: 'passed',
      pageErrors: errors,
    });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
