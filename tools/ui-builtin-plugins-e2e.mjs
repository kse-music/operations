// Isolated rendering fixtures: real host UI, packaged plugin CSS/JS and authenticated iframe bridge.
// No native IPC, persisted configuration, credentials or remote servers.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import {
  closeApplicationSettings,
  openPluginSettings,
  openPluginFunction,
} from './ui-navigation.mjs';
const output = process.env.SERVERDECK_BUILTIN_LAYOUT_OUTPUT ?? '.local/qa/builtin-layout/browser';
await mkdir(output, { recursive: true });
const packages = await Promise.all(
  ['assistant', 'docker'].map(async (name) => {
    const pkg = JSON.parse(await readFile(`plugins/system/packages/${name}.sdplugin`, 'utf8'));
    return {
      ...pkg,
      ui: JSON.parse(Buffer.from(pkg.files.find((f) => f.path === 'ui.json').content, 'base64')),
    };
  }),
);
const server = await createServer({
  root: 'apps/desktop',
  configFile: 'apps/desktop/vite.config.ts',
  server: { host: '127.0.0.1', port: 19436, strictPort: true },
});
await server.listen();
let browser;
const results = [];
try {
  browser = await chromium.launch({
    executablePath:
      process.env.SERVERDECK_BROWSER ??
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  for (const [name, width, height, theme, font] of [
    ['desktop-dark', 1440, 900, 'dark', 'standard'],
    ['desktop-light', 1440, 900, 'light', 'standard'],
    ['minimum-dark', 960, 600, 'dark', 'standard'],
    ['minimum-large', 960, 600, 'light', 'ultraLarge'],
    ['narrow', 390, 844, 'dark', 'standard'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://sdplugin.localhost/**', async (route) => {
      const [, id, , , asset = 'index.html'] = new URL(route.request().url()).pathname.split('/');
      const pkg = packages.find((p) => p.manifest.id === id);
      assert(pkg);
      const file = pkg.files.find((f) => f.path === asset);
      const body =
        asset === 'index.html'
          ? '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="frontend.css"></head><body><div id="app"></div><script src="frontend.js"></script></body></html>'
          : Buffer.from(file.content, 'base64');
      await route.fulfill({
        body,
        contentType: asset.endsWith('.html')
          ? 'text/html'
          : asset.endsWith('.css')
            ? 'text/css'
            : 'text/javascript',
      });
    });
    await page.goto('http://127.0.0.1:19436');
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.evaluate(
      async ({ packages, theme, font }) => {
        const { usePluginsStore } = await import('/src/stores/plugins.ts');
        const { useHostsStore } = await import('/src/stores/hosts.ts');
        const { useOpsStore } = await import('/src/stores/ops.ts');
        const { useModelsStore } = await import('/src/stores/models.ts');
        const { useApplicationStore } = await import('/src/stores/application.ts');
        const { useNotificationsStore } = await import('/src/stores/notifications.ts');
        const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
        const { defaultProductPreferences } = await import('/src/types/product.ts');
        const { hostInput } = await import('/src/types/hosts.ts');
        const { pluginsApi } = await import('/src/services/plugins.ts');
        const { aiApi } = await import('/src/services/ai.ts');
        const { opsApi } = await import('/src/services/ops.ts');
        const { filesApi } = await import('/src/services/files.ts');
        const plugins = usePluginsStore();
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
              readRoots: [],
              writeRoots: [],
            },
          ]),
        );
        pluginsApi.inventory = async () => ({ installed: items, problems: [] });
        pluginsApi.permissions = async (id) => grants[id];
        pluginsApi.statuses = async () => [];
        pluginsApi.ui = async (id) => packages.find((p) => p.manifest.id === id).ui;
        for (const method of ['reset', 'scopeVisibility', 'closeScope', 'cancelScope', 'cancel'])
          pluginsApi[method] = async () => {};
        pluginsApi.activate = async (id) => ({ id, state: 'active', errorCode: null });
        await plugins.refresh();
        const application = useApplicationStore();
        application.state = {
          appVersion: 'layout-test',
          databaseVersion: 10,
          dataDirectory: '',
          logDirectory: '',
          config: {
            version: 2,
            theme,
            interfaceFontSize: font,
            sidebarWidth: 260,
            terminalFontSize: 14,
            connectTimeoutSecs: 10,
            monitorIntervalSecs: 5,
            transferConcurrency: 3,
            logLevel: 'info',
            terminal: defaultTerminalPreferences(),
            product: defaultProductPreferences(),
          },
        };
        application.error = null;
        const host = {
          ...hostInput(),
          id: 'layout-host',
          name: '应用服务器',
          hostname: '192.0.2.10',
          username: 'operator',
          createdAt: '',
          updatedAt: '',
        };
        const catalog = { hosts: [host], groups: [], credentials: [], pendingSecretDeletions: 0 };
        useHostsStore().catalog = catalog;
        useOpsStore().connections[host.id] = {
          host,
          state: 'connected',
          session: {
            id: 'layout-session',
            hostId: host.id,
            transportId: 'layout-transport',
            routeHostIds: [host.id],
          },
          trust: null,
          error: null,
        };
        opsApi.connections = async () => [useOpsStore().connections[host.id].session];
        filesApi.connections = async () => [];
        filesApi.tasks = async () => [];
        const config = {
          provider: 'openai_compatible',
          baseUrl: 'https://layout.invalid/v1',
          model: 'diagnostic-model',
          allowInsecureHttp: false,
          maxOutputTokens: 1024,
          contextWindowTokens: 131072,
        };
        const models = [
          {
            id: 'local-claude-code',
            name: '本地 Claude Code',
            revision: '1',
            hasKey: true,
            config: { ...config, model: 'claude-local' },
          },
          { id: 'remote-a', name: '日常诊断模型', revision: '1', hasKey: true, config },
          {
            id: 'remote-b',
            name: '备用模型',
            revision: '1',
            hasKey: false,
            config: { ...config, model: 'backup-model' },
          },
        ];
        window.layoutModels = models;
        window.layoutSettings = { modelId: 'remote-a', retained: 'keep' };
        window.layoutCalls = [];
        window.dockerQueries = [];
        aiApi.models = async () => window.layoutModels;
        await useModelsStore().refresh();
        pluginsApi.capability = async (_id, input) => {
          const request = input.operation.request;
          window.layoutCalls.push(request.kind);
          switch (request.kind) {
            case 'models':
              return {
                result: {
                  models: window.layoutModels,
                  sources: [
                    {
                      id: 'local-codex',
                      name: '本地 Codex',
                      status: {
                        installed: false,
                        authorized: false,
                        message: '尚未安装，请在平台模型设置中下载安装。',
                      },
                    },
                    {
                      id: 'local-claude-code',
                      name: '本地 Claude Code',
                      status: {
                        installed: true,
                        authorized: true,
                        model: 'claude-local',
                        message: '已连接，使用已有配置与登录状态。',
                      },
                    },
                  ],
                },
                error: null,
              };
            case 'hosts':
              return { result: { hosts: [host], groups: [] }, error: null };
            case 'settings_read':
              return { result: window.layoutSettings, error: null };
            case 'settings_write':
              if (window.holdSave) await new Promise((resolve) => (window.releaseSave = resolve));
              if (window.failSave)
                return { result: null, error: { code: 'IO', message: '模型绑定写入失败' } };
              window.layoutSettings = request.value;
              return { result: null, error: null };
            default:
              throw new Error('Unexpected platform fixture: ' + request.kind);
          }
        };
        pluginsApi.call = async (_id, payload) => {
          if (payload.action !== 'query')
            throw new Error('Unexpected plugin fixture action: ' + payload.action);
          const kind = payload.input.request.kind;
          window.dockerQueries.push(kind);
          if (window.failDocker && kind === 'containers')
            return {
              result: {
                success: false,
                code: 'IO',
                message: '测试列表读取失败',
                records: [],
                detail: null,
              },
              error: null,
            };
          return {
            result: {
              success: true,
              code: null,
              message: null,
              records:
                kind === 'containers'
                  ? Array.from({ length: 24 }, (_, i) => ({
                      ID: 'c' + i,
                      Names: 'app-service-' + (i + 1),
                      Image: 'registry.example/application:stable',
                      State: i % 3 ? 'running' : 'exited',
                      Status: i % 3 ? 'Up 3 days' : 'Exited (1)',
                      Ports: '0.0.0.0:8080 → 80/tcp',
                    }))
                  : kind === 'images'
                    ? [
                        {
                          ID: 'sha256:abcdef1234',
                          Repository: 'registry.example/application',
                          Tag: 'stable',
                          Size: '128 MB',
                          CreatedSince: '3 days ago',
                        },
                      ]
                    : [],
              detail:
                kind === 'capabilities' ? { dockerInstalled: true, dockerState: 'running' } : null,
            },
            error: null,
          };
        };
        useNotificationsStore().items = [];
      },
      { packages: packages.map(({ manifest, ui }) => ({ manifest, ui })), theme, font },
    );
    const shot = async (view) => {
      await page.evaluate(async () => {
        const { useNotificationsStore } = await import('/src/stores/notifications.ts');
        useNotificationsStore().items = [];
      });
      await page.screenshot({ path: `${output}/${name}-${view}.png` });
    };
    const inspectHost = async () => {
      const overflow = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '.settings-dialog-content, .plugin-configuration, .plugin-config-body',
          ),
        ]
          .filter((el) => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1)
          .map((el) => el.className),
      );
      assert.deepEqual(overflow, []);
    };
    const config = await openPluginSettings(page, 'AI 运维助手');
    assert.deepEqual(
      (await config.getByRole('tab').allTextContents()).map((text) => text.trim()),
      ['基本信息', '插件配置'],
    );
    assert.equal(await config.locator('.plugin-config-footer').count(), 0);
    const settings = config.frameLocator('iframe');
    await settings.getByRole('group', { name: '使用模型' }).waitFor();
    assert.equal(await settings.locator('input[value=""]').count(), 0);
    await settings.locator('input[value="remote-a"]:checked').waitFor();
    assert(await settings.locator('input[value="local-codex"]').isDisabled());
    assert(await settings.locator('input[value="remote-b"]').isDisabled());
    await inspectHost();
    await shot('assistant-settings');
    const frame = page.frames().find((f) => f.url().includes('/settings/index.html'));
    const geometry = await frame.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      outerScroll: document.documentElement.scrollHeight > innerHeight + 1,
      footerBottom: document.querySelector('.binding-footer').getBoundingClientRect().bottom,
      height: innerHeight,
    }));
    assert.equal(geometry.overflow, false);
    assert.equal(geometry.outerScroll, false);
    assert(geometry.footerBottom <= geometry.height + 1);
    await settings.locator('input[value="local-claude-code"]').check();
    await settings.getByText('有未保存的选择', { exact: true }).waitFor();
    await page.evaluate(() => {
      window.holdSave = true;
    });
    await settings.getByRole('button', { name: '保存绑定', exact: true }).click();
    await page.waitForFunction(() => !!window.releaseSave);
    assert(await config.getByRole('tab', { name: '基本信息', exact: true }).isDisabled());
    assert(await config.getByRole('button', { name: '返回插件列表', exact: true }).isDisabled());
    await page.evaluate(() => {
      window.holdSave = false;
      window.releaseSave();
    });
    await settings.getByText('模型绑定已保存', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.layoutSettings), {
      retained: 'keep',
      modelId: 'local-claude-code',
    });
    await config.getByRole('tab', { name: '基本信息', exact: true }).click();
    await config.getByRole('heading', { name: '插件信息', exact: true }).waitFor();
    await config.locator('.plugin-permissions > summary').click();
    assert.equal(await config.locator('.plugin-permission-list input').count(), 0);
    await inspectHost();
    await shot('assistant-info');
    await config.getByRole('tab', { name: '插件配置', exact: true }).click();
    const reopened = config.frameLocator('iframe');
    await reopened.locator('input[value="local-claude-code"]:checked').waitFor();
    await reopened.locator('input[value="remote-a"]').check();
    await page.evaluate(() => {
      window.failSave = true;
    });
    await reopened.getByRole('button', { name: '保存绑定', exact: true }).click();
    await reopened.getByRole('alert').filter({ hasText: '模型绑定写入失败' }).waitFor();
    assert.equal(await page.evaluate(() => window.layoutSettings.modelId), 'local-claude-code');
    await page.evaluate(() => {
      window.failSave = false;
    });
    await reopened.getByRole('button', { name: '保存绑定', exact: true }).click();
    await reopened.getByText('模型绑定已保存', { exact: true }).waitFor();
    // A long catalog scrolls inside the content area and keeps save/cancel visible.
    await page.evaluate(() => {
      window.layoutModels.push(
        ...Array.from({ length: 98 }, (_, i) => ({
          ...window.layoutModels[1],
          id: 'extra-' + i,
          name: '长列表模型 ' + i,
        })),
      );
    });
    await reopened.getByRole('button', { name: '刷新', exact: true }).click();
    await reopened.locator('.binding-count').getByText('100', { exact: true }).waitFor();
    assert(await reopened.getByRole('button', { name: '保存绑定', exact: true }).isVisible());
    await reopened.locator('input[value="local-claude-code"]').check();
    await reopened.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.evaluate(() => window.layoutSettings.modelId), 'remote-a');
    await config.locator('.plugin-configuration').waitFor({ state: 'hidden' });
    const dockerConfig = await openPluginSettings(page, 'Docker 管理');
    await dockerConfig.getByRole('tab', { name: '插件配置', exact: true }).click();
    await dockerConfig.getByRole('heading', { name: '无需单独配置', exact: true }).waitFor();
    assert.equal(await dockerConfig.locator('iframe').count(), 0);
    await shot('docker-settings');
    await dockerConfig.getByRole('tab', { name: '基本信息', exact: true }).click();
    await dockerConfig.locator('.plugin-permissions > summary').click();
    await shot('docker-info');
    await closeApplicationSettings(page);
    await openPluginFunction(page, 'Docker 管理', 'layout-host');
    const docker = page.frameLocator('.plugin-frame-container:visible iframe');
    await docker.getByText('app-service-1', { exact: true }).waitFor();
    const dockerFrame = page.frames().find((frame) => frame.url().includes('/server/index.html'));
    if (font === 'standard' && width >= 960) {
      const layout = await dockerFrame.evaluate(() => ({
        height: innerHeight,
        firstRow: document.querySelector('tbody tr').getBoundingClientRect().top,
        footer: document.querySelector('.ops-footer').getBoundingClientRect().bottom,
      }));
      assert(layout.firstRow < layout.height, JSON.stringify(layout));
      assert(layout.footer <= layout.height + 1, JSON.stringify(layout));
    }
    await shot('docker-containers');
    const filter = docker.getByRole('textbox', { name: '运维项目搜索', exact: true });
    await filter.fill('app-service-1');
    const tableScroll = await dockerFrame.evaluate(() => {
      const table = document.querySelector('.ops-table');
      table.scrollTop = 100;
      return table.scrollTop;
    });
    const originalFrame = await page
      .locator('.plugin-frame-container:visible iframe')
      .elementHandle();
    const queriesBeforeSettings = await page.evaluate(() => [...window.dockerQueries]);
    const settingsButton = page
      .locator('.plugin-workspace:visible > .plugin-heading')
      .getByRole('button', { name: '插件设置', exact: true });
    await settingsButton.click();
    const standalone = page.getByRole('dialog', { name: 'Docker 管理 · 插件设置', exact: true });
    await standalone.waitFor();
    assert.equal(
      await standalone.locator('.settings-dialog-navigation, .settings-panel').count(),
      0,
    );
    assert.equal(
      await standalone.getByRole('button', { name: '返回插件列表', exact: true }).count(),
      0,
    );
    assert.equal(await page.getByRole('dialog', { name: '设置', exact: true }).count(), 0);
    await standalone.getByRole('tab', { name: '插件配置', exact: true }).click();
    await standalone.getByRole('heading', { name: '无需单独配置', exact: true }).waitFor();
    await inspectHost();
    await shot('docker-standalone-settings');
    await standalone.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await standalone.waitFor({ state: 'hidden' });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === '插件设置',
    );
    assert.equal(await originalFrame.evaluate((frame) => frame.isConnected), true);
    assert.equal(await filter.inputValue(), 'app-service-1');
    assert.equal(
      await dockerFrame.evaluate(() => document.querySelector('.ops-table').scrollTop),
      tableScroll,
    );
    assert.deepEqual(await page.evaluate(() => window.dockerQueries), queriesBeforeSettings);
    await settingsButton.click();
    await standalone.waitFor();
    await page.keyboard.press('Escape');
    await standalone.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.dockerQueries), queriesBeforeSettings);
    await docker.getByRole('textbox', { name: '运维项目搜索', exact: true }).fill('no-match');
    await docker.getByText('没有匹配项目。', { exact: true }).waitFor();
    await docker.getByRole('textbox', { name: '运维项目搜索', exact: true }).fill('');
    await page.evaluate(() => {
      window.failDocker = true;
    });
    await docker.getByRole('button', { name: '刷新运维列表', exact: true }).click();
    await docker.getByRole('alert').filter({ hasText: '测试列表读取失败' }).waitFor();
    await page.evaluate(() => {
      window.failDocker = false;
    });
    await docker.getByRole('button', { name: '刷新运维列表', exact: true }).click();
    await docker.getByText('app-service-1', { exact: true }).waitFor();
    await docker.getByRole('tab', { name: '镜像', exact: true }).click();
    await docker.getByText('registry.example/application', { exact: true }).waitFor();
    await shot('docker-images');
    await openPluginFunction(page, 'AI 运维助手', 'layout-host');
    const assistant = page.frameLocator('.plugin-frame-container:visible iframe');
    await assistant.getByText('有什么需要一起排查？', { exact: true }).waitFor();
    await assistant.getByRole('button', { name: '资源异常', exact: true }).click();
    assert(
      (await assistant.getByRole('textbox', { name: '问题', exact: true }).inputValue()).includes(
        'CPU',
      ),
    );
    await shot('assistant-chat');
    const question = assistant.getByRole('textbox', { name: '问题', exact: true });
    const questionDraft = await question.inputValue();
    await page
      .locator('.plugin-workspace:visible > .plugin-heading')
      .getByRole('button', { name: '插件设置', exact: true })
      .click();
    const assistantConfig = page.getByRole('dialog', {
      name: 'AI 运维助手 · 插件设置',
      exact: true,
    });
    const assistantSettings = assistantConfig.frameLocator('iframe');
    await assistantSettings.locator('input[value="remote-a"]:checked').waitFor();
    await assistantSettings.locator('input[value="local-claude-code"]').check();
    await assistantSettings.getByRole('button', { name: '保存绑定', exact: true }).click();
    await assistantSettings.getByText('模型绑定已保存', { exact: true }).waitFor();
    await shot('assistant-standalone-settings');
    await assistantSettings.getByRole('button', { name: '取消', exact: true }).click();
    await assistantConfig.waitFor({ state: 'hidden' });
    await assistant
      .getByText('本地 Claude Code · Enter 发送 · Shift + Enter 换行', { exact: true })
      .waitFor();
    assert.equal(await question.inputValue(), questionDraft);
    for (const surface of page.frames().filter((f) => f.url().includes('sdplugin.localhost'))) {
      assert.equal(
        await surface.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    }
    assert.deepEqual(errors, []);
    results.push({ name, width, height, theme, font, settings: geometry, passed: true });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(
    `Passed packaged builtin plugin layouts and interactions in ${results.length} variants.`,
  );
} finally {
  await browser?.close();
  await server.close();
}
