// Run against an isolated Windows debug build with appDirectoriesOverride set to QA_DIR/data.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { closeNativeWindow } from './native-window-close.mjs';
import { navigateWorkspace, openPluginSettings, previewPluginPackage } from './ui-navigation.mjs';

assert.equal(process.platform, 'win32');
assert(process.argv[2], 'Usage: node tools/native-plugin-development-kit-e2e.mjs QA_DIR');
const qa = await realpath(process.argv[2]);
const data = path.join(qa, 'data');
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const temp = await realpath(tmpdir());
const relativeTemp = path.relative(root, temp);
assert(
  relativeTemp.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTemp),
  'The sample must be built outside the repository',
);
const external = await mkdtemp(path.join(temp, 'serverdeck-plugin-kit-'));
const sample = path.join(external, 'starter project');
await mkdir(sample);

function run(program, args) {
  const result = spawnSync(program, args, { cwd: sample, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} ${args.join(' ')}`);
}

function answerSaveDialog(pid, destination) {
  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    path.join(root, 'tools/native-save-dialog.ps1'),
    '-AppProcessId',
    String(pid),
    '-DialogTitle',
    '保存插件开发包',
    ...(destination ? ['-Destination', destination] : []),
  ]);
}

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const child = spawn(path.join(qa, 'PluginDevelopmentKitQa.exe'), [], {
  cwd: qa,
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    WEBVIEW2_USER_DATA_FOLDER: path.join(qa, 'webview'),
  },
});
let browser, page;
try {
  let endpoint;
  for (let attempt = 0; attempt < 100 && !endpoint; attempt++) {
    if (child.exitCode !== null) throw new Error(`QA application exited ${child.exitCode}`);
    try {
      endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch {}
    if (!endpoint) await delay(200);
  }
  assert(endpoint, 'QA WebView2 debugger unavailable');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages()[0];
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const bootstrap = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_bootstrap'));
  assert.equal(path.resolve(bootstrap.dataDirectory), data, 'refuse non-QA data directory');
  await navigateWorkspace(page, '插件管理');

  const save = page.getByRole('button', { name: '下载插件开发包', exact: true });
  assert.equal(await save.evaluate((el) => el.nextElementSibling.textContent.trim()), '安装插件');
  await page.screenshot({ path: path.join(qa, 'plugin-management.png') });
  await save.click();
  answerSaveDialog(child.pid);
  await save.and(page.locator(':enabled')).waitFor();
  assert.deepEqual(await readdir(external), ['starter project']);
  assert.equal(await page.getByText(/^插件开发包已保存到 /).count(), 0);

  const zip = path.join(external, 'serverdeck-plugin-development-kit.zip');
  await save.click();
  answerSaveDialog(child.pid, zip);
  await page.getByText(`插件开发包已保存到 ${zip}`, { exact: true }).waitFor();
  run('tar.exe', ['-xf', zip]);
  assert.match(await readFile(path.join(sample, 'docs/plugins/PLUGIN_SDK.md'), 'utf8'), /4\.0\.0/);

  const manifestPath = path.join(sample, 'example/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.id = `dev.qa.hello-${path.basename(external).slice(-6).toLowerCase()}`;
  manifest.name = '仓库外插件样例';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const pageSource = path.join(sample, 'example/frontend/App.vue');
  await writeFile(
    pageSource,
    (await readFile(pageSource, 'utf8')).replace('<h1>问候示例</h1>', '<h1>仓库外构建的页面</h1>'),
  );
  const wasmSource = path.join(sample, 'example/backend/src/lib.rs');
  await writeFile(
    wasmSource,
    (await readFile(wasmSource, 'utf8')).replace(
      '你好，{name}！',
      '独立构建的 WASM 向 {name} 问好！',
    ),
  );
  const cmd = process.env.ComSpec ?? 'cmd.exe';
  run(cmd, ['/d', '/c', 'npm.cmd', 'ci', '--no-audit', '--no-fund']);
  run('cargo', [
    'fetch',
    '--manifest-path',
    'example/backend/Cargo.toml',
    '--target',
    'wasm32-unknown-unknown',
    '--locked',
  ]);
  run(cmd, ['/d', '/c', 'npm.cmd', 'run', 'package']);

  const preview = await previewPluginPackage(page, path.join(sample, 'example.sdplugin'));
  await preview.getByRole('heading', { name: manifest.name, exact: true }).waitFor();
  await preview.getByRole('checkbox', { name: /确认安装/ }).check();
  await preview.getByRole('button', { name: '安装插件', exact: true }).click();
  await preview.waitFor({ state: 'hidden' });
  const configuration = await openPluginSettings(page, manifest.name);
  await configuration.getByRole('checkbox', { name: 'ui.contribute', exact: true }).check();
  await configuration.getByRole('button', { name: '保存并授权', exact: true }).click();
  await configuration.getByText('已授权', { exact: true }).waitFor();
  await configuration.getByRole('button', { name: '启用插件', exact: true }).click();
  await configuration.getByRole('button', { name: '插件配置', exact: true }).click();

  const frame = configuration.frameLocator('iframe');
  await frame.getByRole('heading', { name: '仓库外构建的页面', exact: true }).waitFor();
  const name = frame.getByRole('textbox', { name: '姓名', exact: true });
  const greet = frame.getByRole('button', { name: '生成问候', exact: true });
  await name.fill(' ');
  await greet.click();
  await frame.getByRole('alert').filter({ hasText: '请输入姓名' }).waitFor();
  await name.fill('ServerDeck');
  await greet.click();
  await frame.getByText('独立构建的 WASM 向 ServerDeck 问好！', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(qa, 'installed-sample.png') });
  const result = { downloadedZip: zip, independentProject: sample, plugin: manifest.id };
  await writeFile(path.join(qa, 'results.json'), JSON.stringify(result, null, 2));
  console.log(
    'PASS native download, external build, upload, authorization, and WASM invocation',
    result,
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(qa, 'failure.png'), timeout: 3000 }).catch(() => {});
    const notices = await page
      .getByText(/^插件开发包保存失败/)
      .allTextContents()
      .catch(() => []);
    if (notices.length) console.error(notices);
  }
  throw error;
} finally {
  try {
    if (child.pid && child.exitCode === null) {
      closeNativeWindow(child.pid);
      await page
        ?.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true })
        .getByRole('button', { name: '确认', exact: true })
        .click({ timeout: 5000 })
        .catch(() => {});
      for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) await delay(100);
      assert.notEqual(child.exitCode, null, 'The isolated QA application did not exit');
    }
  } finally {
    await browser?.close();
  }
}
