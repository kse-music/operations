// Rendering fixtures only. Uses the real host components, packaged UI and iframe bridge.
// No user profile, credentials or remote hosts are accessed.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import {
  closeApplicationSettings,
  closePluginSettings,
  openPluginDetails,
  openPluginFunction,
  openPluginSettings,
  navigateWorkspace,
} from './ui-navigation.mjs';

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
  ['docker', 'assistant'].map(async (name) => {
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
const fontSizeOnly = process.argv.includes('--font-size');
try {
  for (const [width, height, scale = 1] of fontSizeOnly
    ? [
        [1440, 1000, 1],
        [1920, 1000, 1.45],
        [900, 700, 1.45],
        [390, 844, 1.45],
      ]
    : [
        [2400, 1400],
        [1440, 900],
        [900, 600],
        [390, 844],
        [390, 460],
      ]) {
    if (
      process.env.SERVERDECK_PLUGIN_LAYOUT_WIDTH &&
      width !== Number(process.env.SERVERDECK_PLUGIN_LAYOUT_WIDTH)
    )
      continue;
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
          const { useHostsStore } = await import('/src/stores/hosts.ts');
          const { useOpsStore } = await import('/src/stores/ops.ts');
          const { useFilesStore } = await import('/src/stores/files.ts');
          const { useModelsStore } = await import('/src/stores/models.ts');
          const { useNotificationsStore } = await import('/src/stores/notifications.ts');
          const { hostInput } = await import('/src/types/hosts.ts');
          const { pluginsApi } = await import('/src/services/plugins.ts');
          const { opsApi } = await import('/src/services/ops.ts');
          const { terminalApi } = await import('/src/services/terminal.ts');
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
              contextWindowTokens: 131072,
            },
          }));
          window.layoutModels = models;
          aiApi.models = async () => window.layoutModels;
          await useModelsStore().refresh();
          window.layoutSettings = { modelId: models[0].id, retained: true };
          window.dialogLogEvents = [];
          window.dialogTerminalInput = [];
          let terminalReceive;
          pluginsApi.terminalOpen = async (_plugin, _ticket, hostId, _shell, _size, receive) => {
            terminalReceive = receive;
            receive({ type: 'state', state: 'connected', code: null, message: null });
            setTimeout(
              () =>
                receive({
                  type: 'data',
                  data: [...new TextEncoder().encode('container:/ # ')],
                  sequence: 1,
                }),
              0,
            );
            return {
              id: 'dialog-pty',
              hostId,
              transportId: 'layout-transport',
              routeHostIds: [hostId],
            };
          };
          terminalApi.input = async (id, data) => {
            window.dialogTerminalInput.push({
              id,
              text: new TextDecoder().decode(new Uint8Array(data)),
            });
            terminalReceive({ type: 'data', data: [...data], sequence: 2 });
          };
          terminalApi.ack = async () => {};
          terminalApi.resize = async () => {};
          terminalApi.close = async (id) => {
            window.dialogPtyClosed = id;
          };
          const polledLogs = new Set();
          let imageApproved = false,
            imageDeleted = false;
          window.imageDeleteDecisions = [];
          window.imageDeleteExecutions = 0;
          pluginsApi.approve = async (id, accepted) => {
            assertImageApproval(id);
            window.imageDeleteDecisions.push(accepted);
            imageApproved = accepted;
          };
          function assertImageApproval(id) {
            if (id !== 'layout-image-approval') throw new Error('Unknown image approval');
          }
          pluginsApi.call = async (_id, payload) => {
            const operation = JSON.parse(payload.values.request);
            let result;
            if (operation.kind === 'system_query' && operation.request.kind === 'image_remove') {
              if (!imageApproved)
                return {
                  protocolVersion: 1,
                  result: {
                    id: 'layout-image-approval',
                    hostId: 'layout-host',
                    pluginName: 'Docker 管理',
                    pluginVersion: packages.find((pkg) => pkg.manifest.name === 'Docker 管理')
                      .manifest.version,
                    imageId: operation.request.id,
                    description: 'Remove frozen test image',
                  },
                  error: { code: 'PLUGIN_CONFIRMATION_REQUIRED', message: 'confirm' },
                };
              imageApproved = false;
              imageDeleted = true;
              window.imageDeleteExecutions++;
              return {
                protocolVersion: 1,
                result: { success: true, records: [], detail: null, code: null, message: null },
                error: null,
              };
            }
            switch (operation.kind) {
              case 'settings_read':
                result = window.layoutSettings;
                break;
              case 'settings_write':
                if (window.holdLayoutSave)
                  await new Promise((resolve) => (window.releaseLayoutSave = resolve));
                if (window.layoutSaveError)
                  return { result: null, error: { code: 'IO', message: '模型绑定写入失败' } };
                window.layoutSettings = operation.value;
                result = null;
                break;
              case 'system_log_start':
                window.dialogLogEvents.push({ kind: 'start', source: operation.source });
                result = { id: `dialog-log-${window.dialogLogEvents.length}` };
                break;
              case 'system_log_poll':
                result = {
                  events: polledLogs.has(operation.logId)
                    ? []
                    : [
                        { type: 'state', state: 'running', code: null, message: null },
                        {
                          type: 'data',
                          sequence: 1,
                          stream: 'stdout',
                          at: Date.now(),
                          dataBase64: btoa(
                            unescape(
                              encodeURIComponent(
                                '弹窗日志：服务已启动\n<script>literal</script>\n',
                              ),
                            ),
                          ),
                        },
                      ],
                };
                polledLogs.add(operation.logId);
                break;
              case 'system_log_stop':
                window.dialogLogEvents.push({ kind: 'stop', id: operation.logId });
                result = null;
                break;
              case 'system_log_pause':
                result = null;
                break;
              case 'container_shell':
                result = { shellTicket: 'layout-shell-ticket' };
                break;
              case 'system_query': {
                const data = {
                  capabilities: [{ dockerInstalled: true, dockerState: 'running' }],
                  containers: Array.from({ length: 40 }, (_, n) => ({
                    ID: n.toString(16).padStart(64, '0'),
                    Names: n < 6 ? `app-service-${n + 1}` : `worker-${n + 1}`,
                    Image: 'registry.example/application:stable',
                    State: n ? 'running' : 'exited',
                    Status: n ? 'Up 3 days' : 'Exited (1)',
                    Ports: '0.0.0.0:8080->80/tcp',
                  })),
                  container_stats: [
                    {
                      CPUPerc: '12.34%',
                      MemUsage: '42 MiB / 128 MiB',
                      MemPerc: '32.81%',
                      NetIO: '1.2 MB / 500 kB',
                      BlockIO: '0 B / 24 kB',
                      PIDs: '4',
                    },
                  ],
                  images: imageDeleted
                    ? []
                    : [
                        {
                          ID: `sha256:${'a'.repeat(64)}`,
                          Repository: 'registry.example/application',
                          Tag: 'stable',
                          Size: '128 MB',
                          CreatedSince: '3 days ago',
                        },
                      ],
                };
                result = {
                  success: true,
                  code: null,
                  message: null,
                  detail:
                    operation.request.kind === 'container_details'
                      ? {
                          id: operation.request.id,
                          name: '/app-service-1',
                          image: 'registry.example/application:stable',
                          state: { Status: 'running', Health: { Status: 'healthy' } },
                          restartPolicy: { Name: 'unless-stopped' },
                          ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
                          mounts: [
                            { Type: 'bind', Source: '/srv/data', Destination: '/data', RW: true },
                          ],
                          environment: [
                            operation.request.revealEnv
                              ? 'TEST_VAR=fixture=value'
                              : 'TEST_VAR=••••••',
                          ],
                          environmentRevealed: operation.request.revealEnv,
                        }
                      : null,
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
      const configuration = await openPluginSettings(page, 'AI 运维助手');
      assert.equal(await page.locator('.workspace-tab').count(), 0);
      const settings = configuration.frameLocator('iframe');
      await settings.getByRole('group', { name: '使用模型' }).waitFor();
      await settings.locator('input[value="layout-model-0"]:checked').waitFor();
      assert.equal(await settings.locator('.binding-footer').count(), 0);
      assert.equal(
        await settings.getByRole('button', { name: '保存绑定', exact: true }).count(),
        0,
      );
      const settingsFrame = page.frames().find((f) => f.url().includes('/settings/index.html'));
      if (fontSizeOnly) {
        for (const preview of [0.95, scale]) {
          await page.evaluate(
            (value) =>
              document.documentElement.style.setProperty('--interface-font-scale', String(value)),
            preview,
          );
          await settingsFrame.waitForFunction(
            (value) =>
              Math.abs(parseFloat(getComputedStyle(document.body).fontSize) - 14 * value) < 0.01,
            preview,
          );
        }
        assert(await settings.locator('input[value="layout-model-0"]').isChecked());
      }
      const settingsGeometry = await settingsFrame.evaluate(() => ({
        height: innerHeight,
        contentHeight: document.documentElement.scrollHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      assert.equal(settingsGeometry.overflow, false);
      assert(
        settingsGeometry.contentHeight <= settingsGeometry.height + 1,
        `Nested settings scroll: ${JSON.stringify(settingsGeometry)}`,
      );
      await capture('assistant-settings', 'dialog:has(.plugin-config-body)');
      const geometry = await configuration.boundingBox();
      assert(geometry.width <= Math.min(width - 32, 1080));
      assert(geometry.y >= 16 && geometry.y + geometry.height <= height - 16);
      await configuration.screenshot({
        path: `${output}/config-dialog-${width}x${height}-${theme}.png`,
      });
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
      await settings.locator('.binding-count').getByText('100', { exact: true }).waitFor();
      const crowdedGeometry = await settingsFrame.evaluate(() => ({
        height: innerHeight,
        contentHeight: document.documentElement.scrollHeight,
        listScrollable:
          document.querySelector('.binding-content').scrollHeight >
          document.querySelector('.binding-content').clientHeight,
      }));
      assert(crowdedGeometry.listScrollable);
      assert(crowdedGeometry.contentHeight <= crowdedGeometry.height + 1);
      await page.evaluate(async () => {
        const { useModelsStore } = await import('/src/stores/models.ts');
        window.layoutModels = window.layoutModels.slice(0, 2);
        await useModelsStore().refresh();
      });
      const holdSave = theme === 'dark';
      if (holdSave) await page.evaluate(() => (window.holdLayoutSave = true));
      await settings.locator('label:has(input[value="layout-model-1"])').click();
      if (holdSave) {
        await page.waitForFunction(() => typeof window.releaseLayoutSave === 'function');
        assert(
          await configuration.getByRole('button', { name: '关闭对话框', exact: true }).isDisabled(),
        );
        assert(
          await configuration
            .getByRole('button', { name: '返回插件列表', exact: true })
            .isDisabled(),
        );
        assert(
          await configuration
            .getByRole('navigation', { name: '设置分类', exact: true })
            .getByRole('button')
            .evaluateAll((buttons) => buttons.every((button) => button.disabled)),
        );
        await page.evaluate(() => {
          window.holdLayoutSave = false;
          window.releaseLayoutSave();
        });
      }
      await settings.getByText('模型绑定已保存', { exact: true }).waitFor();
      await closePluginSettings(page);
      assert.deepEqual(await page.evaluate(() => window.layoutSettings), {
        modelId: 'layout-model-1',
        retained: true,
      });
      const dockerDetails = await openPluginDetails(page, 'Docker 管理');
      const dockerConfiguration = page.getByRole('dialog', {
        name: '设置',
        exact: true,
      });
      assert.equal(await page.locator('.workspace-tab').count(), 0);
      assert.equal(await dockerDetails.locator('.plugin-state-section').count(), 0);
      assert(await dockerDetails.getByLabel('ui.contribute', { exact: true }).isDisabled());
      await capture('docker-settings', 'dialog:has(.plugin-config-body)');
      await dockerConfiguration.screenshot({
        path: `${output}/docker-config-${width}x${height}-${theme}.png`,
      });
      await openPluginFunction(page, 'Docker 管理', 'layout-host');
      await content().getByText('app-service-1', { exact: true }).waitFor();
      if (fontSizeOnly) {
        const textSize = await content()
          .locator('.ops-table table')
          .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
        assert(Math.abs(textSize - 14 * scale) < 0.01, 'Docker table follows interface font scale');
      }
      const verifyDockerTable = async (name, longList) => {
        const geometry = await content()
          .locator('.ops-table')
          .evaluate((element) => {
            const workbench = element.closest('.docker-workbench');
            const table = element.getBoundingClientRect();
            const footer = workbench.querySelector('.ops-footer').getBoundingClientRect();
            const scrolls = element.scrollHeight > element.clientHeight;
            element.scrollTop = element.scrollHeight;
            const header = element.querySelector('th').getBoundingClientRect();
            element.scrollTop = 0;
            return {
              viewportWidth: document.documentElement.clientWidth,
              viewportHeight: innerHeight,
              workbenchWidth: workbench.getBoundingClientRect().width,
              contentWidth: workbench.clientWidth,
              paddingBottom: parseFloat(getComputedStyle(workbench).paddingBottom),
              tableLeft: table.left,
              tableWidth: table.width,
              footerBottom: footer.bottom,
              scrolls,
              headerOffset: header.top - table.top - element.clientTop,
            };
          });
        assert(
          Math.abs(geometry.workbenchWidth - geometry.viewportWidth) <= 1,
          `${name}: full width`,
        );
        assert(Math.abs(geometry.tableLeft) <= 1, `${name}: left edge aligned`);
        assert(Math.abs(geometry.tableWidth - geometry.contentWidth) <= 1, `${name}: table width`);
        if (width >= 1440) {
          assert(
            Math.abs(geometry.viewportHeight - geometry.footerBottom - geometry.paddingBottom) <= 2,
            `${name}: footer at bottom of workspace (${JSON.stringify(geometry)})`,
          );
        } else {
          const footer = content().locator('.ops-footer');
          await footer.scrollIntoViewIfNeeded();
          const footerBounds = await footer.evaluate((element) => {
            const { top, bottom } = element.getBoundingClientRect();
            return { top, bottom, viewportHeight: innerHeight };
          });
          assert(
            footerBounds.top >= -1 && footerBounds.bottom <= footerBounds.viewportHeight + 1,
            `${name}: footer reachable in a short window (${JSON.stringify(footerBounds)})`,
          );
          await content()
            .locator('.docker-workbench')
            .evaluate((element) => (element.scrollTop = 0));
        }
        if (longList) {
          assert(geometry.scrolls, `${name}: long list scrolls inside the table`);
          assert(Math.abs(geometry.headerOffset) <= 1, `${name}: table header stays visible`);
        }
      };
      await verifyDockerTable('containers', true);
      if (fontSizeOnly) {
        const tableSpace = await content()
          .locator('.ops-table')
          .evaluate((element) => ({
            height: element.clientHeight,
            header: element.querySelector('thead').getBoundingClientRect().height,
            row: element.querySelector('tbody tr').getBoundingClientRect().height,
          }));
        assert(
          tableSpace.height >= tableSpace.header + tableSpace.row,
          `Docker table must show its header and a complete row: ${JSON.stringify(tableSpace)}`,
        );
      }
      for (const notice of await page.getByRole('button', { name: '关闭通知', exact: true }).all())
        await notice.click();
      const openDockerImages = async () => {
        await content().getByRole('tab', { name: '镜像', exact: true }).click();
        await content().getByText('registry.example/application', { exact: true }).waitFor();
        await verifyDockerTable('images', false);
      };
      if (height === 460) {
        await openDockerImages();
        assert.deepEqual(errors, []);
        await page.close();
        console.log(
          `Passed short-window settings and Docker tables: ${width} × ${height}, ${theme}`,
        );
        continue;
      }
      const stoppedRow = content().getByRole('row').filter({ hasText: 'app-service-1' });
      const runningRow = content().getByRole('row').filter({ hasText: 'app-service-2' });
      const actionLabels = async (row) =>
        (await row.getByRole('button').allTextContents()).map((label) => label.trim());
      assert.deepEqual(await actionLabels(stoppedRow), ['详情', '启动', '删除', '日志', 'Shell']);
      assert.deepEqual(await actionLabels(runningRow), ['详情', '停止', '删除', '日志', 'Shell']);
      await capture('docker-containers', '.plugin-workspace');
      await stoppedRow.getByRole('button', { name: '详情', exact: true }).click();
      const containerDetails = content().getByRole('dialog', { name: '容器详情', exact: true });
      const panel = containerDetails.getByRole('tabpanel');
      await panel.getByText('app-service-1', { exact: true }).waitFor();
      await panel.getByText('除非手动停止，否则重启', { exact: true }).waitFor();
      assert.equal(await panel.locator('pre').count(), 0);
      const detailTabs = containerDetails.getByRole('tablist');
      assert.equal(
        await detailTabs.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
        false,
      );
      await capture('docker-container-overview', '.plugin-workspace');
      const overviewTab = containerDetails.getByRole('tab', { name: '概览', exact: true });
      const environmentTab = containerDetails.getByRole('tab', { name: '环境变量', exact: true });
      await overviewTab.focus();
      await overviewTab.press('End');
      assert(await environmentTab.evaluate((tab) => document.activeElement === tab));
      assert.equal(await overviewTab.getAttribute('aria-selected'), 'true');
      await environmentTab.press('Enter');
      await panel.getByText('fixture=value', { exact: true }).waitFor();
      assert.equal(await content().getByRole('dialog').count(), 1);
      assert.equal(await page.getByRole('dialog', { name: '插件操作需要单独确认' }).count(), 0);
      await containerDetails.getByRole('tab', { name: '端口映射', exact: true }).click();
      await panel.getByText('8080', { exact: true }).waitFor();
      assert.equal(await containerDetails.getByText('fixture=value', { exact: true }).count(), 0);
      await containerDetails.getByRole('tab', { name: '挂载', exact: true }).click();
      await panel.getByText('/srv/data', { exact: true }).waitFor();
      await containerDetails.getByRole('tab', { name: '资源使用', exact: true }).click();
      await panel.getByText('12.34%', { exact: true }).waitFor();
      assert.equal(
        await containerDetails.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
        false,
      );
      await capture('docker-container-details', '.plugin-workspace');
      await containerDetails.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await content().getByRole('button', { name: '日志', exact: true }).first().click();
      await content()
        .getByTestId('operations-log-output')
        .filter({ hasText: '弹窗日志' })
        .waitFor();
      await capture('docker-log-dialog', '.plugin-workspace');
      await content().getByRole('button', { name: '关闭对话框', exact: true }).click();
      await content().getByRole('button', { name: 'Shell', exact: true }).nth(1).click();
      const terminal = page.locator('.container-terminal-dialog .xterm-helper-textarea');
      await terminal.waitFor({ state: 'attached' });
      await page
        .locator('.container-terminal-dialog .terminal-pane[data-state="connected"]')
        .waitFor();
      assert(
        await terminal.evaluate((element) => element === document.activeElement),
        'Container terminal should receive focus without another click',
      );
      assert.equal(
        await page.getByRole('dialog', { name: '插件操作需要单独确认', exact: true }).count(),
        0,
      );
      await terminal.pressSequentially('whoami');
      await terminal.press('Enter');
      await page.waitForFunction(() =>
        window.dialogTerminalInput
          .map((entry) => entry.text)
          .join('')
          .includes('whoami\r'),
      );
      await capture('docker-shell-dialog', '.plugin-workspace');
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await page.waitForFunction(() => window.dialogPtyClosed === 'dialog-pty');
      assert.deepEqual(
        await page.evaluate(() =>
          window.dialogLogEvents.filter((e) => e.kind === 'start').map((e) => e.source.kind),
        ),
        ['container'],
      );
      assert.equal(
        await page.evaluate(() => window.dialogLogEvents.filter((e) => e.kind === 'stop').length),
        1,
      );
      await openDockerImages();
      await capture('docker-images', '.plugin-workspace');
      await content().getByRole('button', { name: '删除', exact: true }).click();
      const imageReview = page.getByRole('dialog', { name: '删除镜像？', exact: true });
      await imageReview.waitFor();
      assert.equal(await imageReview.locator('input').count(), 0);
      assert.equal(
        await content().getByRole('dialog', { name: '确认主机运维操作', exact: true }).count(),
        0,
      );
      assert((await imageReview.innerText()).includes(`sha256:${'a'.repeat(64)}`));
      const reviewGeometry = await imageReview.evaluate((element) => ({
        overflow: element.scrollWidth > element.clientWidth + 1,
        footerVisible:
          element.querySelector('footer').getBoundingClientRect().bottom <=
          element.getBoundingClientRect().bottom,
      }));
      assert.equal(reviewGeometry.overflow, false);
      assert.equal(reviewGeometry.footerVisible, true);
      assert.equal(await page.evaluate(() => window.imageDeleteExecutions), 0);
      await page.screenshot({ path: `${output}/image-removal-confirm-${width}-${theme}.png` });
      await imageReview.screenshot({
        path: `${output}/image-removal-dialog-${width}-${theme}.png`,
      });
      await imageReview.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await page.evaluate(() => window.imageDeleteExecutions), 0);
      await content().getByRole('button', { name: '删除', exact: true }).click();
      await imageReview.getByRole('button', { name: '确认删除', exact: true }).click();
      await content().getByText('没有匹配项目。', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.imageDeleteExecutions), 1);
      assert.deepEqual(await page.evaluate(() => window.imageDeleteDecisions), [false, true]);
      await openPluginFunction(page, 'AI 运维助手', 'layout-host');
      await content().getByRole('button', { name: '容器排查', exact: true }).click();
      const chat = page.frameLocator(
        '.plugin-workspace[data-host-id="layout-host"]:visible iframe',
      );
      const question = chat.getByLabel('问题', { exact: true });
      const draft = await question.inputValue();
      assert(draft.includes('Docker'));
      const gear = page
        .locator('.plugin-workspace[data-plugin-id="cn.hiboot.plugins.assistant"]:visible')
        .getByRole('button', { name: '插件设置', exact: true });
      const tabsBefore = await page.locator('.workspace-tab').count();
      await chat.getByText('绑定模型未配置 Key，请在模型中补充', { exact: true }).waitFor();
      await gear.click();
      await configuration.getByRole('tab', { name: '基本信息', exact: true }).click();
      assert.equal(await configuration.locator('.plugin-state-section').count(), 0);
      assert.equal(await configuration.locator('iframe').count(), 0);
      await configuration.getByRole('button', { name: '插件配置', exact: true }).click();
      assert.equal(await page.locator('.workspace-tab').count(), tabsBefore);
      await closePluginSettings(page);
      await configuration.locator('.plugin-configuration').waitFor({ state: 'hidden' });
      await closeApplicationSettings(page);
      assert.equal(await page.evaluate(() => window.layoutSettings.modelId), 'layout-model-1');
      assert.equal(await question.inputValue(), draft);
      assert(await gear.evaluate((button) => document.activeElement === button));
      await gear.click();
      await page.evaluate(() => (window.layoutSaveError = true));
      await settings.locator('label:has(input[value="layout-model-0"])').click();
      await settings.getByText('模型绑定写入失败', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.layoutSettings.modelId), 'layout-model-1');
      await page.evaluate(() => (window.layoutSaveError = false));
      await settings.locator('label:has(input[value="layout-model-0"])').click();
      await settings.getByText('模型绑定已保存', { exact: true }).waitFor();
      await closePluginSettings(page);
      await closeApplicationSettings(page);
      assert.equal(await question.inputValue(), draft);
      assert.equal(await page.evaluate(() => window.layoutSettings.modelId), 'layout-model-0');
      await chat.locator('.ai-chat-composer button[type="submit"]:enabled').waitFor();
      if (fontSizeOnly) {
        const textSize = await question.evaluate((element) =>
          parseFloat(getComputedStyle(element).fontSize),
        );
        assert(
          Math.abs(textSize - 14 * scale) < 0.01,
          'Assistant input follows interface font scale',
        );
        const emptyState = await chat.locator('.ai-chat-messages').evaluate((element) => {
          element.scrollTop = 0;
          const title = element.querySelector('.ai-chat-empty h3').getBoundingClientRect();
          return { titleTop: title.top, panelTop: element.getBoundingClientRect().top };
        });
        assert(
          emptyState.titleTop >= emptyState.panelTop,
          'Assistant empty heading stays reachable at the top',
        );
      }
      await capture('assistant-chat', '.plugin-workspace');
      await gear.click();
      await settings.getByRole('button', { name: '管理模型', exact: true }).click();
      await configuration.locator('.plugin-configuration').waitFor({ state: 'hidden' });
      await page.getByRole('region', { name: '模型', exact: true }).waitFor();
      await navigateWorkspace(page, '插件管理');
      const manager = page.locator('.plugin-manager');
      await manager.waitFor();
      await page.locator('.plugin-installed-row').first().waitFor();
      await page.evaluate(async () => {
        const { usePluginsStore } = await import('/src/stores/plugins.ts');
        const plugins = usePluginsStore();
        const base = plugins.installed[0];
        plugins.installed.push({
          ...base,
          source: 'user',
          enabled: false,
          manifest: {
            ...base.manifest,
            id: `dev.upload.${'long-identifier-'.repeat(8)}plugin`,
            name: '自定义工具 / LongPluginNameWithoutBreaksForResponsiveLayoutVerification',
            description: '布局测试插件：用于验证长名称、长标识和描述换行，不连接主机。'.repeat(4),
          },
        });
      });
      assert.equal(await page.locator('.plugin-installed-row').count(), 3);
      const upload = manager.locator('.plugin-installed-row').last();
      await upload.getByRole('button', { name: /^启用 / }).waitFor();
      const uploadTabs = await page.locator('.workspace-tab').count();
      await upload.locator('.plugin-name-button').click();
      const uploadDialog = page.locator('.settings-page:visible');
      await uploadDialog
        .locator('.plugin-configuration')
        .getByText('用户上传', { exact: true })
        .waitFor();
      assert.equal(await page.locator('.workspace-tab').count(), uploadTabs);
      assert.equal(await uploadDialog.locator('iframe').count(), 0);
      assert.equal(await uploadDialog.locator('.plugin-toggle-button').count(), 0);
      assert.equal(
        await uploadDialog.getByLabel('ui.contribute', { exact: true }).isEnabled(),
        true,
      );
      await uploadDialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await uploadDialog.waitFor({ state: 'hidden' });
      assert.notEqual(
        await page.locator('.workspace-tab.active').getAttribute('data-view'),
        'plugins',
      );
      assert.deepEqual(
        await page
          .locator('.sidebar-app-actions button')
          .evaluateAll((buttons) => buttons.map((button) => button.ariaLabel)),
        ['设置'],
      );
      await navigateWorkspace(page, '插件管理');
      const columns = await manager.evaluate((element) => {
        const cards = element.querySelectorAll('.plugin-installed-row');
        return {
          width: element.clientWidth,
          sameRow:
            Math.abs(cards[0].getBoundingClientRect().top - cards[1].getBoundingClientRect().top) <
            1,
        };
      });
      assert.equal(
        columns.sameRow,
        columns.width > 840,
        'Cards must use two columns only when space allows',
      );
      const searchGeometry = await manager.locator('.plugin-search').evaluate((element) => {
        const icon = element.querySelector('svg').getBoundingClientRect();
        const input = element.querySelector('input').getBoundingClientRect();
        return {
          height: element.getBoundingClientRect().height,
          centered: Math.abs(icon.top + icon.height / 2 - input.top - input.height / 2) < 1,
        };
      });
      assert(
        searchGeometry.centered && searchGeometry.height <= 40 * scale,
        'Search icon and input must share a compact row',
      );
      await capture('plugin-manager', '.plugin-manager');
      await page.getByLabel('插件来源', { exact: true }).selectOption('user');
      assert.equal(await page.locator('.plugin-installed-row').count(), 1);
      await page.getByLabel('搜索插件', { exact: true }).fill('no-matching-plugin');
      await page.getByRole('heading', { name: '没有匹配的插件', exact: true }).waitFor();
      await capture('plugin-manager-filter-empty', '.plugin-manager');
      await page.getByRole('button', { name: '清除筛选', exact: true }).click();
      assert.equal(await page.locator('.plugin-installed-row').count(), 3);
      await page.getByLabel('插件状态', { exact: true }).selectOption('enabled');
      assert.equal(await page.locator('.plugin-installed-row').count(), 2);
      await page.getByLabel('插件状态', { exact: true }).selectOption('all');
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
