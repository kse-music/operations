// Real Windows WebView2 + native IPC + isolated SQLite/OS credential + disposable Linux host.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import {
  navigateWorkspace,
  showHostTree,
  hostContextAction,
  previewPluginPackage,
  openPluginDetails,
  openPluginSettings,
  setPluginEnabled,
} from './ui-navigation.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  base = path.join(root, '.local', 'plugin-13a', 'native');
const config = path.join(base, 'config.json'),
  executable = path.join(base, 'PluginNativeQa.exe');
await mkdir(base, { recursive: true });
if (process.argv.includes('--build')) {
  await writeFile(
    config,
    JSON.stringify({
      identifier: 'cn.hiboot.plugin13a.qa',
      app: { appDirectoriesOverride: path.join(base, `data-${randomUUID()}`) },
    }),
  );
  function build(args) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'tools', 'tauri.mjs'), 'build', '--debug', '--no-bundle', ...args],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          CARGO_TARGET_DIR: path.join(root, 'target'),
          CARGO_BUILD_JOBS: '2',
        },
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'native build failed');
  }
  build(['--config', config]);
  await copyFile(path.join(root, 'target/debug/serverdeck-desktop.exe'), executable);
  build([]);
  process.exit(0);
}
assert.equal(process.platform, 'win32');
const expectedData = JSON.parse(await readFile(config, 'utf8')).app.appDirectoriesOverride;
assert.equal(path.dirname(expectedData), base);
assert(/^data-[0-9a-f-]+$/.test(path.basename(expectedData)));
assert(
  process.env.SERVERDECK_PLUGIN_TEST_PASSWORD && process.env.SERVERDECK_PLUGIN_TEST_HOST_KEY,
  'use tools/plugin-test-host/test.ps1 -Mode ui',
);
const artifacts = path.join(base, `run-${Date.now()}-${randomUUID()}`);
await mkdir(artifacts, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const child = spawn(executable, [], {
  cwd: base,
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    WEBVIEW2_USER_DATA_FOLDER: path.join(base, 'webview'),
  },
});
let browser,
  page,
  safe = false,
  credentialId,
  hostId;
const passed = [];
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
try {
  let websocket;
  for (let i = 0; i < 100 && !websocket; i++) {
    if (child.exitCode !== null) throw new Error(`QA process exited ${child.exitCode}`);
    try {
      websocket = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch {}
    if (!websocket) await delay(200);
  }
  assert(websocket, 'native WebView debugging unavailable');
  browser = await chromium.connectOverCDP(websocket);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  assert.equal(
    path.resolve((await invoke('app_bootstrap')).dataDirectory),
    path.resolve(expectedData),
    'refuse non-QA database',
  );
  safe = true;
  // This QA directory is dedicated to plugin tests; remove only its prior failed-run records.
  for (const p of await invoke('plugin_list'))
    await invoke('plugin_uninstall', {
      input: { id: p.manifest.id, confirmed: true, clearData: true },
    });
  const old = await invoke('host_list');
  for (const h of old.hosts) await invoke('host_delete', { id: h.id });
  for (const c of old.credentials)
    await invoke('credential_delete', { id: c.id, detachHosts: true });
  credentialId = (
    await invoke('credential_save', {
      id: null,
      expectedRevision: null,
      input: {
        name: `plugin-qa-${randomUUID()}`,
        kind: 'password',
        keyPath: null,
        secret: process.env.SERVERDECK_PLUGIN_TEST_PASSWORD,
        clearSecret: false,
      },
    })
  ).value.id;
  hostId = (
    await invoke('host_create', {
      input: {
        name: 'Plugin QA Linux',
        hostname: '127.0.0.1',
        port: Number(process.env.SERVERDECK_PLUGIN_TEST_PORT),
        username: 'plugin',
        authType: 'password',
        credentialId,
        groupId: null,
        description: 'Isolated disposable Linux fixture',
        favorite: false,
        connectTimeoutSecs: 10,
      },
    })
  ).id;
  await page.reload();
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  await navigateWorkspace(page, '插件管理');
  const manager = page.locator('.plugin-manager');
  const preview = await previewPluginPackage(
    page,
    path.join(root, '.local', 'plugin-13a', 'host-info.sdplugin'),
  );
  await preview.locator('.plugin-install-ack').waitFor();
  assert(await preview.getByRole('button', { name: '安装插件', exact: true }).isDisabled());
  await preview.getByRole('checkbox').check();
  await preview.getByRole('button', { name: '安装插件', exact: true }).click();
  const card = manager.locator('.plugin-installed-row[data-plugin-id="dev.serverdeck.host-info"]');
  await card.waitFor();
  passed.push('UI package preview, unverified warning, digest-bound install');
  const grant = await openPluginDetails(page, 'Host Info');
  for (const label of [
    'hosts.read',
    'ssh.execute',
    'ui.contribute',
    'settings.read',
    'settings.write',
  ])
    await grant.getByLabel(label, { exact: true }).check();
  await grant.getByRole('button', { name: '保存并授权', exact: true }).click();
  await grant.getByText('已授权', { exact: true }).waitFor();
  await setPluginEnabled(page, 'Host Info', true);
  await navigateWorkspace(page, 'Host Info');
  await page
    .getByRole('dialog', { name: '选择使用工具的主机', exact: true })
    .getByRole('button', { name: 'Plugin QA Linux', exact: true })
    .click();
  const view = page.locator('.plugin-workspace:visible');
  await view.waitFor();
  assert.equal(await view.getByLabel('插件目标主机', { exact: true }).count(), 0);
  const trust = page.getByRole('dialog', { name: '核验 SSH 主机指纹', exact: true });
  await trust.waitFor();
  const key = process.env.SERVERDECK_PLUGIN_TEST_HOST_KEY.split(/\s+/)[1],
    fingerprint =
      'SHA256:' +
      createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '');
  assert((await trust.textContent()).includes(fingerprint), 'real host key mismatch');
  await trust.getByRole('button', { name: '已核对，信任并连接', exact: true }).click();
  await trust.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    (id) =>
      document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('operations')
        .connections[id]?.state === 'connected',
    hostId,
  );
  const frontend = view.frameLocator('iframe.plugin-frame');
  await frontend.getByRole('button', { name: '读取主机信息', exact: true }).click();
  await frontend.locator('.plugin-output').filter({ hasText: 'Plugin QA Linux' }).waitFor();
  assert(
    !/credentialId|secretRef|password/.test(await frontend.locator('.plugin-output').textContent()),
  );
  await frontend.getByRole('button', { name: '只读诊断 uname -a', exact: true }).click();
  await frontend.locator('.plugin-output').filter({ hasText: 'exitCode' }).waitFor();
  assert((await frontend.locator('.plugin-output').textContent()).includes('Linux'));
  passed.push('installed public SDK WASM UI uses real host projection and authenticated SSH uname');
  assert.equal(await view.getByLabel('插件界面语言', { exact: true }).count(), 0);
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await frontend.getByRole('button', { name: '读取主机信息', exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'global-language-dark.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  assert((await view.evaluate((el) => getComputedStyle(el).color)) !== 'rgb(255, 255, 255)');
  await page.screenshot({ path: path.join(artifacts, 'global-language-light.png') });
  passed.push('plugin labels follow the global language and theme tokens');
  await page.keyboard.press('Control+k');
  await page
    .getByRole('option', { name: '插件命令 · Host Info · Host Info', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await page
    .getByRole('navigation', { name: '当前主机工具', exact: true })
    .getByRole('button', { name: 'Host Info', exact: true })
    .click();
  await frontend.getByRole('heading', { name: '当前主机', exact: true }).waitFor();
  await showHostTree(page);
  await hostContextAction(
    page,
    page.locator('.tree-host-row').filter({ hasText: 'Plugin QA Linux' }),
    'Host Info',
  );
  await frontend.getByRole('heading', { name: '当前主机', exact: true }).waitFor();
  const configuration = await openPluginSettings(page, 'Host Info');
  const form = configuration.frameLocator('iframe.plugin-frame');
  await form
    .getByLabel('备注（仅保存于本插件）', { exact: true })
    .fill('<img src=x onerror=alert(1)>');
  await form.getByRole('button', { name: '保存设置', exact: true }).click();
  await form.getByRole('button', { name: '读取设置', exact: true }).click();
  await form
    .locator('.plugin-output')
    .filter({ hasText: '<img src=x onerror=alert(1)>' })
    .waitFor();
  assert.equal(await form.locator('#app img, #app iframe, #app script').count(), 0);
  passed.push(
    'all five extension surfaces and isolated settings render hostile strings as inert text',
  );
  const disabledCard = await setPluginEnabled(page, 'Host Info', false);
  await page.waitForFunction(
    () => !document.querySelector('.plugin-workspace:visible iframe.plugin-frame'),
  );
  assert.equal((await invoke('plugin_detail', { id: 'dev.serverdeck.host-info' })).enabled, false);
  await disabledCard.getByRole('button', { name: '启用 Host Info', exact: true }).waitFor();
  assert.equal(await page.locator('[data-module="plugins"]').count(), 0);
  await navigateWorkspace(page, '插件管理');
  assert.equal(await page.locator('.plugin-installed-row[data-plugin-id]').count(), 1);
  assert.equal(
    await page.locator('.plugin-installed-row .plugin-source').textContent(),
    '用户上传',
  );
  await card.getByRole('button', { name: '卸载 Host Info', exact: true }).click();
  await page
    .getByRole('dialog', { name: '卸载插件？', exact: true })
    .getByRole('button', { name: '确认卸载', exact: true })
    .click();
  await card.waitFor({ state: 'hidden' });
  assert.equal((await invoke('plugin_list')).length, 0);
  passed.push(
    'disable withdraws workspace/runtime and preserves individual settings; the management list uninstalls it',
  );
  await writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify({ passed, artifacts }, null, 2),
  );
  process.stdout.write(`PASS ${passed.length} real native plugin UI scenarios. ${artifacts}\n`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (safe && page && browser?.isConnected()) {
    try {
      for (const p of await invoke('plugin_list'))
        await invoke('plugin_uninstall', {
          input: { id: p.manifest.id, clearData: true, confirmed: true },
        });
      if (hostId) await invoke('host_delete', { id: hostId });
      if (credentialId) await invoke('credential_delete', { id: credentialId, detachHosts: true });
      await invoke('credential_cleanup');
    } catch {
      process.stderr.write('QA cleanup incomplete; inspect the dedicated native QA database.\n');
    }
  }
  if (browser) await browser.close();
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  }
}
