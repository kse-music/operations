// Launches the explicit installed executable. It never clears application data.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { resources } from './native-release-qa.mjs';
const executable = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3]);
await mkdir(artifacts, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const result = {
  executableSha256: createHash('sha256')
    .update(await readFile(executable))
    .digest('hex'),
  timestamp: new Date().toISOString(),
  profile: 'release installed NSIS executable',
  method:
    'spawn to ready UI via loopback CDP; first run fresh WebView profile, later warm OS/profile cache; no OS cache flush',
  startupMs: [],
  exitMs: [],
};
for (let i = 0; i < 5; i++) {
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    WEBVIEW2_USER_DATA_FOLDER: path.join(artifacts, 'webview'),
  };
  delete env.SERVERDECK_TEST_PASSWORD;
  const t = performance.now();
  const child = spawn(executable, [], { stdio: 'ignore', env });
  let browser;
  try {
    let ws;
    for (let n = 0; n < 200; n++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) ws = (await r.json()).webSocketDebuggerUrl;
      } catch {}
      if (ws) break;
      await delay(50);
    }
    assert(ws, 'native WebView started');
    browser = await chromium.connectOverCDP(ws);
    const page = browser.contexts()[0].pages()[0];
    await page.getByText('本地后端已就绪', { exact: true }).waitFor();
    result.startupMs.push(performance.now() - t);
    if (i === 0)
      result.viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }));
    const catalog = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('host_list'));
    assert.equal(catalog.hosts.length, 0, 'benchmark requires an empty catalog');
    if (i === 0) {
      await delay(30000);
      result.idleProcessTree = resources(child.pid);
      result.idleAfterSeconds = 30;
    }
    const ownedProcesses = resources(child.pid).processIds;
    const closed = new Promise((resolve) => child.once('exit', resolve));
    const e = performance.now();
    await page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke('app_exit_confirm', { confirmed: true }))
      .catch(() => {});
    await Promise.race([closed, delay(15000)]);
    assert(child.exitCode !== null || child.signalCode, 'graceful exit deadline');
    assert.equal(child.exitCode, 0, 'normal application exit code');
    assert.equal(child.signalCode, null, 'normal exit cannot be a signal kill');
    result.exitMs.push(performance.now() - e);
    const running = () =>
      ownedProcesses.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if (error.code === 'ESRCH') return false;
          throw error;
        }
      });
    for (let n = 0; n < 50 && running().length; n++) await delay(200);
    assert.equal(running().length, 0, 'all owned app/WebView processes must terminate');
    result.processTreeExitVerified = true;
    console.log(
      `PASS launch ${i + 1}: ${result.startupMs.at(-1).toFixed(1)} ms, graceful exit ${result.exitMs.at(-1).toFixed(1)} ms`,
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null && !child.signalCode) child.kill();
  }
}
if (process.argv.includes('--plain-idle')) {
  const environment = { ...process.env };
  delete environment.SERVERDECK_TEST_PASSWORD;
  delete environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  delete environment.WEBVIEW2_USER_DATA_FOLDER;
  const child = spawn(executable, [], { stdio: 'ignore', env: environment });
  const closed = new Promise((resolve) => child.once('exit', resolve));
  try {
    await delay(30000);
    assert(child.exitCode === null && !child.signalCode, 'plain production app remains alive');
    result.plainIdleProcessTree = resources(child.pid);
    assert(result.plainIdleProcessTree.mainWindowAvailable, 'plain native window exists');
    result.plainIdleMethod =
      '30s normal production user profile, no CDP/browser arguments; owned process terminated after measurement, not counted as graceful exit';
  } finally {
    if (child.exitCode === null && !child.signalCode) child.kill();
    await Promise.race([closed, delay(5000)]);
  }
  console.log('PASS uninstrumented production idle memory measurement');
}
await writeFile(path.join(artifacts, 'startup-baseline.json'), JSON.stringify(result, null, 2));
