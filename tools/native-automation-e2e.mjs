// Actual native app, SQLite, SSH stdin script execution, two isolated Linux servers and wall-clock scheduling.
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { remotePython } from './native-ops-e2e.mjs';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export async function automationChecks(context) {
  let { page } = context;
  const { artifacts, hostId, passed, restart, registerCleanup } = context;
  page.setDefaultTimeout(30000);
  const rpc = (name, args = {}) =>
    page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), {
      name,
      args,
    });
  const nav = (name) =>
    page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', {
        name: name === 'SSH 终端' ? /^SSH 终端/ : name === '运维自动化' ? /^运维自动化/ : name,
        exact: !['SSH 终端', '运维自动化'].includes(name),
      })
      .click();
  async function until(fn, seconds = 40) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await delay(150);
    }
    throw new Error('automation check did not finish before deadline');
  }
  const key = path.join(artifacts, `automation-key-${randomUUID()}`),
    prefix = `Automation ${randomUUID().slice(0, 8)}`;
  let scope = { uuid: randomUUID(), entries: [], groups: [], hosts: [], credential: null },
    forwards = [],
    cleaned = false;
  const fixtureSource = await readFile(
    new URL('./network-batch-fixture.py', import.meta.url),
    'utf8',
  );
  const catalog = () => rpc('automation_catalog');
  async function remember() {
    await writeFile(path.join(artifacts, 'automation-scope.json'), JSON.stringify(scope, null, 2));
  }
  async function hostShell() {
    const dialogs = page.getByRole('dialog');
    if (await dialogs.count())
      await dialogs.first().getByRole('button', { name: '关闭对话框', exact: true }).click();
    await nav('SSH 终端');
    await page
      .getByRole('tablist', { name: '终端标签' })
      .getByRole('tab', { name: /Linux SSH verification/ })
      .first()
      .click();
    const pane = page.locator('.terminal-pane:visible');
    const connect = pane.getByRole('button', { name: '连接', exact: true });
    if (await connect.isVisible()) {
      await connect.click();
      await pane.getByRole('status').filter({ hasText: '已连接' }).waitFor();
    }
  }
  async function fixtureCall(mode, extra = {}) {
    await hostShell();
    context.page = page;
    const data = Buffer.from(JSON.stringify({ ...scope, ...extra })).toString('base64');
    const guarded =
      `mode=${JSON.stringify(mode)};import json,base64;data=json.loads(base64.b64decode('${data}'))\ntry:\n` +
      fixtureSource
        .split('\n')
        .map((line) => ' ' + line)
        .join('\n') +
      "\nexcept Exception as e:\n print('__SD_OP'+'S_REF__'+base64.b64encode(json.dumps({'error':type(e).__name__+': '+str(e)}).encode()).decode()+'__SD_OP'+'S_END__')";
    const value = await remotePython(context, guarded);
    assert(!value.error, value.error);
    return value;
  }
  const allHistory = () => rpc('automation_history', { query: {} });
  const done = (id) =>
    until(async () => {
      const r = await rpc('automation_run', { id });
      const h = (await allHistory()).find((h) => h.id === id);
      return ['Success', 'Failed', 'Cancelled', 'Unknown'].includes(r.state) &&
        r.finishedAt &&
        h?.finishedAt
        ? r
        : null;
    });
  async function cleanup() {
    if (cleaned) return;
    for (const p of (await catalog()).schedules)
      if (scope.entries.includes(p.spec.entry.id))
        await rpc('automation_schedule_disable', { id: p.id });
    for (const h of await allHistory()) {
      const r = await rpc('automation_run', { id: h.id });
      if (scope.entries.includes(r.spec.entry.id) && ['Pending', 'Running'].includes(r.state))
        await rpc('automation_cancel', { id: r.id, running: true });
    }
    await until(async () => {
      for (const h of await allHistory()) {
        const r = await rpc('automation_run', { id: h.id });
        if (scope.entries.includes(r.spec.entry.id) && ['Pending', 'Running'].includes(r.state))
          return false;
      }
      return true;
    });
    for (const h of await allHistory()) {
      const r = await rpc('automation_run', { id: h.id });
      if (scope.entries.includes(r.spec.entry.id))
        await until(async () => {
          try {
            await rpc('automation_run_delete', { id: r.id, confirmed: true });
            return true;
          } catch {
            return false;
          }
        }, 10);
    }
    for (const id of scope.entries)
      if ((await catalog()).entries.some((e) => e.id === id))
        await rpc('automation_entry_delete', { id, confirmed: true });
    scope.entries = [];
    for (const id of scope.groups)
      if ((await catalog()).groups.some((g) => g.id === id))
        await rpc('automation_group_delete', { id, confirmed: true });
    scope.groups = [];
    for (const id of scope.hosts) {
      await rpc('terminal_close_host', { hostId: id });
      if ((await rpc('host_list')).hosts.some((h) => h.id === id)) await rpc('host_delete', { id });
    }
    scope.hosts = [];
    if (scope.credential) {
      if ((await rpc('host_list')).credentials.some((c) => c.id === scope.credential))
        await rpc('credential_delete', { id: scope.credential, detachHosts: true });
      scope.credential = null;
      await rpc('credential_cleanup');
    }
    for (const f of forwards) await rpc('forward_stop', { id: f.id });
    forwards = [];
    const result = await fixtureCall('cleanup');
    assert.equal(result.cleaned, true);
    await writeFile(
      path.join(artifacts, 'automation-cleanup.json'),
      JSON.stringify(result, null, 2),
    );
    for (const file of [key, key + '.pub'])
      await unlink(file).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    cleaned = true;
  }
  registerCleanup(cleanup);
  if (process.argv.includes('--recover-automation')) {
    scope = JSON.parse(await readFile(path.join(artifacts, 'automation-scope.json'), 'utf8'));
    await cleanup();
    registerCleanup(undefined);
    passed('recovered only UUID-owned automation fixtures');
    return;
  }
  await remember();
  await nav('运维自动化');
  await page.getByRole('button', { name: '管理命令分组', exact: true }).click();
  const gd = page.getByRole('dialog', { name: '命令与脚本分组', exact: true });
  await gd.getByLabel('命令分组名称', { exact: true }).fill(prefix);
  await gd.getByRole('button', { name: '新增命令分组', exact: true }).click();
  await until(async () => {
    const c = await catalog();
    return c.groups.find((g) => g.name === prefix);
  });
  const group = (await catalog()).groups.find((g) => g.name === prefix);
  scope.groups.push(group.id);
  await remember();
  await gd.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '新建命令 / 脚本', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建命令 / 脚本', exact: true });
  await editor.getByLabel('自动化条目名称', { exact: true }).fill(prefix + ' System');
  await editor
    .getByLabel('自动化条目正文', { exact: true })
    .fill("printf '__SD_AUTOMATION_SYSTEM__\\n'; hostname; uname -s");
  await editor
    .getByLabel('自动化条目描述', { exact: true })
    .fill('Actual SSH task persisted to SQLite');
  await editor.getByLabel('条目分组', { exact: true }).selectOption(group.id);
  await editor.getByLabel('持久化任务输出', { exact: true }).check();
  await editor.getByRole('button', { name: '保存条目', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  let system = (await catalog()).entries.find((e) => e.name === prefix + ' System');
  scope.entries.push(system.id);
  await remember();
  let card = page.locator(`[data-entry-id="${system.id}"]`);
  await card.getByRole('button', { name: '收藏条目', exact: true }).click();
  await until(async () => (await catalog()).entries.find((e) => e.id === system.id).favorite);
  await page.getByLabel('搜索自动化条目', { exact: true }).fill(prefix + ' System');
  assert.equal(await page.locator('[data-entry-id]').count(), 1);
  await page.getByLabel('搜索自动化条目', { exact: true }).fill('');
  await card.getByRole('button', { name: '编辑条目', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑命令 / 脚本', exact: true });
  await edit.getByLabel('自动化条目描述', { exact: true }).fill('Edited persistent task');
  await edit.getByRole('button', { name: '保存条目', exact: true }).click();
  await edit.waitFor({ state: 'hidden' });
  system = (await catalog()).entries.find((e) => e.id === system.id);
  assert.equal(system.description, 'Edited persistent task');
  async function openRun(e, ids, values = {}, options = {}) {
    await nav('运维自动化');
    await page.getByRole('tab', { name: '命令与脚本库', exact: true }).click();
    await page.getByRole('button', { name: '刷新自动化数据', exact: true }).click();
    const card = page.locator(`[data-entry-id="${e.id}"]`);
    await card.getByRole('button', { name: '快捷执行', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '执行自动化任务', exact: true });
    for (const h of (await rpc('host_list')).hosts) {
      const box = dialog.getByLabel(`自动化目标 ${h.name}`, { exact: true });
      if (await box.count()) await box.setChecked(ids.includes(h.id));
    }
    for (const [k, v] of Object.entries(values))
      await dialog.getByLabel(`任务参数 ${k}`, { exact: true }).fill(v);
    if (options.timeout)
      await dialog.getByLabel('自动化超时', { exact: true }).fill(String(options.timeout));
    if (options.concurrency)
      await dialog.getByLabel('自动化并发', { exact: true }).fill(String(options.concurrency));
    return dialog;
  }
  async function executeDialog(dialog, e, ids) {
    await dialog.getByRole('button', { name: '预览自动化执行', exact: true }).click();
    await dialog.getByLabel('自动化执行确认文字', { exact: true }).waitFor();
    for (const id of ids)
      assert((await dialog.innerText()).includes(id), 'all targets must be shown');
    assert((await dialog.innerText()).includes(e.body));
    if (e.risk === 'dangerous')
      await dialog.getByLabel('确认危险自动化正文', { exact: true }).check();
    await dialog.getByLabel('自动化执行确认文字', { exact: true }).fill(`执行 ${ids.length} 台`);
    const before = new Set((await allHistory()).map((r) => r.id));
    await dialog.getByRole('button', { name: '确认执行自动化', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    return until(async () =>
      (await allHistory()).find((r) => !before.has(r.id) && r.entryName === e.name),
    );
  }
  let dialog = await openRun(system, [hostId]);
  await dialog.getByRole('button', { name: '连接所选目标', exact: true }).click();
  const primary = await until(async () =>
    (await rpc('ops_connections')).find((s) => s.hostId === hostId),
  );
  const first = await done((await executeDialog(dialog, system, [hostId])).id);
  assert.equal(first.state, 'Success');
  assert(first.rows[0].stdout.includes('__SD_AUTOMATION_SYSTEM__'));
  passed(
    'native command library CRUD/group/favorite/search, current-host context and persisted real single-host execution',
  );
  const keygen = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'OpenSSH',
    'ssh-keygen.exe',
  );
  assert.equal(
    spawnSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-f', key], {
      windowsHide: true,
      stdio: 'ignore',
    }).status,
    0,
  );
  const fixture = await fixtureCall('create', {
    publicKey: await readFile(key + '.pub', 'utf8'),
    python: true,
  });
  scope.servers = fixture.servers;
  await remember();
  scope.credential = (
    await rpc('credential_save', {
      id: null,
      expectedRevision: null,
      input: {
        name: prefix + ' key',
        kind: 'private_key',
        keyPath: key,
        secret: null,
        clearSecret: false,
      },
    })
  ).value.id;
  await remember();
  for (const [n, server] of fixture.servers.entries()) {
    const f = await rpc('forward_start', {
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
    forwards.push(f);
    const h = await rpc('host_create', {
      input: {
        name: prefix + ` Linux ${n}`,
        hostname: '127.0.0.1',
        port: f.input.listenPort,
        username: 'root',
        authType: 'private_key',
        credentialId: scope.credential,
        groupId: null,
        tags: [],
        description: 'Owned automation Linux SSH fixture',
        favorite: false,
        connectTimeoutSecs: 8,
      },
    });
    scope.hosts.push(h.id);
    await remember();
  }
  await nav('主机管理');
  await page.getByRole('button', { name: '刷新', exact: true }).first().click();
  const make = async (name, body, parameters = [], risk = 'normal') => {
    const e = await rpc('automation_entry_save', {
      id: null,
      revision: null,
      input: {
        kind: parameters.length ? 'script' : 'command',
        name: prefix + ' ' + name,
        body,
        description: 'Owned native automation validation',
        groupId: group.id,
        favorite: false,
        risk,
        parameters,
        timeoutSecs: 20,
        concurrency: 2,
        retainOutput: true,
      },
    });
    scope.entries.push(e.id);
    await remember();
    return e;
  };
  const params = [
    {
      name: 'text',
      label: 'Literal text',
      kind: 'text',
      required: true,
      secret: false,
      default: null,
    },
    {
      name: 'number',
      label: 'Number',
      kind: 'integer',
      required: true,
      secret: false,
      default: '7',
    },
  ];
  const argsEntry = await make(
    'Args',
    `printf 'host=%s\\n' "$(hostname)"; printf '%s\\n' "$1"; printf '%s\\n' "$2"`,
    params,
  );
  const literal = '中文 space; $(touch /data/serverdeck-parameter-must-not-execute) \' "';
  dialog = await openRun(argsEntry, scope.hosts, { text: literal, number: '7' });
  await dialog.getByRole('button', { name: '连接所选目标', exact: true }).click();
  for (let n = 0; n < 2; n++) {
    const row = dialog.locator('.task-host').filter({ hasText: prefix + ` Linux ${n}` });
    await row.getByRole('button', { name: '已核对，信任此指纹', exact: true }).waitFor();
    assert((await row.innerText()).includes(fixture.servers[n].fingerprint));
    await row.getByRole('button', { name: '已核对，信任此指纹', exact: true }).click();
  }
  await until(
    async () =>
      (await rpc('ops_connections')).filter((s) => scope.hosts.includes(s.hostId)).length === 2,
  );
  const argsRun = await done((await executeDialog(dialog, argsEntry, scope.hosts)).id);
  assert.equal(argsRun.state, 'Success');
  for (let n = 0; n < 2; n++) {
    const row = argsRun.rows.find((r) => r.hostId === scope.hosts[n]);
    assert(row.stdout.includes(fixture.servers[n].hostname));
    assert(row.stdout.includes(literal));
  }
  await writeFile(
    path.join(artifacts, 'automation-parameters.json'),
    JSON.stringify(argsRun, null, 2),
  );
  passed(
    'native two independent Linux servers execute stdin-separated literal positional parameters, including Unicode and Shell metacharacters',
  );
  const partialEntry = await make(
    'Partial',
    `printf 'host=%s\\n' "$(hostname)"; if [ "$(hostname)" = '${fixture.servers[1].hostname}' ]; then printf 'owned failure\\n' >&2; exit 7; fi; test ! -e /data/serverdeck-parameter-must-not-execute`,
  );
  dialog = await openRun(partialEntry, scope.hosts);
  const partial = await done((await executeDialog(dialog, partialEntry, scope.hosts)).id);
  assert.equal(partial.state, 'Failed');
  assert.equal(partial.rows.find((r) => r.hostId === scope.hosts[0]).exitCode, 0);
  assert.equal(partial.rows.find((r) => r.hostId === scope.hosts[1]).exitCode, 7);
  await writeFile(
    path.join(artifacts, 'automation-partial.json'),
    JSON.stringify(partial, null, 2),
  );
  passed('native partial failure, exit-code attribution and no parameter command injection');
  const secretEntry = await make('Secret', 'printf \'prefix%s suffix\\n\' "$1"', [
    {
      name: 'token',
      label: 'Secret token',
      kind: 'text',
      required: true,
      secret: true,
      default: null,
    },
  ]);
  const secret = randomUUID() + randomUUID();
  dialog = await openRun(secretEntry, [scope.hosts[0]], { token: secret });
  const secretRun = await done((await executeDialog(dialog, secretEntry, [scope.hosts[0]])).id);
  assert.equal(secretRun.state, 'Success');
  assert(secretRun.rows.every((r) => !r.stdout && !r.stderr));
  assert(!JSON.stringify(secretRun).includes(secret), 'secret must not be returned');
  assert(!JSON.stringify(await catalog()).includes(secret));
  const db = await readFile(path.join(context.dataDirectory ?? artifacts, 'serverdeck.sqlite3'));
  assert(!db.includes(Buffer.from(secret)), 'secret must not reach SQLite');
  await writeFile(
    path.join(artifacts, 'automation-secret-metadata.json'),
    JSON.stringify(secretRun, null, 2),
  );
  passed(
    'native secret echo suppressed from UI/cache/history/SQLite even when output retention was requested',
  );
  const timeoutEntry = await make('Timeout', "printf 'started\\n'; sleep 5; printf 'late\\n'");
  dialog = await openRun(timeoutEntry, scope.hosts, {}, { concurrency: 1, timeout: 1 });
  const timed = await executeDialog(dialog, timeoutEntry, scope.hosts);
  await until(async () =>
    (await rpc('automation_run', { id: timed.id })).rows.some((r) => r.state === 'Running'),
  );
  await page.getByRole('button', { name: '取消未开始任务', exact: true }).click();
  const timedRun = await done(timed.id);
  assert.equal(timedRun.state, 'Unknown');
  assert.equal(timedRun.rows.filter((r) => r.state === 'Cancelled').length, 1);
  await writeFile(
    path.join(artifacts, 'automation-timeout.json'),
    JSON.stringify(timedRun, null, 2),
  );
  passed(
    'native timeout is Unknown, queued cancellation does not claim remote process termination',
  );
  const scheduledEntry = await make('Scheduled', `printf 'scheduled=%s\\n' "$(hostname)"`);
  const dangerous = await make('Dangerous', "printf 'explicit approval only\\n'", [], 'dangerous');
  async function schedule(e, name, ids, policy = 'skip') {
    const [entry, targets] = await rpc('automation_prepare', {
      entryId: e.id,
      revision: e.revision,
      hostIds: ids,
    });
    return rpc('automation_schedule_save', {
      id: null,
      revision: null,
      input: {
        name: prefix + ' ' + name,
        entryId: e.id,
        expectedEntryRevision: entry.revision,
        hostIds: ids,
        expectedProfiles: Object.fromEntries(targets.map((t) => [t.hostId, t.routeSignature])),
        parameters: {},
        timing: { kind: 'cron', expression: '* * * * *' },
        offsetMinutes: 0,
        missedPolicy: policy,
        enabled: true,
        authorized: true,
      },
    });
  }
  const normalPlan = await schedule(scheduledEntry, 'Every minute', [scope.hosts[0]]);
  const dangerPlan = await schedule(dangerous, 'Danger pending', [scope.hosts[1]]);
  const offline = await rpc('host_create', {
    input: {
      name: prefix + ' Offline',
      hostname: '127.0.0.1',
      port: 1,
      username: 'root',
      authType: 'private_key',
      credentialId: scope.credential,
      groupId: null,
      tags: [],
      description: 'No SSH connection; must not attempt automatic login',
      favorite: false,
      connectTimeoutSecs: 3,
    },
  });
  scope.hosts.push(offline.id);
  await remember();
  const failurePlan = await schedule(scheduledEntry, 'Offline failure', [offline.id]);
  await nav('SSH 终端');
  console.log('Waiting for actual local scheduler wall-clock minute (no clock override).');
  const scheduled = await until(
    async () => (await allHistory()).find((r) => r.scheduleId === normalPlan.id),
    90,
  );
  assert.equal((await done(scheduled.id)).state, 'Success');
  const dangerPending = await until(
    async () => (await allHistory()).find((r) => r.scheduleId === dangerPlan.id),
    90,
  );
  const pending = await rpc('automation_run', { id: dangerPending.id });
  assert(pending.approvalRequired && pending.state === 'Pending');
  const failed = await until(
    async () => (await allHistory()).find((r) => r.scheduleId === failurePlan.id),
    90,
  );
  assert.equal((await done(failed.id)).state, 'Failed');
  await until(async () => (await rpc('automation_status')).latestFailure);
  await page.getByRole('button', { name: '查看自动化任务', exact: true }).waitFor();
  for (const p of [normalPlan, dangerPlan, failurePlan])
    await rpc('automation_schedule_disable', { id: p.id });
  await nav('运维自动化');
  await page.getByRole('tab', { name: '执行历史', exact: true }).click();
  await page.getByRole('button', { name: '刷新自动化数据', exact: true }).click();
  await page.locator(`[data-run-id="${pending.id}"]`).click();
  await page.getByRole('button', { name: '预览并确认待执行任务', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '执行自动化任务', exact: true });
  await executeDialogApproval(dialog, pending);
  assert.equal((await done(pending.id)).state, 'Success');
  async function executeDialogApproval(dialog, r) {
    await dialog.getByRole('button', { name: '预览自动化执行', exact: true }).click();
    if (r.spec.entry.risk === 'dangerous')
      await dialog.getByLabel('确认危险自动化正文', { exact: true }).check();
    await dialog
      .getByLabel('自动化执行确认文字', { exact: true })
      .fill(`执行 ${r.spec.targets.length} 台`);
    await dialog.getByRole('button', { name: '确认执行自动化', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  passed(
    'native actual Cron trigger, offline scheduled failure notification, and per-occurrence dangerous-task approval',
  );
  const missedAsk = await schedule(scheduledEntry, 'Missed ask', [scope.hosts[0]], 'ask'),
    missedSkip = await schedule(scheduledEntry, 'Missed skip', [scope.hosts[1]], 'skip');
  const crashEntry = await make('Interrupted', "printf 'started\\n'; sleep 30; printf 'late\\n'");
  dialog = await openRun(crashEntry, [scope.hosts[0]]);
  const interrupted = await executeDialog(dialog, crashEntry, [scope.hosts[0]]);
  await until(async () => {
    const r = await rpc('automation_run', { id: interrupted.id });
    return r.rows[0].state === 'Running' && r.rows[0].stdout.includes('started');
  });
  const oldForwards = forwards.map((f) => f.input);
  console.log('Restarting only the isolated test application across a scheduled minute.');
  page = await restart(Math.max(missedAsk.nextAt, missedSkip.nextAt) + 1500);
  context.page = page;
  forwards = [];
  const recovered = await rpc('automation_run', { id: interrupted.id });
  assert.equal(recovered.state, 'Unknown');
  const restored = await rpc('automation_run', { id: argsRun.id });
  assert.equal(restored.state, 'Success');
  assert(restored.rows.every((r) => r.stdout.includes(literal)));
  assert(!JSON.stringify(await rpc('automation_run', { id: secretRun.id })).includes(secret));
  const ask = await until(async () =>
    (await allHistory()).find((r) => r.scheduleId === missedAsk.id && r.trigger === 'missed'),
  );
  const skip = await until(async () =>
    (await allHistory()).find((r) => r.scheduleId === missedSkip.id && r.trigger === 'missed'),
  );
  assert.equal(ask.state, 'Pending');
  assert(ask.approvalRequired);
  assert.equal(skip.state, 'Cancelled');
  for (const p of [missedAsk, missedSkip]) await rpc('automation_schedule_disable', { id: p.id });
  await writeFile(
    path.join(artifacts, 'automation-restart.json'),
    JSON.stringify({ recovered, restored, ask, skip }, null, 2),
  );
  await hostShell();
  dialog = await openRun(system, [hostId]);
  await dialog.getByRole('button', { name: '连接所选目标', exact: true }).click();
  const primaryNew = await until(async () =>
    (await rpc('ops_connections')).find((s) => s.hostId === hostId),
  );
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  for (const input of oldForwards)
    forwards.push(await rpc('forward_start', { id: primaryNew.id, input }));
  await page.getByRole('tab', { name: '执行历史', exact: true }).click();
  await page.getByRole('button', { name: '刷新自动化数据', exact: true }).click();
  await page.locator(`[data-run-id="${argsRun.id}"]`).click();
  await page.locator('[aria-label="自动化执行详情"]').waitFor();
  await page.locator('[aria-label="自动化执行详情"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'automation.png') });
  passed(
    'native process restart preserves history/output, running becomes Unknown, missed plans skip or await confirmation without automatic catch-up',
  );
  await cleanup();
  assert.equal((await catalog()).entries.length, 0);
  assert.equal((await allHistory()).length, 0);
  passed(
    'native automation cleanup releases only owned task/library/schedule/SSH fixture resources',
  );
}
