// Isolated Windows WebView2 test: real native drag event, package IPC and disk layout.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { checkWorkspaceTools } from './plugin-workspace-checks.mjs';
import { navigateWorkspace, openPluginSettings, deliverPluginDrop } from './ui-navigation.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.local/ops-plugin-migration');
const run = path.join(output, 'native', `run-${randomUUID()}`);
const data = path.join(run, 'data'),
  config = path.join(run, 'config.json');
await mkdir(run, { recursive: true });
const base = JSON.parse(
  await readFile(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
);
await writeFile(
  config,
  JSON.stringify({
    identifier: `cn.hiboot.serverdeck.qa.r${randomUUID().replaceAll('-', '')}`,
    app: { appDirectoriesOverride: data, windows: [{ ...base.app.windows[0], visible: false }] },
  }),
);
function build(args) {
  const built = spawnSync(
    process.execPath,
    [path.join(root, 'tools/tauri.mjs'), 'build', '--debug', '--no-bundle', ...args],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, CARGO_TARGET_DIR: path.join(root, 'target') },
    },
  );
  if (built.error) throw built.error;
  assert.equal(built.status, 0, 'native build');
}
build(['--config', config]);
const executable = path.join(run, 'PluginManagementQa.exe');
await copyFile(path.join(root, 'target/debug/serverdeck-desktop.exe'), executable);
build([]);
const packagePath = path.join(run, 'metadata.sdplugin');
const packed = spawnSync(
  process.execPath,
  [
    path.join(root, 'tools/package-plugin.mjs'),
    path.join(root, 'tests/fixtures/plugins/metadata'),
    packagePath,
  ],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
if (packed.error) throw packed.error;
assert.equal(packed.status, 0);
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const child = spawn(executable, [], {
  cwd: run,
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    WEBVIEW2_USER_DATA_FOLDER: path.join(run, 'webview'),
  },
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser,
  page,
  safe = false;
const passed = [];
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
try {
  let endpoint;
  for (let attempt = 0; attempt < 100 && !endpoint; attempt++) {
    if (child.exitCode !== null) throw new Error('Owned QA process exited');
    try {
      endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch {}
    if (!endpoint) await delay(200);
  }
  assert(endpoint, 'QA WebView2 debugger unavailable');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(20000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const bootstrap = await invoke('app_bootstrap');
  assert.equal(
    path.resolve(bootstrap.dataDirectory),
    path.resolve(data),
    'refuse non-owned data directory',
  );
  assert.equal((await invoke('host_list')).hosts.length, 0);
  safe = true;
  const installed = await invoke('plugin_list');
  assert.equal(installed.length, 2);
  for (const plugin of installed) {
    assert(plugin.manifest.id.startsWith('cn.hiboot.plugins.'));
    assert.equal(plugin.source, 'system');
    assert.equal(plugin.enabled, true);
    const grant = await invoke('plugin_permissions', { id: plugin.manifest.id });
    assert.deepEqual(grant.permissions, plugin.manifest.permissions);
    assert(!Object.hasOwn(grant, 'hostIds'));
    if (plugin.manifest.id.endsWith('.logs')) assert.deepEqual(grant.readRoots, ['/']);
    await access(
      path.join(
        data,
        'plugins/system',
        plugin.manifest.id,
        'versions',
        plugin.revision,
        'backend.wasm',
      ),
    );
  }
  passed.push('two cn.hiboot standard packages installed under the owned system directory');
  assert.equal(await page.locator('[data-module="plugins"]').count(), 0);
  const settings = await openPluginSettings(page, 'Docker 管理');
  assert((await page.locator('.plugin-page > header').textContent()).includes('系统内置'));
  assert(await settings.getByLabel('ui.contribute', { exact: true }).isChecked());
  assert(await settings.getByLabel('ui.contribute', { exact: true }).isDisabled());
  assert.equal(await settings.getByRole('button', { name: '保存并授权', exact: true }).count(), 0);
  assert.equal(await settings.getByRole('button', { name: '撤销授权', exact: true }).count(), 0);
  await settings.getByText('已授权', { exact: true }).waitFor();
  await settings.getByRole('button', { name: '禁用插件', exact: true }).click();
  await page
    .getByRole('dialog', { name: '禁用插件？', exact: true })
    .getByRole('button', { name: '明确确认', exact: true })
    .click();
  await settings.getByRole('button', { name: '启用插件', exact: true }).waitFor();
  await settings.getByRole('button', { name: '启用插件', exact: true }).click();
  await settings.getByRole('button', { name: '禁用插件', exact: true }).waitFor();
  assert.equal((await invoke('plugin_health', { id: 'cn.hiboot.plugins.docker' })).error, null);
  passed.push(
    'system permissions are preset and read-only; enable controls stay in individual settings; real WASM health succeeds',
  );
  await navigateWorkspace(page, '插件管理');
  const manager = page.locator('.plugin-manager');
  await manager.waitFor();
  assert.equal(await manager.locator('[data-plugin-id]').count(), 2);
  assert.equal(await manager.locator('.plugin-source').count(), 0);
  assert.equal(await manager.getByLabel('本地插件包路径', { exact: true }).count(), 0);
  await page.screenshot({ path: path.join(run, 'manager.png') });
  const box = await manager
    .getByRole('region', { name: '插件上传区域', exact: true })
    .boundingBox();
  assert(box);
  const ratio = await page.evaluate(() => devicePixelRatio);
  const payload = {
    paths: [packagePath],
    position: { x: (box.x + box.width / 2) * ratio, y: (box.y + box.height / 2) * ratio },
  };
  await deliverPluginDrop(page, payload);
  const preview = page.getByRole('dialog', { name: '安装插件', exact: true });
  await preview.waitFor();
  assert(await preview.getByRole('button', { name: '安装插件', exact: true }).isDisabled());
  await preview.getByRole('checkbox').check();
  await preview.getByRole('button', { name: '安装插件', exact: true }).click();
  await preview.waitFor({ state: 'hidden' });
  const id = 'dev.serverdeck.metadata';
  const upload = await invoke('plugin_detail', { id });
  assert.equal(upload.source, 'user');
  assert.equal(upload.enabled, false);
  await access(path.join(data, 'plugins/upload', id, 'versions', upload.revision, 'readme.txt'));
  const row = manager.locator(`[data-plugin-id="${id}"]`);
  await row.waitFor();
  assert.equal(await row.locator('.plugin-row-actions button').count(), 1);
  assert.equal(await row.locator('.plugin-source').count(), 0);
  passed.push(
    'native WebView drop previews a real package; acknowledgement installs it under plugins/upload',
  );
  await row.getByRole('button', { name: upload.manifest.name, exact: true }).click();
  await page.locator('[aria-label="插件设置"]').waitFor();
  assert((await page.locator('.plugin-page > header').textContent()).includes('用户上传'));
  await page.screenshot({ path: path.join(run, 'uploaded-plugin-settings.png') });
  await navigateWorkspace(page, '插件管理');
  await row.getByRole('button', { name: `卸载 ${upload.manifest.name}`, exact: true }).click();
  await page
    .getByRole('dialog', { name: '卸载插件？', exact: true })
    .getByRole('button', { name: '确认卸载', exact: true })
    .click();
  await row.waitFor({ state: 'detached' });
  assert.equal((await invoke('plugin_list')).length, 2);
  assert.equal((await invoke('host_list')).hosts.length, 0);
  passed.push(
    'source appears only inside individual pages; real native uninstall removes the uploaded package',
  );
  await checkWorkspaceTools({ page, invoke, run, passed });
  await writeFile(
    path.join(run, 'results.json'),
    JSON.stringify({ passed, dataDirectory: data }, null, 2),
  );
  await writeFile(
    path.join(output, 'native-result.json'),
    JSON.stringify({ run, passed }, null, 2),
  );
  console.log(`PASS ${passed.length} native plugin management scenarios. ${run}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (safe && page && browser?.isConnected())
    await invoke('app_exit_confirm', { confirmed: true }).catch(() => {});
  if (browser) await browser.close();
  if (child.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)]);
    if (child.exitCode === null) child.kill();
  }
}
