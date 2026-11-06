import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  openPluginFunction,
  bindAssistantModel,
  openPluginSettings,
  showHostTree,
  selectHostWorkspace,
} from './ui-navigation.mjs';

export async function checkPluginComponents({ page, invoke, run, passed, fixture }) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const poll = async (read, accept) => {
    for (let i = 0; i < 150; i++) {
      const value = await read();
      if (accept(value)) return value;
      await delay(150);
    }
    throw new Error('Owned plugin component operation did not complete');
  };
  const content = () => page.frameLocator('.plugin-frame-container:visible iframe');
  const counts = async () => {
    const result = {};
    for (const frame of page.frames()) {
      if (!frame.url().startsWith('http://sdplugin.localhost/')) continue;
      const id = new URL(frame.url()).pathname.split('/')[1];
      result[id] = (result[id] ?? 0) + (await frame.evaluate(() => window.__pluginRequests ?? 0));
    }
    return result;
  };
  const runtimeStatuses = async () => {
    // Return IPC errors as values: Playwright does not preserve fields on rejected plain objects.
    const result = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('plugin_statuses').then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    );
    if (result.error?.code === 'BUSY') return null;
    assert(!result.error, `Could not inspect runtime status: ${JSON.stringify(result.error)}`);
    return result.value;
  };
  await page.addInitScript(() => {
    window.__pluginRequests = 0;
    const original = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (data, ...args) {
      if (data?.kind === 'request') window.__pluginRequests++;
      return original.call(this, data, ...args);
    };
  });
  const noBusy = async () => {
    const messages = await page.evaluate(() =>
      document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('notifications')
        .items.map((item) => item.text),
    );
    assert(
      !messages.some((message) => message.includes('插件请求正忙')),
      messages.filter((message) => message.includes('插件请求正忙')).join('\n'),
    );
  };
  const dismissNotifications = async () => {
    await noBusy();
    for (
      let i = 0;
      i < 10 && (await page.getByRole('button', { name: '关闭通知', exact: true }).count());
      i++
    )
      await page.getByRole('button', { name: '关闭通知', exact: true }).first().click();
  };
  const stable = async (pluginId, limit = 8) => {
    const before = (await counts())[pluginId] ?? 0;
    await delay(2200);
    const after = (await counts())[pluginId] ?? 0;
    assert(
      after - before <= limit,
      `${pluginId}: request count kept growing (${after - before} in 2.2s)`,
    );
    await noBusy();
    await page.screenshot({
      path: path.join(run, `component-${pluginId.split('.').at(-1)}.png`),
      fullPage: true,
    });
  };
  const list = await invoke('plugin_list');
  assert.equal(list.length, 2);
  const archive = await readdir(path.join(run, 'plugins/retired'));
  for (const name of [
    'batch',
    'automation',
    'resources',
    'processes',
    'logs',
    'network',
    'services',
  ]) {
    const id = `cn.hiboot.plugins.${name}`;
    assert(archive.some((entry) => entry.startsWith(`${id}-removed-`)));
    assert.deepEqual(
      JSON.parse(await readFile(path.join(run, 'plugins/data', id, 'settings.json'), 'utf8')),
      { retained: 'owned upgrade fixture' },
    );
    await assert.rejects(() => invoke('plugin_activate', { id }));
    assert.equal(
      await page
        .getByRole('button', { name: name === 'batch' ? '批量运维' : '自动运维', exact: true })
        .count(),
      0,
    );
  }
  for (const command of ['batch_start', 'automation_status'])
    await assert.rejects(() => invoke(command, {}));
  passed.push(
    'upgrade retires both enabled tools without deleting settings; removed IPC/activation are denied',
  );
  const configurationRequests = {};
  for (const plugin of list) {
    const expectedPackage = JSON.parse(
      await readFile(
        `plugins/system/packages/${plugin.manifest.id.split('.').at(-1)}.sdplugin`,
        'utf8',
      ),
    );
    assert.equal(plugin.manifest.version, expectedPackage.manifest.version);
    await openPluginSettings(page, plugin.manifest.name);
    await page.locator('.plugin-page:visible [aria-label="插件设置"]').waitFor();
    assert.equal(
      await page.getByRole('dialog', { name: '选择使用工具的主机', exact: true }).count(),
      0,
    );
    const hasSettings = plugin.manifest.contributions.some((entry) => entry.kind === 'settings');
    if (hasSettings) await page.locator('.plugin-frame-container:visible').waitFor();
    assert.equal(
      await page.locator('.plugin-frame-container:visible').count(),
      hasSettings ? 1 : 0,
    );
    if (hasSettings) await content().getByRole('group', { name: '使用模型' }).waitFor();
    if (hasSettings) await poll(() => content().getByRole('radio').last().isEnabled(), Boolean);
    if (hasSettings) await poll(counts, (value) => (value[plugin.manifest.id] ?? 0) > 0);
    Object.assign(configurationRequests, await counts());
    const activeIds = (statuses) =>
      statuses?.filter((status) => status.state === 'active').map((status) => status.id);
    const expectedActive = hasSettings ? [plugin.manifest.id] : [];
    await poll(
      runtimeStatuses,
      (statuses) => JSON.stringify(activeIds(statuses)) === JSON.stringify(expectedActive),
    );
    assert.equal(
      await page.locator('.module-navigation [aria-current="page"]').innerText(),
      '设置',
    );
  }
  assert((configurationRequests['cn.hiboot.plugins.assistant'] ?? 0) > 0);
  assert((configurationRequests['cn.hiboot.plugins.assistant'] ?? 0) <= 4);
  assert.equal(configurationRequests['cn.hiboot.plugins.docker'] ?? 0, 0);
  passed.push(
    'both plugins open configuration under Settings without host selection or connections; only the assistant settings surface activates its own guest to read model binding',
  );

  const credential = (
    await invoke('credential_save', {
      id: null,
      expectedRevision: null,
      input: {
        name: `components-${fixture.uuid}`,
        kind: 'private_key',
        keyPath: fixture.keyPath,
        secret: null,
        clearSecret: false,
      },
    })
  ).value;
  const hosts = [];
  for (const name of [
    `Component Host A ${fixture.uuid.slice(0, 8)}`,
    `Component Host B ${fixture.uuid.slice(0, 8)}`,
  ])
    hosts.push(
      await invoke('host_create', {
        input: {
          name,
          hostname: fixture.host,
          port: fixture.port,
          username: fixture.username,
          authType: 'private_key',
          credentialId: credential.id,
          groupId: null,
          tags: [],
          description: 'Owned disposable plugin test endpoint',
          favorite: false,
          connectTimeoutSecs: 10,
        },
      }),
    );
  await page.evaluate(async () =>
    document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia._s.get('hosts')
      .load(),
  );
  const fingerprint =
    'SHA256:' +
    createHash('sha256')
      .update(Buffer.from(fixture.publicKey.split(/\s+/)[1], 'base64'))
      .digest('base64')
      .replace(/=+$/, '');
  await showHostTree(page);
  await page.locator(`.tree-host[data-host-id="${hosts[0].id}"]`).click();
  const trust = page.getByRole('dialog', { name: '确认 SSH 主机指纹', exact: true });
  await trust.waitFor();
  assert((await trust.innerText()).includes(fingerprint));
  await trust.getByRole('button', { name: '已核对，信任并连接', exact: true }).click();
  const terminal = await poll(
    () =>
      page.evaluate((id) => {
        const store = document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('terminals');
        return store.panes.find((pane) => pane.host?.id === id && pane.state === 'connected')
          ?.sessionId;
      }, hosts[0].id),
    Boolean,
  );
  const open = async (name, host = hosts[0]) => {
    await openPluginFunction(page, name, host.id);
    await content().locator('#app > *').waitFor();
    await poll(runtimeStatuses, (statuses) => {
      if (!statuses) return false;
      const active = statuses
        .filter((status) => status.state === 'active')
        .map((status) => status.id);
      const expected = list.find((plugin) => plugin.manifest.name === name)?.manifest.id;
      // The builtin assistant can remain active for its open workspace.
      return (
        active.includes(expected) &&
        active.length <= 2 &&
        new Set(active).size === active.length &&
        active.every((id) => list.some((plugin) => plugin.manifest.id === id))
      );
    });
    assert.equal(await page.getByLabel('插件目标主机', { exact: true }).count(), 0);
    await noBusy();
    await dismissNotifications();
  };
  const cancelMutation = async (row, button, target) => {
    if (!(await row.getByRole('button', { name: button, exact: true }).isVisible()))
      await row.locator('.row-action-menu summary').click();
    await row.getByRole('button', { name: button, exact: true }).click();
    const dialog = content().getByRole('dialog', { name: '确认主机运维操作', exact: true });
    await dialog.waitFor();
    assert((await dialog.innerText()).includes(target));
    assert(await dialog.getByRole('button', { name: '确认执行', exact: true }).isDisabled());
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  };
  const resources = fixture.resources;
  await open('Docker 管理');
  const dockerFilter = content().getByLabel('运维项目搜索', { exact: true });
  await dockerFilter.fill(`serverdeck-e2e-${fixture.uuid}`);
  const containerRow = content()
    .getByRole('row')
    .filter({ hasText: `serverdeck-e2e-${fixture.uuid}` });
  await containerRow.waitFor();
  await containerRow.getByRole('button', { name: '详情', exact: true }).click();
  const dockerDetails = content().getByRole('dialog', { name: '容器详情', exact: true });
  await dockerDetails
    .getByText(resources.container.slice(0, 12), { exact: false })
    .first()
    .waitFor();
  await dockerDetails.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await cancelMutation(containerRow, '停止', resources.container.slice(0, 12));
  await content().getByRole('button', { name: '刷新运维列表', exact: true }).click();
  await containerRow.waitFor();
  await stable('cn.hiboot.plugins.docker', 2);
  assert.equal(await dockerFilter.inputValue(), `serverdeck-e2e-${fixture.uuid}`);
  passed.push(
    'docker: real owned container list/details, cancelled stop, refresh and stable filter without request feedback',
  );

  await containerRow.getByRole('button', { name: '日志', exact: true }).click();
  await content()
    .getByTestId('operations-log-output')
    .filter({ hasText: `__SD_DOCKER_${fixture.uuid}__` })
    .waitFor();
  await content().getByRole('button', { name: '暂停日志', exact: true }).click();
  await content().getByRole('button', { name: '继续日志', exact: true }).waitFor();
  await content().getByRole('button', { name: '继续日志', exact: true }).click();
  await content().getByRole('button', { name: '关闭对话框', exact: true }).click();
  await containerRow.getByRole('button', { name: 'Shell', exact: true }).click();
  const shell = page.locator('.container-terminal-dialog .xterm-helper-textarea');
  await page.locator('.container-terminal-dialog .terminal-pane[data-state="connected"]').waitFor();
  assert(await shell.evaluate((element) => element === document.activeElement));
  await shell.pressSequentially('printf "__SD_COMPONENT_%s__" SHELL');
  await shell.press('Enter');
  await page
    .locator('.container-terminal-dialog .xterm-rows')
    .filter({ hasText: '__SD_COMPONENT_SHELL__' })
    .waitFor();
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  assert.equal(await page.locator('.container-terminal-dialog').count(), 0);
  passed.push(
    'docker: real journal-free container log pause/resume/close and independent container PTY with input focus',
  );

  await open('Docker 管理', hosts[1]);
  await open('Docker 管理', hosts[0]);
  assert.equal(
    await content().getByLabel('运维项目搜索', { exact: true }).inputValue(),
    `serverdeck-e2e-${fixture.uuid}`,
  );
  assert.equal(await page.locator(`.workspace-tab[data-host-id="${hosts[0].id}"]`).count(), 1);
  assert.equal(await page.locator(`.workspace-tab[data-host-id="${hosts[1].id}"]`).count(), 1);
  passed.push(
    'host switching: two real SSH host workspaces keep independent plugin frames and drafts',
  );

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const failure = body.includes('COMPONENT_AI_FAILURE');
    res.writeHead(failure ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(
      failure
        ? '{}'
        : JSON.stringify({
            choices: [
              {
                message: {
                  content: body.includes('connection test')
                    ? 'OK'
                    : JSON.stringify({ answer: 'COMPONENT_AI_CURRENT_HOST_OK', commands: [] }),
                },
                finish_reason: 'stop',
              },
            ],
          }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let model;
  try {
    const input = {
      id: null,
      expectedRevision: null,
      name: 'Owned component model',
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
    input.testId = (await invoke('ai_model_test', { input })).id;
    model = (await invoke('ai_model_save', { input })).value;
    await bindAssistantModel(page, model.id);
    await content().getByRole('button', { name: '管理模型', exact: true }).click();
    await page.getByRole('region', { name: '模型管理', exact: true }).waitFor();
    await open('AI 运维助手');
    assert.equal(
      await content().locator('.ai-model-bar, select, [aria-controls="assistant-context"]').count(),
      0,
    );
    await content()
      .getByLabel('问题', { exact: true })
      .fill('检查当前主机 COMPONENT_AI_CURRENT_HOST');
    await content().getByRole('button', { name: '发送', exact: true }).click();
    await content().getByText('COMPONENT_AI_CURRENT_HOST_OK', { exact: true }).waitFor();
    await content().getByLabel('问题', { exact: true }).fill('检查当前主机 COMPONENT_AI_FAILURE');
    await content().getByRole('button', { name: '发送', exact: true }).click();
    await content().locator('.ai-chat-error').waitFor();
    await dismissNotifications();
    await content()
      .getByLabel('问题', { exact: true })
      .fill('检查当前主机 COMPONENT_AI_CURRENT_HOST_RETRY');
    await content().getByRole('button', { name: '发送', exact: true }).click();
    await content().getByText('COMPONENT_AI_CURRENT_HOST_OK', { exact: true }).nth(1).waitFor();
    await stable('cn.hiboot.plugins.assistant');
    passed.push(
      'assistant: persisted plugin model binding, entry-host hint, direct HTTP answer and HTTP 500 recovery',
    );
  } finally {
    if (model)
      await invoke('ai_model_delete', {
        input: { id: model.id, expectedRevision: model.revision, confirmed: true },
      });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await open('Docker 管理');
  assert.equal(
    await content().getByLabel('运维项目搜索', { exact: true }).inputValue(),
    `serverdeck-e2e-${fixture.uuid}`,
  );
  await content().getByRole('button', { name: '刷新运维列表', exact: true }).click();
  await content()
    .getByRole('row')
    .filter({ hasText: `serverdeck-e2e-${fixture.uuid}` })
    .waitFor();
  for (const [width, height, theme] of [
    [1440, 960, 'dark'],
    [1440, 960, 'light'],
    [900, 650, 'dark'],
    [390, 844, 'light'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    const collapse = page.getByRole('button', { name: '收起主机栏', exact: true });
    if (width < 1000 && (await collapse.isVisible())) await collapse.click();
    for (const [name, label] of [
      ['Docker 管理', 'docker'],
      ['AI 运维助手', 'assistant'],
    ]) {
      await open(name);
      if (label === 'assistant') {
        assert.equal(
          await content().locator('.ai-chat-error').count(),
          0,
          'stale AI cancellation error after context replacement',
        );
        const composer = await content().locator('.ai-chat-composer').boundingBox();
        assert(
          composer && composer.height > 70 && composer.y + composer.height <= height + 2,
          'chat composer clipped',
        );
      }
      const overflow = await content()
        .locator('body')
        .evaluate((node) => {
          if (node.scrollWidth <= innerWidth + 1) return null;
          return {
            width: innerWidth,
            scroll: node.scrollWidth,
            elements: [...document.querySelectorAll('*')]
              .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
              .slice(0, 40)
              .map((element) => ({
                tag: element.tagName,
                classes: element.getAttribute('class'),
                right: element.getBoundingClientRect().right,
                width: element.getBoundingClientRect().width,
                grid: getComputedStyle(element).gridTemplateColumns,
                display: getComputedStyle(element).display,
              })),
          };
        });
      if (overflow)
        await writeFile(
          path.join(run, `overflow-${label}-${width}.json`),
          JSON.stringify(overflow, null, 2),
        );
      assert(!overflow, `${label} overflow at ${width}`);
      await page.screenshot({
        path: path.join(run, `redesign-${label}-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  passed.push(
    'both plugin workspaces fit dark/light desktop, compact and narrow layouts without horizontal body overflow; chat composer stays visible',
  );
  const statuses = await poll(runtimeStatuses, Boolean);
  assert.deepEqual(
    statuses.map((status) => status.id).sort(),
    list.map((plugin) => plugin.manifest.id).sort(),
  );
  const activeStatuses = statuses.filter((status) => status.state === 'active');
  assert(activeStatuses.length >= 1 && activeStatuses.length <= 2);
  passed.push(
    'both runtimes visited within the two installed guests; retained assistant workspace remains allowed; cached Docker draft and real refresh survive reactivation',
  );
  await selectHostWorkspace(page, hosts[0].id);
  await page
    .locator('.workspace-header')
    .getByRole('button', { name: 'SSH 终端', exact: true })
    .click();
  const marker = `SD_TERMINAL_RETAINED_${fixture.uuid}`;
  await invoke('terminal_input', {
    id: terminal,
    data: [...Buffer.from(`printf 'SD_TERMINAL_%s\\n' 'RETAINED_${fixture.uuid}'\r`)],
  });
  await page.locator('.xterm-screen').filter({ hasText: marker }).waitFor();
  await noBusy();
  const requestCounts = await counts();
  for (const plugin of list)
    assert(
      requestCounts[plugin.manifest.id] > 0,
      `request counter missing for ${plugin.manifest.id}`,
    );
  await writeFile(
    path.join(run, 'component-results.json'),
    JSON.stringify(
      {
        hosts: hosts.map((host) => host.id),
        counts: requestCounts,
        checked: list.map((plugin) => plugin.manifest.id),
        ssh: 'real owned WSL endpoint',
        normalTerminalRetained: true,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: path.join(run, 'components-terminal.png'), fullPage: true });
  passed.push(
    'all component switches retain the original real SSH shell and never hit the busy-request guard',
  );
}
