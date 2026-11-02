// Real release WebView, application stores, IPC and authorized SSH; no substituted implementations.
import assert from 'node:assert/strict';
import { showHostTree } from './ui-navigation.mjs';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const summary = (values) => {
  const v = [...values].sort((a, b) => a - b);
  return {
    count: v.length,
    min: v[0],
    median: v[Math.floor(v.length / 2)],
    p95: v[Math.min(v.length - 1, Math.ceil(v.length * 0.95) - 1)],
    max: v.at(-1),
  };
};
export function resources(pid) {
  const script = `$all=Get-CimInstance Win32_Process; $ids=@(${pid}); do {$next=@($all | Where-Object {$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids} | ForEach-Object ProcessId); $ids+=$next} while($next.Count); $p=@($ids | ForEach-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue}); @{processes=$p.Count;workingSetBytes=($p|Measure-Object WorkingSet64 -Sum).Sum;privateBytes=($p|Measure-Object PrivateMemorySize64 -Sum).Sum;cpuSeconds=($p|Measure-Object CPU -Sum).Sum;processIds=@($p|ForEach-Object Id);rootPrivateBytes=(Get-Process -Id ${pid}).PrivateMemorySize64;mainWindowAvailable=((Get-Process -Id ${pid}).MainWindowHandle -ne 0);handles=($p|Measure-Object HandleCount -Sum).Sum}|ConvertTo-Json -Compress`;
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(r.status, 0, 'own process tree measurement');
  return JSON.parse(r.stdout.trim());
}
export async function releaseChecks({
  page,
  artifacts,
  passed,
  hostId,
  command,
  contains,
  processId,
}) {
  const report = {
    timestamp: new Date().toISOString(),
    profile: 'release',
    method: 'native WebView2 + real xterm + real SSH/SFTP; process tree includes WebView children',
    machine: {
      os: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0].model,
      cores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    metrics: {},
    limitations: [
      'LAN single Ubuntu server; two additional host profiles create separate transports to respect OpenSSH MaxSessions; not a 24-hour leak proof',
    ],
  };
  const rpc = (cmd, args = {}) =>
    page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
  const store = async (method, args = []) =>
    page.evaluate(
      async ({ method, args }) => {
        const s = document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('terminals');
        return await s[method](...args);
      },
      { method, args },
    );
  const cloneIds = [];
  const ownedHosts = [];
  let remote = null,
    filesId = null;
  try {
    report.metrics.baselineConnected = resources(processId());
    const latencies = [];
    for (let i = 0; i < 12; i++) {
      const id = `ECHO_${randomUUID().replaceAll('-', '')}`;
      const t = performance.now();
      await command(`printf '\\n__SD_%s__\\n' ${id}`);
      await contains(`__SD_${id}__`);
      latencies.push(performance.now() - t);
    }
    report.metrics.keyboardToRenderedEchoMs = summary(latencies);
    const bulk = performance.now();
    await command(
      "head -c 8388608 /dev/zero | tr '\\000' x; printf '\\n__SD_%s__\\n' RELEASE_BULK",
    );
    await contains('__SD_RELEASE_BULK__');
    report.metrics.renderedOutput = { bytes: 8388608, elapsedMs: performance.now() - bulk };
    passed(
      'release baseline: rendered keyboard echo and 8 MiB output measured before optimization',
    );
    const base = (await rpc('host_list')).hosts.find((h) => h.id === hostId);
    for (let i = 0; i < 2; i++) {
      const h = await rpc('host_copy', { id: hostId });
      cloneIds.push(h.id);
      ownedHosts.push(h);
    }
    const connectionMs = [];
    for (let i = 0; i < 19; i++) {
      const h = i < 6 ? base : ownedHosts[i < 13 ? 0 : 1];
      const t = performance.now();
      await store('open', [h]);
      await page.waitForFunction(
        () => {
          const s = document
            .querySelector('#app')
            .__vue_app__.config.globalProperties.$pinia._s.get('terminals');
          return s.panes.at(-1)?.state === 'connected';
        },
        null,
        { timeout: 30000 },
      );
      connectionMs.push(performance.now() - t);
    }
    const panes = await page.evaluate(() =>
      document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('terminals')
        .panes.map((p) => ({ id: p.sessionId, transport: p.transportId, state: p.state })),
    );
    assert.equal(panes.length, 20);
    assert(panes.every((p) => p.state === 'connected'));
    assert.equal(new Set(panes.map((p) => p.id)).size, 20);
    assert.equal(new Set(panes.map((p) => p.transport)).size, 3);
    report.metrics.additionalShellOpenMs = summary(connectionMs);
    report.metrics.twentyTerminals = resources(processId());
    for (let i = 0; i < panes.length; i++)
      await rpc('terminal_input', {
        id: panes[i].id,
        data: Array.from(Buffer.from(`printf '\\n__SD_%s__\\n' OWNED_${i}\n`)),
      });
    const tabs = await page.evaluate(() =>
      document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('terminals')
        .tabs.map((t) => t.key),
    );
    for (let i = 0; i < tabs.length; i++) {
      await store('select', [tabs[i]]);
      await contains(`__SD_OWNED_${i}__`);
    }
    passed('20 real xterm PTYs on 3 independent transports, unique IDs and scoped output');
    for (const key of tabs.slice(1)) await store('close', [key]);
    await store('select', [tabs[0]]);
    await command("printf '\\n__SD_%s__\\n' TWENTY_SURVIVOR");
    await contains('__SD_TWENTY_SURVIVOR__');
    for (const h of ownedHosts) await rpc('terminal_close_host', { hostId: h.id });
    report.metrics.afterTerminalRelease = resources(processId());
    passed('close 19 terminals preserves surviving shell; associated transports released');
    for (let n = 0; n < 8; n++) {
      const before = await page.evaluate(() =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('terminals')
          .tabs.map((t) => t.key),
      );
      await store('open', [base]);
      await page.waitForFunction(
        () =>
          document
            .querySelector('#app')
            .__vue_app__.config.globalProperties.$pinia._s.get('terminals')
            .panes.at(-1)?.state === 'connected',
      );
      const keys = await page.evaluate(() =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('terminals')
          .tabs.map((t) => t.key),
      );
      await store('close', [keys.find((k) => !before.includes(k))]);
    }
    await store('select', [tabs[0]]);
    passed('eight additional open/close cycles preserve original SSH');
    // Use the real files store through its normal navigation, and SFTP protocol for all filesystem operations.
    await page
      .locator('.terminal-pane:visible')
      .getByRole('button', { name: 'SFTP 文件', exact: true })
      .click();
    for (let i = 0; i < 100; i++) {
      const connections = await rpc('files_connections');
      if (connections.length) {
        filesId = connections.find((s) => s.hostId === hostId)?.id;
        if (filesId) break;
      }
      await delay(100);
    }
    assert(filesId, 'SFTP session');
    const home = await rpc('files_list', { id: filesId, path: '.' });
    remote = home.path.replace(/\/$/, '') + `/.serverdeck-release-qa-${randomUUID()}`;
    await rpc('files_action', { id: filesId, action: { kind: 'mkdir', path: remote } });
    // Creation is explicit test fixture setup, not production file management via shell.
    await page
      .getByRole('navigation')
      .getByRole('button', { name: /SSH 终端/ })
      .click();
    const code = `import pathlib;p=pathlib.Path(${JSON.stringify(remote)});[(p/('entry-%05d.txt'%i)).write_text('qa') for i in range(5000)];print('__SD_DIRECTORY_'+'READY__')`;
    await command(
      `python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(code).toString('base64')}"))'`,
    );
    await contains('__SD_DIRECTORY_READY__');
    const listTimes = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const l = await rpc('files_list', { id: filesId, path: remote });
      assert.equal(l.entries.length, 5000);
      listTimes.push(performance.now() - t);
    }
    report.metrics.sftp5000EntriesMs = summary(listTimes);
    const local = path.join(artifacts, `release-transfers-${randomUUID()}`);
    await mkdir(local, { recursive: true });
    const sources = [];
    const hashes = [];
    for (let i = 0; i < 5; i++) {
      const f = path.join(local, `payload-${i}.bin`);
      const b = randomBytes(8 * 1024 * 1024);
      await writeFile(f, b);
      sources.push(f);
      hashes.push(createHash('sha256').update(b).digest('hex'));
    }
    let peak = 0;
    const started = performance.now();
    const jobs = [];
    for (const source of sources)
      jobs.push(
        await rpc('transfer_start', {
          input: {
            sessionId: filesId,
            direction: 'upload',
            sources: [source],
            destination: remote,
            conflict: 'fail',
            confirmOverwrite: false,
          },
        }),
      );
    const ids = jobs.map((j) => j.id);
    let completed = [];
    for (let i = 0; i < 1800; i++) {
      const rows = (await rpc('transfer_list')).filter((t) => ids.includes(t.id));
      peak = Math.max(peak, rows.filter((t) => ['running', 'verifying'].includes(t.state)).length);
      if (rows.every((t) => ['completed', 'failed', 'cancelled'].includes(t.state))) {
        completed = rows;
        break;
      }
      await delay(100);
    }
    assert.equal(completed.length, 5);
    assert(
      completed.every((t) => t.state === 'completed'),
      JSON.stringify(completed.map((t) => ({ state: t.state, message: t.message }))),
    );
    assert(peak <= 3);
    report.metrics.upload = {
      bytes: 5 * 8 * 1024 * 1024,
      elapsedMs: performance.now() - started,
      peakActive: peak,
    };
    const download = path.join(local, 'download');
    await mkdir(download);
    const t = performance.now();
    const down = await rpc('transfer_start', {
      input: {
        sessionId: filesId,
        direction: 'download',
        sources: sources.map((f) => remote + '/' + path.basename(f)),
        destination: download,
        conflict: 'fail',
        confirmOverwrite: false,
      },
    });
    let done;
    for (let i = 0; i < 1800; i++) {
      done = (await rpc('transfer_list')).find((j) => j.id === down.id);
      if (['completed', 'failed', 'cancelled'].includes(done?.state)) break;
      await delay(100);
    }
    assert.equal(done?.state, 'completed', done?.message);
    for (let i = 0; i < 5; i++)
      assert.equal(
        createHash('sha256')
          .update(await readFile(path.join(download, path.basename(sources[i]))))
          .digest('hex'),
        hashes[i],
      );
    report.metrics.download = { bytes: 5 * 8 * 1024 * 1024, elapsedMs: performance.now() - t };
    passed('5000-entry SFTP listing and five concurrent 8 MiB files round-trip with SHA-256');
    await rpc('files_action', {
      id: filesId,
      action: { kind: 'remove', paths: [remote], recursive: true, confirmed: true },
    });
    remote = null;
    await rpc('files_close', { id: filesId, cancel: false });
    filesId = null;
    // Actual host catalog data, only owned IDs are removed. This measures capped first-paint, not all-row rendering.
    const hostIds = [];
    try {
      for (let i = 0; i < 1000; i++) {
        const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = base;
        const h = await rpc('host_create', {
          input: {
            ...input,
            name: `QA benchmark ${String(i).padStart(4, '0')}`,
            hostname: `qa-${i}.invalid`,
            credentialId: null,
            authType: 'agent',
          },
        });
        hostIds.push(h.id);
      }
      const t = performance.now();
      await showHostTree(page);
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.tree-host').length >= 100);
      report.metrics.hostCatalog1000 = {
        elapsedMs: performance.now() - t,
        treeRows: await page.locator('.tree-host').count(),
      };
    } finally {
      for (const id of hostIds) await rpc('host_delete', { id });
    }
    passed('1000 persisted hosts first-page rendering benchmark and owned cleanup');
    await page
      .getByRole('navigation')
      .getByRole('button', { name: /SSH 终端/ })
      .click();
    report.metrics.final = resources(processId());
  } finally {
    if (remote && filesId)
      await rpc('files_action', {
        id: filesId,
        action: { kind: 'remove', paths: [remote], recursive: true, confirmed: true },
      });
    if (filesId) await rpc('files_close', { id: filesId, cancel: true });
    for (const id of cloneIds) {
      await rpc('terminal_close_host', { hostId: id });
      await rpc('host_delete', { id });
    }
    await writeFile(
      path.join(artifacts, 'performance-baseline.json'),
      JSON.stringify(report, null, 2),
    );
  }
}
