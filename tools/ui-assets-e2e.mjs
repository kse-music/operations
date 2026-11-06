import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace } from './ui-navigation.mjs';

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
    let catalog = {
      hosts: [],
      groups: [],
      pendingSecretDeletions: 2,
      credentials: [
        {
          id: 'password',
          name: '运维登录密码',
          kind: 'password',
          keyPath: null,
          hasSecret: true,
          hostCount: 2,
          revision: 1,
        },
        {
          id: 'key',
          name: '发布服务私钥',
          kind: 'private_key',
          keyPath: 'D:\\SSH\\' + 'deployment-key-directory-'.repeat(9) + 'id_ed25519',
          hasSecret: false,
          hostCount: 0,
          revision: 1,
        },
      ],
    };
    useHostsStore(pinia).catalog = catalog;
    hostsApi.status = async () => ({ available: true, message: '系统凭据库可用。' });
    hostsApi.list = async () => catalog;
    hostsApi.credentialSave = async (id, revision, input) => {
      if (
        id !== null ||
        revision !== null ||
        input.kind !== 'private_key' ||
        input.keyPath !== null ||
        input.keyData !== 'fixture-file-content'
      ) {
        throw new Error('私钥文件导入参数无效');
      }
      const credential = {
        id: 'imported-key',
        name: input.name,
        kind: input.kind,
        keyPath: null,
        hasSecret: true,
        hostCount: 0,
        revision: 1,
      };
      catalog = { ...catalog, credentials: [...catalog.credentials, credential] };
      return { value: credential, warnings: [] };
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
        '.content-scroll, .asset-view, .asset-panel, .model-catalog, .credential-list li, dialog[open]',
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
  await page.locator('.content-scroll').evaluate((el) => (el.scrollTop = 0));
  assert.equal(
    await page.locator('.module-menu [aria-current="page"]').getAttribute('aria-label'),
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

    const credentials = await openAsset(page, '安全凭据');
    const credentialColumns = await credentials
      .locator('.asset-columns')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(credentialColumns, expectedColumns, `${name}: credentials columns`);
    await credentials.getByRole('button', { name: '检查系统凭据库', exact: true }).click();
    await credentials.getByText('系统凭据库可用。', { exact: true }).waitFor();
    await inspect(page, `${name}: credentials`);
    await screenshot('credentials');
    const row = credentials.getByRole('listitem').filter({ hasText: '运维登录密码' });
    await row.getByRole('button', { name: '删除', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: '确认删除凭据', exact: true });
    assert(await deletion.getByRole('button', { name: '确认删除凭据', exact: true }).isDisabled());
    await deletion.getByRole('checkbox').check();
    assert(await deletion.getByRole('button', { name: '确认删除凭据', exact: true }).isEnabled());
    await inspect(page, `${name}: credential confirmation`);
    await deletion.getByRole('button', { name: '取消', exact: true }).click();
    await credentials.getByRole('button', { name: /新建凭据/ }).click();
    const create = page.getByRole('dialog', { name: '新建凭据', exact: true });
    await create.getByLabel('凭据名称', { exact: true }).fill('导入私钥');
    await create.getByLabel('凭据类型', { exact: true }).selectOption('private_key');
    const keyFile = create.getByLabel('选择私钥文件', { exact: true });
    assert(await keyFile.evaluate((input) => input.validity.valueMissing));
    assert.equal(await create.getByLabel('本地私钥路径', { exact: true }).count(), 0);
    await keyFile.setInputFiles({
      name: 'fixture.key',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('fixture-file-content'),
    });
    await create.getByLabel('加密私钥口令（可选）', { exact: true }).waitFor();
    await inspect(page, `${name}: key import dialog`);
    await screenshot('credential-import');
    await create.getByRole('button', { name: '保存凭据', exact: true }).click();
    await create.waitFor({ state: 'hidden' });
    await credentials.getByText('私钥已导入系统凭据库', { exact: true }).waitFor();

    const models = await openAsset(page, '模型管理');
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
  console.log(`Passed credentials and models checks in ${results.length} window/theme variants.`);
} finally {
  await browser.close();
}
