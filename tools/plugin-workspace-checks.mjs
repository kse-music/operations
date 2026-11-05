import { networkFixture } from './plugin-fixtures.mjs';
// Runs only inside the caller's verified, isolated native QA application.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { navigateWorkspace, setPluginEnabled } from './ui-navigation.mjs';

export async function checkWorkspaceTools({ page, invoke, run, passed }) {
  const content = () => page.frameLocator('.plugin-frame-container:visible iframe');
  // Approve only the two known outbound AI reviews in this owned HTTP fixture.
  const approveQuestion = async () => {
    for (const expected of ['资产索引', 'body']) {
      const review = page.getByRole('dialog', { name: '确认插件操作 · AI 运维助手', exact: true });
      await review.waitFor();
      assert((await review.innerText()).includes(expected), 'unexpected AI approval request');
      await review.getByRole('button', { name: '明确确认', exact: true }).click();
      await review.waitFor({ state: 'hidden' });
    }
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const poll = async (read, check) => {
    for (let i = 0; i < 100; i++) {
      const value = await read();
      if (check(value)) return value;
      await delay(100);
    }
    throw new Error('Timed out waiting for owned native operation');
  };
  const refresh = () =>
    page.evaluate(async () => {
      const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      await stores.get('plugins').refresh();
    });
  assert.deepEqual(
    await page
      .locator('.module-navigation [data-module]')
      .evaluateAll((nodes) => nodes.map((n) => n.textContent.trim())),
    ['主机运维', '运维工具', '资产管理', '设置'],
  );
  for (const [name, selector] of [
    ['网络诊断', '[aria-label="诊断工具"]'],
    ['AI 运维助手', '.ai-view'],
  ]) {
    await navigateWorkspace(page, name);
    await content().locator(selector).waitFor();
    assert.equal(await page.locator('.plugin-context:visible').count(), 0);
  }
  await navigateWorkspace(page, '网络诊断');
  await content().getByLabel('诊断目标', { exact: true }).fill('preserved.example');
  await navigateWorkspace(page, 'AI 运维助手');
  await navigateWorkspace(page, '网络诊断');
  assert.equal(
    await content().getByLabel('诊断目标', { exact: true }).inputValue(),
    'preserved.example',
  );
  passed.push(
    'remaining workspace tools render through standard contributions and preserve diagnostic drafts',
  );

  const server = createServer();
  let holding = false,
    model,
    host;
  server.on('request', async (req, res) => {
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const input = JSON.parse(raw),
        system = input.messages[0]?.content ?? '';
      if (raw.includes('qa-hold') && !system.includes('只负责从已登记资产')) {
        holding = true;
        return;
      }
      const content = system.includes('只负责从已登记资产')
        ? JSON.stringify({ hostIds: [], message: '' })
        : raw.includes('connection test')
          ? 'OK'
          : JSON.stringify({ answer: 'NATIVE_WASM_AI_OK', commands: [] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    } catch {
      res.writeHead(400);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const input = {
      id: null,
      expectedRevision: null,
      name: 'Owned native QA model',
      config: {
        provider: 'openai_compatible',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: 'qa',
        allowInsecureHttp: true,
        maxOutputTokens: 512,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
      },
      apiKey: randomUUID(),
      clearKey: false,
    };
    const tested = await invoke('ai_model_test', { input });
    input.testId = tested.id;
    model = (await invoke('ai_model_save', { input })).value;
    host = await invoke('host_create', {
      input: {
        name: 'Owned QA asset',
        hostname: '127.0.0.1',
        port: 22,
        username: 'qa',
        authType: 'agent',
        credentialId: null,
        groupId: null,
        tags: [],
        description: 'No SSH connection is opened',
        favorite: false,
        connectTimeoutSecs: 5,
      },
    });
    await page.evaluate(async () => {
      const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      await stores.get('hosts').load();
    });
    await navigateWorkspace(page, 'AI 运维助手');
    await content().locator('.ai-view').waitFor();
    await content().getByLabel('使用模型', { exact: true }).selectOption(model.id);
    const question = content().getByLabel('问题', { exact: true });
    await question.fill('Explain a basic TCP handshake');
    await content().getByRole('button', { name: '发送', exact: true }).click();
    await approveQuestion();
    await content().getByText('NATIVE_WASM_AI_OK', { exact: true }).waitFor();
    await question.fill('qa-hold');
    await content().getByRole('button', { name: '发送', exact: true }).click();
    await approveQuestion();
    await poll(async () => holding, Boolean);
    await content().getByRole('button', { name: '停止', exact: true }).click();
    await content().getByRole('button', { name: '发送', exact: true }).waitFor();
    await question.fill('Explain TCP again');
    await content().getByRole('button', { name: '发送', exact: true }).click();
    await approveQuestion();
    await content().getByText('NATIVE_WASM_AI_OK', { exact: true }).nth(1).waitFor();
    passed.push(
      'AI model HTTP answer travels through the actual WASM bridge; cancelling an in-flight answer allows another question',
    );
    await page.screenshot({ path: path.join(run, 'assistant.png') });
  } catch (error) {
    await page.screenshot({ path: path.join(run, 'assistant-failure.png') });
    await writeFile(
      path.join(run, 'assistant-failure.json'),
      JSON.stringify(
        {
          error: String(error),
          ui: await content()
            .locator('.ai-view')
            .innerText()
            .catch(() => 'frame unavailable'),
          hostPrompts: await page.locator('.plugin-prompt').allTextContents(),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await navigateWorkspace(page, '任务中心');
    if (model)
      await invoke('ai_model_delete', {
        input: { id: model.id, expectedRevision: model.revision, confirmed: true },
      });
    if (host) await invoke('host_delete', { id: host.id });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  // Real local TCP task; disabling the provider preserves accepted Host work.
  const tcp = createServer((_req, res) => res.end('owned QA'));
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  try {
    await navigateWorkspace(page, '网络诊断');
    await content().getByRole('tab', { name: 'TCP 端口', exact: true }).click();
    await content().getByLabel('诊断目标', { exact: true }).fill('127.0.0.1');
    await content().getByLabel('诊断端口', { exact: true }).fill(String(tcp.address().port));
    await content().getByLabel('诊断次数', { exact: true }).fill('100');
    await content().getByLabel('诊断超时', { exact: true }).fill('180');
    await content().getByRole('button', { name: '开始诊断', exact: true }).click();
    const tasks = await poll(
      () => invoke('diagnostic_list', { versions: {} }),
      (tasks) => tasks.some((t) => t.state === 'running'),
    );
    const task = tasks.find((t) => t.state === 'running');
    await setPluginEnabled(page, '系统服务', false);
    assert((await invoke('diagnostic_list', { versions: {} })).some((t) => t.id === task.id));
    await navigateWorkspace(page, '任务中心');
    const card = page
      .locator('[aria-label="网络诊断任务"] article')
      .filter({ hasText: '127.0.0.1' })
      .first();
    await card.getByRole('button', { name: '请求停止此任务', exact: true }).click();
    await page
      .getByRole('dialog', { name: '确认停止后台任务', exact: true })
      .getByRole('button', { name: '确认请求停止', exact: true })
      .click();
    await poll(
      () => invoke('diagnostic_list', { versions: {} }),
      (tasks) => tasks.some((t) => t.id === task.id && t.state === 'cancelled'),
    );
    await setPluginEnabled(page, '系统服务', true);
    passed.push(
      'real local TCP diagnostic survives plugin disable and can be stopped by the shared Task Center',
    );
  } finally {
    tcp.closeAllConnections();
    await new Promise((resolve) => tcp.close(resolve));
  }

  // An uploaded equivalent with an unrelated ID uses the same public tool contract.
  const packed = await networkFixture();
  packed.manifest.id = 'dev.qa.upload-network';
  packed.manifest.name = 'Uploaded Network QA';
  const source = path.join(run, 'uploaded-network.sdplugin');
  await writeFile(source, JSON.stringify(packed));
  const uploaded = await invoke('plugin_install', {
    input: { path: source, developmentConfirmed: true },
  });
  const id = uploaded.manifest.id;
  assert.equal(uploaded.source, 'user');
  assert.equal(uploaded.enabled, false);
  assert.equal(await invoke('plugin_permissions', { id }), null);
  await invoke('plugin_set_enabled', { id, enabled: true });
  const stageArgs = { id, input: { operation: 'diagnostic_list', args: {} } };
  await assert.rejects(() => invoke('plugin_tool_stage', stageArgs));
  await invoke('plugin_grant', {
    id,
    input: {
      expectedRevision: uploaded.revision,
      permissions: uploaded.manifest.permissions,
      operations: ['network.run', 'ui.contribute'],
      readRoots: [],
      writeRoots: [],
      confirmed: true,
    },
  });
  const ticket = await invoke('plugin_tool_stage', stageArgs);
  const reply = await invoke('plugin_call', {
    id,
    payload: {
      action: 'bridge',
      values: { request: JSON.stringify({ kind: 'tool_invoke', ...ticket }) },
    },
  });
  assert.equal(reply.error, null);
  await refresh();
  await page.locator('[data-module="plugins"]').click();
  await page
    .locator('[aria-label="运维工具导航"]')
    .getByRole('button', { name: 'Uploaded Network QA', exact: true })
    .click();
  await page.locator('.plugin-page:visible [aria-label="插件设置"]').waitFor();
  assert.equal(await page.locator('.plugin-frame-container:visible').count(), 0);
  const openUploaded = () =>
    page.evaluate(
      (id) =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
          .openPlugin(id, 'network', ''),
      id,
    );
  await openUploaded();
  await content().getByRole('tablist', { name: '诊断工具', exact: true }).waitFor();
  assert.equal(await page.locator('.plugin-workspace:visible .plugin-source').count(), 0);
  await page.getByRole('button', { name: '插件设置', exact: true }).click();
  assert((await page.locator('.plugin-page:visible > header').textContent()).includes('用户上传'));
  await openUploaded();
  await content().getByRole('tablist', { name: '诊断工具', exact: true }).waitFor();
  passed.push(
    'unrelated uploaded package ID renders and executes the same tool contract only after explicit grants',
  );
  for (const [width, height, theme] of [
    [1440, 960, 'dark'],
    [1440, 960, 'light'],
    [900, 600, 'dark'],
    [390, 844, 'light'],
  ]) {
    await page.setViewportSize({ width, height });
    const collapse = page.getByRole('button', { name: '收起主机栏', exact: true });
    if (width <= 720 && (await collapse.isVisible())) await collapse.click();
    await page.evaluate(() => {
      document.querySelector('.workspace-main')?.scrollTo(0, 0);
      document.querySelector('.workspace-content')?.scrollTo(0, 0);
    });
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.screenshot({ path: path.join(run, `tools-${theme}-${width}.png`), fullPage: true });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      'tool view must not overflow the viewport',
    );
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await navigateWorkspace(page, '任务中心');
  await invoke('plugin_uninstall', { input: { id, confirmed: true, clearData: true } });
  await refresh();
}
