// Run a copied, isolated QA build; inspect and cancel Open With using computer-use.
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const directory = (
  await readFile('.local/sftp-external-editor/native-app-path.txt', 'utf8')
).trim();
assert.equal(path.dirname(directory), path.resolve('.local/sftp-external-editor'));
assert(path.basename(directory).startsWith('native-app-'));
const executable = path.join(directory, 'ServerDeckFileOpenQA.exe');
await access(executable);
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const child = spawn(executable, [], {
  cwd: directory,
  stdio: 'ignore',
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
  },
});
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert(browser, 'isolated native WebView2 did not start');
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__);
  const bootstrap = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_bootstrap'));
  const actualData = path.resolve(bootstrap.dataDirectory.replace(/^\\\\\?\\/, ''));
  assert(
    actualData === directory || actualData.startsWith(directory + path.sep),
    `QA data escaped isolation: ${actualData}`,
  );
  await page.evaluate(async (directory) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const files = pinia._s.get('files'),
      hosts = pinia._s.get('hosts'),
      workspace = pinia._s.get('workspace');
    // Offline host metadata only makes the local file panel visible; never open SSH.
    const host = {
      id: 'file-open-local-qa',
      name: 'Local file QA',
      hostname: '192.0.2.25',
      port: 22,
      username: 'qa',
      authType: 'agent',
      credentialId: null,
      groupId: null,
      description: '',
      favorite: false,
      tags: [],
      createdAt: '',
      updatedAt: '',
      connectTimeoutSecs: 15,
      keepaliveIntervalSecs: 15,
      keepaliveMax: 3,
      compression: false,
      jumpHostIds: [],
      proxy: null,
    };
    hosts.catalog.hosts.push(host);
    hosts.selectedId = host.id;
    files.active = host.id;
    files.connections[host.id] = {
      host,
      state: 'closed',
      error: null,
      trust: null,
      path: '/',
      listing: null,
      loading: false,
    };
    await files.localLoad(directory);
    workspace.navigate('files', host.id);
  }, directory);
  await page.locator('.file-side').first().locator('[title="config.ini"]').waitFor();
  await writeFile(
    path.join(directory, 'ready.json'),
    JSON.stringify({ executable, directory, dataDirectory: bootstrap.dataDirectory }, null, 2),
  );
  console.log(`READY ${directory}`);
  const deadline = Date.now() + 240000;
  for (;;) {
    try {
      await access(path.join(directory, 'finish'));
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('native UI verification deadline elapsed');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const state = await page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    return {
      opening: pinia._s.get('files').localOpening,
      fileError: pinia._s.get('files').error,
      applicationError: pinia._s.get('application').error,
    };
  });
  assert.equal(state.opening, false);
  assert.equal(state.fileError, null);
  assert.equal(state.applicationError, null);
  await page.screenshot({ path: path.join(directory, 'local-file-after-open.png') });
  await writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify(
      {
        ...state,
        verified:
          'native local INI double click invokes system chooser, cancelled without global error',
      },
      null,
      2,
    ),
  );
  console.log('Native file-open state passed.');
} finally {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page && !page.isClosed())
      await page
        .evaluate(() => window.__TAURI_INTERNALS__.invoke('app_exit_confirm', { confirmed: true }))
        .catch((error) => {
          if (!page.isClosed()) throw error;
        });
    await browser.close();
  }
  if (child.exitCode === null)
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('QA application did not exit normally')), 5000),
      ),
    ]);
}
