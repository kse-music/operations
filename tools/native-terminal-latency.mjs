// Real Release WebView2 + application sessions + ConPTY + timestamped loopback HTTP logs.
// DOM readiness and the next animation-frame opportunity are NOT physical pixel presentation.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

assert.equal(process.platform, 'win32', 'requires Windows/WebView2/ConPTY');
const root = fileURLToPath(new URL('../', import.meta.url));
const qa = path.join(root, '.local', 'qa', 'terminal-latency');
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const label = argument('--label', 'measurement');
assert(/^[a-z0-9-]+$/.test(label));
const run = randomUUID().replaceAll('-', '');
const artifacts = path.join(qa, `${label}-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
const data = path.join(qa, 'data');
const config = path.join(qa, 'tauri-qa.json');
await writeFile(
  config,
  JSON.stringify({
    identifier: 'cn.hiboot.desktop.terminal-latency-qa',
    app: { appDirectoriesOverride: data },
  }),
);
const executable = path.join(artifacts, 'ServerDeckLatencyQA.exe');
function build(extra) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'tools/tauri.mjs'), 'build', '--no-bundle', ...extra],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Release build failed');
}
const existingExecutable = argument('--exe', null);
if (!existingExecutable) {
  try {
    build(['--config', config]);
    await copyFile(path.join(root, 'target/release/serverdeck-desktop.exe'), executable);
  } finally {
    build([]);
  }
} else {
  const source = path.resolve(existingExecutable);
  assert(source.startsWith(qa + path.sep), 'only an existing isolated QA executable may be reused');
  await copyFile(source, executable);
}
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await freePort();
const httpPort = await freePort();
const child = spawn(executable, [], {
  cwd: artifacts,
  stdio: 'ignore',
  windowsHide: false,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    WEBVIEW2_USER_DATA_FOLDER: path.join(artifacts, 'webview'),
  },
});
let browser,
  page,
  safe = false,
  httpReady = false;
const stops = [];
const report = {
  label,
  hiddenLayout: process.argv.includes('--display-none')
    ? 'display:none diagnostic control'
    : 'current application layout',
  startedAt: new Date().toISOString(),
  executableSha256: createHash('sha256')
    .update(await readFile(executable))
    .digest('hex'),
  machine: {
    os: os.release(),
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    memoryBytes: os.totalmem(),
  },
  method:
    'producer UTC timestamp -> real ConPTY/IPC -> xterm DOM MutationObserver; next rAF is a frame opportunity, not pixel presentation',
  phases: [],
  limitations: [
    'Windows local terminals only; no remote SSH, administrator UAC, installer or other OS validation',
  ],
};
const summary = (values) => {
  assert(values.length && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries(
    Object.entries({
      count: sorted.length,
      p50: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      max: sorted.at(-1),
    }).map(([key, value]) => [key, Math.round(value * 100) / 100]),
  );
};
const rpc = (name, args = {}) =>
  page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
const powershellQuote = (value) => `'${value.replaceAll("'", "''")}'`;
async function input(id, command) {
  await rpc('terminal_input', { id, data: [...Buffer.from(command + '\r')] });
}
async function panes() {
  return page.evaluate(() =>
    document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia._s.get('terminals')
      .panes.map((pane) => ({ key: pane.key, id: pane.sessionId, state: pane.state })),
  );
}
try {
  let websocket;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      websocket = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch (error) {
      if (attempt === 119) throw error;
    }
    if (websocket) break;
    assert.equal(child.exitCode, null, 'QA process exited before CDP');
    await delay(250);
  }
  assert(websocket, 'WebView2 CDP unavailable');
  browser = await chromium.connectOverCDP(websocket);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(30000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const bootstrap = await rpc('app_bootstrap');
  assert.equal(path.resolve(bootstrap.dataDirectory), data, 'refusing non-QA application data');
  assert.equal((await rpc('host_list')).hosts.length, 0, 'QA catalog must contain no remote hosts');
  safe = true;
  await page.bringToFront();
  if (process.argv.includes('--display-none')) {
    await page.addStyleTag({
      content:
        '.split-pane.terminal-hidden, .terminal-workspace.terminal-hidden { display: none; }',
    });
  }
  report.browser = await page.evaluate(() => ({
    agent: navigator.userAgent,
    visibility: document.visibilityState,
    devicePixelRatio,
  }));
  await page.evaluate((run) => {
    const qa = (window.latencyQa = {
      run,
      samples: {},
      frames: {},
      tails: {},
      sessions: {},
      foreground: null,
      channels: {},
      ready: {},
      ended: {},
      ackDurations: [],
      longTasks: [],
    });
    const now = () => performance.timeOrigin + performance.now();
    const api = window.__TAURI_INTERNALS__;
    const fetch = window.fetch;
    window.fetch = function (url, options, ...rest) {
      let frames;
      if (String(url).endsWith('/terminal_ack')) {
        const args = JSON.parse(options.body);
        if (args.id === qa.foregroundSession) frames = qa.frames[args.sequence];
      }
      const started = frames ? now() : 0;
      if (frames) for (const sample of frames) sample.parsed ??= started;
      const result = fetch.call(this, url, options, ...rest);
      if (frames) void result.then(() => qa.ackDurations.push(now() - started));
      return result;
    };
    const get = api.callbacks.get;
    api.callbacks.get = function (id) {
      const callback = get.call(this, id);
      if (!callback) return callback;
      return (raw) => {
        const event = raw?.message;
        if (event?.type === 'data') qa.foreground ??= id;
        if (event?.type === 'data' && id !== qa.foreground) {
          const stats = (qa.channels[id] ??= { bytes: 0, frames: 0, tail: '' });
          stats.bytes += event.data.length;
          stats.frames++;
          const text = stats.tail + new TextDecoder().decode(new Uint8Array(event.data));
          for (const match of text.matchAll(/SD_BG_READY_(\w+)_END/g)) qa.ready[match[1]] = id;
          for (const match of text.matchAll(/SD_BG_END_(\w+)_(\d+)_END/g))
            qa.ended[match[1]] = Number(match[2]);
          stats.tail = text.slice(-160);
        }
        if (id === qa.foreground && event?.type === 'data') {
          const text = new TextDecoder().decode(new Uint8Array(event.data));
          qa.tails[id] = (qa.tails[id] ?? '') + text;
          const pattern = new RegExp(`SD_LAT_${run}_(\\d+)_(\\d+)_END`, 'g');
          for (const match of qa.tails[id].matchAll(pattern)) {
            if (qa.samples[match[1]]) continue;
            const sample = (qa.samples[match[1]] = {
              sequence: Number(match[1]),
              emitted: Number(match[2]),
              received: now(),
            });
            (qa.frames[event.sequence] ??= []).push(sample);
          }
          qa.tails[id] = qa.tails[id].slice(-160);
        }
        return callback(raw);
      };
    };
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver((list) =>
        qa.longTasks.push(
          ...list
            .getEntries()
            .map((entry) => ({ start: entry.startTime, duration: entry.duration })),
        ),
      ).observe({ type: 'longtask' });
    }
  }, run);
  await page.getByRole('button', { name: '本地终端', exact: true }).click();
  await page.locator('.terminal-pane:visible .xterm-container[data-state="connected"]').waitFor();
  const foreground = (await panes())[0];
  await page.evaluate((id) => {
    window.latencyQa.foregroundSession = id;
  }, foreground.id);
  await page.evaluate((run) => {
    const now = () => performance.timeOrigin + performance.now();
    const observer = new MutationObserver(() => {
      const text =
        document.querySelector('.terminal-pane:has(.xterm-container) .xterm-rows')?.textContent ??
        '';
      const pattern = new RegExp(`SD_LAT_${run}_(\\d+)_(\\d+)_END`, 'g');
      for (const match of text.matchAll(pattern)) {
        const sample = window.latencyQa.samples[match[1]];
        if (sample && sample.dom === undefined) {
          sample.dom = now();
          requestAnimationFrame(() => {
            sample.nextFrame = now();
          });
        }
      }
    });
    observer.observe(document.querySelector('.terminal-pane .xterm-rows'), {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, run);
  const producer = `powershell.exe -NoLogo -NoProfile -File ${powershellQuote(path.join(root, 'tools/terminal-latency-producer.ps1'))}`;
  await input(foreground.id, `${producer} -Mode http -Port ${httpPort} -Run ${run}`);
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${httpPort}/0`);
      if (response.ok) {
        httpReady = true;
        break;
      }
    } catch (error) {
      if (attempt === 149) throw error;
    }
    await delay(200);
  }
  assert(httpReady);
  await page.waitForFunction(() => window.latencyQa.samples[0]?.nextFrame !== undefined);
  let sequence = 1;
  async function measure(name, background) {
    await delay(1500);
    const first = sequence;
    const start = await page.evaluate(() => performance.now());
    const before = await page.evaluate(() =>
      Object.fromEntries(
        Object.entries(window.latencyQa.channels).map(([id, stats]) => [id, stats.bytes]),
      ),
    );
    const count = Number(argument('--samples', '60'));
    for (let index = 0; index < count; index++) {
      const response = await fetch(`http://127.0.0.1:${httpPort}/${sequence++}`);
      assert.equal(response.status, 200);
      await response.text();
      await delay(100);
    }
    const last = sequence - 1;
    await page.waitForFunction(
      (last) => window.latencyQa.samples[last]?.nextFrame !== undefined,
      last,
    );
    const measured = await page.evaluate(
      ({ first, last, start }) => ({
        samples: Array.from(
          { length: last - first + 1 },
          (_, index) => window.latencyQa.samples[first + index],
        ),
        longTasks: window.latencyQa.longTasks.filter((task) => task.start >= start),
        visibility: document.visibilityState,
        backgroundBytes: Object.fromEntries(
          Object.entries(window.latencyQa.channels).map(([id, stats]) => [id, stats.bytes]),
        ),
      }),
      { first, last, start },
    );
    assert.equal(measured.visibility, 'visible');
    assert(
      measured.samples.every((sample) => sample?.dom !== undefined && sample?.parsed !== undefined),
      'all generated markers must be received, parsed and rendered',
    );
    const metric = (to, from) =>
      summary(measured.samples.map((sample) => sample[to] - sample[from]));
    const phase = {
      name,
      sessions: (await panes()).length,
      background,
      generatedToReceivedMs: metric('received', 'emitted'),
      receivedToParsedMs: metric('parsed', 'received'),
      parsedToDomMs: metric('dom', 'parsed'),
      generatedToDomMs: metric('dom', 'emitted'),
      generatedToNextFrameMs: metric('nextFrame', 'emitted'),
      ...measured,
    };
    phase.backgroundBytes = Object.fromEntries(
      Object.entries(measured.backgroundBytes).map(([id, bytes]) => [
        id,
        bytes - (before[id] ?? 0),
      ]),
    );
    if (background)
      assert.equal(
        Object.values(phase.backgroundBytes).filter((bytes) => bytes > 0).length,
        background,
        'all configured background producers must actually stream output',
      );
    report.phases.push(phase);
    await writeFile(path.join(artifacts, 'metrics.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        phase: name,
        dom: phase.generatedToDomMs,
        receive: phase.generatedToReceivedMs,
        parse: phase.receivedToParsedMs,
        longTasks: phase.longTasks.length,
      }),
    );
    if (process.argv.includes('--profile') && background === 15) {
      const profiler = await page.context().newCDPSession(page);
      await profiler.send('Profiler.enable');
      await profiler.send('Profiler.start');
      await delay(2500);
      const { profile } = await profiler.send('Profiler.stop');
      await writeFile(path.join(artifacts, 'cpu-profile.json'), JSON.stringify(profile));
      await profiler.detach();
    }
  }
  await measure('single-idle', 0);
  async function openUntil(count) {
    while ((await panes()).length < count) {
      await page.evaluate(() =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('terminals')
          .open(null),
      );
      await page.waitForFunction(() =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('terminals')
          .panes.every((pane) => pane.state === 'connected'),
      );
    }
    await page.evaluate(() => {
      const store = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('terminals');
      store.select(store.tabs[0].key);
    });
  }
  await openUntil(8);
  await measure('eight-idle', 0);
  await openUntil(16);
  await measure('sixteen-idle', 0);
  for (const count of [3, 15]) {
    const active = (await panes()).slice(1, count + 1);
    const stop = path.join(artifacts, `stop-${count}`);
    stops.push(stop);
    const runs = active.map((_, index) => `${run}P${count}BG${index}`);
    for (const [index, pane] of active.entries())
      await input(
        pane.id,
        `${producer} -Mode load -Run ${runs[index]} -StopFile ${powershellQuote(stop)}`,
      );
    await page.waitForFunction(
      (runs) => runs.every((run) => window.latencyQa.ready[run] !== undefined),
      runs,
    );
    await delay(2000);
    await measure(`sixteen-${count}-logging`, count);
    if (process.argv.includes('--verify')) {
      const geometry = await page.evaluate(() =>
        [...document.querySelectorAll('.split-pane')].slice(1).map((pane) => ({
          inert: pane.inert,
          hidden: pane.getAttribute('aria-hidden'),
          width: pane.querySelector('.xterm-char-measure-element').offsetWidth,
          right: pane.getBoundingClientRect().right,
        })),
      );
      assert(
        geometry.every(
          (pane) => pane.inert && pane.hidden === 'true' && pane.width > 0 && pane.right < 0,
        ),
        'background panes must remain measurable, outside the viewport and inaccessible',
      );
      report.backgroundGeometry = geometry;
    }
    await writeFile(stop, 'stop');
    await page.waitForFunction(
      (runs) => runs.every((run) => window.latencyQa.ended[run] > 0),
      runs,
    );
    report.backgroundCompleted ??= [];
    report.backgroundCompleted.push(
      await page.evaluate(
        (runs) => runs.map((run) => ({ run, lines: window.latencyQa.ended[run] })),
        runs,
      ),
    );
    await delay(1500);
  }
  if (process.argv.includes('--verify')) {
    const sessions = await panes();
    await page.evaluate(() => {
      const store = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('terminals');
      store.select(store.tabs[1].key);
    });
    await page
      .locator('.terminal-pane:visible .xterm-rows')
      .filter({ hasText: 'SD_BG_END_' })
      .waitFor();
    assert.equal(await page.locator('.terminal-pane:visible').count(), 1);
    assert.equal(
      await page.evaluate(() => {
        const hidden = document.querySelector('.split-pane[inert] .xterm-helper-textarea');
        hidden.focus();
        return document.activeElement === hidden;
      }),
      false,
      'hidden terminal must not receive focus',
    );
    await page.evaluate(() => {
      const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      stores.get('terminals').select(stores.get('terminals').tabs[0].key);
      stores.get('workspace').navigate('server', '');
    });
    await page.locator('.server-view').waitFor();
    assert.equal(await page.locator('.terminal-pane:visible').count(), 0);
    const hiddenWorkspace = await page.evaluate(() => {
      const workspace = document.querySelector('.terminal-workspace');
      return {
        inert: workspace.inert,
        width: workspace.querySelector('.xterm-char-measure-element').offsetWidth,
      };
    });
    assert(
      hiddenWorkspace.inert && hiddenWorkspace.width > 0,
      'leaving the terminal page must also retain valid font measurements',
    );
    await page.evaluate(() =>
      document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
        .navigate('terminals', ''),
    );
    await page.locator('.terminal-pane:visible .xterm-rows').waitFor();
    assert.deepEqual(
      await panes(),
      sessions,
      'tab and page switches must preserve session identities',
    );
    await fetch(`http://127.0.0.1:${httpPort}/stop`);
    httpReady = false;
    await delay(300);
    await page.locator('.terminal-pane:visible .xterm-helper-textarea').focus();
    await page.keyboard.insertText("[Console]::WriteLine(('SD_INPUT_' + 'OK'))");
    await page.keyboard.press('Enter');
    await page
      .locator('.terminal-pane:visible .xterm-rows')
      .filter({ hasText: 'SD_INPUT_OK' })
      .waitFor();
    report.interactionChecks = [
      'background history remains visible on selection',
      'hidden pane rejects focus',
      'leaving terminal page preserves measurable layout',
      'switches preserve every session identity',
      'keyboard input works after restoring foreground',
    ];
  }
  report.ackRoundTripMs = await page.evaluate(() => window.latencyQa.ackDurations);
  if (process.argv.includes('--inspect')) {
    console.log('Inspection ready: ' + artifacts);
    const deadline = Date.now() + 45000;
    while (!existsSync(path.join(artifacts, 'inspection-done')) && Date.now() < deadline)
      await delay(200);
  }
  await page.screenshot({ path: path.join(artifacts, 'foreground.png') });
  report.completed = true;
} catch (error) {
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  for (const stop of stops) await writeFile(stop, 'stop');
  if (httpReady)
    await fetch(`http://127.0.0.1:${httpPort}/stop`).catch((error) => {
      report.httpStopError = String(error);
    });
  if (safe && child.exitCode === null) {
    try {
      for (const pane of await panes()) await rpc('terminal_close', { id: pane.id });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      await rpc('app_exit_confirm', { confirmed: true });
      let exitTimer;
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            exitTimer = setTimeout(() => reject(new Error('QA application exit timed out')), 15000);
          }),
        ]);
      } finally {
        clearTimeout(exitTimer);
      }
      assert.equal(child.exitCode, 0, 'isolated application must exit cleanly');
    } catch (error) {
      report.cleanupError = String(error);
      process.exitCode = 1;
    }
  }
  await writeFile(path.join(artifacts, 'metrics.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
  console.log(`Artifacts: ${artifacts}`);
}
