import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Real xterm and application UI with explicitly isolated in-memory IPC fixtures.
const output = '.local/qa/terminal-status';
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
  for (const [width, height, theme, font, language] of [
    [1280, 820, 'dark', 'standard', 'zh-CN'],
    [960, 600, 'light', 'standard', 'zh-CN'],
    [960, 600, 'dark', 'ultraLarge', 'zh-CN'],
    [1280, 820, 'light', 'standard', 'en-US'],
    [960, 600, 'light', 'ultraLarge', 'en-US'],
  ]) {
    const name = `${width}-${theme}-${font}-${language}`;
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.evaluate(
      async ({ theme, font, language }) => {
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
        if (!modulePath) throw new Error('Cannot locate real xterm');
        const { Terminal } = await import(modulePath);
        window.statusQa = { terminals: [], receivers: [], input: [], closed: [] };
        const openTerminal = Terminal.prototype.open;
        Terminal.prototype.open = function (...args) {
          window.statusQa.terminals.push(this);
          return openTerminal.apply(this, args);
        };
        useApplicationStore().state = {
          appVersion: 'test',
          databaseVersion: 10,
          dataDirectory: '',
          logDirectory: '',
          config: {
            version: 2,
            theme,
            interfaceFontSize: font,
            sidebarWidth: 248,
            terminalFontSize: 16,
            connectTimeoutSecs: 15,
            monitorIntervalSecs: 5,
            transferConcurrency: 3,
            logLevel: 'info',
            terminal: defaultTerminalPreferences(),
            product: { ...defaultProductPreferences(), language },
          },
        };
        const host = {
          ...hostInput(),
          id: 'qa-status',
          name: 'Status QA',
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
        const open = async (receive, local) => {
          const index = window.statusQa.receivers.length;
          const id = `status-session-${index}`;
          window.statusQa.receivers.push(receive);
          queueMicrotask(() => {
            if (!local)
              receive({
                type: 'connection',
                cipher: index === 0 ? 'aes256-ctr' : 'chacha20-poly1305@openssh.com',
              });
            receive({ type: 'state', state: 'connected', code: null, message: null });
            receive({
              type: 'data',
              sequence: 1,
              data: [...new TextEncoder().encode(`Terminal status QA ${index}\r\nqa$ `)],
            });
          });
          return local
            ? { id, shell: 'PowerShell' }
            : { id, hostId: host.id, transportId: 'status-transport', routeHostIds: [host.id] };
        };
        Object.assign(terminalApi, {
          open: async (_host, _size, receive) => open(receive, false),
          openLocal: async (_size, receive) => open(receive, true),
          close: async (id) => {
            window.statusQa.closed.push(id);
          },
          resize: async () => {},
          ack: async () => {},
          input: async (...args) => {
            window.statusQa.input.push(args);
          },
        });
        useTerminalsStore().open(host);
        useWorkspaceStore().navigate('terminals', host.id);
        (await import('/src/stores/notifications.ts')).useNotificationsStore().items = [];
      },
      { theme, font, language },
    );
    const status = page.locator('.statusbar .terminal-status');
    await status.getByText('SSH2 · aes256-ctr', { exact: true }).waitFor();
    await page.evaluate(() =>
      window.statusQa.receivers[0]({
        type: 'data',
        sequence: 2,
        data: [...new TextEncoder().encode('\x1b[17;10H')],
      }),
    );
    await page.waitForFunction(() =>
      /(?:光标|Cursor) 17:10/.test(document.querySelector('.terminal-status').textContent),
    );
    const initial = await page.evaluate(async () => {
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      const pane = useTerminalsStore().panes[0];
      const terminal = window.statusQa.terminals[0];
      return { screen: { ...pane.screen }, rows: terminal.rows, cols: terminal.cols };
    });
    assert.equal(initial.screen.rows, initial.rows);
    assert.equal(initial.screen.cols, initial.cols);
    assert(initial.rows > 17 && initial.cols > 10);
    await page.screenshot({ path: `${output}/${name}.png` });
    const layout = await status.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const footer = element.parentElement.getBoundingClientRect();
      const left = element.parentElement.firstElementChild.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        footerRight: footer.right,
        previousRight: left.right,
        width: box.width,
        scrollWidth: element.scrollWidth,
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert(layout.width > 0 && layout.left >= layout.previousRight);
    assert(layout.right <= layout.footerRight && layout.footerRight - layout.right <= 16);
    assert.equal(layout.documentOverflow, false);
    // Split focus follows real pointer interaction; background cursor events cannot replace it.
    await page.evaluate(async () => {
      const store = (await import('/src/stores/terminals.ts')).useTerminalsStore();
      store.split(store.focused, 'columns');
    });
    await status.getByText('SSH2 · chacha20-poly1305@openssh.com', { exact: true }).waitFor();
    await page.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { modifierCapsLock: false, modifierNumLock: false }),
      ),
    );
    const longLayout = await status.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return {
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        scrollLeft: element.scrollLeft,
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.equal(longLayout.documentOverflow, false);
    if (longLayout.scrollWidth > longLayout.width) {
      assert(longLayout.scrollLeft > 0, 'long metadata must remain horizontally accessible');
      await status.focus();
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(
        (previous) => document.querySelector('.terminal-status').scrollLeft < previous,
        longLayout.scrollLeft,
      );
    }
    await page.screenshot({ path: `${output}/${name}-split.png` });
    await page
      .locator('.split-pane')
      .nth(0)
      .click({ position: { x: 30, y: 30 } });
    await status.getByText('SSH2 · aes256-ctr', { exact: true }).waitFor();
    await page.keyboard.press('x');
    await page.waitForFunction(() => window.statusQa.input.length > 0);
    await page.evaluate(() => {
      window.statusQa.receivers[1]({
        type: 'data',
        sequence: 2,
        data: [...new TextEncoder().encode('\x1b[3;7H')],
      });
      window.dispatchEvent(
        new KeyboardEvent('keydown', { modifierCapsLock: true, modifierNumLock: true }),
      );
    });
    await page.waitForFunction(
      () => document.querySelectorAll('.terminal-status-locks .locked').length === 2,
    );
    assert((await status.textContent()).includes('aes256-ctr'));
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert((await status.textContent()).includes('CAP ?'));
    // Resize changes real PTY dimensions and cursor data without recreating terminals.
    await page.setViewportSize({ width: width + 120, height: height + 60 });
    await page.waitForFunction(async () => {
      const store = (await import('/src/stores/terminals.ts')).useTerminalsStore();
      return store.panes[0].screen.cols === window.statusQa.terminals[0].cols;
    });
    // A second session, disconnection, reconnect, and local workspace all update the same status area.
    await page.evaluate(async () => {
      const store = (await import('/src/stores/terminals.ts')).useTerminalsStore();
      store.open(store.panes[0].host);
    });
    await page.waitForFunction(() => window.statusQa.receivers.length === 3);
    await page.evaluate(() =>
      window.statusQa.receivers[2]({
        type: 'state',
        state: 'disconnected',
        code: null,
        message: null,
      }),
    );
    await page.waitForFunction(() =>
      /已断开连接|Disconnected/.test(document.querySelector('.terminal-status').textContent),
    );
    assert(!(await status.textContent()).includes('chacha20'));
    await page.evaluate(async () => {
      const store = (await import('/src/stores/terminals.ts')).useTerminalsStore();
      await store.reconnect(store.active);
      window.statusQa.receivers[2]({ type: 'connection', cipher: 'stale-cipher' });
    });
    await status.getByText('SSH2 · chacha20-poly1305@openssh.com', { exact: true }).waitFor();
    assert(!(await status.textContent()).includes('stale-cipher'));
    await page.evaluate(async () => {
      const store = (await import('/src/stores/terminals.ts')).useTerminalsStore();
      const workspace = (await import('/src/stores/workspace.ts')).useWorkspaceStore();
      workspace.navigate('files', store.panes[0].host.id);
    });
    await status.waitFor({ state: 'detached' });
    await page.evaluate(async () => {
      (await import('/src/stores/terminals.ts')).useTerminalsStore().open(null);
      (await import('/src/stores/workspace.ts')).useWorkspaceStore().navigate('terminals', '');
    });
    await status.getByText('PowerShell', { exact: true }).waitFor();
    assert(!(await status.textContent()).includes('SSH2'));
    assert.deepEqual(errors, []);
    results.push({ name, initial, layout, longLayout, errors });
    await page.close();
  }
  await writeFile(`${output}/browser-results.json`, JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} real-xterm terminal status scenarios`);
} finally {
  await browser?.close();
  await server.close();
}
