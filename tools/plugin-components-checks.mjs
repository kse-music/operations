import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { openPluginFunction, showHostTree, selectHostWorkspace } from './ui-navigation.mjs';

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
  assert.equal(list.length, 3);
  const archive = await readdir(path.join(run, 'plugins/retired'));
  for (const name of ['batch', 'automation', 'resources', 'processes', 'logs', 'network']) {
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
  const exported = JSON.parse(await invoke('backup_export'));
  assert.equal(exported.version, 3);
  assert.equal(exported.entries, undefined);
  assert.equal(exported.commandGroups, undefined);
  passed.push(
    'upgrade retires both enabled tools without deleting settings; removed IPC/activation are denied and backup omits the command library',
  );
  for (const plugin of list) {
    assert.equal(plugin.manifest.version, '1.2.0');
    await page.locator('[data-module="plugins"]').click();
    await page
      .locator('[aria-label="运维工具导航"]')
      .getByRole('button', { name: plugin.manifest.name, exact: true })
      .click();
    await page.locator('.plugin-page:visible [aria-label="插件设置"]').waitFor();
    assert.equal(
      await page.getByRole('dialog', { name: '选择使用工具的主机', exact: true }).count(),
      0,
    );
    assert.equal(await page.locator('.plugin-frame-container:visible').count(), 0);
    assert.equal(
      await page.locator('.module-navigation [aria-current="page"]').innerText(),
      '运维工具',
    );
  }
  assert.equal(
    Object.values(await counts()).reduce((sum, value) => sum + value, 0),
    0,
  );
  assert.equal((await poll(runtimeStatuses, Boolean)).length, 0);
  passed.push(
    'all three Operations Tools entries open configuration without host selection, connection or business Wasm calls',
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
    await poll(
      runtimeStatuses,
      (statuses) => statuses?.filter((status) => status.state === 'active').length === 1,
    );
    assert.equal(await page.getByLabel('插件目标主机', { exact: true }).count(), 0);
    await noBusy();
    await dismissNotifications();
  };
  const parentApproval = async (expected) => {
    const dialog = page.getByRole('dialog').filter({ has: page.locator('.plugin-prompt') });
    await dialog.waitFor();
    assert((await dialog.innerText()).includes(expected), 'unexpected native approval target');
    const field = dialog.getByLabel('插件操作确认文字', { exact: true });
    if (await field.count())
      await field.fill((await dialog.locator('label code').innerText()).trim());
    await dialog.getByRole('button', { name: '明确确认', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
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
  await open('资源监控');
  await content().getByTestId('monitor-cpu').waitFor();
  assert(!/不可用/.test(await content().getByTestId('monitor-cpu').innerText()));
  await content().getByRole('tab', { name: '磁盘', exact: true }).click();
  await content().getByRole('tab', { name: '网络', exact: true }).click();
  await stable('cn.hiboot.plugins.services');
  passed.push('resources: real Linux SSH CPU sample, disk/network tabs and bounded polling');

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

  await open('进程与端口');
  const processFilter = content().getByLabel('运维项目搜索', { exact: true });
  await processFilter.fill(String(resources.sleepPid));
  const processRow = content()
    .getByRole('row')
    .filter({
      has: content().getByRole('cell', { name: String(resources.sleepPid), exact: true }),
    });
  await processRow.waitFor();
  await processRow.getByRole('button', { name: '进程详情 / 信号', exact: true }).click();
  const processDetails = content().getByRole('dialog', { name: '进程详情', exact: true });
  await processDetails.getByText(`PID ${resources.sleepPid}`, { exact: true }).waitFor();
  await processDetails.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await content().getByRole('tab', { name: '监听端口', exact: true }).click();
  await content().getByLabel('运维项目搜索', { exact: true }).fill(String(resources.tcpPort));
  await content()
    .getByRole('row')
    .filter({ hasText: String(resources.tcpPort) })
    .waitFor();
  await stable('cn.hiboot.plugins.services', 2);
  passed.push('processes: real owned PID details and listening TCP port, bounded list requests');

  await open('systemd 服务');
  await content().getByLabel('systemd 范围', { exact: true }).selectOption('user');
  await content().getByLabel('运维项目搜索', { exact: true }).fill(resources.unit);
  const serviceRow = content().getByRole('row').filter({ hasText: resources.unit });
  await serviceRow.waitFor();
  assert((await serviceRow.innerText()).includes('active'));
  await serviceRow.getByRole('button', { name: '详情', exact: true }).click();
  const serviceDetails = content().getByRole('dialog', { name: '服务详情', exact: true });
  await serviceDetails.getByText(resources.unit, { exact: false }).first().waitFor();
  await serviceDetails.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await cancelMutation(serviceRow, '停止', resources.unit);
  await stable('cn.hiboot.plugins.services', 2);
  passed.push(
    'systemd: real owned active user unit, details and cancelled mutation without changing other services',
  );

  await open('日志查看');
  await content().getByLabel('远程日志绝对路径', { exact: true }).fill(resources.log);
  await content().getByRole('button', { name: '打开日志文件', exact: true }).click();
  await content().locator('.ops-log-output').filter({ hasText: 'fixture initial 中文' }).waitFor();
  await content().getByRole('button', { name: '暂停日志', exact: true }).click();
  await content().getByRole('button', { name: '继续日志', exact: true }).waitFor();
  await content().getByRole('button', { name: '继续日志', exact: true }).click();
  await stable('cn.hiboot.plugins.services', 40);
  await content().getByRole('button', { name: '关闭日志标签', exact: true }).click();
  await content()
    .getByLabel('远程日志绝对路径', { exact: true })
    .fill(`${resources.root}/missing.log`);
  await content().getByRole('button', { name: '打开日志文件', exact: true }).click();
  await content().getByRole('status').filter({ hasText: 'failed' }).waitFor();
  await content().getByRole('button', { name: '关闭日志标签', exact: true }).click();
  passed.push('logs: real quoted Unicode path, output/pause/resume/close and missing-file failure');

  await open('资源监控', hosts[1]);
  await content().getByTestId('monitor-cpu').waitFor();
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

  await open('网络诊断');
  assert.equal(await content().getByLabel('诊断来源', { exact: true }).inputValue(), 'remote');
  assert.equal(await content().getByLabel('诊断主机', { exact: true }).count(), 0);
  await content().getByRole('tab', { name: 'TCP 端口', exact: true }).click();
  await content().getByLabel('诊断目标', { exact: true }).fill('127.0.0.1');
  await content().getByLabel('诊断端口', { exact: true }).fill(String(resources.tcpPort));
  await content().getByLabel('诊断次数', { exact: true }).fill('1');
  await content().getByRole('button', { name: '开始诊断', exact: true }).click();
  await poll(
    () => invoke('diagnostic_list', { versions: {} }),
    (rows) =>
      rows.some(
        (row) =>
          row.input.origin.kind === 'remote' &&
          row.input.origin.hostId === hosts[0].id &&
          row.input.port === resources.tcpPort &&
          row.state === 'completed',
      ),
  );
  await stable('cn.hiboot.plugins.services');
  passed.push(
    'network: terminal entry fixes the origin host and completes a real remote TCP probe',
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
        inputPricePerMillion: null,
        outputPricePerMillion: null,
      },
      apiKey: randomUUID(),
      clearKey: false,
    };
    input.testId = (await invoke('ai_model_test', { input })).id;
    model = (await invoke('ai_model_save', { input })).value;
    await open('AI 运维助手');
    await content().getByLabel('使用模型', { exact: true }).selectOption(model.id);
    await content().getByRole('button', { name: '管理模型', exact: true }).click();
    await page.getByRole('region', { name: '模型管理', exact: true }).waitFor();
    await open('AI 运维助手');
    assert.equal(await content().getByLabel('使用模型', { exact: true }).inputValue(), model.id);
    assert(
      (await content().locator('.ai-view').innerText()).includes(`当前主机：${hosts[0].name}`),
    );
    assert.equal(
      await content().getByRole('checkbox', { name: '跨主机分析', exact: true }).isChecked(),
      false,
    );
    await content().getByLabel('问题', { exact: true }).fill('COMPONENT_AI_CURRENT_HOST');
    await content().getByRole('button', { name: '发送', exact: true }).click();
    await parentApproval('COMPONENT_AI_CURRENT_HOST');
    await content().getByText('COMPONENT_AI_CURRENT_HOST_OK', { exact: true }).waitFor();
    await content().getByLabel('问题', { exact: true }).fill('COMPONENT_AI_FAILURE');
    await content().getByRole('button', { name: '发送', exact: true }).click();
    await parentApproval('COMPONENT_AI_FAILURE');
    await content().locator('.ai-chat-error').waitFor();
    await dismissNotifications();
    await content().getByLabel('问题', { exact: true }).fill('COMPONENT_AI_CURRENT_HOST_RETRY');
    await content().getByRole('button', { name: '发送', exact: true }).click();
    await parentApproval('COMPONENT_AI_CURRENT_HOST_RETRY');
    await content().getByText('COMPONENT_AI_CURRENT_HOST_OK', { exact: true }).nth(1).waitFor();
    await stable('cn.hiboot.plugins.assistant');
    passed.push(
      'assistant: current host fixed by terminal entry, real reviewed HTTP answer and HTTP 500 recovery',
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
  await open('网络诊断');
  await content().getByLabel('诊断目标', { exact: true }).fill('retained.example');
  await content().getByRole('tab', { name: '日志查看', exact: true }).click();
  await content().getByLabel('远程日志绝对路径', { exact: true }).fill(resources.log);
  await content().getByRole('button', { name: '打开日志文件', exact: true }).click();
  await content().locator('.ops-log-output').filter({ hasText: 'fixture initial 中文' }).waitFor();
  await content().getByRole('tab', { name: '网络诊断', exact: true }).click();
  assert.equal(
    await content().getByLabel('诊断目标', { exact: true }).inputValue(),
    'retained.example',
  );
  await content().getByRole('tab', { name: '日志查看', exact: true }).click();
  assert((await content().locator('.ops-log-output').innerText()).includes('fixture initial 中文'));
  assert.equal(await content().getByRole('button', { name: '继续日志', exact: true }).count(), 0);
  await content().getByRole('button', { name: '关闭日志标签', exact: true }).click();
  await open('systemd 服务');
  assert.equal(await content().getByLabel('systemd 范围', { exact: true }).inputValue(), 'user');
  assert.equal(
    await content().getByLabel('运维项目搜索', { exact: true }).inputValue(),
    resources.unit,
  );
  passed.push(
    'system panel navigation retains diagnostic, service and log drafts; leaving logs closes the stream and retains read output',
  );
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
      ['资源监控', 'system'],
      ['Docker 管理', 'docker'],
      ['AI 运维助手', 'assistant'],
    ]) {
      await open(name);
      if (label === 'system') {
        await content().getByRole('tab', { name: '资源概览', exact: true }).click();
        await poll(
          () =>
            content()
              .getByTestId('monitor-cpu')
              .textContent()
              .catch(() => ''),
          (value) => /[0-9]+(?:\.[0-9]+)?%/.test(value || ''),
        );
      }
      if (label === 'assistant') {
        assert.equal(
          await content().locator('.ai-chat-error').count(),
          0,
          'stale AI cancellation error after context replacement',
        );
        const toggle = content().getByRole('button', { name: /^上下文/ });
        if (width < 1000 && (await toggle.getAttribute('aria-expanded')) === 'true')
          await toggle.click();
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
    'three redesigned plugin workspaces fit dark/light desktop, compact and narrow layouts without horizontal body overflow; chat composer stays visible',
  );
  const statuses = await poll(runtimeStatuses, Boolean);
  assert.equal(statuses.length, 3);
  assert.equal(statuses.filter((status) => status.state === 'active').length, 1);
  passed.push(
    'all three runtimes visited with only one active guest; cached Docker draft and real refresh survive reactivation',
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
