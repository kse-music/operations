import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Browser-memory transport fixtures with real xterm buffers; no native IPC or remote operations.
const output = '.local/qa/terminal-reconnect-reset';
await mkdir(output, { recursive: true });
const server = await createServer({
  root: path.resolve('apps/desktop'),
  configFile: path.resolve('apps/desktop/vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
await server.listen();
let browser;
const results = [];
try {
  browser = await chromium.launch({
    executablePath:
      process.env.SERVERDECK_BROWSER ??
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  for (const [kind, theme, alternate] of [
    ['local', 'dark', false],
    ['ssh', 'light', false],
    ['ssh', 'dark', true],
  ]) {
    const name = `${kind}-${theme}-${alternate ? 'alternate' : 'normal'}`;
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.evaluate(
      async ({ kind, theme }) => {
        const { useTerminalsStore } = await import('/src/stores/terminals.ts');
        const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
        const { useHostsStore } = await import('/src/stores/hosts.ts');
        const { useApplicationStore } = await import('/src/stores/application.ts');
        const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
        const { defaultProductPreferences } = await import('/src/types/product.ts');
        const { hostInput } = await import('/src/types/hosts.ts');
        const { terminalApi } = await import('/src/services/terminal.ts');
        const { filesApi } = await import('/src/services/files.ts');
        const source = await (await fetch('/src/components/TerminalPane.vue')).text();
        const modulePath = source.match(
          /import\s*\{\s*Terminal\s*\}\s*from\s*["']([^"']+)["']/,
        )?.[1];
        if (!modulePath) throw new Error('Cannot locate the real xterm module');
        const { Terminal } = await import(modulePath);
        const write = Terminal.prototype.write;
        window.reconnectQa = { receivers: [], closed: [], input: [], terminal: null };
        Terminal.prototype.write = function (...args) {
          window.reconnectQa.terminal = this;
          return write.apply(this, args);
        };
        useApplicationStore().state = {
          appVersion: 'test',
          databaseVersion: 10,
          dataDirectory: '',
          logDirectory: '',
          config: {
            version: 2,
            theme,
            interfaceFontSize: 'standard',
            sidebarWidth: 248,
            terminalFontSize: 16,
            connectTimeoutSecs: 15,
            monitorIntervalSecs: 5,
            transferConcurrency: 3,
            logLevel: 'info',
            terminal: defaultTerminalPreferences(),
            product: defaultProductPreferences(),
          },
        };
        const host = {
          ...hostInput(),
          id: 'qa',
          name: 'Reconnect QA',
          hostname: '192.0.2.1',
          username: 'qa',
          createdAt: '',
          updatedAt: '',
        };
        useHostsStore().catalog = {
          hosts: [host],
          groups: [],
          credentials: [],
          pendingSecretDeletions: 0,
        };
        Object.assign(filesApi, { tasks: async () => [], connections: async () => [] });
        const open = async (receive) => {
          const id = `session-${window.reconnectQa.receivers.length}`;
          window.reconnectQa.receivers.push(receive);
          queueMicrotask(() => {
            receive({ type: 'state', state: 'connected', code: null, message: null });
            receive({
              type: 'data',
              sequence: 1,
              data: [...new TextEncoder().encode(`NEW-${id}\r\nqa$ `)],
            });
          });
          return { id, hostId: host.id, transportId: id, routeHostIds: [host.id], shell: 'QA' };
        };
        terminalApi.open = async (_host, _size, receive) => open(receive);
        terminalApi.openLocal = async (_size, receive) => open(receive);
        terminalApi.close = async (id) => {
          window.reconnectQa.closed.push(id);
        };
        terminalApi.resize = async () => {};
        terminalApi.ack = async () => {};
        terminalApi.input = async (...args) => {
          window.reconnectQa.input.push(args);
        };
        useTerminalsStore().open(kind === 'local' ? null : host);
        useWorkspaceStore().navigate('terminals', kind === 'local' ? '' : host.id);
        document.documentElement.dataset.theme = theme;
      },
      { kind, theme },
    );
    await page.locator('.terminal-pane[data-state="connected"]').waitFor();
    const old = await page.evaluate(async (alternate) => {
      const qa = window.reconnectQa;
      await new Promise((resolve) => qa.terminal.write('', resolve));
      const oldOutput = Array.from({ length: 150 }, (_, n) => `OLD-HISTORY-${n}\r\n`).join('');
      qa.receivers[0]({
        type: 'data',
        sequence: 2,
        data: [...new TextEncoder().encode(oldOutput)],
      });
      await new Promise((resolve) => qa.terminal.write('', resolve));
      const scrollback = qa.terminal.buffer.normal.baseY;
      if (alternate) {
        qa.receivers[0]({
          type: 'data',
          sequence: 3,
          data: [...new TextEncoder().encode('\x1b[?1049hOLD-ALTERNATE\r\n')],
        });
        await new Promise((resolve) => qa.terminal.write('', resolve));
      }
      qa.terminal.select(0, 0, 5);
      qa.receivers[0]({
        type: 'data',
        sequence: 4,
        data: [...new TextEncoder().encode('\x1b[?1h\x1b[?2004h\x1b[31m')],
      });
      await new Promise((resolve) => qa.terminal.write('', resolve));
      return {
        scrollback,
        mode: qa.terminal.buffer.active.type,
        selected: qa.terminal.hasSelection(),
      };
    }, alternate);
    assert(old.scrollback > 0, 'fixture must contain real scrollback');
    assert.equal(old.mode, alternate ? 'alternate' : 'normal');
    assert(old.selected);
    const menu = page.getByRole('menu', { name: '终端会话操作', exact: true });
    const tab = page.locator('.terminal-tab [role="tab"]').first();
    await tab.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '断开连接', exact: true }).click();
    await page.locator('.terminal-pane[data-state="disconnected"]').waitFor();
    const disconnected = await page.evaluate(() => ({
      baseY: window.reconnectQa.terminal.buffer.normal.baseY,
      selected: window.reconnectQa.terminal.hasSelection(),
    }));
    assert.equal(disconnected.baseY, old.scrollback, 'disconnect must preserve the old buffer');
    assert(disconnected.selected);
    // Leave output queued and the parser inside an unfinished OSC before reconnecting.
    await page.evaluate(async () => {
      window.reconnectQa.terminal.write('OLD-PENDING\x1b]0;unfinished');
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      await useTerminalsStore().reconnect(useTerminalsStore().active);
      await new Promise((resolve) => window.reconnectQa.terminal.write('', resolve));
    });
    await page.locator('.terminal-pane[data-state="connected"]').waitFor();
    const clean = await page.evaluate(() => {
      const terminal = window.reconnectQa.terminal;
      const text = (buffer) =>
        Array.from(
          { length: buffer.length },
          (_, i) => buffer.getLine(i)?.translateToString(true) ?? '',
        ).join('\n');
      return {
        normal: text(terminal.buffer.normal),
        alternate: text(terminal.buffer.alternate),
        active: terminal.buffer.active.type,
        baseY: terminal.buffer.normal.baseY,
        selection: terminal.getSelection(),
        modes: terminal.modes,
        fontSize: terminal.options.fontSize,
        closed: window.reconnectQa.closed,
        input: window.reconnectQa.input.length,
      };
    });
    assert(clean.normal.includes('NEW-session-1'));
    assert(!clean.normal.includes('OLD-') && !clean.normal.includes('NEW-session-0'));
    assert(!clean.alternate.includes('OLD-'));
    assert.equal(clean.active, 'normal');
    assert.equal(clean.baseY, 0);
    assert.equal(clean.selection, '');
    assert.equal(clean.modes.bracketedPasteMode, false);
    assert.equal(clean.modes.applicationCursorKeysMode, false);
    assert.equal(clean.fontSize, 16);
    assert.equal(clean.input, 0, 'display reset must not send commands to the new Shell');
    assert.deepEqual(clean.closed, ['session-0']);
    const late = await page.evaluate(async () => {
      const terminal = window.reconnectQa.terminal;
      window.reconnectQa.receivers[0]({
        type: 'data',
        sequence: 5,
        data: [...new TextEncoder().encode('OLD-LATE')],
      });
      await new Promise((resolve) => terminal.write('', resolve));
      return Array.from(
        { length: terminal.buffer.normal.length },
        (_, i) => terminal.buffer.normal.getLine(i)?.translateToString(true) ?? '',
      ).join('\n');
    });
    assert(!late.includes('OLD-LATE'));
    await page.screenshot({ path: `${output}/${name}.png` });
    // Connected sessions cannot reconnect through the menu or the store entry point.
    await tab.click({ button: 'right' });
    const reconnect = menu.getByRole('menuitem', { name: '重新连接', exact: true });
    assert(await reconnect.isDisabled());
    await reconnect.evaluate((element) => element.click());
    await page.evaluate(async () => {
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      await useTerminalsStore().reconnect(useTerminalsStore().active);
    });
    assert.equal(await page.evaluate(() => window.reconnectQa.receivers.length), 2);
    assert.equal(await page.evaluate(() => window.reconnectQa.closed.length), 1);
    await page.screenshot({ path: `${output}/${name}-reconnect-disabled.png` });
    // A remote disconnect updates an already-open menu, and retry still resets the old screen.
    await page.evaluate(() =>
      window.reconnectQa.receivers[1]({
        type: 'state',
        state: 'disconnected',
        code: null,
        message: null,
      }),
    );
    await page.locator('.terminal-pane[data-state="disconnected"]').waitFor();
    assert(await reconnect.isEnabled());
    await menu.getByRole('menuitem', { name: '重新连接', exact: true }).click();
    await page.waitForFunction(() => window.reconnectQa.receivers.length === 3);
    const again = await page.evaluate(async () => {
      const terminal = window.reconnectQa.terminal;
      await new Promise((resolve) => terminal.write('', resolve));
      return Array.from(
        { length: terminal.buffer.normal.length },
        (_, i) => terminal.buffer.normal.getLine(i)?.translateToString(true) ?? '',
      ).join('\n');
    });
    assert(again.includes('NEW-session-2') && !again.includes('NEW-session-1'));
    assert.equal(await page.locator('.terminal-tab').count(), 1);
    assert.deepEqual(errors, []);
    results.push({ name, old, disconnected, clean, errors });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} real-xterm reconnect scenarios`);
} finally {
  await browser?.close();
  await server.close();
}
