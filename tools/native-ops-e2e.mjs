import { openPluginFunction } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resources } from './native-release-qa.mjs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
export async function remotePython({ page, hostId }, script) {
  assert(hostId, 'fixture execution needs an explicit host context');
  const nonce = randomUUID().replaceAll('-', '');
  script =
    "sd_nonce='" +
    nonce +
    "';\n" +
    script
      .replaceAll("'__SD_OP'+'S_REF__'", "'__SD_OP'+'S_REF_'+sd_nonce+'__'")
      .replaceAll("'__SD_OP'+'S_END__'", "'__SD_OP'+'S_END_'+sd_nonce+'__'");
  const encoded = deflateSync(Buffer.from(script)).toString('base64');
  const command = `python3 -c 'import base64,zlib;exec(zlib.decompress(base64.b64decode("${encoded}")))'`;
  // Use an owned, explicitly granted fixture with the retained bounded Execute capability.
  const id = `dev.qa.fixture-${nonce}`;
  const folder = fileURLToPath(new URL('../.local/fixture-exec/', import.meta.url));
  await mkdir(folder, { recursive: true });
  const fixture = JSON.parse(
    await readFile(
      new URL(
        '../tests/fixtures/plugins/server-capabilities/server-capabilities.sdplugin',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  fixture.manifest = {
    ...fixture.manifest,
    id,
    name: 'Owned SSH fixture',
    permissions: ['ssh.execute', 'ui.contribute'],
  };
  const source = path.join(folder, `${id}.sdplugin`);
  await writeFile(source, JSON.stringify(fixture), { flag: 'wx' });
  const row = await page.evaluate(
    async ({ id, source, hostId, command }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const bootstrap = await invoke('app_bootstrap');
      if (!bootstrap.dataDirectory.replaceAll('\\', '/').includes('/.local/'))
        throw new Error('Fixture requires an isolated QA profile');
      const plugin = await invoke('plugin_install', {
        input: { path: source, developmentConfirmed: true },
      });
      let value, failure;
      try {
        await invoke('plugin_grant', {
          id,
          input: {
            expectedRevision: plugin.revision,
            permissions: plugin.manifest.permissions,
            operations: ['ssh.execute', 'ui.contribute'],
            readRoots: [],
            writeRoots: [],
            confirmed: true,
          },
        });
        await invoke('plugin_set_enabled', { id, enabled: true });
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const ops = pinia._s.get('operations');
        const host = (await invoke('host_list')).hosts.find((h) => h.id === hostId);
        if (!host) throw new Error('Fixture host missing');
        await ops.open(host);
        let session;
        for (let n = 0; n < 100; n++) {
          const c = ops.connections[hostId];
          if (c?.state === 'connected' && c.session) {
            session = c.session.id;
            break;
          }
          if (['failed', 'awaiting_trust'].includes(c?.state))
            throw new Error('Fixture requires an explicitly trusted authenticated connection');
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!session) throw new Error('Fixture connection deadline');
        await invoke('plugin_context', {
          id,
          input: { hostId, opsSession: session, fileSession: null },
        });
        const operation = { kind: 'execute', command, timeoutSecs: 30 };
        const request = () =>
          invoke('plugin_capability', {
            id,
            request: { apiVersion: 1, requestId: crypto.randomUUID(), operation },
          });
        const pending = await request();
        const review = pending.result?.confirmationRequired;
        if (
          pending.error?.code !== 'PLUGIN_CONFIRMATION_REQUIRED' ||
          review?.pluginId !== id ||
          review.hostId !== hostId ||
          review.description !== command
        )
          throw new Error('Unexpected fixture approval');
        await invoke('plugin_approve', { id: review.id, confirmed: true });
        const reply = await request();
        if (reply.error) throw new Error(reply.error.message);
        if (reply.result.truncated)
          throw new Error('Fixture output exceeded the bounded capability');
        value = reply.result;
      } catch (error) {
        failure = error;
      }
      try {
        await invoke('plugin_uninstall', { input: { id, clearData: true, confirmed: true } });
      } catch (cleanup) {
        if (failure) throw new AggregateError([failure, cleanup], 'Fixture and cleanup failed');
        throw cleanup;
      }
      if (failure) throw failure;
      return value;
    },
    { id, source, hostId, command },
  );
  assert.equal(row?.state, 'completed', 'real SSH fixture execution must complete');
  assert.equal(row.exitCode, 0, 'real SSH fixture exit status');
  const text = row.stdout.replace(/\s/g, '');
  const matches = [
    ...text.matchAll(
      new RegExp('__SD_OPS_REF_' + nonce + '__([A-Za-z0-9+/=]+)__SD_OPS_END_' + nonce + '__', 'g'),
    ),
  ];
  assert(
    matches.length,
    'complete fixture result, never reconstructed from arbitrary Shell display text',
  );
  return JSON.parse(Buffer.from(matches.at(-1)[1], 'base64').toString());
}

export async function probeOps(context) {
  const value = await remotePython(
    context,
    String.raw`import os,json,subprocess,base64,shutil,signal
def run(args):
 try:
  p=subprocess.run(args,capture_output=True,text=True,timeout=8);return {'code':p.returncode,'out':p.stdout[:1500],'error':p.stderr[:250]}
 except Exception as e:return {'error':type(e).__name__}
uid=os.getuid();sock='/run/user/%s/docker.sock'%uid
if not os.path.exists(sock):sock='/var/run/docker.sock'
r={'uid':uid,'docker':shutil.which('docker'),'socket':sock,'version':run(['docker','--host','unix://'+sock,'version','--format','{{json .Server.Version}}']),'images':run(['docker','--host','unix://'+sock,'images','--format','{{.ID}} {{.Repository}}:{{.Tag}}']),'systemd':os.path.isdir('/run/systemd/system'),'userSystemd':run(['systemctl','--user','--no-pager','--no-ask-password','is-system-running']),'pidfd':hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal')}
print('__SD_OP'+'S_REF__'+base64.b64encode(json.dumps(r).encode()).decode()+'__SD_OP'+'S_END__')`,
  );
  await writeFile(
    path.join(context.artifacts, 'ops-capabilities.json'),
    JSON.stringify(value, null, 2),
  );
  context.passed('read-only Linux operations capability probe');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function operationsChecks(context) {
  const { page, artifacts, passed, hostId, command, contains, registerCleanup } = context;
  page.setDefaultTimeout(30000);
  const content = () => page.frameLocator('.plugin-frame-container:visible iframe');
  const source = await readFile(new URL('./ops-fixture.py', import.meta.url), 'utf8');
  const nav = () => page.getByRole('navigation', { name: '当前主机工具', exact: true });
  async function hostShell() {
    if (await page.locator('.plugin-frame-container:visible iframe').count()) {
      const dialog = content().getByRole('dialog', { name: '确认主机运维操作', exact: true });
      if (await dialog.isVisible())
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
    }
    await nav()
      .getByRole('button', { name: /SSH 终端/ })
      .click();
    await page
      .getByRole('tablist', { name: '终端标签' })
      .getByRole('tab', { name: /Linux SSH verification/ })
      .first()
      .click();
  }
  let fixture;
  async function fixtureCall(mode) {
    await hostShell();
    const raw = Buffer.from(JSON.stringify(fixture ?? {})).toString('base64');
    return remotePython(
      context,
      `mode=${JSON.stringify(mode)};data=json.loads(base64.b64decode('${raw}'))\n`.replace(
        'data=json',
        'import json,base64;data=json',
      ) + source,
    );
  }
  if (process.env.SERVERDECK_RECOVER_OPS_ARTIFACT) {
    assert.equal(
      path.resolve(process.env.SERVERDECK_RECOVER_OPS_ARTIFACT),
      artifacts,
      'recovery only uses this explicitly named isolated artifact',
    );
    fixture = JSON.parse(await readFile(path.join(artifacts, 'ops-scope.json'), 'utf8'));
    const recovered = await fixtureCall('cleanup');
    assert.equal(recovered.cleaned, true, recovered.error);
    await writeFile(
      path.join(artifacts, 'ops-recovery.json'),
      JSON.stringify({ uuid: fixture.uuid, ...recovered }, null, 2),
    );
  }
  fixture = { uuid: randomUUID() };
  registerCleanup(async () => {
    const result = await fixtureCall('cleanup');
    await writeFile(path.join(artifacts, 'ops-cleanup.json'), JSON.stringify(result, null, 2));
    assert.equal(result.cleaned, true, result.error);
  });
  const created = await fixtureCall('create');
  fixture = created.scope ?? created;
  await writeFile(path.join(artifacts, 'ops-scope.json'), JSON.stringify(fixture, null, 2));
  registerCleanup(async () => {
    const result = await fixtureCall('cleanup');
    await writeFile(path.join(artifacts, 'ops-cleanup.json'), JSON.stringify(result, null, 2));
    assert.equal(result.cleaned, true, result.error);
  });
  assert(!created.error, created.error);
  assert.equal(fixture.container.length, 64);
  await openPluginFunction(page, 'Docker 管理', hostId);
  await content().getByRole('tab', { name: 'Docker 容器', exact: true }).click();
  async function connections() {
    return page.evaluate(() => window.__TAURI_INTERNALS__.invoke('ops_connections'));
  }
  let session;
  for (let n = 0; n < 200; n++) {
    session = (await connections()).find((s) => s.hostId === hostId);
    if (session) break;
    await delay(100);
  }
  assert(session, 'operations must use a real SSH lease');
  const query = (request) =>
    page.evaluate(
      ({ id, request }) => window.__TAURI_INTERNALS__.invoke('ops_query', { id, request }),
      { id: session.id, request },
    );
  const showOps = async () => openPluginFunction(page, 'Docker 管理', hostId);
  const switchTab = async (name) => {
    const detailDialog = content()
      .getByRole('dialog')
      .filter({ has: content().getByTestId('operations-detail') });
    if (await detailDialog.count())
      await detailDialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await showOps();
    await content().getByRole('tab', { name, exact: true }).click();
    await content().getByRole('button', { name: '刷新运维列表', exact: true }).waitFor();
  };
  async function row(key) {
    const r = content().locator(`[data-ops-target="${key}"]`);
    await r.waitFor();
    return r;
  }
  async function action(target, label) {
    const targetRow = await row(target);
    await targetRow.getByRole('button', { name: label, exact: true }).click();
  }
  async function confirm(target) {
    const dialog = content().getByRole('dialog', { name: '确认主机运维操作', exact: true });
    await dialog.getByLabel('确认运维目标').fill(String(target));
    await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
    const approval = page.getByRole('dialog', { name: '插件操作需要单独确认', exact: true });
    await approval.waitFor();
    await approval.getByRole('button', { name: '明确确认', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  const capability = await query({ kind: 'capabilities' });
  assert.equal(capability.detail.dockerState, 'running');
  await writeFile(
    path.join(artifacts, 'ops-capabilities.json'),
    JSON.stringify(capability.detail, null, 2),
  );
  await content().getByRole('tab', { name: 'Docker 容器', exact: true }).click();
  await content().getByLabel('运维项目搜索').fill(fixture.uuid);
  await action(fixture.container, '启动');
  await confirm(fixture.container);
  const refused = await query({
    kind: 'container_action',
    id: fixture.container,
    action: 'remove',
    confirmed: true,
  });
  assert.equal(refused.success, false, 'running container removal must not silently force');
  let list = await query({ kind: 'containers' });
  assert.equal(list.records.find((r) => r.ID === fixture.container).State, 'running');
  await (await row(fixture.container)).getByRole('button', { name: '详情', exact: true }).click();
  const containerDetails = content().getByRole('dialog', { name: '容器详情', exact: true });
  const detail = containerDetails.getByRole('tabpanel');
  await detail.getByText('运行中', { exact: true }).waitFor();
  assert.equal(await detail.locator('pre').count(), 0);
  await containerDetails.getByRole('tab', { name: '端口映射', exact: true }).click();
  await detail.getByText('127.0.0.1', { exact: true }).first().waitFor();
  await containerDetails.getByRole('tab', { name: '挂载', exact: true }).click();
  await detail.getByText('绑定挂载', { exact: true }).first().waitFor();
  await containerDetails.getByRole('tab', { name: '资源使用', exact: true }).click();
  await containerDetails
    .getByRole('region', { name: '资源使用' })
    .getByText(/^\d+(\.\d+)?%$/)
    .first()
    .waitFor();
  assert(!(await detail.innerText()).includes('protect-' + fixture.uuid));
  await page.screenshot({ path: path.join(artifacts, 'ops-container.png') });
  const inspected = await query({
    kind: 'container_details',
    id: fixture.container,
    revealEnv: false,
    confirmed: false,
  });
  assert(!JSON.stringify(inspected).includes('protect-' + fixture.uuid));
  assert(inspected.detail.mounts.length);
  assert(inspected.detail.ports['8080/tcp'][0].HostIp === '127.0.0.1');
  await containerDetails.getByRole('tab', { name: '环境变量', exact: true }).click();
  await detail.filter({ hasText: 'protect-' + fixture.uuid }).waitFor();
  assert.equal(await content().getByLabel('确认运维目标').count(), 0);
  assert.equal(await page.getByRole('dialog', { name: '插件操作需要单独确认' }).count(), 0);
  await containerDetails.getByRole('tab', { name: '概览', exact: true }).click();
  assert(!(await containerDetails.innerText()).includes('protect-' + fixture.uuid));
  await content().getByRole('button', { name: '关闭对话框', exact: true }).click();
  passed(
    'native Docker detection/version, container list/start, structured detail tabs and direct scoped environment access',
  );
  await (await row(fixture.container)).getByRole('button', { name: '日志', exact: true }).click();
  const output = content().getByTestId('operations-log-output');
  await output.filter({ hasText: '__SD_DOCKER_' + fixture.uuid + '__' }).waitFor();
  assert(/\d{4}-\d\d-\d\dT/.test(await output.innerText()));
  await content().getByLabel('日志关键词').fill('__SD_STDERR_');
  assert(!(await output.innerText()).includes('__SD_DOCKER_'));
  await content().getByLabel('日志关键词').fill('');
  await content().getByRole('button', { name: '暂停日志', exact: true }).click();
  await content().getByRole('status').filter({ hasText: '已暂停' }).waitFor();
  const frozen = await output.innerText();
  await delay(1200);
  assert.equal(await output.innerText(), frozen);
  await content().getByRole('button', { name: '继续日志', exact: true }).click();
  await content().getByRole('status').filter({ hasText: '实时跟踪' }).waitFor();
  for (let i = 0; i < 100 && (await output.innerText()).length <= frozen.length; i++)
    await delay(100);
  assert((await output.innerText()).length > frozen.length);
  if (process.argv.includes('--soak')) {
    const samples = [];
    for (let i = 0; i <= 30; i++) {
      const characters = (await output.textContent()).length;
      assert(characters <= 1024 * 1024 + 8192, 'bounded Docker log buffer');
      samples.push({
        seconds: i * 10,
        logCharacters: characters,
        resources: resources(context.processId()),
      });
      if (i < 30) await delay(10000);
    }
    assert(samples.at(-1).logCharacters > samples[0].logCharacters);
    await writeFile(
      path.join(artifacts, 'docker-logs-soak.json'),
      JSON.stringify(samples, null, 2),
    );
    passed('five-minute real Docker log stream remains bounded');
  }
  await page.screenshot({ path: path.join(artifacts, 'ops-logs.png') });
  await content().getByRole('button', { name: '关闭对话框', exact: true }).click();
  await switchTab('Docker 容器');
  await content().getByLabel('运维项目搜索').fill(fixture.uuid);
  await (await row(fixture.container)).getByRole('button', { name: 'Shell', exact: true }).click();
  assert.equal(await content().getByLabel('确认运维目标').count(), 0);
  await page
    .locator('.container-terminal-dialog .terminal-pane')
    .locator('.xterm-container[data-state="connected"]')
    .waitFor();
  const shellInput = page.locator('.container-terminal-dialog .xterm-helper-textarea');
  await shellInput.pressSequentially('test -f /.dockerenv && hostname');
  await shellInput.press('Enter');
  await page
    .locator('.container-terminal-dialog .xterm-rows')
    .filter({ hasText: fixture.container.slice(0, 12) })
    .waitFor();
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  passed(
    'native bounded Docker log stream, timestamps/search/pause/resume/close and independent real container PTY shell',
  );
  assert.equal(await content().getByLabel('远程日志绝对路径').count(), 0);
  assert.equal(await content().getByRole('tab', { name: '日志', exact: true }).count(), 0);
  const status = await fixtureCall('status');
  assert.deepEqual(
    status.streamProcesses,
    [],
    'closed log dialogs must release actual remote log processes',
  );
  passed('standalone file-log UI is absent; closing container log dialogs releases remote streams');
  await switchTab('Docker 容器');
  await content().getByLabel('运维项目搜索').fill(fixture.uuid);
  await action(fixture.container, '停止');
  await confirm(fixture.container);
  const stopped = await query({ kind: 'containers' });
  assert.equal(stopped.records.find((r) => r.ID === fixture.container).State, 'exited');
  await action(fixture.container, '删除');
  await confirm(fixture.container);
  assert(!(await query({ kind: 'containers' })).records.some((r) => r.ID === fixture.container));
  await switchTab('镜像');
  await content().getByLabel('运维项目搜索').fill(fixture.uuid);
  await (await row(fixture.image)).getByRole('button', { name: '删除', exact: true }).click();
  const imageReview = page.getByRole('dialog', { name: '删除镜像？', exact: true });
  await imageReview.waitFor();
  assert.equal(await imageReview.locator('input').count(), 0);
  assert((await imageReview.innerText()).includes(fixture.image));
  await imageReview.getByRole('button', { name: '确认删除', exact: true }).click();
  await imageReview.waitFor({ state: 'hidden' });
  assert(!(await query({ kind: 'images' })).records.some((r) => r.ID === fixture.image));
  await page.screenshot({ path: path.join(artifacts, 'operations.png') });
  await page.evaluate((id) => window.__TAURI_INTERNALS__.invoke('ops_close', { id }), session.id);
  await hostShell();
  await command("printf '\\n__SD_%s__\\n' OPS_SURVIVED");
  await contains('__SD_OPS_SURVIVED__');
  const cleaned = await fixtureCall('cleanup');
  await writeFile(path.join(artifacts, 'ops-cleanup.json'), JSON.stringify(cleaned, null, 2));
  assert.equal(cleaned.cleaned, true, cleaned.error);
  registerCleanup(undefined);
  passed(
    'native confirmed container stop/remove, isolated image removal and full fixture cleanup; original SSH shell survives',
  );
}
