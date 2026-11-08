// Isolated real Windows WebView2/Rust/SQLite/OS-vault UI test; model replies are HTTP fixtures.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { navigateWorkspace, bindAssistantModel } from './ui-navigation.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(process.platform, 'win32');
const output = path.join(root, '.local', 'assistant-hosts', 'native', randomUUID());
await mkdir(output, { recursive: true });
const config = path.join(output, 'tauri-e2e.json');
await writeFile(
  config,
  JSON.stringify({
    identifier: 'cn.hiboot.desktop.ai-e2e',
    app: { appDirectoriesOverride: output },
  }),
);
function build(args) {
  const r = spawnSync(
    process.execPath,
    [path.join(root, 'tools', 'tauri.mjs'), 'build', '--debug', '--no-bundle', ...args],
    { cwd: root, windowsHide: true, stdio: 'inherit' },
  );
  if (r.error) throw r.error;
  assert.equal(r.status, 0, 'native build');
}
const executable = path.join(output, 'ServerDeckAiE2E.exe');
build(['--config', config]);
await copyFile(path.join(root, 'target', 'debug', 'serverdeck-desktop.exe'), executable);
build([]);
const key = `fixture-${randomUUID()}`;
const otherKey = `fixture-${randomUUID()}`;
const requestedModels = [];
const requestedHistories = [];
let testCalls = 0,
  routeCalls = 0,
  routeTargetId = '',
  unrelatedAttempts = 0,
  unrelatedServer;
const fixtureHostIds = [];
let calls = 0,
  mode = 'success',
  child,
  browser,
  page,
  safe = false;
const model = createServer(async (req, res) => {
  try {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    assert(['fixture-model', 'fixture-other'].includes(body.model));
    assert.equal(
      req.headers.authorization,
      `Bearer ${body.model === 'fixture-model' ? key : otherKey}`,
    );
    assert.equal(body.tools, undefined);
    assert.equal(body.store, false);
    const connectionTest = body.messages.length === 1;
    const payload = connectionTest ? null : JSON.parse(body.messages.at(-1).content);
    const hostRouting = payload && Object.hasOwn(payload, 'assets');
    if (connectionTest) {
      assert.equal(body.messages[0].content, 'ServerDeck connection test. Reply OK.');
      assert.equal(body.max_completion_tokens, 256);
      testCalls++;
    } else if (hostRouting) {
      routeCalls++;
      assert.equal(body.max_completion_tokens, 1024);
      assert(
        !text.includes('credentialId') && !text.includes('keyPath') && !text.includes('secretRef'),
      );
    } else {
      assert.deepEqual(payload.context, { associatedAssets: [] });
      requestedModels.push(body.model);
      requestedHistories.push(body.messages.slice(1, -1));
      calls++;
    }
    assert(!text.includes('must-not-transmit'));
    if (mode === 'failure') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"error":"fixture-unavailable"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(
                hostRouting
                  ? { hostIds: [routeTargetId], message: '' }
                  : {
                      answer:
                        '## 诊断结论\n\n**这是本机协议测试回答。** 当前未授权读取服务器数据，证据不足。\n\n- 先检查资源变化\n- 再核对进程与选定日志\n\n|项目|状态|\n|---|---|\n|服务器上下文|未授权|\n\n```sh\nuptime\n```\n\n<script>untrusted()</script>\n\n![tracking](https://track.example/pixel)\n\n[危险链接](javascript:untrusted())',
                      commands: ['uptime'],
                    },
              ),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 18 },
      }),
    );
  } catch {
    res.writeHead(500);
    res.end();
  }
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
const rpc = (name, args = {}) =>
  page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const debugPort = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
  child = spawn(executable, [], {
    cwd: output,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
      WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'),
    },
  });
  let websocket;
  for (let n = 0; n < 100; n++) {
    try {
      websocket = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch {}
    if (websocket) break;
    assert.equal(child.exitCode, null);
    await delay(200);
  }
  assert(websocket);
  browser = await chromium.connectOverCDP(websocket);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const bootstrap = await rpc('app_bootstrap');
  assert.equal(path.resolve(bootstrap.dataDirectory), output);
  safe = true;
  assert.equal((await rpc('ai_models')).length, 0, 'isolated empty model registry');
  await navigateWorkspace(page, '模型管理');
  await page.getByRole('region', { name: '模型管理', exact: true }).waitFor();
  async function register(name, modelId, secret) {
    await page.getByRole('button', { name: '注册模型', exact: true }).click();
    await page.getByLabel('模型名称', { exact: true }).fill(name);
    await page.getByLabel('Base URL（含服务要求的 /v1）', { exact: true }).fill(baseUrl);
    await page.getByLabel('模型 ID', { exact: true }).fill(modelId);
    await page.getByLabel('API Key（留空保留已有 Key）', { exact: true }).fill(secret);
    await page.getByLabel('明确允许 HTTP 明文传输（仅用于可信网络）', { exact: true }).check();
    assert.equal(
      await page.getByRole('button', { name: '保存模型', exact: true }).isDisabled(),
      true,
    );
    if (name === '模型 A') {
      mode = 'failure';
      await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await view.getByRole('alert').filter({ hasText: '模型服务返回错误' }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: '保存模型', exact: true }).isDisabled(),
        true,
      );
      assert.equal((await rpc('ai_models')).length, 0);
      mode = 'success';
    }
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: '保存模型', exact: true }).isDisabled(),
      false,
    );
    if (name === '模型 A') {
      await page.getByLabel('模型 ID', { exact: true }).fill('temporary-change');
      assert.equal(
        await page.getByRole('button', { name: '保存模型', exact: true }).isDisabled(),
        true,
      );
      await page.getByLabel('模型 ID', { exact: true }).fill(modelId);
      await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
    }
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('input[type=password]').count(), 0);
  }
  await register('模型 A', 'fixture-model', key);
  await register('模型 B', 'fixture-other', otherKey);
  const registered = await rpc('ai_models');
  assert.equal(registered.length, 2);
  const a = registered.find((m) => m.name === '模型 A'),
    b = registered.find((m) => m.name === '模型 B');
  assert(a.hasKey && b.hasKey);
  const modelScreenshots = [];
  for (const [name, width, height, theme] of [
    ['desktop-dark', 1440, 900, 'dark'],
    ['desktop-light', 1440, 900, 'light'],
    ['small-dark', 900, 600, 'dark'],
    ['small-light', 900, 600, 'light'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.screenshot({ path: path.join(output, `models-${name}.png`) });
    await page.getByRole('button', { name: '编辑模型 模型 A', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.screenshot({ path: path.join(output, `form-${name}.png`) });
    assert(
      await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
      'no horizontal form overflow',
    );
    await page.getByRole('dialog').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.screenshot({ path: path.join(output, `form-bottom-${name}.png`) });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    modelScreenshots.push(name);
  }
  await navigateWorkspace(page, 'AI 运维助手');
  const view = page
    .frameLocator('.plugin-frame-container:visible iframe')
    .getByRole('region', { name: 'AI 运维助手', exact: true });
  async function useBoundModel(id) {
    await bindAssistantModel(page, id);
    await navigateWorkspace(page, 'AI 运维助手');
    await view.waitFor();
  }
  await view.waitFor();
  assert.equal(await view.locator('input[type=password]').count(), 0);
  await useBoundModel(a.id);
  const assistantScreenshots = [];
  async function captureAssistant(state) {
    for (const [name, width, height, theme] of [
      ['desktop-dark', 1440, 900, 'dark'],
      ['desktop-light', 1440, 900, 'light'],
      ['small-dark', 900, 600, 'dark'],
      ['small-light', 900, 600, 'light'],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await view.evaluate((el) => {
        el.scrollTop = 0;
      });
      await view.locator('.ai-chat-messages').evaluate((el, state) => {
        el.scrollTop = state === 'answer' ? 0 : el.scrollHeight;
      }, state);
      await page.screenshot({ path: path.join(output, `${state}-${name}.png`) });
      assert(
        await view.evaluate((el) => el.scrollWidth <= el.clientWidth),
        'no horizontal assistant overflow',
      );
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        'no horizontal page overflow',
      );
      const chat = await view.getByRole('region', { name: '对话', exact: true }).boundingBox();
      assert.equal(
        await view.getByRole('complementary', { name: '服务器上下文', exact: true }).count(),
        0,
      );
      const workspace = await view.locator('.ai-workspace').boundingBox();
      assert(Math.abs(chat.width - workspace.width) < 2, 'chat fills the workspace');
      const action = await view.getByRole('button', { name: '发送', exact: true }).boundingBox();
      assert(action.y + action.height <= height - 28, 'send action fits in the first viewport');
      assistantScreenshots.push(`${state}-${name}`);
    }
  }
  await captureAssistant('empty');
  assert.equal(await page.getByLabel('当前服务器', { exact: true }).count(), 0);
  assert.equal(await view.locator('[aria-controls="assistant-context"]').count(), 0);
  assert.equal(await view.locator('input[type=checkbox], .ai-model-bar, select').count(), 0);
  assert.equal(await page.getByRole('button', { name: '批准发送', exact: true }).count(), 0);
  assert.equal(await page.getByRole('region', { name: '发送预览', exact: true }).count(), 0);
  assert.equal(calls, 0);
  await useBoundModel(b.id);
  await view.getByLabel('问题', { exact: true }).fill('协议测试，password=must-not-transmit');
  await view.getByRole('button', { name: '发送', exact: true }).click();
  await view.locator('.ai-markdown').waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'chat sends without a popup');
  assert.equal(calls, 1, 'one click makes one model call without a second approval');
  assert.equal(await view.locator('script,img,iframe').count(), 0);
  assert.match(await view.textContent(), /<script>untrusted\(\)<\/script>/);
  assert.equal(await view.locator('.ai-markdown h3').textContent(), '诊断结论');
  assert.equal(await view.locator('.ai-markdown table td').count(), 2);
  assert.equal(await view.locator('.ai-markdown pre code').textContent(), 'uptime');
  assert.equal(await view.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '审核此命令', exact: true }).count(), 0);
  await captureAssistant('answer');
  await view.getByLabel('问题', { exact: true }).fill('请继续解释刚才的建议');
  await view.getByLabel('问题', { exact: true }).press('Enter');
  await view.locator('.ai-markdown').nth(1).waitFor();
  assert.equal(calls, 2);
  assert.equal(requestedHistories[1].length, 2);
  assert.equal(requestedHistories[1][0].role, 'user');
  assert.equal(requestedHistories[1][1].role, 'assistant');
  assert(!JSON.stringify(requestedHistories[1]).includes('must-not-transmit'));
  await captureAssistant('followup');
  await useBoundModel(a.id);
  assert.equal(await view.locator('.ai-chat-turn').count(), 0);
  await view.getByLabel('问题', { exact: true }).fill('新模型测试');
  await view.getByRole('button', { name: '发送', exact: true }).click();
  await view.locator('.ai-markdown').waitFor();
  assert.equal(calls, 3);
  assert.equal(requestedHistories[2].length, 0, 'model switch clears prior conversation');
  assert.deepEqual(requestedModels, ['fixture-other', 'fixture-other', 'fixture-model']);
  const screenshots = assistantScreenshots;
  mode = 'failure';
  await view.getByLabel('问题', { exact: true }).fill('服务失败测试');
  await view.getByRole('button', { name: '发送', exact: true }).click();
  await view.getByRole('alert').filter({ hasText: '模型服务返回错误' }).waitFor();
  assert.equal(calls, 4);
  await captureAssistant('error');
  assert.equal((await rpc('host_list')).hosts.length, 0);
  assert((await rpc('files_local', { path: output })).entries.length > 0);
  assert.equal((await rpc('app_bootstrap')).databaseVersion, 9);
  // All SSH endpoints below are test-owned loopback fixtures; no user server is contacted.
  const unavailable = net.createServer();
  await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
  const closedPort = unavailable.address().port;
  unrelatedServer = net.createServer((socket) => {
    unrelatedAttempts++;
    socket.destroy();
  });
  await new Promise((resolve) => unrelatedServer.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => unavailable.close(resolve));
  async function fixtureHost(name, port) {
    const host = await rpc('host_create', {
      input: {
        name,
        hostname: '127.0.0.1',
        port,
        username: 'ops',
        authType: 'agent',
        credentialId: null,
        groupId: null,
        description: '',
        favorite: false,
        connectTimeoutSecs: 1,
      },
    });
    fixtureHostIds.push(host.id);
    return host;
  }
  const failedHost = await fixtureHost('自动匹配故障夹具', closedPort);
  await fixtureHost('自动匹配未命中夹具', unrelatedServer.address().port);
  mode = 'success';
  routeTargetId = failedHost.id;
  await view.getByLabel('问题', { exact: true }).fill('检查自动匹配故障夹具的状态');
  await view.getByRole('button', { name: '发送', exact: true }).click();
  await view.getByRole('alert').filter({ hasText: '命中主机「自动匹配故障夹具」' }).waitFor();
  assert.equal(calls, 4, 'connection failure prevents a diagnosis request');
  assert.equal(routeCalls, 0, 'explicit name resolves locally');
  assert.equal(unrelatedAttempts, 0, 'unmatched host is never connected');
  await view.getByLabel('问题', { exact: true }).fill('排查生产服务异常');
  await view.getByRole('button', { name: '发送', exact: true }).click();
  await view.locator('.ai-chat-error').nth(2).waitFor();
  assert.equal(routeCalls, 1, 'semantic fallback uses the real model protocol');
  assert.equal(calls, 4);
  assert.equal(unrelatedAttempts, 0);
  await captureAssistant('connection-error');
  const stale = await rpc('ai_prepare', {
    input: {
      modelId: a.id,
      sessionId: null,
      question: 'stale preview fixture',
      selection: {
        server: false,
        metrics: false,
        processes: false,
        docker: false,
        log: null,
        logLines: 100,
      },
      maskAddresses: true,
      redactValues: [],
    },
  });
  await navigateWorkspace(page, '模型管理');
  await page.getByRole('button', { name: '编辑模型 模型 A', exact: true }).click();
  assert.equal(
    await page.getByLabel('API Key（留空保留已有 Key）', { exact: true }).inputValue(),
    '',
  );
  await page.getByLabel('模型名称', { exact: true }).fill('模型 A 已编辑');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const staleCode = await page.evaluate(async (id) => {
    try {
      await window.__TAURI_INTERNALS__.invoke('ai_send', { id, confirmed: true });
      return null;
    } catch (error) {
      return error.code;
    }
  }, stale.id);
  assert.equal(staleCode, 'NOT_FOUND');
  assert.equal(calls, 4);
  await page.getByRole('button', { name: '删除模型 模型 B', exact: true }).click();
  await page.getByRole('dialog', { name: '确认删除模型', exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await rpc('ai_models')).length, 2);
  await page.getByRole('button', { name: '删除模型 模型 B', exact: true }).click();
  await page.getByRole('button', { name: '确认删除模型', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await rpc('ai_models')).length, 1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(output, 'models-list.png') });
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        screenshots,
        assistantLayout: true,
        directChat: true,
        automaticHostMatching: true,
        matchedHostFailure: true,
        unselectedHostUntouched: unrelatedAttempts === 0,
        hostRouteCalls: routeCalls,
        followupHistory: true,
        safeMarkdown: true,
        modelCalls: calls,
        modelTestCalls: testCalls,
        registrationTestGate: true,
        modelScreenshots,
        apiFailureIsolated: true,
        autoExecuted: false,
        secretReadback: false,
        modelCrud: true,
        currentModelRegistry: true,
        selectedModelRouting: true,
        stalePreviewRevoked: true,
      },
      null,
      2,
    ),
  );
  console.log(`Native AI UI checks passed: ${output}`);
} finally {
  if (safe && page) {
    for (const item of await rpc('ai_models')) {
      const removed = await rpc('ai_model_delete', {
        input: { id: item.id, expectedRevision: item.revision, confirmed: true },
      });
      assert.equal(removed.warnings.length, 0);
    }
    assert.equal((await rpc('ai_models')).length, 0);
    for (const id of fixtureHostIds) await rpc('host_delete', { id });
    await rpc('app_exit_confirm', { confirmed: true });
  }
  await browser?.close();
  if (child && child.exitCode === null)
    await Promise.race([new Promise((r) => child.once('exit', r)), delay(5000)]);
  if (unrelatedServer) await new Promise((resolve) => unrelatedServer.close(resolve));
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
}
