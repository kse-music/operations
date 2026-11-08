// Real Windows/WebView2 + IPC + SQLite + credential-store migration. Isolated profiles only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { navigateWorkspace } from './ui-navigation.mjs';

if (process.platform !== 'win32') throw new Error('This native check requires Windows/WebView2.');
const root = fileURLToPath(new URL('../', import.meta.url));
const run = path.join(root, '.local/settings-storage', `native-${Date.now()}`);
const source = path.join(run, 'source');
const destination = process.env.SERVERDECK_STORAGE_TEST_TARGET
  ? path.resolve(process.env.SERVERDECK_STORAGE_TEST_TARGET, `profile-${randomUUID()}`)
  : path.join(run, 'migrated');
const executable = path.join(run, 'StorageQA.exe');
await mkdir(run, { recursive: true });
const configFile = path.join(run, 'tauri-storage.json');
await writeFile(
  configFile,
  JSON.stringify({
    identifier: 'cn.hiboot.desktop.storage.e2e',
    app: { appDirectoriesOverride: source },
  }),
);
function build(config) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'tools/tauri.mjs'),
      'build',
      '--debug',
      '--no-bundle',
      ...(config ? ['--config', config] : []),
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'native build failed');
}
build(configFile);
await copyFile(path.join(root, 'target/debug/serverdeck-desktop.exe'), executable);
// Restore the normal build configuration before starting the QA copy.
build();
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});
const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
};
delete env.WEBVIEW2_USER_DATA_FOLDER;
const child = spawn(executable, [], { cwd: run, stdio: 'ignore', windowsHide: true, env });
await writeFile(
  path.join(run, 'session.json'),
  JSON.stringify({ port, pid: child.pid, executable }),
);
let browser,
  page,
  credentialId,
  currentRoot = source;
const results = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connect() {
  const deadline = Date.now() + 120000;
  let error;
  let reports = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const version = await response.json();
      browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
      page = browser.contexts()[0].pages()[0];
      page.setDefaultTimeout(20000);
      await page.getByText('本地后端已就绪', { exact: true }).waitFor();
      return;
    } catch (cause) {
      error = cause;
      if (++reports % 40 === 0)
        process.stdout.write(`Waiting for isolated QA WebView: ${cause.message}\n`);
      await browser?.close().catch(() => {});
      await delay(250);
    }
  }
  throw new Error(`QA WebView did not become ready: ${error?.message}`);
}
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function absent(file) {
  try {
    await stat(file);
    return false;
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    throw e;
  }
}
try {
  await connect();
  const original = await invoke('app_bootstrap');
  assert.equal(path.resolve(original.dataDirectory), source, 'refusing to touch a non-QA profile');
  const secret = `storage-qa-${randomUUID()}`;
  const saved = await invoke('credential_save', {
    id: null,
    expectedRevision: null,
    input: {
      name: 'Storage migration QA',
      kind: 'password',
      keyPath: null,
      secret,
      clearSecret: false,
    },
  });
  credentialId = saved.value.id;
  const host = await invoke('host_create', {
    input: {
      name: 'Migration QA host',
      hostname: 'migration.invalid',
      port: 22,
      username: 'qa',
      authType: 'password',
      credentialId,
      groupId: null,
      description: 'isolated storage migration',
      favorite: false,
      connectTimeoutSecs: 15,
    },
  });
  await invoke('plugin_set_enabled', { id: 'cn.hiboot.plugins.docker', enabled: false });
  const plugins = await invoke('plugin_list');
  await page.evaluate(() => localStorage.setItem('storage-migration-qa', 'preserve-webview'));
  await writeFile(path.join(source, 'plugins/migration-evidence.txt'), 'plugin data preserved');
  await navigateWorkspace(page, '数据与存储');
  await page.getByLabel('数据根目录', { exact: true }).fill(destination);
  await navigateWorkspace(page, '通用');
  await page.getByTestId('theme-select').selectOption('light');
  await page.getByRole('button', { name: '保存、迁移并重启', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '迁移数据并重启', exact: true });
  await dialog.waitFor();
  assert((await dialog.textContent()).includes(destination));
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await invoke('app_bootstrap')).config.theme, original.config.theme);
  assert.equal(await absent(destination), true);
  results.push('native cancellation preserves drafts and does not save, migrate or restart');
  await page.getByRole('button', { name: '保存、迁移并重启', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '迁移数据并重启', exact: true });
  await dialog.waitFor();
  await page.screenshot({ path: path.join(run, 'migration-confirm.png') });
  const disconnected = new Promise((resolve) => browser.once('disconnected', resolve));
  await dialog.getByRole('button', { name: '确认迁移并重启', exact: true }).click();
  await Promise.race([
    disconnected,
    delay(30000).then(() => {
      throw new Error('old QA process did not close');
    }),
  ]);
  await connect();
  const migrated = await invoke('app_bootstrap');
  currentRoot = migrated.dataDirectory;
  assert.equal(path.resolve(currentRoot), destination, JSON.stringify(migrated.storage));
  assert.equal(migrated.config.theme, 'light');
  assert.equal(path.resolve(migrated.storage.webviewDirectory), path.join(destination, 'webview'));
  assert.equal(
    await page.evaluate(() => localStorage.getItem('storage-migration-qa')),
    'preserve-webview',
  );
  const catalog = await invoke('host_list');
  assert.equal(catalog.hosts.find((h) => h.id === host.id).credentialId, credentialId);
  assert.equal(catalog.credentials.find((c) => c.id === credentialId).hasSecret, true);
  const afterPlugins = await invoke('plugin_list');
  for (const plugin of plugins) {
    const after = afterPlugins.find((p) => p.manifest.id === plugin.manifest.id);
    assert.equal(after.enabled, plugin.enabled);
    assert.equal(after.revision, plugin.revision);
  }
  assert.equal(
    await readFile(path.join(destination, 'plugins/migration-evidence.txt'), 'utf8'),
    'plugin data preserved',
  );
  assert.equal(await absent(path.join(source, 'serverdeck.sqlite3')), true);
  assert.equal(await absent(path.join(source, 'plugins')), true);
  assert.equal(await absent(path.join(source, 'webview')), true);
  assert.equal(await absent(path.join(source, 'storage-location.json')), false);
  assert(
    !(await readFile(path.join(destination, 'serverdeck.sqlite3'))).includes(Buffer.from(secret)),
  );
  results.push(
    'real automatic restart preserves SQLite hosts, credential references, plugin revision/enabled choice, logs and WebView localStorage; old copies cleaned',
  );
  await navigateWorkspace(page, '数据与存储');
  await page.screenshot({ path: path.join(run, 'migrated-storage.png') });
  await writeFile(
    path.join(run, 'results.json'),
    JSON.stringify(
      {
        source,
        destination,
        crossVolume: path.parse(source).root !== path.parse(destination).root,
        results,
      },
      null,
      2,
    ),
  );
  process.stdout.write(JSON.stringify({ run, destination, results }, null, 2) + '\n');
} finally {
  if (page && !page.isClosed()) {
    // Only random QA credentials are deleted; preserve diagnostics and profile artifacts.
    try {
      const active = await invoke('app_bootstrap');
      assert([source, destination].includes(path.resolve(active.dataDirectory)));
      if (credentialId) await invoke('credential_delete', { id: credentialId, detachHosts: true });
      await invoke('app_exit_confirm', { confirmed: true });
    } catch (error) {
      process.stderr.write(`QA cleanup requires attention (${currentRoot}): ${error.message}\n`);
    }
  }
  await browser?.close().catch(() => {});
  if (child.exitCode === null)
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  if (!page && child.exitCode === null) child.kill(); // Only this owned QA child.
}
