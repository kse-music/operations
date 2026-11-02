import { terminalAction } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { closeNativeWindow } from './native-window-close.mjs';

export async function sftpChecks({ page, artifacts, passed, registerCleanup, processId }) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const source = path.join(artifacts, `sftp-source-${randomUUID()}`),
    destination = path.join(artifacts, `sftp-download-${randomUUID()}`);
  await mkdir(path.join(source, '子目录'), { recursive: true });
  await mkdir(destination, { recursive: true });
  const textName = "配置 空格 ;$'.txt",
    renamed = "日志 空格 ;$'.log";
  await writeFile(path.join(source, textName), '\uFEFF__SFTP_TEXT_ORIGINAL__\n中文文本\n');
  await writeFile(path.join(source, '子目录', 'nested.txt'), 'nested data');
  const file = await open(path.join(source, 'large.bin'), 'w');
  for (let n = 0; n < 256; n++) await file.write(randomBytes(65536));
  await file.close();
  const table = (side) =>
    page.getByRole('table', { name: side === 'local' ? '本地文件' : '远程文件', exact: true });
  const button = (side, name) => table(side).locator('.file-name').filter({ hasText: name });
  async function navFiles() {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: /SFTP 文件/ })
      .click();
  }
  async function shell(command) {
    const pane = page.locator('.terminal-pane:visible').first();
    await pane.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
  }
  async function taskList() {
    return page.evaluate(() => window.__TAURI_INTERNALS__.invoke('transfer_list'));
  }
  async function waitTask(direction, existing = []) {
    let task;
    for (let n = 0; n < 500; n++) {
      task = (await taskList()).find((t) => t.direction === direction && !existing.includes(t.id));
      if (
        task &&
        !['queued', 'scanning', 'running', 'verifying', 'cancelling'].includes(task.state)
      ) {
        assert.equal(task.state, 'completed', task.message);
        return task;
      }
      await delay(100);
    }
    throw new Error('SFTP task deadline');
  }
  async function select(side, names) {
    const checkboxes = table(side).locator('tbody input[type=checkbox]');
    for (const checkbox of await checkboxes.all())
      if (await checkbox.isChecked()) await checkbox.uncheck();
    for (const name of names) await table(side).getByLabel(`选择 ${name}`, { exact: true }).check();
  }
  async function remotePath(value) {
    await page.getByLabel('远程路径', { exact: true }).fill(value);
    await page
      .locator('.file-side')
      .nth(1)
      .getByRole('button', { name: '前往', exact: true })
      .click();
    await page.waitForFunction(
      (value) => document.querySelector('input[aria-label="远程路径"]')?.value === value,
      value,
    );
    await delay(100);
  }
  async function context(name, menu) {
    await button('remote', name).click({ button: 'right' });
    await page.getByRole('menuitem', { name: menu, exact: true }).click();
  }
  await shell(
    String.raw`printf '\033]7;file://localhost%s\007' "$PWD"; printf '\n__SFTP_OSC_READY__\n'`,
  );
  await page
    .locator('.terminal-pane:visible .xterm-rows')
    .filter({ hasText: '__SFTP_OSC_READY__' })
    .waitFor();
  await terminalAction(page, page.locator('.terminal-pane:visible'), 'SFTP 文件');
  await table('remote').waitFor();
  const home = await page.getByLabel('远程路径', { exact: true }).inputValue();
  assert(home.startsWith('/') && home !== '.');
  if (process.env.SERVERDECK_RECOVER_SFTP_ARTIFACT) {
    const previous = path.resolve(process.env.SERVERDECK_RECOVER_SFTP_ARTIFACT);
    assert.equal(path.dirname(previous), path.dirname(artifacts));
    const begin = (await stat(path.join(previous, 'sftp-source', 'large.bin'))).birthtimeMs / 1000;
    const end = begin + 30;
    assert(Date.now() / 1000 > end, 'failed run scope must predate the active run');
    const result = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const sessions = await invoke('files_connections');
      return {
        session: sessions[0].id,
        listing: await invoke('files_list', { id: sessions[0].id, path: '.' }),
      };
    });
    for (const item of result.listing.entries.filter(
      (e) =>
        /^serverdeck-sftp-e2e-[0-9a-f-]{36}$/.test(e.name) &&
        e.modified >= begin - 5 &&
        e.modified <= end + 5,
    )) {
      const children = await page.evaluate(
        ({ id, path }) => window.__TAURI_INTERNALS__.invoke('files_list', { id, path }),
        { id: result.session, path: item.path },
      );
      assert.equal(
        children.entries.length,
        0,
        'only a confirmed empty owned test root may be recovered',
      );
      await page.evaluate(
        ({ id, path }) =>
          window.__TAURI_INTERNALS__.invoke('files_action', {
            id,
            action: { kind: 'remove', paths: [path], recursive: false, confirmed: true },
          }),
        { id: result.session, path: item.path },
      );
      await writeFile(
        path.join(previous, 'sftp-recovery.json'),
        JSON.stringify({ removedEmptyOwnedRoot: item.path }, null, 2),
      );
    }
  }
  const rootName = `serverdeck-sftp-e2e-${randomUUID()}`,
    root = `${home.replace(/\/$/, '')}/${rootName}`;
  let session;
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  const create = page.getByRole('dialog', { name: '创建远程文件夹', exact: true });
  await create.getByLabel('远程项目名称').fill(rootName);
  await create.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await create.waitFor({ state: 'hidden' });
  const live = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('files_connections'));
  assert.equal(live.length, 1);
  session = live[0].id;
  registerCleanup(async () => {
    assert(root.startsWith(`${home.replace(/\/$/, '')}/serverdeck-sftp-e2e-`));
    await page.evaluate(
      async ({ id, root }) => {
        await window.__TAURI_INTERNALS__.invoke('files_action', {
          id,
          action: { kind: 'remove', paths: [root], recursive: true, confirmed: true },
        });
      },
      { id: session, root },
    );
  });
  await writeFile(
    path.join(artifacts, 'sftp-scope.json'),
    JSON.stringify({ root, session }, null, 2),
  );
  await button('remote', rootName).dblclick();
  await page.getByLabel('本地路径', { exact: true }).fill(source);
  await page
    .locator('.file-side')
    .nth(0)
    .getByRole('button', { name: '前往', exact: true })
    .click();
  await button('local', textName).waitFor();
  await select('local', [textName, 'large.bin', '子目录']);
  await page.getByRole('button', { name: '上传选中', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '确认文件传输', exact: true });
  await dialog.getByRole('button', { name: '加入传输队列', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('navigation').getByRole('button', { name: '全局设置', exact: true }).click();
  const uploaded = await waitTask('upload');
  session = uploaded.sessionId;
  assert.equal(uploaded.filesDone, 3);
  assert.equal(uploaded.remainingBytes, 0);
  await writeFile(
    path.join(artifacts, 'sftp-scope.json'),
    JSON.stringify({ root, session }, null, 2),
  );
  await navFiles();
  await button('remote', textName).waitFor();
  passed(
    'native SFTP channel, local/remote navigation, Unicode paths and background recursive upload',
  );
  await select('remote', [textName, 'large.bin', '子目录']);
  const before = (await taskList()).map((t) => t.id);
  await page.getByRole('button', { name: '下载选中', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '确认文件传输', exact: true });
  await dialog.getByLabel('传输目标目录').fill(destination);
  await dialog.getByRole('button', { name: '加入传输队列', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await waitTask('download', before);
  async function hashes(root) {
    const result = {};
    async function walk(current, relative = '') {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const key = path.join(relative, entry.name),
          absolute = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(absolute, key);
        else
          result[key] = createHash('sha256')
            .update(await readFile(absolute))
            .digest('hex');
      }
    }
    await walk(root);
    return result;
  }
  assert.deepEqual(await hashes(source), await hashes(destination));
  passed('native multi-file/folder download and 16 MiB SHA-256 roundtrip integrity');
  await context(textName, '重命名');
  dialog = page.getByRole('dialog', { name: '重命名远程项目', exact: true });
  await dialog.getByLabel('远程项目名称').fill(renamed);
  await dialog.getByRole('button', { name: '确认重命名', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await button('remote', renamed).waitFor();
  await context(renamed, '查看属性');
  dialog = page.getByRole('dialog', { name: '文件属性', exact: true });
  assert((await dialog.innerText()).includes('0600'));
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await button('remote', renamed).dblclick();
  const editor = page.getByRole('dialog', { name: '远程文本编辑', exact: true });
  await editor.locator('.monaco-editor').waitFor();
  async function edit(text) {
    await editor.locator('.native-edit-context,textarea.inputarea').focus();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText(text);
  }
  await edit('__SFTP_LOG_SAVED__\n已编辑 UTF-8\n');
  await editor.getByRole('button', { name: '关闭编辑器', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '未保存内容', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '返回编辑', exact: true }).click();
  await editor.getByRole('checkbox').check();
  await editor.getByRole('button', { name: '保存远程文件', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.editor-header strong')?.textContent.includes('未保存'),
  );
  let inspected = await page.evaluate(
    async ({ id, path }) => window.__TAURI_INTERNALS__.invoke('text_read', { id, path }),
    { id: session, path: `${root}/${renamed}` },
  );
  assert.equal(inspected.content, '\uFEFF__SFTP_LOG_SAVED__\n已编辑 UTF-8\n');
  assert.equal(inspected.permissions, 0o600);
  await page.evaluate(async (doc) => {
    await window.__TAURI_INTERNALS__.invoke('text_save', {
      input: { token: doc.token, content: '__SFTP_LOG_EXTERNAL__\n', confirmReplace: true },
    });
    await window.__TAURI_INTERNALS__.invoke('text_close', { token: doc.token, discard: true });
  }, inspected);
  await edit('must not overwrite external content');
  await editor.getByRole('button', { name: '保存远程文件', exact: true }).click();
  await editor.getByRole('alert').filter({ hasText: '外部修改' }).waitFor();
  await editor.getByRole('button', { name: '重新加载', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '未保存内容', exact: true });
  await dialog.getByRole('button', { name: '放弃修改并重新加载', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await editor.getByRole('button', { name: '关闭编辑器', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  const denied = await page.evaluate(async (id) => {
    try {
      await window.__TAURI_INTERNALS__.invoke('files_list', { id, path: '/root' });
      return null;
    } catch (error) {
      return error.code;
    }
  }, session);
  assert.equal(denied, 'SFTP_PERMISSION');
  passed(
    'native rename/properties/Monaco UTF-8 save, unsaved-close confirmation, external conflict and real Linux permission denial',
  );
  // Follow a protocol report from the authenticated source terminal; never inspect arbitrary pwd text.
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /SSH 终端/ })
    .click();
  await shell(
    String.raw`cd -- '${root}/子目录'; printf '\033]7;file://localhost%s\007' "$PWD"; printf '\n__SFTP_CWD_CHANGED__\n'`,
  );
  await page
    .locator('.terminal-pane:visible .xterm-rows')
    .filter({ hasText: '__SFTP_CWD_CHANGED__' })
    .waitFor();
  await navFiles();
  await page.getByRole('checkbox', { name: '跟随来源终端的 OSC 7 目录' }).check();
  await page.waitForFunction(
    (value) => document.querySelector('input[aria-label="远程路径"]')?.value === value,
    `${root}/子目录`,
  );
  await page.getByRole('checkbox', { name: '跟随来源终端的 OSC 7 目录' }).uncheck();
  await remotePath(root);
  await context(renamed, '在新终端执行 tail -f');
  dialog = page.getByRole('dialog', { name: '确认打开文件终端', exact: true });
  await dialog.getByRole('button', { name: '确认打开新终端', exact: true }).click();
  await page
    .locator('.terminal-pane:visible .xterm-rows')
    .filter({ hasText: '__SFTP_LOG_EXTERNAL__' })
    .waitFor();
  await page.locator('.terminal-pane:visible .xterm-helper-textarea').focus();
  await page.keyboard.press('Control+c');
  await page.locator('.terminal-pane:visible .xterm-container[data-state="closed"]').waitFor();
  await navFiles();
  passed('native OSC 7 working-directory link and safely quoted independent tail -f PTY');
  // A sparse local file is a real large file, cancelled while bytes are in flight.
  const cancelFile = await open(path.join(source, 'cancel-large.bin'), 'w');
  await cancelFile.truncate(128 * 1024 * 1024);
  await cancelFile.close();
  await page.getByRole('button', { name: '刷新本地', exact: true }).click();
  await button('local', 'cancel-large.bin').waitFor();
  await select('local', ['cancel-large.bin']);
  const existing = (await taskList()).map((t) => t.id);
  await page.getByRole('button', { name: '上传选中', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '确认文件传输', exact: true });
  await dialog.getByRole('button', { name: '加入传输队列', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  let active;
  for (let n = 0; n < 100; n++) {
    active = (await taskList()).find((t) => !existing.includes(t.id));
    if (active?.transferredBytes > 0) break;
    await delay(50);
  }
  assert(active?.transferredBytes > 0);
  closeNativeWindow(processId());
  dialog = page.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '继续使用', exact: true }).click();
  await page
    .locator(`[data-task-id="${active.id}"]`)
    .getByRole('button', { name: '取消传输', exact: true })
    .click();
  for (let n = 0; n < 200; n++) {
    active = (await taskList()).find((t) => t.id === active.id);
    if (!['queued', 'scanning', 'running', 'verifying', 'cancelling'].includes(active.state)) break;
    await delay(50);
  }
  assert.equal(active.state, 'cancelled');
  assert.equal(active.recoveryPaths.length, 0);
  const listing = await page.evaluate(
    async ({ id, path }) => window.__TAURI_INTERNALS__.invoke('files_list', { id, path }),
    { id: session, path: root },
  );
  assert(
    !listing.entries.some(
      (e) => e.name === 'cancel-large.bin' || e.name.startsWith('.serverdeck-'),
    ),
  );
  passed(
    'native pending-transfer exit confirmation, active cancellation and remote staging cleanup',
  );
  await page.screenshot({ path: path.join(artifacts, 'sftp-transfers.png') });
  await page.locator('.content-scroll').evaluate((e) => {
    e.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(artifacts, 'sftp.png') });
  await remotePath(home);
  await button('remote', rootName).waitFor();
  await select('remote', [rootName]);
  await page.getByRole('button', { name: '删除选中', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '确认删除远程项目', exact: true });
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await button('remote', rootName).waitFor({ state: 'hidden' });
  registerCleanup(undefined);
  passed('native confirmed recursive deletion of the isolated remote test tree');
}
