import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Real xterm/parser/UI with in-memory transport and clipboard fixtures. No native clipboard access.
const output = '.local/qa/terminal-clipboard';
await mkdir(output, { recursive: true });
const server = await createServer({
  root: path.resolve('apps/desktop'),
  configFile: path.resolve('apps/desktop/vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
await server.listen();
let browser, page;
const results = [];
try {
  browser = await chromium.launch({
    executablePath:
      process.env.SERVERDECK_BROWSER ??
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  for (const [kind, theme, language] of [
    ['ssh', 'dark', 'zh-CN'],
    ['local', 'light', 'en-US'],
  ]) {
    page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.evaluate(
      async ({ kind, theme, language }) => {
        const { useTerminalsStore } = await import('/src/stores/terminals.ts');
        const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
        const { useHostsStore } = await import('/src/stores/hosts.ts');
        const { useApplicationStore } = await import('/src/stores/application.ts');
        const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
        const { defaultProductPreferences } = await import('/src/types/product.ts');
        const { hostInput } = await import('/src/types/hosts.ts');
        const { terminalApi } = await import('/src/services/terminal.ts');
        const { clipboardApi } = await import('/src/services/clipboard.ts');
        const { filesApi } = await import('/src/services/files.ts');
        const source = await (await fetch('/src/components/TerminalPane.vue')).text();
        const modulePath = source.match(
          /import\s*\{\s*Terminal\s*\}\s*from\s*["']([^"']+)["']/,
        )?.[1];
        if (!modulePath) throw new Error('Cannot locate real xterm');
        const { Terminal } = await import(modulePath);
        window.clipboardQa = { input: [], writes: [], reads: 0, clipboard: 'original', acks: [] };
        const openTerminal = Terminal.prototype.open;
        Terminal.prototype.open = function (...args) {
          window.clipboardQa.terminal = this;
          return openTerminal.apply(this, args);
        };
        useApplicationStore().state = {
          appVersion: 'test',
          databaseVersion: 10,
          dataDirectory: '',
          logDirectory: '',
          config: {
            version: 5,
            theme,
            interfaceFontSize: 100,
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
          id: 'qa-clipboard',
          name: 'Clipboard QA',
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
        const open = async (receive) => {
          window.clipboardQa.receive = receive;
          queueMicrotask(() => {
            receive({ type: 'state', state: 'connected', code: null, message: null });
            receive({ type: 'data', sequence: 1, data: [...new TextEncoder().encode('qa$ ')] });
          });
          return kind === 'ssh'
            ? { id: 'qa:clipboard', hostId: host.id, transportId: 'qa:transport', routeHostIds: [] }
            : { id: 'qa:clipboard', shell: 'QA shell', elevated: false };
        };
        Object.assign(terminalApi, {
          open: async (_id, _size, receive) => open(receive),
          openLocal: async (_size, receive) => open(receive),
          close: async () => {},
          resize: async () => {},
          ack: async (_id, sequence) => {
            window.clipboardQa.acks.push(sequence);
          },
          input: async (_id, data) => {
            const text = new TextDecoder().decode(data);
            const qa = window.clipboardQa;
            qa.input.push(text);
            // Simulate the remote application's OSC 52 response to a mouse selection.
            if (qa.remoteSelection && /\x1b\[<\d+;\d+;\d+m/.test(text)) {
              qa.receive({
                type: 'data',
                sequence: 7,
                data: [...new TextEncoder().encode(`\x1b]52;c;${qa.remoteSelection}\x07`)],
              });
            }
          },
        });
        Object.assign(clipboardApi, {
          writeText: async (text) => {
            window.clipboardQa.writes.push(text);
            window.clipboardQa.clipboard = text;
          },
          readText: async () => {
            window.clipboardQa.reads++;
            return window.clipboardQa.clipboard;
          },
        });
        Object.assign(filesApi, { tasks: async () => [], connections: async () => [] });
        useTerminalsStore().open(kind === 'ssh' ? host : null);
        useWorkspaceStore().navigate('terminals', kind === 'ssh' ? host.id : '');
      },
      { kind, theme, language },
    );
    const pane = page.locator('.terminal-pane:visible');
    await pane.locator('.xterm-container[data-state="connected"]').waitFor();
    await page.waitForFunction(() => window.clipboardQa.acks.includes(1));
    // Claude-like alternate screen, mouse reporting, and bracketed paste modes.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.clipboardQa.terminal.write(
            '\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[HCLAUDE selection test\r\n> ',
            resolve,
          ),
        ),
    );
    const screen = await pane.locator('.xterm-screen').boundingBox();
    assert(screen);
    const dimensions = await page.evaluate(() => ({
      cols: window.clipboardQa.terminal.cols,
      rows: window.clipboardQa.terminal.rows,
    }));
    const cellWidth = screen.width / dimensions.cols;
    const rowY = screen.y + screen.height / dimensions.rows / 2;
    async function dragSelection(shift) {
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.move(screen.x + cellWidth * 0.1, rowY);
      await page.mouse.down();
      await page.mouse.move(screen.x + cellWidth * 6.1, rowY, { steps: 5 });
      await page.mouse.up();
      if (shift) await page.keyboard.up('Shift');
    }
    await dragSelection(false);
    await page.waitForFunction(() => /\x1b\[<\d+;\d+;\d+m/.test(window.clipboardQa.input.join('')));
    assert.equal(await page.evaluate(() => window.clipboardQa.terminal.getSelection()), '');
    await page.evaluate(() => {
      window.clipboardQa.input = [];
    });
    await pane.locator('.xterm-helper-textarea').press('Control+Shift+C');
    assert.deepEqual(await page.evaluate(() => window.clipboardQa.writes), []);
    assert.equal(await page.evaluate(() => window.clipboardQa.clipboard), 'original');
    await pane.locator('.xterm-helper-textarea').press('Control+Shift+V');
    await page.waitForFunction(
      () => window.clipboardQa.input.join('') === '\x1b[200~original\x1b[201~',
    );
    await page.evaluate(() => {
      window.clipboardQa.input = [];
    });
    await dragSelection(true);
    assert.equal(await page.evaluate(() => window.clipboardQa.terminal.getSelection()), 'CLAUDE');
    await pane.locator('.xterm-helper-textarea').press('Control+Shift+C');
    await page.waitForFunction(() => window.clipboardQa.clipboard === 'CLAUDE');
    await pane.locator('.xterm-helper-textarea').press('Control+Shift+V');
    await page.waitForFunction(
      () => window.clipboardQa.input.join('') === '\x1b[200~CLAUDE\x1b[201~',
    );
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.evaluate(async () => {
      const app = (await import('/src/stores/application.ts')).useApplicationStore();
      app.state.config.terminal.quickCopyPaste = true;
      window.clipboardQa.terminal.clearSelection();
      window.clipboardQa.clipboard = 'before quick copy';
    });
    await dragSelection(true);
    await page.waitForFunction(() => window.clipboardQa.clipboard === 'CLAUDE');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.evaluate(async () => {
      (
        await import('/src/stores/application.ts')
      ).useApplicationStore().state.config.terminal.quickCopyPaste = false;
      window.clipboardQa.terminal.clearSelection();
      window.clipboardQa.input = [];
      window.clipboardQa.writes = [];
      window.clipboardQa.clipboard = 'original';
    });
    const text = '你好 🙂\nclipboard round trip';
    const encoded = Buffer.from(text).toString('base64');
    // Exercise a real OSC sequence split across SSH frames, with both BEL and ST terminators.
    await page.evaluate(async (encoded) => {
      const qa = window.clipboardQa;
      for (const [index, chunk] of [
        '\x1b]5',
        '2;c;',
        encoded.slice(0, 5),
        encoded.slice(5),
        '\x07',
      ].entries()) {
        qa.receive({
          type: 'data',
          sequence: index + 2,
          data: [...new TextEncoder().encode(chunk)],
        });
      }
    }, encoded);
    await page.waitForFunction(() => window.clipboardQa.acks.includes(6));
    await page.waitForFunction((text) => window.clipboardQa.clipboard === text, text);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.clipboardQa.writes), [text]);
    await page.screenshot({ path: `${output}/${kind}-${language}.png` });
    // No local selection: the copy shortcut preserves the text Claude already copied.
    await pane.locator('.xterm-helper-textarea').press('Control+Shift+C');
    assert.deepEqual(await page.evaluate(() => window.clipboardQa.writes), [text]);
    await pane.locator('.xterm-helper-textarea').press('Control+Shift+V');
    await page.waitForFunction(() => window.clipboardQa.input.length === 1);
    assert.deepEqual(await page.evaluate(() => window.clipboardQa.input), [
      `\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`,
    ]);
    const nextText = '第二次选择';
    await page.evaluate(
      (encoded) =>
        new Promise((resolve) => {
          window.clipboardQa.terminal.write(`\x1b]52;c;${encoded}\x1b\\`, resolve);
        }),
      Buffer.from(nextText).toString('base64'),
    );
    await page.waitForFunction((text) => window.clipboardQa.clipboard === text, nextText);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.clipboardQa.writes), [text, nextText]);
    // Ordinary drag goes to the remote app, which copies through the real xterm parser.
    const mouseText = 'Claude 鼠标选区';
    await page.evaluate((encoded) => {
      window.clipboardQa.input = [];
      window.clipboardQa.remoteSelection = encoded;
    }, Buffer.from(mouseText).toString('base64'));
    await dragSelection(false);
    await page.waitForFunction((text) => window.clipboardQa.clipboard === text, mouseText);
    assert.equal(await page.evaluate(() => window.clipboardQa.terminal.getSelection()), '');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.evaluate(() => {
      window.clipboardQa.input = [];
    });
    await pane.locator('.xterm-helper-textarea').press('Control+Shift+C');
    assert.equal(await page.evaluate(() => window.clipboardQa.clipboard), mouseText);
    await pane.locator('.xterm-helper-textarea').press('Control+Shift+V');
    await page.waitForFunction(() => window.clipboardQa.input.length === 1);
    assert.deepEqual(await page.evaluate(() => window.clipboardQa.input), [
      `\x1b[200~${mouseText}\x1b[201~`,
    ]);
    const before = await page.evaluate(() => ({
      reads: window.clipboardQa.reads,
      input: window.clipboardQa.input,
    }));
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          window.clipboardQa.terminal.write(
            '\x1b]52;c;?\x07\x1b]52;c;\x07\x1b]52;c;!\x07',
            resolve,
          );
        }),
    );
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(
      await page.evaluate(() => ({
        reads: window.clipboardQa.reads,
        input: window.clipboardQa.input,
      })),
      before,
    );
    assert.deepEqual(await page.evaluate(() => window.clipboardQa.writes), [
      text,
      nextText,
      mouseText,
    ]);
    assert.deepEqual(errors, []);
    results.push({
      kind,
      language,
      splitOsc52: true,
      automaticOsc52Copy: true,
      copyPaste: true,
      invalidAndReadDenied: true,
      mouseApplicationShortcuts: true,
      shiftSelectionAndQuickCopyWithoutDialog: true,
      remoteMouseCopyWithoutDialog: true,
    });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: `${output}/failure.png` });
    await writeFile(`${output}/failure.txt`, await page.locator('body').innerText());
    console.log(
      await page.evaluate(() => ({
        clipboard: window.clipboardQa.clipboard,
        writes: window.clipboardQa.writes,
        selection: window.clipboardQa.terminal.getSelection(),
      })),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
