import { networkFixture } from './plugin-fixtures.mjs';
// Real WebView2, installed packages, Wasm and SQLite in a fresh QA profile.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { navigateWorkspace, setPluginEnabled } from './ui-navigation.mjs';
import { closeNativeWindow } from './native-window-close.mjs';
import { checkWorkspaceTools } from './plugin-workspace-checks.mjs';
import { checkPluginComponents } from './plugin-components-checks.mjs';

assert.equal(process.platform, 'win32');
const root = fileURLToPath(new URL('../', import.meta.url));
const reuse = process.argv[2] === '--reuse';
const run = reuse
  ? path.resolve(process.argv[3])
  : path.join(root, '.local', 'plugin-ui-isolation', randomUUID());
assert.equal(path.dirname(run), path.join(root, '.local', 'plugin-ui-isolation'));
await mkdir(run, { recursive: true });
const config = path.join(run, 'qa.json'),
  executable = path.join(run, 'PluginUiQa.exe');
await writeFile(
  config,
  JSON.stringify({
    identifier: `cn.hiboot.pluginui.qa${path.basename(run).replaceAll('-', '')}`,
    app: { appDirectoriesOverride: run },
  }),
);
const buildDirectory = path.join(root, '.local', 'native-ui-build');
if (!reuse) {
  const fixture = spawnSync(
    process.execPath,
    [
      path.join(root, 'tools/build-plugin.mjs'),
      'tests/fixtures/plugins/custom-ui',
      path.join(run, 'custom-ui.sdplugin'),
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  if (fixture.error) throw fixture.error;
  assert.equal(fixture.status, 0, 'custom UI fixture build failed');
  const build = spawnSync(
    process.execPath,
    [path.join(root, 'tools/tauri.mjs'), 'build', '--debug', '--no-bundle', '--config', config],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, CARGO_TARGET_DIR: buildDirectory },
    },
  );
  if (build.error) throw build.error;
  assert.equal(build.status, 0, 'QA build failed');
  await copyFile(path.join(buildDirectory, 'debug', 'serverdeck-desktop.exe'), executable);
}
if (!reuse && process.env.SERVERDECK_PLUGIN_COMPONENT_FIXTURE) {
  // Old enabled records must be retired before the new SDK decodes their removed permissions.
  const template = JSON.parse(
    await readFile(path.join(root, 'plugins/system/packages/services.sdplugin'), 'utf8'),
  ).manifest;
  for (const [name, permission] of [
    ['batch', 'batch.run'],
    ['automation', 'automation.manage'],
    ['resources', 'metrics.read'],
    ['processes', 'system.read'],
    ['logs', 'logs.read'],
    ['network', 'network.run'],
  ]) {
    const id = `cn.hiboot.plugins.${name}`;
    const folder = path.join(run, 'plugins/packages', id);
    const data = path.join(run, 'plugins/data', id);
    await mkdir(folder, { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(
      path.join(folder, 'record.json'),
      JSON.stringify({
        version: 1,
        current: {
          source: 'system',
          manifest: { ...template, id, version: '1.1.2', permissions: [permission] },
          enabled: true,
          trust: 'local_development_unverified',
          packageDigest: '0'.repeat(64),
          revision: 'version-retired',
          previousVersion: null,
        },
        backup: null,
      }),
    );
    await writeFile(
      path.join(data, 'settings.json'),
      JSON.stringify({ retained: 'owned upgrade fixture' }),
    );
  }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(() => resolve(value));
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
let browser,
  page,
  safe = false;
const passed = [],
  errors = [];
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const scope = () => page.frameLocator('.plugin-frame-container:visible iframe');
async function open(name) {
  await navigateWorkspace(page, name);
  await scope().locator('#app > *').waitFor();
  return scope();
}
async function refreshPlugins() {
  await page.evaluate(async () => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    await pinia._s.get('plugins').refresh();
  });
}
try {
  let websocket;
  for (let i = 0; i < 100 && !websocket; i++) {
    if (child.exitCode !== null) throw new Error(`QA exited ${child.exitCode}`);
    try {
      websocket = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch {}
    if (!websocket) await delay(200);
  }
  assert(websocket, 'QA browser unavailable');
  browser = await chromium.connectOverCDP(websocket);
  for (let i = 0; i < 100 && !page; i++) {
    page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) await delay(100);
  }
  assert(page, 'QA main WebView unavailable');
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  assert.equal(path.resolve((await invoke('app_bootstrap')).dataDirectory), run);
  safe = true;
  const componentFixturePath = process.env.SERVERDECK_PLUGIN_COMPONENT_FIXTURE;
  if (componentFixturePath) {
    await checkPluginComponents({
      page,
      invoke,
      run,
      passed,
      fixture: JSON.parse(await readFile(componentFixturePath, 'utf8')),
    });
    assert.deepEqual(errors, []);
    await writeFile(path.join(run, 'results.json'), JSON.stringify({ passed, errors }, null, 2));
    console.log(
      `PASS ${passed.length} component scenarios covering three real plugins. Artifacts: ${run}`,
    );
  } else {
    for (const plugin of await invoke('plugin_list')) {
      if (
        ['dev.qa.custom-ui', 'dev.qa.independent-ui', 'dev.qa.upload-network'].includes(
          plugin.manifest.id,
        )
      )
        await invoke('plugin_uninstall', {
          input: { id: plugin.manifest.id, confirmed: true, clearData: true },
        });
      if (
        plugin.source === 'system' &&
        ['cn.hiboot.plugins.services', 'cn.hiboot.plugins.assistant'].includes(
          plugin.manifest.id,
        ) &&
        !plugin.enabled
      )
        await invoke('plugin_set_enabled', { id: plugin.manifest.id, enabled: true });
    }
    await refreshPlugins();
    for (const name of ['网络诊断', 'AI 运维助手']) await open(name);
    passed.push('two independently packaged UIs load from the installed repository');
    await open('网络诊断');
    await scope().getByLabel('诊断目标', { exact: true }).fill('preserved.example');
    await open('AI 运维助手');
    await open('网络诊断');
    assert.equal(
      await scope().getByLabel('诊断目标', { exact: true }).inputValue(),
      'preserved.example',
    );
    await page.getByRole('button', { name: '插件设置', exact: true }).click();
    await open('网络诊断');
    assert.equal(
      await scope().getByLabel('诊断目标', { exact: true }).inputValue(),
      'preserved.example',
    );
    passed.push('tab switches and own settings retain the plugin iframe and diagnostic draft');
    const frame = page
      .frames()
      .find((f) => f.url().includes('sdplugin.localhost') && f.url().includes('services'));
    assert(frame, 'network frame missing');
    const forbiddenHost = `blocked-${randomUUID()}`;
    const isolated = await frame.evaluate((name) => {
      let blocked = false;
      try {
        void parent.document.body;
      } catch {
        blocked = true;
      }
      const internal = window.__TAURI_INTERNALS__;
      if (typeof internal?.invoke === 'function')
        void internal
          .invoke('host_create', {
            input: {
              name,
              hostname: '127.0.0.1',
              port: 22,
              username: 'qa',
              authType: 'agent',
              credentialId: null,
              groupId: null,
              tags: [],
              description: 'QA isolation probe; never connected',
              favorite: false,
              connectTimeoutSecs: 5,
            },
          })
          .catch(() => {});
      return {
        blocked,
        ipc: typeof internal?.invoke,
        keys: Object.getOwnPropertyNames(internal ?? {}),
        origin: window.origin,
      };
    }, forbiddenHost);
    assert.equal(isolated.blocked, true);
    assert.equal(isolated.origin, 'null');
    await delay(1500);
    assert(
      !(await invoke('host_list')).hosts.some((host) => host.name === forbiddenHost),
      `iframe native IPC was allowed (${isolated.ipc}; ${isolated.keys.join(',')})`,
    );
    passed.push('opaque sandbox origin cannot access parent DOM or native IPC');

    const custom = await invoke('plugin_install', {
      input: { path: path.join(run, 'custom-ui.sdplugin'), developmentConfirmed: true },
    });
    await invoke('plugin_grant', {
      id: custom.manifest.id,
      input: {
        expectedRevision: custom.revision,
        permissions: ['ui.contribute'],
        operations: ['ui.contribute'],
        readRoots: [],
        writeRoots: [],
        confirmed: true,
      },
    });
    await invoke('plugin_set_enabled', { id: custom.manifest.id, enabled: true });
    await refreshPlugins();
    const draftHosts = [];
    const hostSuffix = randomUUID().slice(0, 8);
    for (const name of [`Draft host A ${hostSuffix}`, `Draft host B ${hostSuffix}`]) {
      draftHosts.push(
        await invoke('host_create', {
          input: {
            name,
            hostname: '127.0.0.1',
            port: 22,
            username: 'qa',
            authType: 'agent',
            credentialId: null,
            groupId: null,
            tags: [],
            description: 'UI-only host context; never connected',
            favorite: false,
            connectTimeoutSecs: 5,
          },
        }),
      );
    }
    await page.evaluate(async () => {
      await document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('hosts')
        .load();
    });
    await page.evaluate(
      (id) =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
          .openPlugin('dev.qa.custom-ui', 'custom', id),
      draftHosts[0].id,
    );
    await navigateWorkspace(page, 'Custom UI QA');
    assert.equal(await page.getByLabel('插件目标主机', { exact: true }).count(), 0);
    assert.equal(
      await page.locator(`.workspace-tab[data-host-id="${draftHosts[0].id}"]`).count(),
      1,
    );
    await scope().getByLabel('姓名', { exact: true }).fill('独立插件');
    await scope().getByRole('button', { name: '调用自己的 WASM', exact: true }).click();
    await scope().getByText('来自独立 WASM 的问候：独立插件', { exact: true }).waitFor();
    await scope().getByRole('button', { name: '检查权限隔离', exact: true }).click();
    await scope().getByText('未授权能力已拒绝', { exact: true }).waitFor();
    passed.push(
      'a generic frontend contribution runs package-owned business Wasm without a predefined host tool; undeclared host access is denied',
    );

    const draftFrameA = page.frames().find((frame) => frame.url().includes('dev.qa.custom-ui'));
    assert(draftFrameA);
    await page.getByRole('button', { name: '插件设置', exact: true }).click();
    await page.locator('.plugin-page [aria-label="插件设置"]').waitFor();
    assert.equal(
      await page.locator('.module-navigation [aria-current="page"]').innerText(),
      '设置',
    );
    await page.locator(`.workspace-tab[data-host-id="${draftHosts[0].id}"] [role=tab]`).click();
    assert.equal(await scope().getByLabel('姓名', { exact: true }).inputValue(), '独立插件');
    await open('网络诊断');
    await page.evaluate(
      (id) =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
          .openPlugin('dev.qa.custom-ui', 'custom', id),
      draftHosts[1].id,
    );
    await navigateWorkspace(page, 'Custom UI QA');
    assert.equal(await scope().getByLabel('姓名', { exact: true }).inputValue(), '');
    await scope().getByLabel('姓名', { exact: true }).fill('B 的草稿');
    await page.locator(`.workspace-tab[data-host-id="${draftHosts[0].id}"] [role=tab]`).click();
    assert.equal(await scope().getByLabel('姓名', { exact: true }).inputValue(), '独立插件');
    assert.equal(await scope().getByRole('status').innerText(), '来自独立 WASM 的问候：独立插件');
    assert(page.frames().includes(draftFrameA), 'host A frame was unnecessarily replaced');
    await scope().getByRole('button', { name: '调用自己的 WASM', exact: true }).click();
    await scope().getByText('来自独立 WASM 的问候：独立插件', { exact: true }).waitFor();
    await page.locator(`.workspace-tab[data-host-id="${draftHosts[1].id}"] [role=tab]`).click();
    assert.equal(await scope().getByLabel('姓名', { exact: true }).inputValue(), 'B 的草稿');
    await scope().getByRole('button', { name: '调用自己的 WASM', exact: true }).click();
    await scope().getByText('来自独立 WASM 的问候：B 的草稿', { exact: true }).waitFor();
    assert.equal((await invoke('ops_connections')).length, 0);
    passed.push(
      'single-host plugin shares the device tab; host switches and settings preserve separate iframe drafts, results and working Wasm contexts without opening SSH',
    );

    const packed = await networkFixture();
    packed.manifest.id = 'dev.qa.independent-ui';
    packed.manifest.name = 'Independent upload QA';
    const script = packed.files.find((file) => file.path === 'frontend.js');
    const original = Buffer.from(script.content, 'base64').toString();
    assert(original.includes('诊断工具'));
    const customized = Buffer.from(original.replaceAll('诊断工具', '独立上传界面'));
    script.content = customized.toString('base64');
    const digest = packed.manifest.files.find((file) => file.path === 'frontend.js');
    digest.size = customized.length;
    digest.sha256 = createHash('sha256').update(customized).digest('hex');
    const upload = path.join(run, 'independent.sdplugin');
    await writeFile(upload, JSON.stringify(packed));
    const installed = await invoke('plugin_install', {
      input: { path: upload, developmentConfirmed: true },
    });
    assert.equal(installed.source, 'user');
    assert.equal(installed.enabled, false);
    assert.equal(await invoke('plugin_permissions', { id: installed.manifest.id }), null);
    await assert.rejects(() =>
      invoke('plugin_ui', { id: installed.manifest.id, revision: installed.revision }),
    );
    await invoke('plugin_grant', {
      id: installed.manifest.id,
      input: {
        expectedRevision: installed.revision,
        permissions: installed.manifest.permissions,
        operations: ['network.run', 'ui.contribute'],
        readRoots: [],
        writeRoots: [],
        confirmed: true,
      },
    });
    await invoke('plugin_set_enabled', { id: installed.manifest.id, enabled: true });
    await refreshPlugins();
    // This fixture exercises local diagnostics, with an explicit global context.
    await page.evaluate(
      (id) =>
        document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
          .openPlugin(id, 'network', ''),
      installed.manifest.id,
    );
    await scope().locator('#app > *').waitFor();
    await scope().getByRole('tablist', { name: '独立上传界面', exact: true }).waitFor();
    passed.push(
      'an unrelated upload executes its own changed UI asset through the same loader after explicit grants',
    );

    const tcp = createServer((socket) => {
      socket.on('error', (error) => {
        if (!['ECONNRESET', 'EPIPE'].includes(error.code))
          errors.push(`fixture socket: ${error.message}`);
      });
      socket.end('owned QA');
    });
    await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    try {
      await scope().getByRole('tab', { name: 'TCP 端口', exact: true }).click();
      await scope().getByLabel('诊断目标', { exact: true }).fill('127.0.0.1');
      await scope().getByLabel('诊断端口', { exact: true }).fill(String(tcp.address().port));
      await scope().getByLabel('诊断次数', { exact: true }).fill('100');
      await scope().getByLabel('诊断超时', { exact: true }).fill('180');
      await scope().getByRole('button', { name: '开始诊断', exact: true }).click();
      let task;
      for (let i = 0; i < 100 && !task; i++) {
        task = (await invoke('diagnostic_list', { versions: {} })).find(
          (t) => t.state === 'running',
        );
        if (!task) await delay(100);
      }
      assert(task, 'real diagnostic did not start');
      await setPluginEnabled(page, 'Independent upload QA', false);
      assert((await invoke('diagnostic_list', { versions: {} })).some((t) => t.id === task.id));
      await assert.rejects(() =>
        invoke('plugin_ui', { id: installed.manifest.id, revision: installed.revision }),
      );
      await invoke('diagnostic_cancel', { id: task.id });
      passed.push('real SDK diagnostic survives plugin disable; revoked UI assets are denied');
    } finally {
      tcp.closeAllConnections?.();
      await new Promise((resolve) => tcp.close(resolve));
    }
    await open('网络诊断');
    for (const [width, height, theme] of [
      [1440, 960, 'dark'],
      [900, 600, 'light'],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      await page.screenshot({ path: path.join(run, `${theme}-${width}.png`), fullPage: true });
      assert(
        await scope()
          .locator('body')
          .evaluate((node) => node.scrollWidth <= innerWidth + 1),
      );
    }
    await checkWorkspaceTools({ page, invoke, run, passed });
    await open('网络诊断');
    await page.locator(`.workspace-tab[data-host-id="${draftHosts[0].id}"] [role=tab]`).click();
    await scope().getByLabel('姓名', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(run, 'host-workspace-draft.png'), fullPage: true });
    const unexpected = errors.filter(
      (error) =>
        !error.includes('ERR_ABORTED') &&
        !(
          error.includes('http://ipc.localhost/host_create') &&
          error.includes('Content Security Policy')
        ),
    );
    assert.deepEqual(unexpected, []);
    await writeFile(path.join(run, 'results.json'), JSON.stringify({ passed, errors }, null, 2));
    console.log(`PASS ${passed.length} native plugin UI scenarios. Artifacts: ${run}`);
  }
} catch (error) {
  await page?.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  await writeFile(
    path.join(run, 'failure.json'),
    JSON.stringify(
      {
        message: String(error),
        passed,
        errors,
        frames: page?.frames().map((frame) => frame.url()),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (safe && child.exitCode === null) {
    closeNativeWindow(child.pid);
    await page
      .getByRole('dialog', { name: '退出前检查', exact: true })
      .getByRole('button', { name: '确认退出', exact: true })
      .click()
      .catch(() => {});
    for (let i = 0; i < 50 && child.exitCode === null; i++) await delay(100);
  }
  await browser?.close();
  if (child.exitCode === null) child.kill();
}
