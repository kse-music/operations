// Real WebView2 -> iframe/WASM -> model HTTP fixture -> SSH -> isolated Docker daemon.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import {
  navigateWorkspace,
  openPluginFunction,
  openPluginSettings,
  showHostTree,
} from './ui-navigation.mjs';

const root = process.cwd();
const backgroundTest = process.argv.includes('--background');
const base = path.resolve(
  root,
  process.env.SERVERDECK_AGENT_OUTPUT ??
    (backgroundTest ? '.local/assistant-background-20261105' : '.local/assistant-agent-20261105'),
);
assert(
  base.startsWith(path.join(root, '.local') + path.sep),
  'Agent QA output must stay in .local',
);
const configPath = path.join(base, 'native-config.json');
const executable = path.join(base, 'AssistantAgentQa.exe');
await mkdir(base, { recursive: true });
if (process.argv.includes('--build')) {
  await writeFile(
    configPath,
    JSON.stringify({
      identifier: backgroundTest
        ? 'cn.hiboot.qa.assistantbackground'
        : 'cn.hiboot.qa.assistantagent',
      app: {
        appDirectoriesOverride: path.join(base, `native-data-${randomUUID()}`),
        windows: [
          {
            label: 'main',
            title: 'ServerDeck AI Agent QA',
            width: 1280,
            height: 820,
            minWidth: 900,
            minHeight: 600,
          },
        ],
      },
    }),
  );
  function build(args) {
    const result = spawnSync(
      process.execPath,
      ['tools/tauri.mjs', 'build', '--debug', '--no-bundle', ...args],
      { cwd: root, stdio: 'inherit', windowsHide: true },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0);
  }
  build(['--config', configPath]);
  await copyFile(path.join(root, 'target/debug/serverdeck-desktop.exe'), executable);
  build([]);
  await copyFile(
    path.join(root, 'target/debug/serverdeck-desktop.exe'),
    path.join(base, 'ServerDeck-preview.exe'),
  );
  process.exit(0);
}
const config = JSON.parse(await readFile(configPath, 'utf8'));
const expectedData = config.app.appDirectoriesOverride;
assert.equal(path.dirname(expectedData), base);
assert.match(path.basename(expectedData), /^native-data-[a-f0-9-]+$/);
const shell = (await readFile('tools/assistant-agent-test-host.sh', 'utf8')).replaceAll(
  '\r\n',
  '\n',
);
const runId = randomUUID();
const taskPassword = `${randomUUID()}SdA1!`;
function fixture(mode) {
  const result = spawnSync(
    'wsl.exe',
    [
      '--distribution',
      process.env.SERVERDECK_TEST_DISTRO ?? 'Ubuntu-24.04',
      '--user',
      'root',
      '--exec',
      'bash',
      '-c',
      shell,
      '--',
      mode,
      runId,
    ],
    {
      input: mode === 'start' ? `${taskPassword}\n` : '',
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Owned Docker fixture ${mode} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = createServer();
let hostId = '',
  modelCalls = 0;
let holdNext = false,
  held = false,
  heldCancelled = false,
  releaseHeld;
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await wait(50);
  }
  throw new Error('Owned background state timed out');
}
server.on('request', async (req, res) => {
  try {
    let raw = '';
    for await (const part of req) {
      raw += part;
      assert(raw.length < 128 * 1024);
    }
    const body = JSON.parse(raw);
    const system = body.messages[0].content;
    let content;
    if (raw.includes('ServerDeck connection test.')) content = 'OK';
    else if (system.includes('只负责从已登记资产'))
      content = JSON.stringify({ hostIds: [hostId], message: '' });
    else {
      assert(system.includes('运维智能体'));
      modelCalls++;
      if (holdNext) {
        holdNext = false;
        held = true;
        heldCancelled = false;
        res.on('close', () => {
          if (!res.writableFinished) heldCancelled = true;
        });
        await new Promise((resolve) => {
          releaseHeld = resolve;
        });
        held = false;
      }
      content = body.messages.some(
        (m) => m.role === 'user' && m.content.includes('untrustedToolResults'),
      )
        ? JSON.stringify({
            kind: 'plan',
            summary: '清理无标签 Docker 镜像。仅删除已查询的目标，不强制删除，完成后逐项复查。',
            actions: [{ kind: 'remove_untagged_images' }],
          })
        : JSON.stringify({ kind: 'query', requests: [{ kind: 'images' }] });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 30 },
      }),
    );
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const debugPort = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const port = s.address().port;
    s.close(() => resolve(port));
  });
});
let browser, page, child, credentialId, model, secondHostId;
let safe = false;
const passed = [];
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
try {
  const linux = JSON.parse(fixture('start'));
  await writeFile(path.join(base, 'native-fixture.json'), JSON.stringify(linux, null, 2));
  assert.equal(linux.images.filter((r) => r.Tag === '<none>').length, 2);
  assert.equal(linux.images.filter((r) => r.Tag !== '<none>').length, 1);
  child = spawn(executable, [], {
    cwd: base,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
      WEBVIEW2_USER_DATA_FOLDER: path.join(base, `webview-${runId}`),
    },
  });
  let websocket;
  for (let i = 0; i < 100 && !websocket; i++) {
    assert.equal(child.exitCode, null);
    try {
      websocket = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch {
      /* Wait for this owned process. */
    }
    if (!websocket) await wait(200);
  }
  assert(websocket);
  browser = await chromium.connectOverCDP(websocket);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(20000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  assert.equal(
    path.resolve((await invoke('app_bootstrap')).dataDirectory),
    path.resolve(expectedData),
  );
  assert.equal(
    (await invoke('host_list')).hosts.length,
    0,
    'Only a fresh isolated profile is allowed',
  );
  safe = true;
  credentialId = (
    await invoke('credential_save', {
      id: null,
      expectedRevision: null,
      input: {
        name: `agent-${runId}`,
        kind: 'password',
        keyPath: null,
        secret: taskPassword,
        clearSecret: false,
      },
    })
  ).value.id;
  hostId = (
    await invoke('host_create', {
      input: {
        name: 'Agent QA',
        hostname: '127.0.0.1',
        port: linux.port,
        username: 'plugin',
        authType: 'password',
        credentialId,
        groupId: null,
        tags: [],
        description: 'Owned SSH host with separate Docker daemon',
        favorite: false,
        connectTimeoutSecs: 10,
      },
    })
  ).id;
  const registration = {
    id: null,
    expectedRevision: null,
    name: 'Agent QA model',
    config: {
      provider: 'openai_compatible',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'agent-fixture',
      allowInsecureHttp: true,
      maxOutputTokens: 2048,
      contextWindowTokens: 131072,
    },
    apiKey: `agent-${runId}`,
    clearKey: false,
    testId: null,
  };
  registration.testId = (await invoke('ai_model_test', { input: registration })).id;
  model = (await invoke('ai_model_save', { input: registration })).value;
  const pluginId = 'cn.hiboot.plugins.assistant';
  await invoke('plugin_set_enabled', { id: pluginId, enabled: true });
  const saved = await invoke('plugin_capability', {
    id: pluginId,
    request: {
      apiVersion: 1,
      requestId: randomUUID(),
      operation: { kind: 'settings_write', value: { modelId: model.id } },
    },
  });
  assert.equal(saved.error, null);
  await page.reload();
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const fingerprint =
    'SHA256:' +
    createHash('sha256')
      .update(Buffer.from(linux.hostKey.split(/\s+/)[1], 'base64'))
      .digest('base64')
      .replace(/=+$/, '');
  if (backgroundTest) {
    await showHostTree(page);
    await page.locator(`.tree-host[data-host-id="${hostId}"]`).click();
    const trust = page.getByRole('dialog', { name: '确认 SSH 主机指纹', exact: true });
    await trust.waitFor();
    assert((await trust.innerText()).includes(fingerprint));
    await trust.getByRole('button', { name: '已核对，信任并连接', exact: true }).click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('terminals')
          .panes.some((pane) => pane.host?.id === id && pane.state === 'connected'),
      hostId,
    );
    await openPluginFunction(page, 'AI 运维助手', hostId);
  } else await navigateWorkspace(page, 'AI 运维助手');
  const frame = backgroundTest
    ? page.frameLocator(
        `.plugin-workspace[data-plugin-id="${pluginId}"][data-host-id="${hostId}"] iframe`,
      )
    : page.frameLocator('.plugin-frame-container:visible iframe');
  const question =
    '查询 Agent QA 的 Docker 镜像，生成删除 tag 为 <none> 镜像的计划，确认后执行并复查。';
  async function ask() {
    await frame.getByLabel('问题', { exact: true }).fill(question);
    await frame.getByRole('button', { name: '发送', exact: true }).click();
  }
  if (!backgroundTest) {
    await ask();
    const trust = frame.getByRole('button', { name: '已核对，信任此指纹', exact: true });
    await trust.waitFor();
    assert((await frame.locator('.ai-trust-review').innerText()).includes(fingerprint));
    await trust.click();
    const hostTrust = page.getByRole('dialog', { name: '核验 SSH 主机指纹', exact: true });
    await hostTrust.waitFor();
    assert((await hostTrust.innerText()).includes(fingerprint));
    await hostTrust.getByRole('button', { name: '明确确认', exact: true }).click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('operations').connections[id]
          ?.state === 'connected',
      hostId,
    );
  } else holdNext = true;
  await ask();
  if (backgroundTest) {
    await until(() => held);
    const version = await page.evaluate(
      (id) =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('plugins')
          .contextVersion(id),
      pluginId,
    );
    await openPluginSettings(page, 'AI 运维助手');
    assert(!heldCancelled, 'settings navigation must not cancel the model request');
    secondHostId = (
      await invoke('host_create', {
        input: {
          name: 'Agent QB',
          hostname: '127.0.0.1',
          port: linux.port,
          username: 'plugin',
          authType: 'password',
          credentialId,
          groupId: null,
          tags: [],
          description: 'Owned second workspace',
          favorite: false,
          connectTimeoutSecs: 10,
        },
      })
    ).id;
    await page.evaluate(async () =>
      document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('hosts')
        .load(),
    );
    await openPluginFunction(page, 'AI 运维助手', secondHostId);
    assert(!heldCancelled, 'another host assistant must not cancel the first host');
    await page.evaluate(
      async (id) =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
          .close(`host:${id}`),
      secondHostId,
    );
    assert(!heldCancelled, 'closing another host must not cancel this request');
    assert.equal(
      await page.evaluate(
        (id) =>
          document
            .querySelector('#app')
            .__vue_app__.config.globalProperties.$pinia._s.get('plugins')
            .contextVersion(id),
        pluginId,
      ),
      version,
    );
    releaseHeld();
    await frame.getByText('执行计划 · 2 项操作', { exact: true }).waitFor({ state: 'attached' });
    await openPluginFunction(page, 'AI 运维助手', hostId);
    assert.equal(await frame.getByText('已停止回答', { exact: true }).count(), 0);
    passed.push(
      'Host answer survives settings, another assistant workspace and closing that other workspace; returned plan remains valid',
    );
  }
  await frame.getByText('执行计划 · 2 项操作', { exact: true }).waitFor();
  assert.equal(fixture('inspect').split('\n').length, 3, 'No deletion during query or planning');
  passed.push(
    'Real model protocol queries images through SSH and freezes two exact targets without mutating',
  );
  await frame.getByRole('button', { name: '审核执行计划', exact: true }).click();
  const review = page.getByRole('dialog', { name: '确认 AI 运维计划', exact: true });
  await review.waitFor();
  for (const image of linux.images.filter((r) => r.Tag === '<none>'))
    assert((await review.innerText()).includes(image.ID));
  assert(await review.getByRole('button', { name: '明确确认', exact: true }).isDisabled());
  assert.equal(fixture('inspect').split('\n').length, 3, 'No deletion before native confirmation');
  await page.screenshot({ path: path.join(base, 'agent-plan-review.png') });
  await review
    .getByLabel('插件操作确认文字', { exact: true })
    .fill(await review.locator('label code').innerText());
  await review.getByRole('button', { name: '明确确认', exact: true }).click();
  await frame.getByText('计划已执行并完成复查', { exact: true }).waitFor();
  assert.equal(
    await frame
      .getByText('已执行并复查 · 操作完成，已通过 SSH 重新读取目标状态并确认预期结果', {
        exact: true,
      })
      .count(),
    2,
  );
  const remaining = fixture('inspect')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(remaining.length, 1);
  assert.notEqual(remaining[0].Tag, '<none>');
  assert.equal(
    modelCalls,
    2,
    'Execution output is checked locally, without automatic model transmission',
  );
  passed.push(
    'Native exact-target confirmation gates real Docker removal; both postconditions verified and tagged image retained',
  );
  await page.screenshot({ path: path.join(base, 'agent-result-dark.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.screenshot({ path: path.join(base, 'agent-result-light.png') });
  await frame.getByRole('button', { name: '新对话', exact: true }).click();
  await ask();
  await frame.getByText('查询完成，没有符合条件的目标，无需执行变更。', { exact: true }).waitFor();
  assert.equal(await frame.getByRole('button', { name: '审核执行计划', exact: true }).count(), 0);
  passed.push(
    'A fresh follow-up sees actual remaining images and correctly produces no destructive plan',
  );
  if (backgroundTest) {
    await frame.getByRole('button', { name: '新对话', exact: true }).click();
    holdNext = true;
    await ask();
    await until(() => held);
    const callsBeforeClose = modelCalls;
    await openPluginSettings(page, 'AI 运维助手');
    const versionBeforeClose = await page.evaluate(
      (id) =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('plugins')
          .contextVersion(id),
      pluginId,
    );
    await page.evaluate(
      async (id) =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
          .close(`host:${id}`),
      hostId,
    );
    await until(() => heldCancelled);
    releaseHeld();
    await wait(100);
    assert.equal(
      await page.evaluate(
        (id) =>
          document
            .querySelector('#app')
            .__vue_app__.config.globalProperties.$pinia._s.get('plugins')
            .contextVersion(id),
        pluginId,
      ),
      versionBeforeClose,
      'closing this host must not revoke the settings owner generation',
    );
    await page
      .frameLocator('.plugin-frame-container:visible iframe')
      .getByText('Agent QA model', { exact: true })
      .first()
      .waitFor();
    assert.equal(await page.locator(`.plugin-workspace[data-host-id="${hostId}"]`).count(), 0);
    assert.equal(
      modelCalls,
      callsBeforeClose,
      'closed host must not continue querying or generating a late plan',
    );
    passed.push(
      'Closing the owning host cancels the pending model request and removes its cached frame without late work',
    );
  }
  await writeFile(
    path.join(base, 'native-results.json'),
    JSON.stringify(
      { passed, modelCalls, retainedImages: remaining.map((r) => ({ id: r.ID, tag: r.Tag })) },
      null,
      2,
    ),
  );
  process.stdout.write(`PASS ${passed.length} real SSH/Docker/WebView2 scenarios.\n`);
} catch (error) {
  try {
    await writeFile(path.join(base, 'native-ssh.log'), fixture('logs'));
  } catch (diagnosticError) {
    process.stderr.write(`Owned SSH diagnostic unavailable: ${diagnosticError}\n`);
  }
  if (page)
    await writeFile(
      path.join(base, 'native-failure.txt'),
      (await page
        .locator('body')
        .innerText()
        .catch(() => 'main unavailable')) +
        '\n' +
        (await page
          .frameLocator('.plugin-frame-container:visible iframe')
          .locator('body')
          .innerText()
          .catch(() => 'frame unavailable')),
    );
  if (page) await page.screenshot({ path: path.join(base, 'native-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (safe && page && browser?.isConnected()) {
    try {
      if (model)
        await invoke('ai_model_delete', {
          input: { id: model.id, expectedRevision: model.revision, confirmed: true },
        });
      if (hostId) await invoke('host_delete', { id: hostId });
      if (secondHostId) await invoke('host_delete', { id: secondHostId });
      if (credentialId) await invoke('credential_delete', { id: credentialId, detachHosts: true });
      await invoke('credential_cleanup');
    } catch {
      process.stderr.write(
        'Owned QA credential cleanup incomplete; inspect the isolated profile.\n',
      );
    }
    await invoke('app_exit_confirm', { confirmed: true }).catch(() => {});
  }
  if (browser) await browser.close();
  if (child?.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(5000)]);
    if (child.exitCode === null) child.kill();
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fixture('stop');
}
