import { automationChecks } from './native-automation-e2e.mjs';
import { networkBatchChecks } from './native-network-batch-e2e.mjs';
import { probeOps, operationsChecks } from './native-ops-e2e.mjs';
// Real packaged WebView2 -> Tauri -> OS credential store -> SSH -> Linux PTY.
// Password must arrive through process environment (or the invoking secure prompt), never argv/files.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { advancedTerminalChecks } from './native-terminal-advanced.mjs';
import { sftpChecks } from './native-sftp-e2e.mjs';
import { transferExitChecks } from './native-transfer-exit.mjs';
import { monitorChecks } from './native-monitor-e2e.mjs';
import { releaseChecks } from './native-release-qa.mjs';
import { createProductHost, productChecks } from './native-product-e2e.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = {
  hostname: process.env.SERVERDECK_TEST_HOST,
  username: process.env.SERVERDECK_TEST_USER,
  secret: process.env.SERVERDECK_TEST_PASSWORD,
  pin: process.env.SERVERDECK_TEST_PIN,
};
assert(
  process.platform === 'win32' && target.hostname && target.username && target.secret && target.pin,
  'Windows and authorized SERVERDECK_TEST_* environment required',
);
const releaseProfile = process.argv.includes('--release');
const installedArg = process.argv.indexOf('--installed-exe');
const installedExecutable = installedArg >= 0 ? path.resolve(process.argv[installedArg + 1]) : null;
assert(
  !process.argv.includes('--release-qa') || releaseProfile,
  'performance baseline requires an explicit release profile',
);
const productMode = process.argv.includes('--product') || process.argv.includes('--product-core');
const reuse = process.argv[2] === '--reuse';
const artifacts = reuse
  ? path.resolve(process.argv[3])
  : path.join(root, '.local', 'terminal-e2e', `${Date.now()}-${randomUUID()}`);
assert.equal(
  path.dirname(artifacts),
  path.join(root, '.local', 'terminal-e2e'),
  'invalid isolated artifact directory',
);
await mkdir(artifacts, { recursive: true });
const config = path.join(artifacts, 'tauri-e2e.json');
await writeFile(
  config,
  JSON.stringify({
    identifier: 'io.serverdeck.desktop.terminal-e2e',
    app: { appDirectoriesOverride: artifacts },
  }),
);
function build(args) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'tools', 'tauri.mjs'),
      'build',
      ...(releaseProfile ? [] : ['--debug']),
      '--no-bundle',
      ...args,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  assert.equal(result.status, 0, 'native build failed');
}
const executable = installedExecutable || path.join(artifacts, 'ServerDeckTerminalE2E.exe');
if (!installedExecutable && (!reuse || process.argv.includes('--rebuild'))) {
  build(['--config', config]);
  await copyFile(
    path.join(root, 'target', releaseProfile ? 'release' : 'debug', 'serverdeck-desktop.exe'),
    executable,
  );
  build([]);
}
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
const environment = { ...process.env };
delete environment.SERVERDECK_TEST_PASSWORD;
let child = spawn(executable, [], {
  cwd: artifacts,
  stdio: 'ignore',
  env: {
    ...environment,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    WEBVIEW2_USER_DATA_FOLDER: path.join(artifacts, 'webview'),
  },
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
let page;
let scoped = false;
let cleanupFiles;
let hostId;
let credentialId;
let originalConfig;
let originalLayout;
let dataDirectory;
async function restartIsolated(waitUntil = 0, closeAction = null) {
  const current = child;
  const closed = new Promise((resolve) => current.once('exit', resolve));
  if (closeAction) await closeAction();
  else current.kill();
  await Promise.race([closed, delay(closeAction ? 45000 : 5000)]);
  assert(current.exitCode !== null || current.signalCode, 'isolated app did not terminate');
  if (closeAction) {
    assert.equal(current.exitCode, 0, 'UI-confirmed exit must return zero');
    assert.equal(current.signalCode, null, 'UI-confirmed exit must not be a signal kill');
  }
  if (browser) await browser.close().catch(() => {});
  while (Date.now() < waitUntil) await delay(Math.min(250, waitUntil - Date.now()));
  const nextPort = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
  child = spawn(executable, [], {
    cwd: artifacts,
    stdio: 'ignore',
    env: {
      ...environment,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${nextPort} --remote-debugging-address=127.0.0.1`,
      WEBVIEW2_USER_DATA_FOLDER: path.join(artifacts, 'webview'),
    },
  });
  let websocket;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${nextPort}/json/version`);
      if (r.ok) {
        websocket = (await r.json()).webSocketDebuggerUrl;
        if (websocket) break;
      }
    } catch {}
    await delay(200);
  }
  assert(websocket, 'restarted isolated WebView2 unavailable');
  browser = await chromium.connectOverCDP(websocket);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(30000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const bootstrap = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_bootstrap'));
  if (!installedExecutable)
    assert.equal(path.resolve(bootstrap.dataDirectory), path.resolve(artifacts));
  return page;
}
const results = [];
const startedAt = new Date().toISOString();
const executableSha256 = createHash('sha256')
  .update(await readFile(executable))
  .digest('hex');
let runCompleted = false;
const limitations = [];
const passed = (name) => {
  results.push(name);
  console.log(`PASS ${name}`);
};
try {
  let websocket;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        websocket = (await response.json()).webSocketDebuggerUrl;
        if (websocket) break;
      }
    } catch {}
    await delay(200);
  }
  assert(websocket, 'WebView2 CDP unavailable');
  browser = await chromium.connectOverCDP(websocket);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const bootstrap = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_bootstrap'));
  if (!installedExecutable)
    assert.equal(path.resolve(bootstrap.dataDirectory), path.resolve(artifacts));
  if (installedExecutable) {
    const existing = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('host_list'));
    assert(
      existing.hosts.length === 0 && existing.credentials.length === 0,
      'installed application must have an empty catalog; never delete user data',
    );
  }
  if (installedExecutable) {
    originalConfig = bootstrap.config;
    originalLayout = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('workspace_load'));
  }
  dataDirectory = bootstrap.dataDirectory;
  scoped = true;
  await page.evaluate(async (installed) => {
    if (installed) return; // Never clear a normal installation's catalog.
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const catalog = await invoke('host_list');
    for (const host of catalog.hosts) {
      await invoke('terminal_close_host', { hostId: host.id });
      await invoke('host_delete', { id: host.id });
    }
    for (const credential of catalog.credentials)
      await invoke('credential_delete', { id: credential.id, detachHosts: true });
    await invoke('credential_cleanup');
  }, !!installedExecutable);
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('workspace_save', {
      layout: { version: 1, active: '', tabs: [] },
    }),
  );
  await page.reload();
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const setup = await page.evaluate(
    async ({ hostname, username, secret, product }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const credential = await invoke('credential_save', {
        id: null,
        expectedRevision: null,
        input: {
          name: 'Isolated SSH verification',
          kind: 'password',
          keyPath: null,
          secret,
          clearSecret: false,
        },
      });
      const host = product
        ? null
        : await invoke('host_create', {
            input: {
              name: 'Linux SSH verification',
              hostname,
              port: 22,
              username,
              authType: 'password',
              credentialId: credential.value.id,
              groupId: null,
              tags: [],
              description: 'Temporary authorized validation',
              favorite: false,
              connectTimeoutSecs: 15,
            },
          });
      return { hostId: host?.id, credentialId: credential.value.id };
    },
    { ...target, product: productMode || !!installedExecutable },
  );
  credentialId = setup.credentialId;
  const productDescription = `Product integration ${path.basename(artifacts)}`;
  if (productMode || installedExecutable) {
    setup.hostId = await createProductHost(page, target, setup.credentialId, productDescription);
    passed('native host creation through UI with a single existing secure credential reference');
  }
  hostId = setup.hostId;
  credentialId = setup.credentialId;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  async function openTerminal() {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '主机管理', exact: true })
      .click();
    await page
      .locator('tbody')
      .getByRole('button', { name: 'Linux SSH verification', exact: true })
      .click();
    await page.getByRole('button', { name: '连接 / 新建终端', exact: true }).click();
  }
  const active = () => page.locator('.terminal-pane:visible');
  const screen = () => active().locator('.xterm-rows');
  async function command(text) {
    await active().locator('.xterm-helper-textarea').focus();
    await page.keyboard.insertText(text);
    await page.keyboard.press('Enter');
  }
  async function contains(text) {
    await screen().filter({ hasText: text }).waitFor();
  }
  await openTerminal();
  const trust = page.getByRole('dialog', { name: '确认 SSH 主机指纹', exact: true });
  if (!reuse || (await trust.isVisible())) {
    await trust.waitFor();
    assert(
      (await trust.innerText()).includes(target.pin),
      'presented fingerprint must match verified pin',
    );
    await trust.getByRole('button', { name: '已核对，信任并连接' }).click();
  }
  await active().getByRole('status').filter({ hasText: '已连接' }).waitFor();
  await command("printf '\\n__SD_%s__\\n' NATIVE; uname -s");
  await contains('__SD_NATIVE__');
  await contains('Linux');
  passed('native xterm real Linux shell + explicit fingerprint confirmation');
  if (!process.argv.includes('--modules-only')) {
    await openTerminal();
    await active().getByRole('status').filter({ hasText: '已连接' }).waitFor();
    assert.equal(await page.getByRole('tablist', { name: '终端标签' }).getByRole('tab').count(), 2);
    assert.equal(await page.getByRole('dialog').count(), 0);
    passed('two independent tabs + persisted trust');
    await page.getByRole('tablist', { name: '终端标签' }).getByRole('tab').nth(0).click();
    await active().getByRole('button', { name: '关闭终端', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label="终端标签"] [role=tab]').length === 1,
    );
    await command("printf '\\n__SD_%s__\\n' SURVIVED");
    await contains('__SD_SURVIVED__');
    passed('closing one channel keeps other shell alive');
    await command('vim -Nu NONE -n -i NONE');
    await contains('VIM');
    await page.keyboard.press('i');
    await page.keyboard.insertText('ServerDeck UTF-8 中文');
    await contains('ServerDeck UTF-8 中文');
    await page.keyboard.press('Escape');
    await page.keyboard.type(':q!');
    await page.keyboard.press('Enter');
    await screen().filter({ hasText: 'ServerDeck UTF-8 中文' }).waitFor({ state: 'hidden' });
    await delay(150);
    await command("printf '\\n__SD_%s__\\n' VIM_DONE");
    await contains('__SD_VIM_DONE__');
    passed('vim alternate screen, keyboard, UTF-8, return to shell');
    await command('LC_ALL=C top -d 1');
    await contains('Tasks:');
    await page.keyboard.press('q');
    await delay(150);
    await command('sleep 30');
    await delay(200);
    await page.keyboard.press('Control+c');
    await command("printf '\\n__SD_%s__\\n' INTERRUPTED");
    await contains('__SD_INTERRUPTED__');
    passed('top + Ctrl+C interrupt');
    await command('sleep 30');
    await delay(150);
    await page.keyboard.press('Control+z');
    await delay(150);
    await command("kill -KILL %1; wait %1 2>/dev/null; printf '\\n__SD_%s__\\n' SUSPENDED");
    await contains('__SD_SUSPENDED__');
    passed('Ctrl+Z shell job control and test job cleanup');
    async function available(program) {
      assert(['htop', 'less'].includes(program));
      await command(
        `if command -v ${program} >/dev/null 2>&1; then printf '\\n__SD_${program}_%s__\\n' YES; else printf '\\n__SD_${program}_%s__\\n' NO; fi`,
      );
      await page.waitForFunction(
        (name) =>
          [...document.querySelectorAll('.terminal-pane')]
            .filter((e) => e.offsetHeight > 0)
            .some(
              (e) =>
                e.textContent.includes(`__SD_${name}_YES__`) ||
                e.textContent.includes(`__SD_${name}_NO__`),
            ),
        program,
      );
      return (await screen().innerText()).includes(`__SD_${program}_YES__`);
    }
    if (await available('htop')) {
      await command('LC_ALL=C htop');
      await contains('Help');
      await page.keyboard.press('q');
      await delay(200);
      await command("printf '\\n__SD_%s__\\n' HTOP_DONE");
      await contains('__SD_HTOP_DONE__');
      passed('htop fullscreen navigation and return to shell');
    } else {
      // Extract a package from the target's configured apt repositories into a private temporary
      // directory. Do not install it, change apt configuration, or write remote persistent files.
      await command(
        `(sd_tmp=$(mktemp -d /tmp/serverdeck-htop.XXXXXXXX) || exit; sd_cleanup() { case "$sd_tmp" in /tmp/serverdeck-htop.*) if [ -d "$sd_tmp" ] && [ ! -L "$sd_tmp" ]; then rm -rf -- "$sd_tmp"; fi;; esac; }; trap sd_cleanup EXIT HUP TERM; if (cd "$sd_tmp" && timeout 35s apt-get download htop >/dev/null 2>&1 && dpkg-deb -x ./htop_*.deb root); then LC_ALL=C "$sd_tmp/root/usr/bin/htop"; else printf '\\n__SD_%s__\\n' HTOP_PACKAGE_UNAVAILABLE; fi)`,
      );
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.terminal-pane')]
            .filter((e) => e.offsetHeight > 0)
            .some(
              (e) =>
                e.textContent.includes('Help') ||
                e.textContent.includes('__SD_HTOP_PACKAGE_UNAVAILABLE__'),
            ),
        undefined,
        { timeout: 45000 },
      );
      if ((await screen().innerText()).includes('__SD_HTOP_PACKAGE_UNAVAILABLE__'))
        limitations.push(
          'htop is not installed and temporary package extraction failed; no packages installed',
        );
      else {
        await page.screenshot({ path: path.join(artifacts, 'htop.png') });
        await page.keyboard.press('q');
        await delay(200);
        await command("printf '\\n__SD_%s__\\n' HTOP_PACKAGE_DONE");
        await contains('__SD_HTOP_PACKAGE_DONE__');
        passed('htop from isolated temporary apt package + return to shell and trap cleanup');
      }
    }
    if (await available('less')) {
      await command('seq 1 1000 | LESS= LC_ALL=C less -R');
      await delay(200);
      await page.keyboard.press('G');
      await contains('(END)');
      await page.keyboard.press('q');
      await delay(150);
      await command("printf '\\n__SD_%s__\\n' LESS_DONE");
      await contains('__SD_LESS_DONE__');
      passed('less paging, end navigation and return to shell');
    } else limitations.push('less is not installed on the authorized target');
    await command("head -c 2097152 /dev/zero | tr '\\000' x; printf '\\n__SD_%s__\\n' BULK_DONE");
    await contains('__SD_BULK_DONE__');
    passed('2 MiB output rendered through parser acknowledgements');
    await active().getByRole('button', { name: '查找', exact: true }).click();
    await active().getByLabel('终端查找内容').fill('__SD_BULK_DONE__');
    await active().getByRole('button', { name: '上一个', exact: true }).click();
    assert.equal(await active().getByRole('alert').count(), 0);
    passed('search real terminal scrollback');
    await command('exit');
    await active().getByRole('status').filter({ hasText: '已关闭' }).waitFor();
    await active().getByRole('button', { name: '重新连接', exact: true }).click();
    await active().getByRole('status').filter({ hasText: '已连接' }).waitFor();
    await command("printf '\\n__SD_%s__\\n' RECONNECTED");
    await contains('__SD_RECONNECTED__');
    passed('manual reconnect creates fresh shell');
  }
  if (process.argv.includes('--exit-transfer'))
    await transferExitChecks({ page, artifacts, hostId, passed, restart: restartIsolated });
  if (process.argv.includes('--release-qa'))
    await releaseChecks({
      page,
      artifacts,
      passed,
      hostId,
      command,
      contains,
      openTerminal,
      processId: () => child.pid,
      restart: restartIsolated,
    });
  if (process.argv.includes('--advanced')) {
    await advancedTerminalChecks({
      page,
      browser,
      artifacts,
      passed,
      openTerminal,
      pin: target.pin,
    });
    // Advanced checks intentionally rename/split tabs and restore an idle layout.
    // Start downstream modules from a fresh normal-profile shell, keeping their host context explicit.
    await page.evaluate(async () => {
      const store = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('terminals');
      for (const tab of [...store.tabs]) await store.close(tab.key);
    });
    await openTerminal();
    await active().getByRole('status').filter({ hasText: '已连接' }).waitFor();
  }
  if (process.argv.includes('--automation') || process.argv.includes('--recover-automation'))
    await automationChecks({
      dataDirectory,
      page,
      artifacts,
      passed,
      hostId,
      command,
      contains,
      restart: restartIsolated,
      registerCleanup: (fn) => {
        cleanupFiles = fn;
      },
    });
  if (process.argv.includes('--network-batch'))
    await networkBatchChecks({
      page,
      artifacts,
      passed,
      hostId,
      command,
      contains,
      registerCleanup: (fn) => {
        cleanupFiles = fn;
      },
    });
  if (process.argv.includes('--ops'))
    await operationsChecks({
      processId: () => child.pid,
      page,
      artifacts,
      passed,
      hostId,
      command,
      contains,
      registerCleanup: (fn) => {
        cleanupFiles = fn;
      },
    });
  if (process.argv.includes('--ops-probe'))
    await probeOps({ page, artifacts, passed, command, contains, hostId });
  if (process.argv.includes('--monitor'))
    await monitorChecks({ page, artifacts, passed, hostId, command, contains });
  if (process.argv.includes('--sftp'))
    await sftpChecks({
      page,
      artifacts,
      passed,
      registerCleanup: (fn) => {
        cleanupFiles = fn;
      },
    });
  if (productMode) {
    const shared = {
      page,
      artifacts,
      hostId,
      passed,
      command,
      contains,
      registerCleanup: (fn) => {
        cleanupFiles = fn;
      },
    };
    if (!process.argv.includes('--product-core')) {
      await monitorChecks(shared);
      await page
        .locator('.terminal-pane:visible')
        .getByRole('button', { name: '监控', exact: true })
        .click();
      await page.getByRole('button', { name: '查看资源占用进程', exact: true }).click();
      assert.equal(await page.getByLabel('运维主机', { exact: true }).inputValue(), hostId);
      passed('native monitor-to-process navigation preserves the selected server');
      await page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('button', { name: /^SSH 终端/ })
        .click();
      await sftpChecks(shared);
      await operationsChecks(shared);
    }
    await productChecks({
      ...shared,
      description: productDescription,
      executable,
      restart: restartIsolated,
      processId: () => child.pid,
    });
  }
  await page.screenshot({ path: path.join(artifacts, 'terminal.png') });
  await writeFile(
    path.join(artifacts, 'result.json'),
    JSON.stringify({ results, limitations }, null, 2),
  );
  runCompleted = true;
  console.log(`Native SSH validation passed (${results.length}); artifacts: ${artifacts}`);
} finally {
  if (page) await page.screenshot({ path: path.join(artifacts, 'last-state.png') }).catch(() => {});
  if (scoped && page) {
    if (cleanupFiles)
      await cleanupFiles().catch((error) => {
        console.error(
          error?.code ?? error?.name,
          String(error?.stack ?? '')
            .split('\n')
            .filter((line) => line.trim().startsWith('at '))
            .slice(0, 5)
            .join('\n'),
        );
        process.exitCode = 1;
        console.error(
          'Isolated workspace cleanup failed; inspect only the owned test scope recorded in artifacts.',
        );
      });
    await page
      .evaluate(
        async ({ hostId, credentialId }) => {
          const invoke = window.__TAURI_INTERNALS__.invoke;
          if (hostId) {
            await invoke('terminal_close_host', { hostId });
            await invoke('host_delete', { id: hostId });
          }
          if (credentialId)
            await invoke('credential_delete', { id: credentialId, detachHosts: true });
          await invoke('credential_cleanup');
          const catalog = await invoke('host_list');
          if (catalog.hosts.length || catalog.credentials.length || catalog.pendingSecretDeletions)
            throw new Error('test resources were not released');
        },
        { hostId, credentialId },
      )
      .catch(() => {
        process.exitCode = 1;
        console.error(
          'Isolated test cleanup failed; recover test credential using artifact DB references.',
        );
      });
  }
  if (installedExecutable && originalConfig && page) {
    await page.evaluate(
      async ({ config, layout }) => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        await invoke('config_save', { config });
        await invoke('workspace_save', { layout: layout || { version: 1, active: '', tabs: [] } });
      },
      { config: originalConfig, layout: originalLayout },
    );
  }
  target.secret = undefined;
  if (page && child.exitCode === null && !child.signalCode) {
    const started = Date.now();
    const closed = new Promise((resolve) => child.once('exit', resolve));
    await page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke('app_exit_confirm', { confirmed: true }))
      .catch(() => {});
    await Promise.race([closed, delay(20000)]);
    const graceful = child.exitCode === 0 && !child.signalCode;
    await writeFile(
      path.join(artifacts, 'native-shutdown.json'),
      JSON.stringify(
        {
          graceful,
          exitCode: child.exitCode,
          signal: child.signalCode,
          elapsedMs: Date.now() - started,
        },
        null,
        2,
      ),
    );
    if (!graceful) {
      process.exitCode = 1;
      console.error('Native graceful shutdown deadline exceeded');
    }
  }
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null && !child.signalCode) child.kill();
  await writeFile(
    path.join(artifacts, `run-${Date.parse(startedAt)}.json`),
    JSON.stringify(
      {
        startedAt,
        executableSha256,
        profile: releaseProfile ? 'release' : 'debug',
        installed: !!installedExecutable,
        flags: process.argv.slice(2).filter((s) => s.startsWith('--')),
        validationSucceeded: runCompleted && !process.exitCode,
        passedSteps: results,
        limitations,
      },
      null,
      2,
    ),
  );
}
