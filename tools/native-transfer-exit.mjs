import assert from 'node:assert/strict';
import { open, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export async function transferExitChecks(context) {
  let page = context.page;
  const { hostId, artifacts, passed, restart } = context;
  const rpc = (cmd, args = {}) =>
    page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
  async function connectFiles() {
    await page.evaluate(async (hostId) => {
      const host = (await window.__TAURI_INTERNALS__.invoke('host_list')).hosts.find(
        (h) => h.id === hostId,
      );
      const s = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('files');
      await s.open(host);
    }, hostId);
    for (let i = 0; i < 200; i++) {
      const rows = await rpc('files_connections');
      const session = rows.find((s) => s.hostId === hostId);
      if (session) return session;
      await delay(100);
    }
    throw new Error('SFTP connection deadline');
  }
  const local = path.join(artifacts, `exit-upload-${randomUUID()}.bin`);
  const file = await open(local, 'wx');
  await file.truncate(256 * 1024 * 1024);
  await file.close();
  let session, remote;
  try {
    session = await connectFiles();
    const home = await rpc('files_list', { id: session.id, path: '.' });
    remote = home.path.replace(/\/$/, '') + `/.serverdeck-exit-${randomUUID()}`;
    await writeFile(
      path.join(artifacts, 'transfer-exit-scope.json'),
      JSON.stringify({ hostId, remote, local }, null, 2),
    );
    await rpc('files_action', { id: session.id, action: { kind: 'mkdir', path: remote } });
    const task = await rpc('transfer_start', {
      input: {
        sessionId: session.id,
        direction: 'upload',
        sources: [local],
        destination: remote,
        conflict: 'fail',
        confirmOverwrite: false,
      },
    });
    let active;
    for (let i = 0; i < 300; i++) {
      active = (await rpc('transfer_list')).find((t) => t.id === task.id);
      if (active?.state === 'running' && active.transferredBytes >= 65536) break;
      assert(
        !['failed', 'completed', 'cancelled'].includes(active?.state),
        'must exit while the real upload is active',
      );
      await delay(100);
    }
    assert(
      active?.state === 'running' &&
        active.transferredBytes >= 65536 &&
        active.transferredBytes < active.totalBytes,
    );
    await rpc('app_exit_confirm', { confirmed: false });
    const review = page.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true });
    await review.waitFor();
    assert((await review.innerText()).includes('未完成的传输'));
    const started = Date.now();
    page = await restart(0, async () => {
      await review
        .getByRole('button', { name: '取消任务并退出', exact: true })
        .click()
        .catch((error) => {
          if (!/closed/i.test(String(error))) throw error;
        });
    });
    const elapsed = Date.now() - started;
    const connections = await rpc('background_tasks');
    assert.equal(connections.connections.length, 0, 'restart must not reconnect or resume uploads');
    session = await connectFiles();
    const contents = await rpc('files_list', { id: session.id, path: remote });
    assert.equal(
      contents.entries.length,
      0,
      'cancelled staged upload must leave neither partial destination nor .part file',
    );
    await rpc('files_action', {
      id: session.id,
      action: { kind: 'remove', paths: [remote], recursive: true, confirmed: true },
    });
    remote = null;
    await rpc('files_close', { id: session.id, cancel: false });
    session = null;
    await writeFile(
      path.join(artifacts, 'transfer-exit-result.json'),
      JSON.stringify(
        {
          gracefulConfirmedExit: true,
          transferredBeforeExit: active.transferredBytes,
          totalBytes: active.totalBytes,
          shutdownAndRestartMs: elapsed,
          afterRestartEntries: contents.entries.length,
          unattendedConnections: connections.connections.length,
        },
        null,
        2,
      ),
    );
    passed(
      'real active SFTP upload: UI-confirmed graceful exit, fresh idle restart, no partial destination or staging file',
    );
  } finally {
    if (remote && session) {
      await rpc('files_action', {
        id: session.id,
        action: { kind: 'remove', paths: [remote], recursive: true, confirmed: true },
      });
      await rpc('files_close', { id: session.id, cancel: true });
    }
    await unlink(local);
  }
}
