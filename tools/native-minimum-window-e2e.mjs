// Real Windows/WebView2, isolated SQLite profile, no hosts or remote operations.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace, closeApplicationSettings } from './ui-navigation.mjs';

assert.equal(process.platform, 'win32');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, '.local/qa/minimum-window', String(Date.now()));
await mkdir(artifacts, { recursive: true });
const config = path.join(artifacts, 'tauri-qa.json');
await writeFile(
  config,
  JSON.stringify({
    identifier: 'cn.hiboot.desktop.minimum-window-qa',
    app: {
      appDirectoriesOverride: artifacts,
      security: {
        capabilities: [
          'main',
          {
            identifier: 'minimum-window-test',
            windows: ['main'],
            permissions: ['core:window:allow-set-size'],
          },
        ],
      },
    },
  }),
);
const executable = path.join(artifacts, 'ServerDeckMinimumWindowQA.exe');
function build(extra) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'tools/tauri.mjs'), 'build', '--debug', '--no-bundle', ...extra],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'native build failed');
}
try {
  build(['--config', config]);
  await copyFile(path.join(root, 'target/debug/serverdeck-desktop.exe'), executable);
} finally {
  build([]);
}

async function launch() {
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const child = spawn(executable, [], {
    cwd: artifacts,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  child.unref();
  let endpoint;
  for (let index = 0; index < 100 && !endpoint; index++) {
    assert.equal(child.exitCode, null, 'QA exited before WebView2 was ready');
    try {
      endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch {}
    if (!endpoint) await delay(200);
  }
  assert(endpoint, 'WebView2 debugger unavailable');
  const browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  page.setDefaultTimeout(15000);
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  assert.equal(
    path.resolve((await invoke('app_bootstrap')).dataDirectory),
    artifacts,
    'refusing non-QA data',
  );
  return { child, browser, page, invoke };
}
async function shutdown(session) {
  if (session.child.exitCode === null) {
    await closeApplicationSettings(session.page);
    await session.invoke('app_exit_confirm', { confirmed: false }).catch(() => {});
    for (let index = 0; index < 150 && session.child.exitCode === null; index++) await delay(100);
    assert.equal(session.child.exitCode, 0, 'QA must exit normally');
  }
  await session.browser.close();
}
async function reachable(locator, name) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ trial: true });
  assert(await locator.isEnabled(), `${name}: disabled`);
  const geometry = await locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      visible:
        r.width > 0 &&
        r.height > 0 &&
        r.left >= 0 &&
        r.top >= 0 &&
        r.right <= innerWidth + 1 &&
        r.bottom <= innerHeight + 1,
      clear: element === hit || element.contains(hit),
    };
  });
  assert(
    geometry.visible && geometry.clear,
    `${name}: clipped or covered ${JSON.stringify(geometry)}`,
  );
}

function nativeMinimum(pid) {
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MinimumWindowQa {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MinMax {
    public Point Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, ref MinMax l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
[MinimumWindowQa]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$handle = (Get-Process -Id ${pid} -ErrorAction Stop).MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'Missing isolated QA window' }
$limits = [MinimumWindowQa+MinMax]::new()
[MinimumWindowQa]::SendMessage($handle, 0x24, [IntPtr]::Zero, [ref]$limits) | Out-Null
$outer = [MinimumWindowQa+Rect]::new()
$inner = [MinimumWindowQa+Rect]::new()
if (-not [MinimumWindowQa]::GetWindowRect($handle, [ref]$outer)) { throw 'Window bounds unavailable' }
if (-not [MinimumWindowQa]::GetClientRect($handle, [ref]$inner)) { throw 'Client bounds unavailable' }
$scale = [MinimumWindowQa]::GetDpiForWindow($handle) / 96.0
@{
  width = ($limits.MinTrackSize.X - (($outer.Right - $outer.Left) - $inner.Right)) / $scale
  height = ($limits.MinTrackSize.Y - (($outer.Bottom - $outer.Top) - $inner.Bottom)) / $scale
  scale = $scale
} | ConvertTo-Json -Compress
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const minimum = JSON.parse(result.stdout.trim());
  assert(Math.abs(minimum.width - 960) <= 1, JSON.stringify(minimum));
  assert(Math.abs(minimum.height - 600) <= 1, JSON.stringify(minimum));
  return minimum;
}

// Seed a formerly valid 900px saved width, then verify the real restore path.
const seed = await launch();
await shutdown(seed);
const database = new DatabaseSync(path.join(artifacts, 'serverdeck.sqlite3'));
database
  .prepare(
    "INSERT INTO application_settings(key,value) VALUES('window_geometry',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  )
  .run(JSON.stringify({ width: 900, height: 600, maximized: false }));
database.close();
const session = await launch();
const { page, invoke } = session;
const errors = [],
  results = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const dimensions = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.deepEqual(
    await dimensions(),
    { width: 960, height: 600 },
    'saved width must restore at new minimum',
  );
  const minimum = nativeMinimum(session.child.pid);
  await invoke('plugin:window|set_size', {
    label: 'main',
    value: { Logical: { width: 960, height: 600 } },
  });
  await page.waitForFunction(() => innerWidth === 960 && innerHeight === 600);
  assert.deepEqual(
    await dimensions(),
    { width: 960, height: 600 },
    'native viewport must match the configured minimum',
  );

  for (const [theme, size, label] of [
    ['dark', 'standard', '标准'],
    ['light', 'standard', '标准'],
    ['dark', 'ultraLarge', '超大'],
    ['light', 'ultraLarge', '超大'],
  ]) {
    const name = `${theme}-${size}`;
    await navigateWorkspace(page, '通用');
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByTestId('theme-select').selectOption(theme);
    await settings
      .locator('.interface-font-ticks')
      .getByRole('button', { name: label, exact: true })
      .click();
    for (const notice of await page.getByRole('button', { name: '关闭通知', exact: true }).all())
      await notice.click();
    const save = settings.getByRole('button', { name: '保存设置', exact: true });
    await reachable(save, `${name}: save`);
    await save.click();
    await page.getByText('设置已保存', { exact: false }).first().waitFor();
    const saved = (await invoke('app_bootstrap')).config;
    assert.equal(saved.theme, theme);
    assert.equal(saved.interfaceFontSize, size);

    for (const category of ['通用', '终端', '快捷键', '数据与存储', '模型管理', '插件', '关于']) {
      await navigateWorkspace(page, category === '插件' ? '插件管理' : category);
      await reachable(
        settings
          .locator(':scope > .modal-heading')
          .getByRole('button', { name: '关闭对话框', exact: true }),
        `${name}/${category}: close`,
      );
      assert(
        await settings.evaluate((dialog) => {
          const r = dialog.getBoundingClientRect();
          const content = dialog.querySelector('.settings-dialog-content');
          return (
            r.left >= 0 &&
            r.top >= 0 &&
            r.right <= innerWidth + 1 &&
            r.bottom <= innerHeight + 1 &&
            document.documentElement.scrollWidth <= innerWidth &&
            content.scrollWidth <= content.clientWidth + 1
          );
        }),
        `${name}/${category}: overflow`,
      );
      if (['通用', '终端', '快捷键', '数据与存储'].includes(category))
        await reachable(save, `${name}/${category}: save`);
    }
    await navigateWorkspace(page, '插件管理');
    await settings.getByRole('button', { name: '配置 AI 运维助手', exact: true }).click();
    const cancel = settings
      .locator('.plugin-config-footer')
      .getByRole('button', { name: '取消', exact: true });
    await reachable(cancel, `${name}: plugin cancel`);
    await page.screenshot({ path: path.join(artifacts, `${name}-plugin-settings.png`) });
    await cancel.click();
    await settings.locator('.plugin-manager').waitFor();
    assert.equal(await settings.locator('.plugin-configuration').count(), 0);
    await settings
      .locator(':scope > .modal-heading')
      .getByRole('button', { name: '关闭对话框', exact: true })
      .click();
    await settings.waitFor({ state: 'detached' });

    await navigateWorkspace(page, '通用');
    await page.screenshot({ path: path.join(artifacts, `${name}-general.png`) });
    const selectTheme = settings.getByTestId('theme-select');
    const draftTheme = theme === 'dark' ? 'light' : 'dark';
    await selectTheme.selectOption(draftTheme);
    const close = settings
      .locator(':scope > .modal-heading')
      .getByRole('button', { name: '关闭对话框', exact: true });
    await close.click();
    const prompt = page.getByRole('dialog', { name: '设置尚未保存', exact: true });
    const continueEditing = prompt.getByRole('button', { name: '继续编辑', exact: true });
    await reachable(continueEditing, `${name}: cancel close`);
    await continueEditing.click();
    await prompt.waitFor({ state: 'detached' });
    assert.equal(await selectTheme.inputValue(), draftTheme);
    assert.equal((await invoke('app_bootstrap')).config.theme, theme);
    await close.click();
    const discard = prompt.getByRole('button', { name: '放弃更改并关闭', exact: true });
    await reachable(discard, `${name}: discard close`);
    await discard.click();
    await settings.waitFor({ state: 'detached' });
    await navigateWorkspace(page, '通用');
    assert.equal(await selectTheme.inputValue(), theme);
    await settings.press('Escape');
    await settings.waitFor({ state: 'detached' });
    results.push({
      name,
      width: 960,
      height: 600,
      categories: 7,
      save: true,
      cancel: true,
      close: true,
      unsavedGuard: true,
      noOverflow: true,
    });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify(
      { artifacts, restoredSaved900: true, nativeMinimum: minimum, results, errors },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ artifacts, results }));
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await shutdown(session);
}
