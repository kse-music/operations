// Runs only inside the caller's verified, isolated native QA application.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { navigateWorkspace, bindAssistantModel } from './ui-navigation.mjs';

export async function checkWorkspaceTools({ page, invoke, run, passed }) {
  const content = () => page.frameLocator('.plugin-frame-container:visible iframe');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const poll = async (read, check) => {
    for (let i = 0; i < 100; i++) {
      const value = await read();
      if (check(value)) return value;
      await delay(100);
    }
    throw new Error('Timed out waiting for owned native operation');
  };
  assert.deepEqual(
    await page
      .locator('.sidebar-app-actions button')
      .evaluateAll((nodes) => nodes.map((n) => n.textContent.trim())),
    ['设置'],
  );
  await navigateWorkspace(page, 'AI 运维助手');
  await content().locator('.ai-view').waitFor();
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
        contextWindowTokens: 131072,
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
        description: 'No SSH connection is opened',
        favorite: false,
        connectTimeoutSecs: 5,
      },
    });
    await page.evaluate(async () => {
      const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      await stores.get('hosts').load();
    });
    await bindAssistantModel(page, model.id);
    await navigateWorkspace(page, 'AI 运维助手');
    await content().locator('.ai-view').waitFor();
    assert.equal(await content().locator('.ai-model-bar, select').count(), 0);
    const question = content().getByLabel('问题', { exact: true });
    await question.fill('Explain a basic TCP handshake');
    await content().getByRole('button', { name: '发送', exact: true }).click();
    await content().getByText('NATIVE_WASM_AI_OK', { exact: true }).waitFor();
    await question.fill('qa-hold');
    await content().getByRole('button', { name: '发送', exact: true }).click();
    await poll(async () => holding, Boolean);
    await content().getByRole('button', { name: '停止', exact: true }).click();
    await content().getByRole('button', { name: '发送', exact: true }).waitFor();
    await question.fill('Explain TCP again');
    await content().getByRole('button', { name: '发送', exact: true }).click();
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
    await navigateWorkspace(page, '插件管理');
    if (model)
      await invoke('ai_model_delete', {
        input: { id: model.id, expectedRevision: model.revision, confirmed: true },
      });
    if (host) await invoke('host_delete', { id: host.id });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  await navigateWorkspace(page, 'AI 运维助手');
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
}
