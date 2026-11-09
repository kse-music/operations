import { terminalAction, navigateWorkspace } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';

// Drives the packaged application's real xterm/SSH path. No Terminal or IPC replacement.
export async function advancedTerminalChecks({ page, artifacts, passed, openTerminal, pin }) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const panes = () => page.locator('.terminal-pane:visible');
  async function send(pane, text) {
    await pane.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  }
  async function contains(pane, text) {
    await pane.locator('.xterm-rows').filter({ hasText: text }).waitFor();
  }
  async function ready(pane) {
    await pane.locator('.xterm-container[data-state="connected"]').waitFor();
  }
  async function rename(title) {
    await page.locator('.terminal-tab.active [role=tab]').dblclick();
    const dialog = page.getByRole('dialog', { name: '重命名标签', exact: true });
    await dialog.getByLabel('标签名称').fill(title);
    await dialog.getByRole('button', { name: '保存名称' }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  await send(
    panes().nth(0),
    'HISTFILE=/dev/null; SD_PANE_VALUE=alpha; printf \'\\n__SD_VALUE_%s__\\n\' "$SD_PANE_VALUE"',
  );
  await contains(panes().nth(0), '__SD_VALUE_alpha__');
  await panes().nth(0).locator('.xterm-helper-textarea').press('Control+Shift+e');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.terminal-pane')].filter((p) => p.offsetHeight > 0).length ===
      2,
  );
  await ready(panes().nth(1));
  await delay(200);
  await send(
    panes().nth(1),
    'HISTFILE=/dev/null; SD_PANE_VALUE=beta; printf \'\\n__SD_VALUE_%s__\\n\' "$SD_PANE_VALUE"',
  );
  await contains(panes().nth(1), '__SD_VALUE_beta__');
  let sizeSequence = 0;
  async function size() {
    const sequence = ++sizeSequence;
    await send(panes().nth(0), `printf '\\n__SD_SIZE_${sequence}_%s_%s__\\n' $(stty size)`);
    await contains(panes().nth(0), new RegExp(`__SD_SIZE_${sequence}_\\d+_\\d+__`));
    const text = await panes().nth(0).locator('.xterm-rows').innerText();
    const matches = [...text.matchAll(new RegExp(`__SD_SIZE_${sequence}_(\\d+)_(\\d+)__`, 'g'))];
    assert(matches.length, 'stty output missing');
    return matches.at(-1).slice(1).map(Number);
  }
  const before = await size(),
    divider = page.getByRole('separator', { name: '调整分屏大小', exact: true }).first(),
    box = await divider.boundingBox();
  assert(box);
  await page.mouse.move(box.x + 3, box.y + Math.min(box.height / 2, 60));
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 60, { steps: 8 });
  await page.mouse.up();
  await delay(200);
  const after = await size();
  assert(after[1] > before[1], 'drag must resize real remote PTY columns');
  await panes().nth(1).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+h');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.terminal-pane')].filter((p) => p.offsetHeight > 0).length ===
      3,
  );
  await ready(panes().nth(2));
  await send(panes().nth(0), 'printf \'\\n__SD_VALUE_%s__\\n\' "$SD_PANE_VALUE"');
  await contains(panes().nth(0), '__SD_VALUE_alpha__');
  await terminalAction(page, panes().nth(1), '关闭终端');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.terminal-pane')].filter((p) => p.offsetHeight > 0).length ===
      2,
  );
  passed(
    'horizontal/vertical split, independent shells, drag PTY resize, close one pane without restarting others',
  );
  await rename('Operations');
  await openTerminal();
  await rename('Extra B');
  await openTerminal();
  await rename('Extra C');
  await page
    .getByRole('tab', { name: /Extra C/ })
    .locator('..')
    .dragTo(page.getByRole('tab', { name: /Operations/ }).locator('..'));
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="终端标签"] [role=tab]')?.textContent.includes('Extra C'),
  );
  for (const title of ['Extra B', 'Extra C'])
    await page.getByRole('button', { name: `关闭标签 ${title}`, exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-label="终端标签"] [role=tab]').length === 1,
  );
  await send(panes().nth(0), 'printf \'\\n__SD_VALUE_%s__\\n\' "$SD_PANE_VALUE"');
  await contains(panes().nth(0), '__SD_VALUE_alpha__');
  passed('tab rename, drag reorder and closing individual extra sessions retain live split shells');
  await navigateWorkspace(page, '终端');
  await page.getByLabel('终端字体', { exact: true }).fill('Consolas, monospace');
  await page.getByLabel('终端行高', { exact: true }).fill('120');
  await page.getByLabel('滚动历史行数', { exact: true }).fill('1024');
  await page.getByLabel('终端主题', { exact: true }).selectOption('nord');
  await page.getByLabel('光标样式', { exact: true }).selectOption('bar');
  await navigateWorkspace(page, '快捷键');
  await page.getByLabel('查找快捷键', { exact: true }).focus();
  await page.keyboard.press('Control+Shift+g');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await delay(300);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /SSH 终端/ })
    .click();
  if (await panes().nth(0).getByLabel('终端查找内容').isVisible())
    await panes().nth(0).locator('.xterm-helper-textarea').press('Control+Shift+g');
  await panes().nth(0).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+g');
  await panes().nth(0).getByLabel('终端查找内容').waitFor();
  const color = await panes()
    .nth(0)
    .locator('.xterm-scrollable-element')
    .evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.equal(color, 'rgb(46, 52, 64)');
  passed(
    'persisted terminal font/line-height/scrollback/theme/cursor settings and configurable search shortcut',
  );
  await panes().nth(0).locator('.xterm-helper-textarea').press('Control+Shift+g');
  await send(
    panes().nth(0),
    "bind 'set enable-bracketed-paste on'; printf '\\n__SD_%s__\\n' BRACKET_READY",
  );
  await contains(panes().nth(0), '__SD_BRACKET_READY__');
  const text = "printf '\\n__SD_%s__\\n' BRACKET_CONFIRMED\n" + ' '.repeat(5000);
  await panes()
    .nth(0)
    .locator('.xterm-container')
    .evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);
  const paste = page.getByRole('dialog', { name: '确认大文本粘贴', exact: true });
  await paste.waitFor();
  assert(
    !(await panes().nth(0).locator('.xterm-rows').innerText()).includes('__SD_BRACKET_CONFIRMED__'),
  );
  await paste.getByRole('button', { name: '确认粘贴', exact: true }).click();
  await paste.waitFor({ state: 'hidden' });
  await delay(150);
  assert(
    !(await panes().nth(0).locator('.xterm-rows').innerText()).includes('__SD_BRACKET_CONFIRMED__'),
    'bracketed multiline paste must wait for Enter',
  );
  await panes().nth(0).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Enter');
  await contains(panes().nth(0), '__SD_BRACKET_CONFIRMED__');
  passed('large-paste confirmation and real Bash bracketed-paste boundaries');
  assert.equal(await page.locator('.terminal-footnote').count(), 0);
  assert.equal(await page.getByRole('button', { name: '打开终端操作', exact: true }).count(), 0);
  passed('terminal bottom actions and shortcut hints are absent');
  await networkChecks(page, panes, passed, openTerminal, pin);
  // Observe renderer heap after repeated real output; keep a finite scrollback and record actual values.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const heapBefore = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  for (let n = 0; n < 4; n++) {
    await send(
      panes().nth(1),
      `HISTFILE=/dev/null; head -c 2097152 /dev/zero | tr '\\000' x; printf '\\n__SD_MEM_%s__\\n' ${n}`,
    );
    await contains(panes().nth(1), `__SD_MEM_${n}__`);
  }
  await cdp.send('HeapProfiler.collectGarbage');
  const heapAfter = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  assert(
    heapAfter - heapBefore < 32 * 1024 * 1024,
    'renderer heap did not stay within finite-buffer budget',
  );
  await writeFile(
    path.join(artifacts, 'memory.json'),
    JSON.stringify({ heapBefore, heapAfter, outputBytes: 4 * 2097152, scrollback: 1024 }, null, 2),
  );
  passed('8 MiB repeated real output with finite scrollback and measured renderer heap');
  // Leave a real listener alive so reload must prove it releases the previous sessions.
  const liveForward = await startForward(page, 'local', 8080);
  const cleanupPort = liveForward.input.listenPort;
  const probe = await tcpConnect(cleanupPort);
  probe.destroy();
  assert.equal(await page.locator('.terminal-pane').count(), 2);
  await page.screenshot({ path: path.join(artifacts, 'splits.png') });
  await page.reload();
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '欢迎使用 ServerDeck', exact: true }).waitFor();
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  assert.equal(await page.locator('.terminal-tab').count(), 0);
  await assert.rejects(() => tcpConnect(cleanupPort));
  passed('workspace reload starts without terminal tabs and closes the previous WebView sessions');
}

// The forwarding UI was removed; retain real backend and routing assertions through IPC.
async function startForward(page, kind, targetPort, listenPort = 0) {
  return page.evaluate(
    async (input) => {
      const store = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('terminals');
      const id = store.tabs.find((tab) => tab.key === store.active)?.panes[0]?.sessionId;
      if (!id) throw new Error('No active SSH session for forwarding verification');
      const forward = await window.__TAURI_INTERNALS__
        .invoke('forward_start', { id, input })
        .catch((cause) => {
          throw new Error(cause?.message ?? String(cause));
        });
      if (forward.state !== 'running') throw new Error(`Forward did not start: ${forward.state}`);
      return forward;
    },
    {
      kind,
      bindAddress: '127.0.0.1',
      listenPort,
      targetHost: kind === 'dynamic' ? null : '127.0.0.1',
      targetPort: kind === 'dynamic' ? null : targetPort,
      confirmPublic: false,
    },
  );
}
async function networkChecks(page, panes, passed, openTerminal, pin) {
  const localForward = await startForward(page, 'local', 22);
  const local = localForward.input.listenPort;
  await sshBanner(local);
  passed('real Linux Local Forward reaches SSH service');
  await assert.rejects(() => startForward(page, 'local', 22, local), /端口冲突/);
  await sshBanner(local);
  passed('local bind conflict leaves existing SSH forwarding intact');
  const dynamicForward = await startForward(page, 'dynamic', 0);
  const dynamic = dynamicForward.input.listenPort;
  await sshBanner(dynamic, true);
  passed('real Linux dynamic SOCKS5 forwarding');
  await routeChecks({ page, panes, passed, openTerminal, pin, dynamic });
  const sockets = new Set();
  const echo = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  try {
    const echoPort = echo.address().port,
      remotePort = 39000 + Math.floor(Math.random() * 5000);
    const remoteForward = await startForward(page, 'remote', echoPort, remotePort);
    const chainForward = await startForward(page, 'local', remotePort);
    const chainPort = chainForward.input.listenPort;
    const stream = net.createConnection(chainPort, '127.0.0.1');
    stream.setTimeout(8000, () => stream.destroy(new Error('forward echo timeout')));
    await once(stream, 'connect');
    const expected = Buffer.alloc(128 * 1024, 97);
    stream.end(expected);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert(Buffer.concat(chunks).equals(expected), 'real remote forward byte integrity');
    passed('real Linux Remote Forward returns 128KiB through paired SSH channels');
    await page.evaluate(async (forward) => {
      await window.__TAURI_INTERNALS__.invoke('forward_stop', { id: forward.id });
      const forwards = await window.__TAURI_INTERNALS__.invoke('forward_list', {
        id: forward.sessionId,
      });
      if (forwards.find((item) => item.id === forward.id)?.state !== 'stopped')
        throw new Error('Remote forward did not stop');
    }, remoteForward);
    for (const forward of [chainForward, dynamicForward, localForward])
      await page.evaluate(
        (id) => window.__TAURI_INTERNALS__.invoke('forward_stop', { id }),
        forward.id,
      );
    await assert.rejects(() => tcpConnect(local));
    await assert.rejects(() => tcpConnect(dynamic));
    passed('forward stop releases real local and dynamic listeners');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => echo.close(resolve));
  }
}
async function tcpConnect(port) {
  const socket = net.createConnection(port, '127.0.0.1');
  socket.setTimeout(4000, () => socket.destroy(new Error('TCP timeout')));
  try {
    await once(socket, 'connect');
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
async function sshBanner(port, socks = false) {
  const socket = await tcpConnect(port);
  const iterator = socket[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  async function read(size) {
    while (pending.length < size) {
      const next = await iterator.next();
      assert(!next.done, 'unexpected EOF');
      pending = Buffer.concat([pending, next.value]);
      assert(pending.length < 65536);
    }
    const result = pending.subarray(0, size);
    pending = pending.subarray(size);
    return result;
  }
  try {
    if (socks) {
      socket.write(Buffer.from([5, 1, 0]));
      assert((await read(2)).equals(Buffer.from([5, 0])));
      socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 22]));
      assert.equal((await read(10))[1], 0);
    }
    assert.equal((await read(4)).toString(), 'SSH-');
  } finally {
    socket.destroy();
  }
}

// Uses the isolated catalog's existing OS credential reference; no password leaves Rust.
async function routeChecks({ page, panes, passed, openTerminal, pin, dynamic }) {
  const original = await page.evaluate(async () => {
    const { hosts } = await window.__TAURI_INTERNALS__.invoke('host_list');
    const { id, createdAt, updatedAt, ...input } = hosts.find(
      (h) => h.name === 'Linux SSH verification',
    );
    return { id, input };
  });
  async function update(input) {
    await page.evaluate(
      ({ id, input }) => window.__TAURI_INTERNALS__.invoke('host_update', { id, input }),
      { id: original.id, input },
    );
  }
  async function verify(marker) {
    await openTerminal();
    const pane = panes().first();
    const trust = page.getByRole('dialog', { name: '确认 SSH 主机指纹', exact: true });
    await Promise.race([
      trust.waitFor(),
      pane.locator('.xterm-container[data-state="connected"]').waitFor(),
    ]);
    if (await trust.isVisible()) {
      assert(
        (await trust.innerText()).includes(pin),
        'jump target key must match the verified Linux key',
      );
      await trust.getByRole('button', { name: '已核对，信任并连接' }).click();
    }
    await pane.locator('.xterm-container[data-state="connected"]').waitFor();
    await pane.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`HISTFILE=/dev/null; printf '\\n__SD_%s__\\n' ${marker}; uname -s`);
    await page.keyboard.press('Enter');
    await pane
      .locator('.xterm-rows')
      .filter({ hasText: `__SD_${marker}__` })
      .waitFor();
    await pane.locator('.xterm-rows').filter({ hasText: 'Linux' }).waitFor();
    await terminalAction(page, pane, '关闭终端');
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label="终端标签"] [role=tab]').length === 1,
    );
  }
  const sockets = new Set();
  const http = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    let header = Buffer.alloc(0);
    const receive = (chunk) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (header.length > 8192) return client.destroy();
      if (end < 0) return;
      client.pause();
      client.removeListener('data', receive);
      if (!header.toString().startsWith(`CONNECT ${original.input.hostname}:22 HTTP/1.1\r\n`))
        return client.destroy();
      const upstream = net.createConnection(22, original.input.hostname);
      sockets.add(upstream);
      upstream.on('close', () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (header.length > end + 4) upstream.write(header.subarray(end + 4));
        client.pipe(upstream).pipe(client);
        client.resume();
      });
    };
    client.on('data', receive);
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  let jump;
  try {
    for (const [kind, port] of [
      ['socks5', dynamic],
      ['http_connect', http.address().port],
    ]) {
      await update({
        ...original.input,
        ssh: {
          ...original.input.ssh,
          proxy: {
            kind,
            hostname: '127.0.0.1',
            port,
            username: null,
            credentialId: null,
          },
        },
      });
      await verify(kind === 'socks5' ? 'SOCKS_ROUTE' : 'HTTP_ROUTE');
      passed(`real Linux interactive shell through ${kind} proxy and safe channel close`);
    }
    jump = await page.evaluate(
      (input) => window.__TAURI_INTERNALS__.invoke('host_create', { input }),
      { ...original.input, name: 'Isolated verified jump' },
    );
    await update({
      ...original.input,
      hostname: '127.0.0.1',
      ssh: { ...original.input.ssh, jumpHostId: jump.id },
    });
    await verify('JUMP_ROUTE');
    passed(
      'real OpenSSH jump transport to loopback Linux target with independent host-key verification',
    );
  } finally {
    await update(original.input);
    if (jump)
      await page.evaluate(
        (id) => window.__TAURI_INTERNALS__.invoke('host_delete', { id }),
        jump.id,
      );
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => http.close(resolve));
  }
}
