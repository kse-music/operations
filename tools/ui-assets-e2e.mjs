import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { hostContextAction, hostTreeAction, navigateWorkspace } from './ui-navigation.mjs';

const url = process.env.SERVERDECK_ASSETS_URL ?? 'http://127.0.0.1:1421';
const output = process.env.SERVERDECK_ASSETS_OUTPUT ?? '.local/assets-layout-qa/ui';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.SERVERDECK_BROWSER ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});

// Test-only in-memory fixtures. No real credentials or providers.
async function fixtures(page, theme) {
  await page.evaluate(async (theme) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const { useApplicationStore } = await import('/src/stores/application.ts');
    const { useHostsStore } = await import('/src/stores/hosts.ts');
    const { useNotificationsStore } = await import('/src/stores/notifications.ts');
    const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
    const { defaultProductPreferences } = await import('/src/types/product.ts');
    const { aiApi } = await import('/src/services/ai.ts');
    const { hostsApi } = await import('/src/services/hosts.ts');
    const application = useApplicationStore(pinia);
    application.state = {
      appVersion: 'ui-test',
      databaseVersion: 5,
      dataDirectory: '',
      logDirectory: '',
      config: {
        version: 1,
        theme,
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
    const catalog = {
      hosts: [],
      groups: [],
      pendingSecretDeletions: 2,
      credentials: [],
    };
    useHostsStore(pinia).catalog = catalog;
    hostsApi.list = async () => ({ ...catalog, hosts: [...catalog.hosts] });
    hostsApi.test = async (input, authentication, _confirmed, hostId) => {
      if (hostId === 'fixture-host') {
        if (input.credentialId !== 'fixture-key' || authentication !== undefined)
          throw new Error('编辑测试应沿用已有私钥');
        return { status: 'connected', testId: 'fixture-edit-test', expiresInSeconds: 300 };
      }
      if (
        input.authType !== 'private_key' ||
        authentication?.kind !== 'private_key' ||
        authentication.keyData !== 'fixture-file-content'
      ) {
        throw new Error('主机私钥文件导入参数无效');
      }
      return { status: 'connected', testId: 'fixture-host-test', expiresInSeconds: 300 };
    };
    hostsApi.create = async (input, _authentication, testId) => {
      if (testId !== 'fixture-host-test') throw new Error('缺少主机连接测试结果');
      const host = {
        ...input,
        id: 'fixture-host',
        credentialId: 'fixture-key',
        createdAt: '',
        updatedAt: '',
      };
      catalog.hosts.push(host);
      return host;
    };
    hostsApi.updateTested = async (id, input, _authentication, testId) => {
      if (id !== 'fixture-host' || testId !== 'fixture-edit-test')
        throw new Error('缺少当前主机的编辑测试结果');
      const host = { ...catalog.hosts[0], ...input };
      catalog.hosts[0] = host;
      return host;
    };
    let models = [
      {
        id: 'model-a',
        name: '内网诊断模型',
        revision: '1',
        hasKey: true,
        config: {
          provider: 'openai_compatible',
          model: 'diagnostics-v1',
          baseUrl: 'https://api.example.test/v1',
          maxOutputTokens: 4096,
          allowInsecureHttp: false,
          contextWindowTokens: 131072,
        },
      },
      {
        id: 'model-b',
        name: '部署验证模型',
        revision: '1',
        hasKey: false,
        config: {
          provider: 'openai_compatible',
          model: 'deployment-'.repeat(12),
          baseUrl: 'http://api.example.test/' + 'gateway-'.repeat(20) + '/v1',
          maxOutputTokens: 2048,
          allowInsecureHttp: true,
          contextWindowTokens: 131072,
        },
      },
    ];
    aiApi.models = async () => models;
    aiApi.modelTest = async ({ config }) => {
      if (config.contextWindowTokens !== 8192) throw new Error('上下文窗口未传给连接测试');
      return { id: 'window-test', elapsedMs: 10, expiresInSeconds: 300 };
    };
    aiApi.modelSave = async ({ id, config, testId }) => {
      if (
        config.contextWindowTokens !== 8192 ||
        testId !== 'window-test' ||
        'inputPricePerMillion' in config ||
        'outputPricePerMillion' in config
      ) {
        throw new Error('模型保存参数无效');
      }
      const model = { ...models.find((entry) => entry.id === id), config, revision: '2' };
      models = models.map((entry) => (entry.id === id ? model : entry));
      return { value: model, warnings: [] };
    };
    useNotificationsStore(pinia).items = [];
  }, theme);
}

async function inspect(page, label) {
  const overflow = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.content-scroll, .asset-view, .asset-panel, .model-catalog, dialog[open]',
      ),
    ]
      .filter((el) => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.className || el.tagName),
  );
  assert.deepEqual(overflow, [], label);
}

async function openAsset(page, label, regionName = label) {
  await navigateWorkspace(page, label);
  const view = page.getByRole('region', { name: regionName, exact: true });
  await view.waitFor();
  await page.locator('.settings-dialog-content').evaluate((el) => (el.scrollTop = 0));
  assert.equal(
    await page
      .locator('.settings-dialog-navigation [aria-current="page"]')
      .getAttribute('aria-label'),
    label,
  );
  return view;
}

const results = [];
try {
  for (const [name, width, height, theme] of [
    ['desktop-dark', 1440, 900, 'dark'],
    ['desktop-light', 1440, 900, 'light'],
    ['wide', 2400, 1000, 'dark'],
    ['small', 900, 600, 'light'],
    ['narrow', 390, 844, 'dark'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await fixtures(page, theme);
    const expectedColumns = width >= 1440 ? 2 : 1;
    const screenshot = (view) => page.screenshot({ path: `${output}/${name}-${view}.png` });

    await navigateWorkspace(page, '数据与存储');
    await page.getByLabel('默认下载目录', { exact: true }).waitFor();
    assert.equal(await page.getByRole('group', { name: '系统凭据库', exact: true }).count(), 0);
    await inspect(page, `${name}: data and storage settings`);

    await hostTreeAction(page, null, '新建主机');
    const hostDialog = page.getByRole('dialog', { name: '新建主机', exact: true });
    await hostDialog.getByLabel('地址（IP / 域名）', { exact: true }).fill('host.example.test');
    await hostDialog.getByLabel('用户名', { exact: true }).fill('ops');
    await hostDialog
      .getByLabel('认证方式', { exact: true })
      .selectOption({ label: '公钥认证（PublicKey）' });
    await hostDialog.getByLabel('私钥内容', { exact: true }).waitFor();
    await inspect(page, `${name}: pasted private key form`);
    await screenshot('host-key');
    await hostDialog.getByLabel('选择私钥文件', { exact: true }).setInputFiles({
      name: 'fixture.key',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('fixture-file-content'),
    });
    await hostDialog.getByLabel('加密私钥口令（可选）', { exact: true }).waitFor();
    const saveHost = hostDialog.getByRole('button', { name: '保存主机', exact: true });
    assert(await saveHost.isDisabled());
    await hostDialog.getByRole('button', { name: '测试连接', exact: true }).click();
    await hostDialog.getByText('SSH 连接和认证成功，可以保存主机。', { exact: true }).waitFor();
    await saveHost.click();
    await hostDialog.waitFor({ state: 'hidden' });

    await hostContextAction(page, page.locator('.tree-host[data-host-id="fixture-host"]'), '编辑');
    const edit = page.getByRole('dialog', { name: '编辑主机', exact: true });
    const saveEdit = edit.getByRole('button', { name: '保存主机', exact: true });
    const nameField = edit.getByLabel('主机名称（可选）', { exact: true });
    assert(await saveEdit.isDisabled());
    await edit.getByRole('button', { name: '测试连接', exact: true }).click();
    await edit.getByText('SSH 连接和认证成功，可以保存主机。', { exact: true }).waitFor();
    await nameField.fill('编辑后需重测');
    assert(await saveEdit.isDisabled());
    await edit.getByRole('button', { name: '测试连接', exact: true }).click();
    await saveEdit.click();
    await edit.waitFor({ state: 'hidden' });
    await page.getByText('编辑后需重测', { exact: true }).waitFor();

    const models = await openAsset(page, '模型管理');
    assert.equal(
      await page
        .locator('.settings-dialog-navigation [aria-current="page"]')
        .getAttribute('aria-label'),
      '模型管理',
    );
    await models.getByRole('heading', { name: '内网诊断模型', exact: true }).waitFor();
    assert.equal(await models.locator('.model-list-heading').isVisible(), expectedColumns === 2);
    await inspect(page, `${name}: models`);
    await screenshot('models');
    await models.getByRole('button', { name: '编辑模型 内网诊断模型', exact: true }).click();
    const modelDialog = page.getByRole('dialog', { name: '编辑模型', exact: true });
    await modelDialog.locator('.model-advanced summary').click();
    const contextWindow = modelDialog.getByLabel('上下文窗口（Token）', { exact: true });
    assert.equal(await contextWindow.inputValue(), '131072');
    assert.equal(await modelDialog.getByLabel(/单价/).count(), 0);
    await contextWindow.fill('1024');
    assert(
      await modelDialog
        .getByLabel('最大输出 Token', { exact: true })
        .evaluate((input) => input.validity.rangeOverflow),
    );
    await contextWindow.fill('8192');
    await inspect(page, `${name}: model dialog`);
    await screenshot('model-context');
    await modelDialog.getByRole('button', { name: '测试连接', exact: true }).click();
    await modelDialog.getByText(/当前配置可保存/).waitFor();
    await modelDialog.getByRole('button', { name: '保存模型', exact: true }).click();
    await modelDialog.waitFor({ state: 'hidden' });
    await models
      .getByRole('listitem')
      .filter({ hasText: '内网诊断模型' })
      .getByText('8,192', { exact: true })
      .waitFor();

    assert.deepEqual(errors, [], `${name}: page errors`);
    results.push({ name, width, height, theme, columns: expectedColumns });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(
    `Passed host authentication, storage settings and model checks in ${results.length} window/theme variants.`,
  );
} finally {
  await browser.close();
}
