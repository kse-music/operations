import { reloadHosts } from './ui-navigation.mjs';
// Real WebView2 IPC, local sockets, trusted Linux SSH and two isolated Linux SSH containers.
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, unlink, open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import net from 'node:net';
import { remotePython } from './native-ops-e2e.mjs';
import { navigateWorkspace, showHostTree } from './ui-navigation.mjs';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (s) => `'${s.replaceAll("'", "'\"'\"'")}'`;
export async function networkBatchChecks(context) {
  const { page, artifacts, hostId, passed, registerCleanup, command, contains } = context;
  page.setDefaultTimeout(30000);
  const rpc = (name, args = {}) =>
    page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), {
      name,
      args,
    });
  const nav = (name) => navigateWorkspace(page, name);
  async function until(check, seconds = 30) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const value = await check();
      if (value) return value;
      await delay(100);
    }
    throw new Error('condition did not complete before deadline');
  }
  async function hostShell() {
    const dialog = page.getByRole('dialog', { name: '确认批量运维操作', exact: true });
    if (await dialog.isVisible())
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await nav('SSH 终端');
    await page
      .getByRole('tablist', { name: '终端标签' })
      .getByRole('tab', { name: /Linux SSH verification/ })
      .first()
      .click();
  }
  const fixtureSource = await readFile(
    new URL('./network-batch-fixture.py', import.meta.url),
    'utf8',
  );
  let fixture = { uuid: randomUUID() },
    hostIds = [],
    credential,
    forwards = [];
  const key = path.join(artifacts, `isolated-batch-key-${randomUUID()}`);
  const localSource = path.join(artifacts, "分发 中文 ' ;$ .bin"),
    large = path.join(artifacts, 'cancel-owned.bin');
  async function fixtureCall(mode, extra = {}) {
    await hostShell();
    const data = Buffer.from(JSON.stringify({ ...fixture, ...extra })).toString('base64');
    const prefix = `mode=${JSON.stringify(mode)};import json,base64;data=json.loads(base64.b64decode('${data}'))\n`;
    const guarded =
      prefix +
      'try:\n' +
      fixtureSource
        .split('\n')
        .map((line) => ' ' + line)
        .join('\n') +
      "\nexcept Exception as e:\n print('__SD_OP'+'S_REF__'+base64.b64encode(json.dumps({'error':type(e).__name__+': '+str(e)}).encode()).decode()+'__SD_OP'+'S_END__')";
    const result = await remotePython(context, guarded);
    assert(!result.error, result.error);
    return result;
  }
  let cleaned = false;
  let fixtureAttempted = false;
  async function cleanup() {
    if (cleaned) return;
    for (const b of await rpc('batch_list'))
      if (!b.finished) await rpc('batch_cancel', { id: b.id, running: true });
    for (const t of await rpc('diagnostic_list'))
      if (['queued', 'running'].includes(t.state)) await rpc('diagnostic_cancel', { id: t.id });
    await until(
      async () =>
        !(await rpc('transfer_list')).some((t) =>
          ['queued', 'scanning', 'running', 'verifying', 'cancelling'].includes(t.state),
        ),
      40,
    );
    for (const id of hostIds) {
      await rpc('terminal_close_host', { hostId: id });
      await rpc('host_delete', { id });
    }
    hostIds = [];
    if (credential) {
      await rpc('credential_delete', { id: credential, detachHosts: true });
      credential = null;
      await rpc('credential_cleanup');
    }
    for (const f of forwards) await rpc('forward_stop', { id: f.id });
    forwards = [];
    const result = fixtureAttempted
      ? await fixtureCall('cleanup')
      : { cleaned: true, fixtureCreated: false };
    assert.equal(result.cleaned, true);
    await writeFile(
      path.join(artifacts, 'network-batch-cleanup.json'),
      JSON.stringify(result, null, 2),
    );
    for (const file of [key, key + '.pub', localSource, large])
      await unlink(file).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    cleaned = true;
  }
  registerCleanup(cleanup);
  // Exercise local UI and actual Windows tools before setting up remote targets.
  await nav('网络诊断');
  async function diagnostic(
    tool,
    target = '127.0.0.1',
    origin = 'local',
    port = 22,
    count = 1,
    seconds = 12,
  ) {
    await page
      .getByRole('tablist', { name: '诊断工具' })
      .getByRole('tab', { name: tool, exact: true })
      .click();
    await page.getByLabel('诊断来源', { exact: true }).selectOption(origin);
    if (origin === 'remote')
      await page.getByLabel('诊断主机', { exact: true }).selectOption(hostId);
    if (await page.getByLabel('诊断目标', { exact: true }).count())
      await page.getByLabel('诊断目标', { exact: true }).fill(target);
    if (await page.getByLabel('诊断端口', { exact: true }).count())
      await page.getByLabel('诊断端口', { exact: true }).fill(String(port));
    await page.getByLabel('诊断次数', { exact: true }).fill(String(count));
    await page.getByLabel('诊断超时', { exact: true }).fill(String(seconds));
    const before = new Set((await rpc('diagnostic_list')).map((t) => t.id));
    await page.getByRole('button', { name: '开始诊断', exact: true }).click();
    return until(async () => (await rpc('diagnostic_list')).find((t) => !before.has(t.id)));
  }
  const done = (id) =>
    until(async () => {
      const t = (await rpc('diagnostic_list')).find((t) => t.id === id);
      return t && !['queued', 'running'].includes(t.state) ? t : null;
    }, 25);
  const localServer = net.createServer((s) => s.end());
  await new Promise((r) => localServer.listen(0, '127.0.0.1', r));
  try {
    const t = await diagnostic('TCP 端口', '127.0.0.1', 'local', localServer.address().port);
    assert.equal((await done(t.id)).state, 'completed');
  } finally {
    await new Promise((r) => localServer.close(r));
  }
  for (const name of ['Ping', 'DNS 解析', 'Traceroute', '网络接口', '网络连接']) {
    const t = await diagnostic(name, name === 'DNS 解析' ? 'localhost' : '127.0.0.1');
    const result = await done(t.id);
    assert.equal(result.state, 'completed', `${name}: ${result.message}\n${result.output}`);
    assert(result.output.length > 0);
    if (name === 'Ping')
      assert(!result.output.includes('\ufffd'), 'Windows localized output must decode correctly');
  }
  const exportWait = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出诊断结果', exact: true }).click();
  const download = await exportWait;
  await download.saveAs(path.join(artifacts, 'network-export.json'));
  assert.equal(
    JSON.parse(await readFile(path.join(artifacts, 'network-export.json'), 'utf8')).input.origin
      .kind,
    'local',
  );
  passed(
    'native local Ping/DNS/TCP/Traceroute/interfaces/connections and source-labelled actual result export',
  );
  // Authenticated remote origin uses the existing strict-trust engine.
  await page.getByLabel('诊断来源', { exact: true }).selectOption('remote');
  await page.getByLabel('诊断主机', { exact: true }).selectOption(hostId);
  await page.getByRole('button', { name: '连接所选目标', exact: true }).click();
  const primary = await until(async () =>
    (await rpc('ops_connections')).find((s) => s.hostId === hostId),
  );
  const diagnostics = [];
  for (const name of [
    'Ping',
    'DNS 解析',
    'TCP 端口',
    'Traceroute',
    'MTR',
    '网络接口',
    '网络连接',
    'SSH 延迟',
  ]) {
    const t = await diagnostic(name, name === 'DNS 解析' ? 'localhost' : '127.0.0.1', 'remote', 22);
    const result = await done(t.id);
    diagnostics.push(result);
    assert.equal(result.input.origin.hostId, hostId);
    if (['Traceroute', 'MTR'].includes(name) && result.exitCode === 127) {
      assert.match(result.output, /not found|not installed/);
      continue;
    }
    assert.equal(result.state, 'completed', `${name}: ${result.message}\n${result.output}`);
    assert(result.output.length > 0);
  }
  await writeFile(
    path.join(artifacts, 'network-remote.json'),
    JSON.stringify(diagnostics, null, 2),
  );
  await page
    .getByLabel('诊断实时结果', { exact: true })
    .filter({ hasText: 'round-trip' })
    .waitFor();
  await page.getByLabel('诊断实时结果', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'network.png') });
  await page.evaluate(() =>
    document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
      .navigate('network', ''),
  );
  await page.waitForFunction(
    () => document.querySelector('[aria-label="诊断来源"]')?.value === 'local',
  );
  assert.equal(
    await page.getByLabel('诊断主机', { exact: true }).count(),
    0,
    'returning to a local workspace must not leave a hidden remote origin',
  );
  await page.evaluate(
    (hostId) =>
      document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
        .navigate('network', hostId),
    hostId,
  );
  passed(
    'native network workspace preserves explicit remote selection and clears origin when returning to local context',
  );
  const a = await diagnostic('Ping', '127.0.0.1', 'remote', 22, 100, 30);
  const b = await diagnostic('Ping', '127.0.0.1', 'remote', 22, 100, 30);
  await rpc('app_exit_confirm', { confirmed: false });
  const exitReview = page.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true });
  await exitReview.waitFor();
  assert((await exitReview.innerText()).includes('传输、诊断、批量或自动化任务'));
  await exitReview.getByRole('button', { name: '继续使用', exact: true }).click();
  await rpc('diagnostic_cancel', { id: a.id });
  assert.equal((await done(a.id)).state, 'uncertain');
  assert(
    ['queued', 'running'].includes((await rpc('diagnostic_list')).find((t) => t.id === b.id).state),
  );
  await rpc('diagnostic_cancel', { id: b.id });
  await done(b.id);
  passed(
    'native remote diagnostics, SSH exec latency, independent cancellation and unchanged shared SSH',
  );
  // Fresh public-key-only test endpoints, no real passwords are copied into containers.
  const keygen = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'OpenSSH',
    'ssh-keygen.exe',
  );
  const generated = spawnSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-f', key], {
    windowsHide: true,
    stdio: 'ignore',
  });
  assert.equal(generated.status, 0, 'test key generation');
  await writeFile(
    path.join(artifacts, 'network-batch-scope.json'),
    JSON.stringify(fixture, null, 2),
  );
  fixtureAttempted = true;
  fixture = await fixtureCall('create', { publicKey: await readFile(key + '.pub', 'utf8') });
  await writeFile(
    path.join(artifacts, 'network-batch-scope.json'),
    JSON.stringify(fixture, null, 2),
  );
  credential = (
    await rpc('credential_save', {
      id: null,
      expectedRevision: null,
      input: {
        name: 'Isolated batch key',
        kind: 'private_key',
        keyPath: key,
        secret: null,
        clearSecret: false,
      },
    })
  ).value.id;
  for (const [n, server] of fixture.servers.entries()) {
    const forward = await rpc('forward_start', {
      id: primary.id,
      input: {
        kind: 'local',
        bindAddress: '127.0.0.1',
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: server.port,
        confirmPublic: false,
      },
    });
    forwards.push(forward);
    const h = await rpc('host_create', {
      input: {
        name: `Isolated batch ${n}`,
        hostname: '127.0.0.1',
        port: forward.input.listenPort,
        username: 'root',
        authType: 'private_key',
        credentialId: credential,
        groupId: null,
        tags: [],
        description: 'UUID-owned Linux SSH container',
        favorite: false,
        connectTimeoutSecs: 8,
      },
    });
    hostIds.push(h.id);
  }
  await showHostTree(page);
  await reloadHosts(page);
  await nav('批量运维');
  for (let n = 0; n < 2; n++)
    await page.getByLabel(`选择批量目标 Isolated batch ${n}`, { exact: true }).check();
  await page.getByRole('button', { name: '连接所选目标', exact: true }).click();
  for (let n = 0; n < 2; n++) {
    const row = page.locator('.task-host').filter({ hasText: `Isolated batch ${n}` });
    await row.getByRole('button', { name: '已核对，信任此指纹', exact: true }).waitFor();
    assert(
      (await row.innerText()).includes(fixture.servers[n].fingerprint),
      'fingerprint must match key generated on trusted Linux',
    );
    await row.getByRole('button', { name: '已核对，信任此指纹', exact: true }).click();
  }
  await until(
    async () =>
      (await rpc('ops_connections')).filter((s) => hostIds.includes(s.hostId)).length === 2,
  );
  async function submit() {
    const before = new Set((await rpc('batch_list')).map((b) => b.id));
    await page.getByRole('button', { name: '预览全部目标与操作', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认批量运维操作', exact: true });
    for (const id of hostIds)
      assert((await dialog.innerText()).includes(id), 'all target IDs shown before execution');
    await dialog.getByLabel('批量执行确认文字', { exact: true }).fill(`执行 ${hostIds.length} 台`);
    await dialog.getByRole('button', { name: '确认执行批量操作', exact: true }).click();
    return until(async () => (await rpc('batch_list')).find((b) => !before.has(b.id)));
  }
  const batchDone = (id) =>
    until(async () => {
      const b = (await rpc('batch_list')).find((b) => b.id === id);
      return b?.finished ? b : null;
    }, 50);
  await page.getByLabel('批量并发数', { exact: true }).fill('2');
  await page
    .getByLabel('批量统一命令', { exact: true })
    .fill(
      `printf 'host=%s 中文\\n' "$(hostname)"; if [ "$(hostname)" = ${quote(fixture.servers[1].hostname)} ]; then printf 'isolated failure\\n' >&2; exit 7; fi`,
    );
  const partial = await batchDone((await submit()).id);
  assert.equal(partial.rows.length, 2);
  for (let n = 0; n < 2; n++) {
    const row = partial.rows.find((r) => r.hostId === hostIds[n]);
    assert(row.stdout.includes(fixture.servers[n].hostname));
    assert(!row.stdout.includes(fixture.servers[1 - n].hostname));
    assert.equal(row.exitCode, n === 1 ? 7 : 0);
  }
  await writeFile(path.join(artifacts, 'batch-partial.json'), JSON.stringify(partial, null, 2));
  for (let n = 0; n < 2; n++) {
    const row = page.locator(`[data-host-id="${hostIds[n]}"]`);
    await row
      .locator('h3')
      .filter({ hasText: n === 1 ? '失败' : '完成' })
      .waitFor();
    await row.locator('summary').click();
    assert((await row.locator('pre').first().innerText()).includes(fixture.servers[n].hostname));
  }
  const batchDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出批量结果', exact: true }).click();
  await (await batchDownload).saveAs(path.join(artifacts, 'batch-export.json'));
  const exported = JSON.parse(await readFile(path.join(artifacts, 'batch-export.json'), 'utf8'));
  assert.equal(exported.id, partial.id);
  assert.equal(exported.rows.find((r) => r.hostId === hostIds[1]).exitCode, 7);
  await page.locator(`[data-host-id="${hostIds[1]}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'batch.png') });
  passed(
    'native two independent Linux SSH containers: explicit preview, private-key trust, per-host stdout/stderr/exit code and partial failure',
  );
  // Timed-out process is deliberately not described as stopped. Queued target must never exec.
  await page.getByLabel('批量并发数', { exact: true }).fill('1');
  await page.getByLabel('批量超时', { exact: true }).fill('1');
  await page
    .getByLabel('批量统一命令', { exact: true })
    .fill("printf 'attempt\\n' >> /data/attempts; sleep 3; printf 'late\\n' >> /data/attempts");
  const waiting = await submit();
  await until(async () =>
    (await rpc('batch_list'))
      .find((b) => b.id === waiting.id)
      .rows.some((r) => r.state === 'running' && r.startedAt),
  );
  await page.getByRole('button', { name: '取消未执行目标', exact: true }).click();
  const timed = await batchDone(waiting.id);
  assert.equal(timed.rows.filter((r) => r.state === 'uncertain').length, 1);
  assert.equal(timed.rows.filter((r) => r.state === 'cancelled').length, 1);
  await writeFile(path.join(artifacts, 'batch-timeout.json'), JSON.stringify(timed, null, 2));
  await page.getByLabel('批量超时', { exact: true }).fill('20');
  await page
    .getByLabel('批量统一命令', { exact: true })
    .fill(
      "printf 'host=%s attempts=' \"$(hostname)\"; if [ -f /data/attempts ]; then cat /data/attempts; else printf 'none\\n'; fi; mkdir -p -- '/data/中文 目录'",
    );
  const attempts = await batchDone((await submit()).id);
  for (const r of attempts.rows) {
    const old = timed.rows.find((t) => t.hostId === r.hostId);
    assert.equal((r.stdout.match(/attempt\n/g) || []).length, old.state === 'uncertain' ? 1 : 0);
  }
  passed(
    'native timeout is uncertain, queued cancellation prevents execution, no implicit retry or mixed target output',
  );
  const bytes = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await writeFile(localSource, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  await page.getByLabel('批量任务类型', { exact: true }).selectOption('file');
  await page.getByRole('button', { name: '连接所选目标', exact: true }).click();
  await until(
    async () =>
      (await rpc('files_connections')).filter((s) => hostIds.includes(s.hostId)).length === 2,
  );
  await page.getByLabel('分发源文件', { exact: true }).fill(localSource);
  await page.getByLabel('分发目标目录', { exact: true }).fill('/data/中文 目录');
  await page.getByLabel('批量并发数', { exact: true }).fill('2');
  const files = await batchDone((await submit()).id);
  assert(
    files.rows.every(
      (r) => r.state === 'completed' && r.transfer.transferredBytes === bytes.length,
    ),
  );
  await page.getByLabel('批量任务类型', { exact: true }).selectOption('command');
  await page
    .getByLabel('批量统一命令', { exact: true })
    .fill(`sha256sum -- ${quote('/data/中文 目录/' + path.basename(localSource))}`);
  const hashes = await batchDone((await submit()).id);
  assert(hashes.rows.every((r) => r.state === 'completed' && r.stdout.includes(hash)));
  await writeFile(
    path.join(artifacts, 'batch-files.json'),
    JSON.stringify({ files, hash, verified: hashes.rows }, null, 2),
  );
  passed(
    'native bounded multi-host SFTP distribution, Unicode/special names and independent SHA-256 verification',
  );
  await page.getByLabel('批量任务类型', { exact: true }).selectOption('file');
  const conflicts = await batchDone((await submit()).id);
  assert(conflicts.rows.every((r) => r.state === 'failed'));
  await page.getByLabel('分发冲突策略', { exact: true }).selectOption('overwrite');
  await page.getByRole('checkbox', { name: '确认覆盖目标现有文件', exact: true }).check();
  const replaced = await batchDone((await submit()).id);
  assert(replaced.rows.every((r) => r.state === 'completed'));
  // A missing destination fails; explicit preparation followed by one-target retry must succeed.
  await page.getByLabel('分发冲突策略', { exact: true }).selectOption('fail');
  await page.getByLabel('分发目标目录', { exact: true }).fill('/data/retry-owned');
  const missing = await batchDone((await submit()).id);
  assert(missing.rows.every((r) => r.state === 'failed'));
  await page.getByLabel('批量任务类型', { exact: true }).selectOption('command');
  await page.getByLabel('批量统一命令', { exact: true }).fill('mkdir -p -- /data/retry-owned');
  assert((await batchDone((await submit()).id)).rows.every((r) => r.state === 'completed'));
  await page.getByLabel('批量任务类型', { exact: true }).selectOption('file');
  await page.locator(`[data-batch-id="${missing.id}"]`).click();
  await page
    .locator(`[data-host-id="${missing.rows[0].hostId}"]`)
    .getByRole('button', { name: '预览重试此文件目标', exact: true })
    .click();
  const retryDialog = page.getByRole('dialog', { name: '确认批量运维操作', exact: true });
  assert((await retryDialog.innerText()).includes(missing.rows[0].hostId));
  await retryDialog.getByLabel('批量执行确认文字', { exact: true }).fill('执行 1 台');
  const ids = new Set((await rpc('batch_list')).map((b) => b.id));
  await retryDialog.getByRole('button', { name: '确认执行批量操作', exact: true }).click();
  const retried = await until(async () => (await rpc('batch_list')).find((b) => !ids.has(b.id)));
  const retriedResult = await batchDone(retried.id);
  assert.equal(retriedResult.rows.length, 1);
  assert.equal(retriedResult.rows[0].hostId, missing.rows[0].hostId);
  assert.equal(retriedResult.rows[0].state, 'completed');
  assert.equal(retriedResult.rows[0].transfer.transferredBytes, bytes.length);
  await page.getByLabel('分发目标目录', { exact: true }).fill('/data/中文 目录');
  const file = await open(large, 'w');
  await file.truncate(64 * 1024 * 1024);
  await file.close();
  await page.getByLabel('分发源文件', { exact: true }).fill(large);
  await page.getByLabel('分发冲突策略', { exact: true }).selectOption('fail');
  await page.getByLabel('批量并发数', { exact: true }).fill('1');
  const cancel = await submit();
  await until(async () =>
    (await rpc('batch_list'))
      .find((b) => b.id === cancel.id)
      .rows.some((r) => r.transfer?.transferredBytes > 0),
  );
  await page.getByRole('button', { name: '请求停止全部目标', exact: true }).click();
  const cancelled = await batchDone(cancel.id);
  assert(cancelled.rows.some((r) => r.state === 'uncertain' || r.state === 'cancelled'));
  await until(
    async () =>
      !(await rpc('transfer_list')).some(
        (t) =>
          t.sources.includes(large) &&
          ['queued', 'scanning', 'running', 'verifying', 'cancelling'].includes(t.state),
      ),
    40,
  );
  await writeFile(
    path.join(artifacts, 'batch-cancel.json'),
    JSON.stringify(
      (await rpc('batch_list')).find((b) => b.id === cancel.id),
      null,
      2,
    ),
  );
  passed(
    'native file conflict refusal, explicit overwrite, isolated retry and in-flight/queued cancellation with SFTP cleanup',
  );
  await cleanup();
  await command("printf '\\n__SD_%s__\\n' NETWORK_BATCH_SURVIVES");
  await contains('__SD_NETWORK_BATCH_SURVIVES__');
  passed(
    'native task cleanup removes only owned containers/images/hosts/keys/forwards; original SSH shell survives',
  );
}
