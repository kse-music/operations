import {
  hostContextAction,
  hostTreeAction,
  navigateWorkspace,
  reloadHosts,
  showHostTree,
} from './ui-navigation.mjs';
// Real packaged WebView2 + Rust IPC + SQLite + OS credential store. No IPC mocking.
// Test config and browser debugging apply only to a copied, isolated test executable.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

if (process.platform !== 'win32')
  throw new Error('This native E2E harness is verified only on Windows/WebView2.');
const root = fileURLToPath(new URL('../', import.meta.url));
const cleanupOnly = process.argv[2] === '--cleanup';
const artifacts = cleanupOnly
  ? path.resolve(process.argv[3] ?? '')
  : path.join(root, '.local', 'native-e2e', `${Date.now()}-${randomUUID()}`);
assert(
  path.dirname(artifacts) === path.join(root, '.local', 'native-e2e'),
  'invalid test artifacts directory',
);
await mkdir(artifacts, { recursive: true });
const config = path.join(artifacts, 'tauri-e2e.json');
await writeFile(
  config,
  JSON.stringify({
    identifier: 'cn.hiboot.desktop.e2e',
    app: { appDirectoriesOverride: artifacts },
  }),
);
function build(args) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'tools', 'tauri.mjs'), 'build', '--debug', '--no-bundle', ...args],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'native build failed');
}
const executable = path.join(artifacts, 'ServerDeckE2E.exe');
if (!cleanupOnly) {
  build(['--config', config]);
  await copyFile(path.join(root, 'target', 'debug', 'serverdeck-desktop.exe'), executable);
  // Restore the normal deliverable before running the isolated test copy.
  build([]);
}
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
let child;
let browser;
let page;
let safeScope = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function start() {
  const port = await freePort();
  child = spawn(executable, [], {
    cwd: artifacts,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
      WEBVIEW2_USER_DATA_FOLDER: path.join(artifacts, 'webview'),
    },
  });
  const deadline = Date.now() + 20000;
  let connected = false;
  let websocket;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        websocket = (await response.json()).webSocketDebuggerUrl;
        if (websocket) {
          connected = true;
          break;
        }
      }
    } catch {}
    if (child.exitCode !== null) throw new Error(`Native test process exited: ${child.exitCode}`);
    await delay(200);
  }
  assert(connected, 'WebView2 CDP did not start');
  browser = await chromium.connectOverCDP(websocket);
  page = browser.contexts()[0].pages()[0];
  assert(page, 'missing native WebView page');
  page.setDefaultTimeout(10000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  await showHostTree(page);
  const bootstrap = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_bootstrap'));
  assert.equal(
    path.resolve(bootstrap.dataDirectory),
    path.resolve(artifacts),
    'refusing to mutate a non-test data directory',
  );
  safeScope = true;
  await page.locator('.tree-group[data-group-id=""] > .group-toggle').waitFor();
}
async function stop() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = undefined;
  }
  if (child && child.exitCode === null) {
    const current = child;
    current.kill();
    await Promise.race([new Promise((resolve) => current.once('exit', resolve)), delay(5000)]);
  }
  child = undefined;
}
const dialog = (name) => page.getByRole('dialog', { name, exact: true });
const row = (name) =>
  page.locator('.tree-host-row').filter({ has: page.getByText(name, { exact: true }) });
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
// Host context actions were removed; retain backend contract coverage as explicitly named IPC tests.
async function updateTestHost(name, changes) {
  const host = (await invoke('host_list')).hosts.find((item) => item.name === name);
  assert(host, `missing isolated host: ${name}`);
  const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = host;
  await invoke('host_update', { id, input: { ...input, ...changes } });
  await reloadHosts(page);
}
async function showHosts() {
  await showHostTree(page);
}
const secret = `e2e-only-${randomUUID()}`;
const passphrase = `e2e-passphrase-${randomUUID()}`;
const results = [];
try {
  await start();
  if (cleanupOnly) {
    process.stdout.write('Connected to isolated test run for cleanup.\n');
  } else {
    await hostTreeAction(page, null, '新建文件夹');
    let form = dialog('新建文件夹');
    await form.getByLabel('文件夹名称', { exact: true }).fill('验收分组');
    await form.getByRole('button', { name: '新建文件夹', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    const groupId = (await invoke('host_list')).groups.find((g) => g.name === '验收分组').id;
    await hostTreeAction(page, groupId, '新建主机');
    form = dialog('新建主机');
    await form.getByLabel('主机名称（可选）', { exact: true }).fill('E2E-Host');
    await form.getByLabel('地址（IP / 域名）', { exact: true }).fill('127.0.0.1');
    await form.getByLabel('SSH 端口', { exact: true }).fill(String(await freePort()));
    await form.getByLabel('用户名', { exact: true }).fill('ops');
    await form.getByLabel('SSH 密码', { exact: true }).fill(secret);
    assert.equal(await form.getByLabel('分组', { exact: true }).count(), 0);
    assert.equal(await form.getByLabel('标签（逗号分隔）', { exact: true }).count(), 0);
    assert.equal(await form.getByLabel('备注', { exact: true }).count(), 0);
    assert.equal(await form.getByLabel('收藏此主机', { exact: true }).count(), 0);
    const save = form.getByRole('button', { name: '保存主机', exact: true });
    assert(await save.isDisabled());
    assert.equal(await form.getByRole('button', { name: '取消', exact: true }).count(), 0);
    await form.getByRole('button', { name: '测试连接', exact: true }).click();
    await form.getByRole('alert').waitFor();
    assert(await save.isDisabled());
    assert.equal((await invoke('host_list')).hosts.length, 0);
    await form.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await invoke('host_create', {
      input: {
        name: 'E2E-Host',
        hostname: '192.0.2.25',
        port: 22,
        username: 'ops',
        authType: 'password',
        credentialId: null,
        groupId,
        tags: [],
        description: '',
        favorite: false,
        connectTimeoutSecs: 15,
      },
      authentication: { kind: 'password', password: secret },
    });
    await reloadHosts(page);
    await row('E2E-Host').waitFor();
    results.push('native new-host form blocks saving after real loopback connection refusal');
    await updateTestHost('E2E-Host', {
      hostname: 'updated.example.com',
      description: '端到端修改与重启验证',
    });
    await row('E2E-Host').getByText('updated.example.com', { exact: true }).waitFor();
    assert(
      (await row('E2E-Host').locator('.tree-host').getAttribute('title')).includes(
        'ops@updated.example.com:22',
      ),
    );
    results.push('native host update via real IPC, reflected in the sidebar');
    await page.locator('.module-navigation [data-module="hosts"]').click();
    const expand = page.getByRole('button', { name: '展开主机栏', exact: true });
    if (await expand.isVisible()) await expand.click();
    const original = (await invoke('host_list')).hosts.find((item) => item.name === 'E2E-Host');
    await invoke('host_copy', { id: original.id });
    await reloadHosts(page);
    await row('E2E-Host 副本').waitFor();
    results.push('native host copy via real IPC, without a host menu UI');
    assert(original.credentialId, 'inline password must be attached to its host');
    await hostContextAction(page, row('E2E-Host 副本').locator('.tree-host'), '编辑主机');
    form = dialog('编辑主机');
    assert.equal(
      await form.getByLabel('SSH 密码', { exact: true }).inputValue(),
      '',
      'saved secrets must not be sent back to the UI',
    );
    assert.equal(await form.getByRole('button', { name: '取消', exact: true }).count(), 0);
    const address = form.getByLabel('地址（IP / 域名）', { exact: true });
    const port = form.getByLabel('SSH 端口', { exact: true });
    const previousAddress = await address.inputValue();
    await address.fill('127.0.0.1');
    await port.fill(String(await freePort()));
    const saveEdit = form.getByRole('button', { name: '保存主机', exact: true });
    assert(await saveEdit.isDisabled());
    await form.getByRole('button', { name: '测试连接', exact: true }).click();
    await form
      .getByRole('alert')
      .filter({ hasText: /连接|SSH/ })
      .waitFor();
    assert(await saveEdit.isDisabled());
    assert.equal(
      (await invoke('host_list')).hosts.find((host) => host.name === 'E2E-Host 副本').hostname,
      previousAddress,
    );
    results.push(
      'native host edit with saved authentication blocks saving after a refused SSH connection',
    );
    await form
      .getByLabel('认证方式', { exact: true })
      .selectOption({ label: '公钥认证（PublicKey）' });
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyData = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase,
    });
    await form.getByLabel('选择私钥文件', { exact: true }).setInputFiles({
      name: 'e2e-ed25519.key',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(keyData),
    });
    await form.getByLabel('加密私钥口令（可选）', { exact: true }).fill(passphrase);
    assert(await saveEdit.isDisabled());
    await form.getByRole('button', { name: '关闭对话框', exact: true }).click();
    const {
      id: copyId,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...copyInput
    } = (await invoke('host_list')).hosts.find((host) => host.name === 'E2E-Host 副本');
    // Offline persistence fixture. The real form is gated even for this test host.
    await invoke('host_update', {
      id: copyId,
      input: { ...copyInput, authType: 'private_key', credentialId: null },
      authentication: { kind: 'private_key', keyData, passphrase },
    });
    await reloadHosts(page);
    const saved = await invoke('host_list');
    const edited = saved.hosts.find((host) => host.name === 'E2E-Host 副本');
    assert.equal(edited.authType, 'private_key');
    assert(edited.credentialId && edited.credentialId !== original.credentialId);
    assert.equal(
      saved.hosts.find((host) => host.id === original.id).credentialId,
      original.credentialId,
    );
    assert.deepEqual(saved.credentials, []);
    await navigateWorkspace(page, '模型管理');
    assert.deepEqual(
      await page
        .locator('.module-menu [aria-label]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
      ['通用', '终端', '快捷键', '数据与存储', '模型管理', '关于'],
    );
    await showHosts();
    const database = await readFile(path.join(artifacts, 'serverdeck.sqlite3'));
    assert(
      !database.includes(Buffer.from(secret)) && !database.includes(Buffer.from(passphrase)),
      'plaintext secret found in SQLite',
    );
    const log = await readFile(path.join(artifacts, 'logs', 'serverdeck.log'), 'utf8');
    assert(!log.includes(secret) && !log.includes(passphrase), 'secret found in logs');
    results.push(
      'native PublicKey form selection, IPC fixture import, copy isolation and no secret readback or leak',
    );
    await stop();
    await start();
    await row('E2E-Host').waitFor();
    assert.equal(await page.locator('.tree-host-row').count(), 2);
    assert.equal(
      (await invoke('host_list')).hosts.find((item) => item.name === 'E2E-Host').description,
      '端到端修改与重启验证',
    );
    results.push('native process restart restores SQLite data');
    await showHostTree(page);
    await hostTreeAction(page, null, '导入 OpenSSH Config…');
    form = dialog('导入 OpenSSH Config');
    await form
      .getByLabel('OpenSSH Config 内容', { exact: true })
      .fill(
        'Host E2E-Host\n HostName updated.example.com\n User ops\nHost imported-new\n HostName imported.example.com\n User ops\nHost blocked\n HostName direct.example.com\n ProxyJump jump',
      );
    await form.getByRole('button', { name: '生成导入预览', exact: true }).click();
    await form.getByText('此条目已阻止导入。', { exact: true }).waitFor();
    await form
      .getByLabel('已检查预览、认证方式与警告，确认只导入选中的条目。', { exact: true })
      .check();
    await form.getByRole('button', { name: '导入 1 台主机', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    await row('imported-new').waitFor();
    results.push('native OpenSSH preview + duplicates + unsafe option blocking + selective import');
    assert.deepEqual(
      await page
        .locator('.host-list-heading button')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
      ['本地终端'],
    );
    assert.equal(await page.getByLabel('选择 ServerDeck 主机文件', { exact: true }).count(), 0);
    for (const command of ['hosts_export', 'hosts_import_archive']) {
      await assert.rejects(invoke(command, { text: '{}' }), /not allowed|not found/);
    }
    const catalog = await invoke('host_list');
    assert.equal(catalog.hosts.length, 3);
    await page.screenshot({ path: path.join(artifacts, 'hosts.png') });
    for (const host of catalog.hosts) await invoke('host_delete', { id: host.id });
    await reloadHosts(page);
    await page.getByText('尚未添加主机', { exact: true }).waitFor();
    results.push('host JSON controls and commands are unavailable');
    await navigateWorkspace(page, '数据与存储');
    await page.getByLabel('默认下载目录', { exact: true }).waitFor();
    assert.equal(await page.getByRole('group', { name: '系统凭据库', exact: true }).count(), 0);
    assert.equal((await invoke('credential_status')).available, true);
    const afterDeletion = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('host_list'));
    assert.equal(afterDeletion.pendingSecretDeletions, 0);
    results.push('native OS secret deletion');
    await stop();
    await start();
    await page.getByText('尚未添加主机', { exact: true }).waitFor();
    results.push('deletion persists after a second restart');
    await writeFile(
      path.join(artifacts, 'results.json'),
      JSON.stringify({ passed: results, artifacts }, null, 2),
    );
    process.stdout.write(`PASS ${results.length} native scenarios. Artifacts: ${artifacts}\n`);
  }
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (safeScope && page && browser?.isConnected()) {
    // Cleanup only this run's isolated data and random OS references, even after a failed assertion.
    try {
      await page.evaluate(async () => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const catalog = await invoke('host_list');
        for (const host of catalog.hosts) await invoke('host_delete', { id: host.id });
        for (const credential of catalog.credentials)
          await invoke('credential_delete', { id: credential.id, detachHosts: true });
        for (const group of catalog.groups) await invoke('group_delete', { id: group.id });
        await invoke('credential_cleanup');
      });
    } catch {
      process.stderr.write(
        'Test cleanup incomplete; isolated metadata and OS references remain in the artifacts directory.\n',
      );
    }
  }
  await stop();
}
