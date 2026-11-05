// Rendering fixtures only. Uses the real host components, packaged UI and iframe bridge.
// No user profile, credentials or remote hosts are accessed.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { openPluginFunction, openPluginSettings, navigateWorkspace } from './ui-navigation.mjs';

const output = process.env.SERVERDECK_PLUGIN_LAYOUT_OUTPUT ?? '.local/plugin-layout-qa';
const server = process.env.SERVERDECK_PLUGIN_LAYOUT_URL
  ? null
  : await createServer({
      root: 'apps/desktop',
      configFile: 'apps/desktop/vite.config.ts',
      server: { host: '127.0.0.1', port: 19424, strictPort: true },
    });
await server?.listen();
await mkdir(output, { recursive: true });
const packages = await Promise.all(
  ['services', 'docker', 'assistant'].map(async (name) => {
    const pkg = JSON.parse(await readFile(`plugins/system/packages/${name}.sdplugin`, 'utf8'));
    const ui = JSON.parse(
      Buffer.from(pkg.files.find((f) => f.path === 'ui.json').content, 'base64'),
    );
    return { ...pkg, ui };
  }),
);
const browser = await chromium.launch({
  executablePath:
    process.env.SERVERDECK_BROWSER ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const results = [];
try {
  for (const [width, height] of [
    [2400, 1400],
    [1440, 900],
    [900, 600],
    [390, 844],
  ]) {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('http://sdplugin.localhost/**', async (route) => {
        const [, id, , , asset = 'index.html'] = new URL(route.request().url()).pathname.split('/');
        const pkg = packages.find((p) => p.manifest.id === id);
        assert(pkg, `Unknown package: ${id}`);
        if (asset === 'index.html') {
          await route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="frontend.css"></head><body><div id="app"></div><script src="frontend.js"></script></body></html>',
          });
        } else {
          const file = pkg.files.find((f) => f.path === asset);
          assert(file, `Missing packaged asset: ${asset}`);
          await route.fulfill({
            contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript',
            body: Buffer.from(file.content, 'base64'),
          });
        }
      });
      await page.goto(process.env.SERVERDECK_PLUGIN_LAYOUT_URL ?? 'http://127.0.0.1:19424');
      await page.getByText('后端未连接', { exact: true }).waitFor();
      await page.evaluate(
        async ({ packages, theme }) => {
          const { usePluginsStore } = await import('/src/stores/plugins.ts');
          const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
          const { useHostsStore } = await import('/src/stores/hosts.ts');
          const { useOpsStore } = await import('/src/stores/ops.ts');
          const { useFilesStore } = await import('/src/stores/files.ts');
          const { useModelsStore } = await import('/src/stores/models.ts');
          const { useNotificationsStore } = await import('/src/stores/notifications.ts');
          const { hostInput } = await import('/src/types/hosts.ts');
          const { pluginsApi } = await import('/src/services/plugins.ts');
          const { opsApi } = await import('/src/services/ops.ts');
          const { aiApi } = await import('/src/services/ai.ts');
          const plugins = usePluginsStore();
          useFilesStore().open = async () => {};
          plugins.stop();
          const items = packages.map(({ manifest }) => ({
            manifest,
            enabled: true,
            source: 'system',
            revision: 'layout-qa',
            packageDigest: 'layout-fixture',
            previousVersion: null,
            trust: 'local_development_unverified',
          }));
          const grants = Object.fromEntries(
            items.map((p) => [
              p.manifest.id,
              {
                version: 1,
                pluginId: p.manifest.id,
                pluginVersion: p.manifest.version,
                revision: p.revision,
                packageDigest: p.packageDigest,
                publisher: null,
                permissions: p.manifest.permissions,
                operations: [...p.manifest.permissions, 'ui.notify'],
                readRoots: ['/'],
                writeRoots: [],
              },
            ]),
          );
          pluginsApi.list = async () => items;
          pluginsApi.permissions = async (id) => grants[id];
          pluginsApi.statuses = async () => [];
          pluginsApi.ui = async (id) => packages.find((p) => p.manifest.id === id).ui;
          pluginsApi.activate = async (id) => ({ id, state: 'active', errorCode: null });
          pluginsApi.context = async () => {};
          pluginsApi.cancel = async () => {};
          pluginsApi.toolCancelRequest = async () => {};
          await plugins.refresh();
          const host = {
            ...hostInput(),
            id: 'layout-host',
            name: '应用服务器 · 布局验证',
            hostname: '192.0.2.10',
            username: 'operator',
            createdAt: '',
            updatedAt: '',
          };
          const catalog = { hosts: [host], groups: [], credentials: [], pendingSecretDeletions: 0 };
          useHostsStore().catalog = catalog;
          const session = {
            id: 'layout-session',
            hostId: host.id,
            transportId: 'layout-transport',
            routeHostIds: [host.id],
          };
          useOpsStore().connections[host.id] = {
            host,
            state: 'connected',
            session,
            trust: null,
            error: null,
          };
          opsApi.connections = async () => [session];
          const models = ['默认模型', '备用模型'].map((name, i) => ({
            id: `layout-model-${i}`,
            name,
            revision: 'r1',
            hasKey: i === 0,
            config: {
              provider: 'openai_compatible',
              baseUrl: 'https://layout.invalid/v1',
              model: i ? 'backup-model' : 'diagnostic-model',
              allowInsecureHttp: false,
              maxOutputTokens: 1024,
              inputPricePerMillion: null,
              outputPricePerMillion: null,
            },
          }));
          window.layoutModels = models;
          aiApi.models = async () => window.layoutModels;
          await useModelsStore().refresh();
          window.layoutSettings = { modelId: models[0].id, retained: true };
          const now = Date.now(),
            gb = 1024 ** 3;
          const snapshot = {
            hostId: host.id,
            sessionId: 'layout-monitor',
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
              cpus: [{ name: 'cpu', usage: 23.4, iowait: 0.8 }],
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
                {
                  mount: '/',
                  source: '/dev/vda1',
                  filesystem: 'ext4',
                  device: '1',
                  total: 100 * gb,
                  used: 42 * gb,
                  available: 58 * gb,
                  usage: 42,
                  pseudo: false,
                  image: false,
                  duplicateOf: null,
                  error: null,
                },
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
            history: Array.from({ length: 30 }, (_, n) => ({
              sampledAt: now - (30 - n) * 3000,
              uptime: n * 3,
              cpu: 22 + Math.sin(n / 4) * 8,
              memory: 38 + Math.sin(n / 6),
              receiveRate: 16384,
              sendRate: 8192,
            })),
          };
          pluginsApi.call = async (_id, payload) => {
            const operation = JSON.parse(payload.values.request);
            let result;
            switch (operation.kind) {
              case 'settings_read':
                result = window.layoutSettings;
                break;
              case 'settings_write':
                window.layoutSettings = operation.value;
                result = null;
                break;
              case 'metrics_open':
                result = { id: 'layout-monitor' };
                break;
              case 'metrics_snapshot':
                result = snapshot;
                break;
              case 'metrics_visible':
              case 'metrics_close':
              case 'system_log_stop':
                result = null;
                break;
              case 'system_feedback':
                result = [];
                break;
              case 'system_query': {
                const data = {
                  capabilities: [{ dockerInstalled: true, dockerState: 'running', systemd: true }],
                  containers: Array.from({ length: 6 }, (_, n) => ({
                    ID: `${n}`.repeat(64),
                    Names: `app-service-${n + 1}`,
                    Image: 'registry.example/application:stable',
                    State: n ? 'running' : 'exited',
                    Status: n ? 'Up 3 days' : 'Exited (1)',
                    Ports: '0.0.0.0:8080->80/tcp',
                  })),
                  images: [
                    {
                      ID: 'a'.repeat(64),
                      Repository: 'registry.example/application',
                      Tag: 'stable',
                      Size: '128 MB',
                      CreatedSince: '3 days ago',
                    },
                  ],
                  processes: [
                    {
                      pid: 1024,
                      user: 'www-data',
                      cpu: 12.4,
                      memory: 2.3,
                      elapsed: 7200,
                      command: 'nginx',
                    },
                  ],
                  ports: [
                    {
                      protocol: 'tcp',
                      state: 'LISTEN',
                      local: '0.0.0.0:80',
                      peer: '*:*',
                      process: 'nginx (1024)',
                    },
                  ],
                  services: [
                    {
                      unit: 'nginx.service',
                      description: 'Web application service',
                      load: 'loaded',
                      active: 'active',
                      sub: 'running',
                      enabled: 'enabled',
                    },
                  ],
                };
                result = {
                  success: true,
                  code: null,
                  message: null,
                  records: data[operation.request.kind] ?? [],
                };
                break;
              }
              default:
                throw new Error(`Unexpected fixture operation: ${operation.kind}`);
            }
            return { result, error: null };
          };
          useNotificationsStore().items = [];
          useWorkspaceStore().openPluginSettings('cn.hiboot.plugins.assistant');
          document.documentElement.dataset.theme = theme;
        },
        { packages: packages.map(({ manifest, ui }) => ({ manifest, ui })), theme },
      );
      const content = () => page.frameLocator('.plugin-frame-container:visible iframe');
      const capture = async (name, selector) => {
        await page.locator(`${selector}:visible`).waitFor();
        const geometry = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          workspaceOverflow:
            document.querySelector('.content-scroll').scrollWidth >
            document.querySelector('.content-scroll').clientWidth + 1,
        }));
        assert.equal(geometry.overflow, false, `${name}: outer overflow`);
        assert.equal(geometry.workspaceOverflow, false, `${name}: workspace overflow`);
        await page.screenshot({ path: `${output}/${name}-${width}-${theme}.png` });
        results.push({ name, width, height, theme, ...geometry });
      };
      await content().getByRole('group', { name: '使用模型' }).waitFor();
      await content()
        .locator('.binding-current strong')
        .getByText('默认模型', { exact: true })
        .waitFor();
      assert(
        await content().getByRole('button', { name: '保存模型绑定', exact: true }).isVisible(),
      );
      const settingsFrame = page.frames().find((f) => f.url().includes('/settings/index.html'));
      const settingsGeometry = await settingsFrame.evaluate(() => ({
        height: innerHeight,
        contentHeight: document.documentElement.scrollHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
        footerBottom: document.querySelector('footer').getBoundingClientRect().bottom,
      }));
      assert.equal(settingsGeometry.overflow, false);
      assert(
        settingsGeometry.footerBottom <= settingsGeometry.height + 1,
        `Settings footer clipped: ${JSON.stringify(settingsGeometry)}`,
      );
      assert(
        settingsGeometry.contentHeight <= settingsGeometry.height + 1,
        `Nested settings scroll: ${JSON.stringify(settingsGeometry)}`,
      );
      await capture('assistant-settings', '.plugin-page');
      await page.evaluate(async () => {
        const { useModelsStore } = await import('/src/stores/models.ts');
        window.layoutModels = [
          ...window.layoutModels,
          ...Array.from({ length: 98 }, (_, i) => ({
            ...window.layoutModels[0],
            id: `extra-${i}`,
            name: `额外测试模型 ${i + 1}`,
          })),
        ];
        await useModelsStore().refresh();
      });
      await content().getByText('100 个已注册', { exact: true }).waitFor();
      const crowdedGeometry = await settingsFrame.evaluate(() => ({
        footerBottom: document.querySelector('footer').getBoundingClientRect().bottom,
        height: innerHeight,
        contentHeight: document.documentElement.scrollHeight,
        listScrollable:
          document.querySelector('.binding-options').scrollHeight >
          document.querySelector('.binding-options').clientHeight,
      }));
      assert(crowdedGeometry.listScrollable);
      assert(crowdedGeometry.footerBottom <= crowdedGeometry.height + 1);
      assert(crowdedGeometry.contentHeight <= crowdedGeometry.height + 1);
      await page.evaluate(async () => {
        const { useModelsStore } = await import('/src/stores/models.ts');
        window.layoutModels = window.layoutModels.slice(0, 2);
        await useModelsStore().refresh();
      });
      await content().locator('input[value="layout-model-1"]').check();
      await content().getByRole('button', { name: '保存模型绑定', exact: true }).click();
      await content().getByText('模型绑定已保存', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.layoutSettings), {
        modelId: 'layout-model-1',
        retained: true,
      });
      await openPluginSettings(page, 'Docker 管理');
      await capture('docker-settings', '.plugin-page');
      await openPluginSettings(page, '系统服务');
      await capture('services-settings', '.plugin-page');
      await page.evaluate(async () => {
        const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
        await useWorkspaceStore().openPlugin(
          'cn.hiboot.plugins.services',
          'server',
          'layout-host',
          'overview',
        );
      });
      await content().getByRole('tab', { name: '资源监控', exact: true }).waitFor();
      await content().getByText('23.4%', { exact: true }).waitFor();
      await capture('services-monitor', '.plugin-workspace');
      for (const tab of ['进程与端口', 'systemd 服务', '日志查看']) {
        await content().getByRole('tab', { name: tab, exact: true }).click();
        if (tab !== '日志查看') await content().locator('.ops-table tbody tr').first().waitFor();
        await capture(
          `services-${tab === '进程与端口' ? 'processes' : tab === 'systemd 服务' ? 'units' : 'logs'}`,
          '.plugin-workspace',
        );
      }
      await openPluginFunction(page, 'Docker 管理', 'layout-host');
      await content().getByText('app-service-1', { exact: true }).waitFor();
      await capture('docker-containers', '.plugin-workspace');
      await content().getByRole('tab', { name: '镜像', exact: true }).click();
      await content().getByText('registry.example/application', { exact: true }).waitFor();
      await capture('docker-images', '.plugin-workspace');
      await openPluginFunction(page, 'AI 运维助手', 'layout-host');
      await content().getByRole('button', { name: '容器排查', exact: true }).click();
      assert((await content().getByLabel('问题', { exact: true }).inputValue()).includes('Docker'));
      await capture('assistant-chat', '.plugin-workspace');
      await navigateWorkspace(page, '插件管理');
      await capture('plugin-manager', '.plugin-manager');
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`Passed packaged plugin layouts: ${width} × ${height}, ${theme}`);
    }
  }
  await writeFile(`${output}/result.json`, JSON.stringify({ results }, null, 2));
} finally {
  await browser.close();
  await server?.close();
}
