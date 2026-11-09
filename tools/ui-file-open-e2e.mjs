import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const output = path.resolve('.local/sftp-external-editor/browser');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.SERVERDECK_BROWSER ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const results = [];
try {
  for (const size of [
    { width: 1280, height: 820 },
    { width: 960, height: 600 },
  ]) {
    const page = await browser.newPage({ viewport: size });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.SERVERDECK_UI_URL ?? 'http://127.0.0.1:1421/');
    // Rendering fixtures only. Real Monaco loads; no user data or server is accessed.
    await page.evaluate(async () => {
      const { createApp, h } = await import('/node_modules/.vite/deps/vue.js');
      const { useFilesStore } = await import('/src/stores/files.ts');
      const { filesApi } = await import('/src/services/files.ts');
      const { default: Host } = await import('/src/components/RemoteEditorHost.vue');
      const { default: Dialogs } = await import('/src/components/FileOpenDialogs.vue');
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      document.querySelector('#app').__vue_app__.unmount();
      const files = useFilesStore(pinia);
      const state = { files, saves: 0, closes: 0, rootErrors: [], failSave: false };
      window.fileOpenQa = state;
      filesApi.dirty = async () => {};
      filesApi.tasks = async () => [];
      filesApi.connections = async () => [];
      filesApi.closeEditor = async () => {
        state.closes++;
      };
      filesApi.externalSave = async () => {
        state.saves++;
        if (state.failSave) throw { message: '远程文件已变化，未覆盖' };
        return { document: { token: 'external' }, message: null, recoveryPath: null };
      };
      files.refresh = async () => {};
      const app = createApp({
        render: () => [files.document ? h(Host, { key: files.document.token }) : null, h(Dialogs)],
      }).use(pinia);
      app.config.errorHandler = (error) => state.rootErrors.push(String(error));
      app.mount('#app');
      files.document = {
        token: 'ini',
        sessionId: 'session',
        path: '/etc/server.ini',
        content: '[server]\nport=8080\n',
        sha256: 'fixture',
        permissions: 384,
        uid: 1000,
        gid: 1000,
        atomicSave: true,
      };
    });
    const editor = page.getByRole('dialog', { name: '远程文本编辑', exact: true });
    await editor.locator('.monaco-editor').waitFor();
    await editor.getByRole('button', { name: '关闭编辑器', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      const state = window.fileOpenQa;
      state.files.externalDocument = {
        token: 'external',
        sessionId: 'session',
        path: '/etc/very-long-directory/server-config.ini',
        localPath: 'D:/ServerDeck/data/external-edits/edit-isolated/server-config.ini',
        transferId: 'download',
        atomicSave: true,
        ready: true,
      };
    });
    const external = page.getByRole('dialog', { name: '外部编辑远程文件', exact: true });
    await external.waitFor();
    const upload = external.getByRole('button', { name: '确认回传服务器', exact: true });
    assert(await upload.isDisabled());
    assert.equal(await page.evaluate(() => window.fileOpenQa.saves), 0);
    await external.getByRole('checkbox').check();
    await page.evaluate(() => {
      window.fileOpenQa.failSave = true;
    });
    await upload.click();
    await external.getByRole('alert').filter({ hasText: '未覆盖' }).waitFor();
    assert.equal(
      await page.evaluate(() => window.fileOpenQa.files.externalDocument.localPath),
      'D:/ServerDeck/data/external-edits/edit-isolated/server-config.ini',
    );
    await page.evaluate(() => {
      window.fileOpenQa.failSave = false;
    });
    await upload.click();
    await external.getByRole('status').filter({ hasText: '回传成功' }).waitFor();
    assert(await upload.isDisabled());
    assert.equal(await page.evaluate(() => window.fileOpenQa.saves), 2);
    const box = await external.boundingBox();
    assert(
      box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= size.width + 1 &&
        box.y + box.height <= size.height + 1,
    );
    assert(await external.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: path.join(output, `external-${size.width}.png`) });
    await external.getByRole('button', { name: '结束外部编辑', exact: true }).click();
    const close = page.getByRole('dialog', { name: '结束外部编辑', exact: true });
    await close.getByText('尚未回传的本地修改不会自动上传。', { exact: false }).waitFor();
    await close.getByRole('button', { name: '确认结束', exact: true }).click();
    await close.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.fileOpenQa.rootErrors), []);
    assert.deepEqual(errors, []);
    results.push(
      `${size.width}x${size.height}: real Monaco INI, explicit upload/conflict/retry, retained-copy close, modal bounds`,
    );
    await page.close();
  }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
  console.log(results.join('\n'));
} finally {
  await browser.close();
}
