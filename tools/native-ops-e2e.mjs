import { terminalAction } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { resources } from './native-release-qa.mjs';
import { deflateSync } from 'node:zlib';
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
  // Fixture setup/cleanup uses the real bounded SSH execution API rather than terminal scrollback.
  // No secret read, external ssh process, local exec IPC or fake result is introduced.
  const job = await page.evaluate(
    async ({ hostId, command }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const host = (await invoke('host_list')).hosts.find((h) => h.id === hostId);
      if (!host) throw new Error('fixture host missing');
      const ops = pinia._s.get('operations');
      await ops.open(host);
      for (let n = 0; n < 100; n++) {
        const c = ops.connections[hostId];
        if (c?.state === 'connected' && c.session)
          return await invoke('batch_start', {
            input: {
              targets: [{ hostId, sessionId: c.session.id }],
              operation: { kind: 'command', command },
              concurrency: 1,
              timeoutSecs: 90,
              confirmed: true,
            },
          });
        if (['failed', 'awaiting_trust'].includes(c?.state))
          throw new Error('fixture needs an explicitly trusted authenticated connection');
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('fixture connection deadline');
    },
    { hostId, command },
  );
  let row;
  for (let n = 0; n < 1000; n++) {
    const value = await page.evaluate(
      (id) =>
        window.__TAURI_INTERNALS__
          .invoke('batch_list')
          .then((rows) => rows.find((r) => r.id === id)),
      job.id,
    );
    if (value?.finished) {
      row = value.rows[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
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
  const source = await readFile(new URL('./ops-fixture.py', import.meta.url), 'utf8');
  const nav = () => page.getByRole('navigation', { name: '当前主机工具', exact: true });
  async function hostShell() {
    const dialog = page.getByRole('dialog', { name: '确认主机运维操作', exact: true });
    if (await dialog.isVisible())
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
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
  await terminalAction(page, page.locator('.terminal-pane:visible'), '服务器管理');
  await page.getByRole('tab', { name: 'Docker 容器', exact: true }).click();
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
  const showOps = async () =>
    nav().getByRole('button', { name: '服务器管理', exact: true }).click();
  const switchTab = async (name) => {
    const detailDialog = page
      .getByRole('dialog')
      .filter({ has: page.getByTestId('operations-detail') });
    if (await detailDialog.count())
      await detailDialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await showOps();
    await page.getByRole('tab', { name, exact: true }).click();
    if (name !== '日志')
      await page.getByRole('button', { name: '刷新运维列表', exact: true }).waitFor();
    else await page.getByRole('button', { name: '打开日志文件', exact: true }).waitFor();
  };
  async function row(key) {
    const r = page.locator(`[data-ops-target="${key}"]`);
    await r.waitFor();
    return r;
  }
  async function confirm(target) {
    const dialog = page.getByRole('dialog', { name: '确认主机运维操作', exact: true });
    await dialog.getByLabel('确认运维目标').fill(String(target));
    await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  const capability = await query({ kind: 'capabilities' });
  assert.equal(capability.detail.dockerState, 'running');
  await writeFile(
    path.join(artifacts, 'ops-capabilities.json'),
    JSON.stringify(capability.detail, null, 2),
  );
  await page.getByRole('tab', { name: 'Docker 容器', exact: true }).click();
  await page.getByLabel('运维项目搜索').fill(fixture.uuid);
  await (await row(fixture.container)).getByRole('button', { name: '启动', exact: true }).click();
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
  const detail = page.getByTestId('operations-detail');
  await detail.filter({ hasText: 'SD_E2E_SECRET' }).waitFor();
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
  await page.getByRole('button', { name: '显示环境变量值…', exact: true }).click();
  await confirm(fixture.container);
  await detail.filter({ hasText: 'protect-' + fixture.uuid }).waitFor();
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await (await row(fixture.container)).getByRole('button', { name: '资源', exact: true }).click();
  await detail.filter({ hasText: 'CPUPerc' }).waitFor();
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  passed(
    'native Docker detection/version, container list/start, masked environment, explicit reveal, ports/mounts and stats',
  );
  await (await row(fixture.container)).getByRole('button', { name: '日志', exact: true }).click();
  const output = page.getByTestId('operations-log-output');
  await output.filter({ hasText: '__SD_DOCKER_' + fixture.uuid + '__' }).waitFor();
  assert(/\d{4}-\d\d-\d\dT/.test(await output.innerText()));
  await page.getByLabel('日志关键词').fill('__SD_STDERR_');
  assert(!(await output.innerText()).includes('__SD_DOCKER_'));
  await page.getByLabel('日志关键词').fill('');
  await page.getByRole('button', { name: '暂停日志', exact: true }).click();
  await page.locator('.ops-logs').getByRole('status').filter({ hasText: 'paused' }).waitFor();
  const frozen = await output.innerText();
  await delay(1200);
  assert.equal(await output.innerText(), frozen);
  await page.getByRole('button', { name: '继续日志', exact: true }).click();
  await page.locator('.ops-logs').getByRole('status').filter({ hasText: 'running' }).waitFor();
  await page.waitForFunction(
    (length) =>
      (document.querySelector('[data-testid="operations-log-output"]')?.textContent?.length ?? 0) >
      length,
    frozen.length,
  );
  if (process.argv.includes('--soak')) {
    const seconds = 300;
    const start = Date.now();
    const samples = [];
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '服务器管理', exact: true })
      .click();
    await page.getByRole('tab', { name: '资源概览', exact: true }).click();
    for (let n = 0; n < 100; n++) {
      const ready = await page.evaluate(async (hostId) => {
        try {
          return !!(
            await window.__TAURI_INTERNALS__.invoke('monitor_snapshot', { hostId, after: null })
          )?.sample;
        } catch {
          return false;
        }
      }, hostId);
      if (ready) break;
      await delay(100);
    }
    await nav().getByRole('button', { name: '服务器管理', exact: true }).click();
    await switchTab('Docker 容器');
    await page.getByLabel('运维项目搜索').fill(fixture.uuid);
    await (await row(fixture.container)).getByRole('button', { name: '日志', exact: true }).click();
    await output.filter({ hasText: '__SD_DOCKER_' + fixture.uuid + '__' }).waitFor();
    await page.evaluate(
      (hostId) => window.__TAURI_INTERNALS__.invoke('monitor_visible', { hostId, visible: true }),
      hostId,
    );
    let monitorId;
    for (let i = 0; i <= seconds / 10; i++) {
      const snapshot = await page.evaluate(
        (hostId) => window.__TAURI_INTERNALS__.invoke('monitor_snapshot', { hostId, after: null }),
        hostId,
      );
      assert(snapshot?.sample, 'soak must collect real Linux metrics');
      monitorId ??= snapshot.sessionId;
      assert.equal(snapshot.sessionId, monitorId, 'one host sampler');
      assert(snapshot.history.length <= 600);
      const chars = (await output.textContent()).length;
      assert(chars <= 1024 * 1024 + 8192, 'bounded Docker log buffer');
      samples.push({
        elapsedMs: Date.now() - start,
        revision: snapshot.revision,
        history: snapshot.history.length,
        logCharacters: chars,
      });
      if (i % 3 === 0) {
        console.log(`SOAK ${i * 10}/${seconds}s: real Monitor + Docker logs`);
        samples.at(-1).resources = resources(context.processId());
      }
      if (i < seconds / 10) await delay(10000);
    }
    assert(samples.at(-1).revision > samples[0].revision);
    assert(samples.at(-1).logCharacters > samples[0].logCharacters);
    await writeFile(
      path.join(artifacts, 'monitor-docker-soak.json'),
      JSON.stringify(
        {
          durationSeconds: (Date.now() - start) / 1000,
          samples,
          limitation: 'five-minute observation; not proof against 24-hour leaks',
        },
        null,
        2,
      ),
    );
    await page.evaluate(
      (hostId) => window.__TAURI_INTERNALS__.invoke('monitor_stop', { hostId }),
      hostId,
    );
    await nav().getByRole('button', { name: '服务器管理', exact: true }).click();
    passed(
      'five-minute simultaneous real Monitor/Docker logs, bounded histories and resource samples',
    );
  }
  await page.screenshot({ path: path.join(artifacts, 'ops-logs.png') });
  await page.getByRole('button', { name: '关闭日志标签', exact: true }).click();
  await switchTab('Docker 容器');
  await page.getByLabel('运维项目搜索').fill(fixture.uuid);
  await (await row(fixture.container)).getByRole('button', { name: 'Shell', exact: true }).click();
  await confirm(fixture.container);
  await page
    .locator('.terminal-pane:visible')
    .locator('.xterm-container[data-state="connected"]')
    .waitFor();
  await command(
    `test -f /.dockerenv && printf '\\n__SD_%s__%s__\\n' CONTAINER_REAL_SHELL "$(hostname)"`,
  );
  await contains('__SD_CONTAINER_REAL_SHELL__' + fixture.container.slice(0, 12) + '__');
  await command('exit');
  await page
    .locator('.terminal-pane:visible')
    .locator('.xterm-container[data-state="closed"]')
    .waitFor();
  await terminalAction(page, page.locator('.terminal-pane:visible'), '关闭终端');
  passed(
    'native bounded Docker log stream, timestamps/search/pause/resume/close and independent real container PTY shell',
  );
  await fixtureCall('schedule_append');
  await switchTab('日志');
  await page.getByLabel('远程日志绝对路径').fill(fixture.log);
  await page.getByRole('button', { name: '打开日志文件', exact: true }).click();
  await output.filter({ hasText: 'fixture initial 中文' }).waitFor();
  assert(!(await output.innerText()).includes('__SD_FILE_LIVE_'));
  await output.filter({ hasText: '__SD_FILE_LIVE_' + fixture.uuid + '__' }).waitFor();
  await fixtureCall('append');
  await showOps();
  await page.getByRole('tab', { name: '日志', exact: true }).click();
  // Leaving the workspace closes tabs; reopening reads the newly appended tail.
  await page.getByLabel('远程日志绝对路径').fill(fixture.log);
  await page.getByRole('button', { name: '打开日志文件', exact: true }).click();
  await output.filter({ hasText: '__SD_FILE_APPEND_' }).waitFor();
  await page.getByLabel('日志关键词').fill('__SD_FILE_APPEND_');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出可见日志', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(path.join(artifacts, 'visible-log.txt'));
  assert(
    (await readFile(path.join(artifacts, 'visible-log.txt'), 'utf8')).includes('__SD_FILE_APPEND_'),
  );
  await page.getByRole('button', { name: '关闭日志标签', exact: true }).click();
  await fixtureCall('deny_log');
  await showOps();
  await page.getByRole('tab', { name: '日志', exact: true }).click();
  await page.getByLabel('远程日志绝对路径').fill(fixture.log);
  await page.getByRole('button', { name: '打开日志文件', exact: true }).click();
  await page.locator('.ops-logs').getByRole('status').filter({ hasText: 'failed' }).waitFor();
  await page.getByRole('button', { name: '关闭日志标签', exact: true }).click();
  await fixtureCall('restore_log');
  const status = await fixtureCall('status');
  assert.deepEqual(
    status.streamProcesses,
    [],
    'closed log tabs must release actual remote log processes',
  );
  passed(
    'native Unicode/special-character file logs, tail refresh/filter/export and actual remote stream process release',
  );
  await switchTab('进程');
  await page.getByLabel('运维项目搜索').fill(String(fixture.sleepPid));
  await (
    await row(fixture.sleepPid)
  )
    .getByRole('button', { name: '进程详情 / 信号', exact: true })
    .click();
  await detail.filter({ hasText: 'startTicks' }).waitFor();
  const proc = await query({ kind: 'process_details', pid: fixture.sleepPid });
  assert.equal(proc.detail.startTicks, fixture.sleepStart);
  const stale = await query({
    kind: 'signal',
    pid: fixture.sleepPid,
    startTicks: String(BigInt(fixture.sleepStart) + 1n),
    bootId: proc.detail.bootId,
    signal: 'TERM',
    confirmed: true,
  });
  assert.equal(stale.success, false);
  await page.getByRole('button', { name: '发送信号…', exact: true }).click();
  await confirm(fixture.sleepPid);
  const after = await fixtureCall('status');
  assert(!after.sleepState || after.sleepState === 'Z');
  fixture = await fixtureCall('spawn_kill');
  const victim = await query({ kind: 'process_details', pid: fixture.killPid });
  const killed = await query({
    kind: 'signal',
    pid: fixture.killPid,
    startTicks: victim.detail.startTicks,
    bootId: victim.detail.bootId,
    signal: 'KILL',
    confirmed: true,
  });
  assert.equal(killed.success, true);
  const killStatus = await fixtureCall('status');
  assert(!killStatus.killState || killStatus.killState === 'Z');
  passed(
    'native process list/details, PID start-time mismatch refusal and confirmed pidfd TERM/KILL of only the fixture process',
  );
  await switchTab('监听端口');
  await page.getByLabel('运维项目搜索').fill(String(fixture.tcpPort));
  await page
    .locator('.ops-table')
    .getByText('127.0.0.1:' + fixture.tcpPort, { exact: true })
    .waitFor();
  const ports = await query({ kind: 'ports' });
  assert(
    ports.records.some((p) => p.protocol === 'udp' && p.local.endsWith(':' + fixture.udpPort)),
  );
  assert(
    ports.records.some(
      (p) => p.protocol === 'tcp' && String(p.process).includes('pid=' + fixture.portPid),
    ),
  );
  const remote = await query({
    kind: 'probe',
    location: 'remote',
    target: '127.0.0.1',
    port: fixture.tcpPort,
  });
  assert.equal(remote.detail.reachable, true);
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const local = await query({
      kind: 'probe',
      location: 'local',
      target: '127.0.0.1',
      port: server.address().port,
    });
    assert.equal(local.detail.reachable, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  passed('native TCP/UDP listeners and owning PID, remote and local TCP reachability');
  await switchTab('systemd 服务');
  await page.getByLabel('systemd 范围').selectOption('user');
  await page.getByLabel('运维项目搜索').fill(fixture.unit);
  let servicePid;
  for (const label of ['启动', '重启', '启用自启', '禁用自启']) {
    await (await row(fixture.unit)).getByRole('button', { name: label, exact: true }).click();
    await confirm(fixture.unit);
    const observed = await query({ kind: 'service_details', scope: 'user', unit: fixture.unit });
    if (label === '启动') {
      assert.equal(observed.detail.ActiveState, 'active');
      servicePid = observed.detail.MainPID;
    }
    if (label === '重启') {
      assert.equal(observed.detail.ActiveState, 'active');
      assert.notEqual(observed.detail.MainPID, servicePid);
    }
    if (label === '启用自启') assert.equal(observed.detail.UnitFileState, 'enabled');
    if (label === '禁用自启') assert.equal(observed.detail.UnitFileState, 'disabled');
  }
  await page.screenshot({ path: path.join(artifacts, 'ops-service.png') });
  const service = await query({ kind: 'service_details', scope: 'user', unit: fixture.unit });
  assert.equal(service.detail.ActiveState, 'active');
  assert.equal(service.detail.UnitFileState, 'disabled');
  await (await row(fixture.unit)).getByRole('button', { name: '服务日志', exact: true }).click();
  await output.filter({ hasText: '__SD_SERVICE_' + fixture.uuid + '__' }).waitFor();
  await page.getByRole('button', { name: '关闭日志标签', exact: true }).click();
  await switchTab('systemd 服务');
  await page.getByLabel('运维项目搜索').fill(fixture.unit);
  await (await row(fixture.unit)).getByRole('button', { name: '停止', exact: true }).click();
  await confirm(fixture.unit);
  passed(
    'native scoped systemd user-service start/restart/enable/disable/stop and journal shortcut',
  );
  await switchTab('Docker 容器');
  await page.getByLabel('运维项目搜索').fill(fixture.uuid);
  const beforeRestart = await query({
    kind: 'container_details',
    id: fixture.container,
    revealEnv: false,
    confirmed: false,
  });
  for (const label of ['重启', '停止', '删除']) {
    await (await row(fixture.container)).getByRole('button', { name: label, exact: true }).click();
    await confirm(fixture.container);
    if (label === '重启') {
      const changed = await query({
        kind: 'container_details',
        id: fixture.container,
        revealEnv: false,
        confirmed: false,
      });
      assert.notEqual(changed.detail.state.StartedAt, beforeRestart.detail.state.StartedAt);
      assert.equal(changed.detail.state.Running, true);
    }
    if (label === '停止') {
      const stopped = await query({ kind: 'containers' });
      assert.equal(stopped.records.find((r) => r.ID === fixture.container).State, 'exited');
    }
  }
  assert(!(await query({ kind: 'containers' })).records.some((r) => r.ID === fixture.container));
  await switchTab('镜像');
  await page.getByLabel('运维项目搜索').fill(fixture.uuid);
  await (await row(fixture.image)).getByRole('button', { name: '删除镜像', exact: true }).click();
  await confirm(fixture.image);
  assert(!(await query({ kind: 'images' })).records.some((r) => r.ID === fixture.image));
  await page.screenshot({ path: path.join(artifacts, 'operations.png') });
  await page.getByRole('button', { name: '断开运维连接', exact: true }).click();
  await hostShell();
  await command("printf '\\n__SD_%s__\\n' OPS_SURVIVED");
  await contains('__SD_OPS_SURVIVED__');
  const cleaned = await fixtureCall('cleanup');
  await writeFile(path.join(artifacts, 'ops-cleanup.json'), JSON.stringify(cleaned, null, 2));
  assert.equal(cleaned.cleaned, true, cleaned.error);
  registerCleanup(undefined);
  passed(
    'native confirmed container restart/stop/remove, isolated image removal and full fixture cleanup; original SSH shell survives',
  );
}
