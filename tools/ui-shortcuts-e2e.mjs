import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Real application UI, xterm and keyboard events; native services are isolated fixtures.
const output = '.local/qa/shortcuts';
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
  for (const kind of ['local', 'ssh']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/src/main.ts', async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const mount = /app\.mount\(["']#app["']\);/;
      assert(mount.test(source), 'Cannot defer application mount for native service fixtures');
      await route.fulfill({
        response,
        body: source.replace(mount, 'window.shortcutMount = () => app.mount("#app");'),
      });
    });
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => !!window.shortcutMount);
    await page.evaluate(async (kind) => {
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
      const { useHostsStore } = await import('/src/stores/hosts.ts');
      const { useApplicationStore } = await import('/src/stores/application.ts');
      const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
      const { defaultProductPreferences } = await import('/src/types/product.ts');
      const { hostInput } = await import('/src/types/hosts.ts');
      const { terminalApi } = await import('/src/services/terminal.ts');
      const { filesApi } = await import('/src/services/files.ts');
      const { clipboardApi } = await import('/src/services/clipboard.ts');
      const source = await (await fetch('/src/components/TerminalPane.vue')).text();
      const modulePath = source.match(/import\s*\{\s*Terminal\s*\}\s*from\s*["']([^"']+)["']/)?.[1];
      if (!modulePath) throw new Error('Cannot locate real xterm');
      const { Terminal } = await import(modulePath);
      const qa = (window.shortcutsQa = {
        terminals: [],
        receivers: [],
        input: [],
        closed: [],
        copied: [],
        saves: [],
      });
      const originalOpen = Terminal.prototype.open;
      Terminal.prototype.open = function (...args) {
        qa.terminals.push(this);
        return originalOpen.apply(this, args);
      };
      const application = useApplicationStore();
      qa.application = application;
      application.initialize = async () => {};
      useHostsStore().load = async () => {};
      useTerminalsStore().loadSaved = async () => {};
      (await import('/src/stores/background.ts')).useBackgroundStore().start = () => {};
      (await import('/src/stores/plugins.ts')).usePluginsStore().start = () => {};
      (await import('/src/stores/updates.ts')).useUpdatesStore().initialize = async () => {};
      const files = (await import('/src/stores/files.ts')).useFilesStore();
      files.poll = async () => {};
      files.syncEditorState = async () => {};
      application.state = {
        appVersion: 'test',
        databaseVersion: 10,
        dataDirectory: '',
        logDirectory: '',
        config: {
          version: 2,
          theme: 'dark',
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
      application.save = async (config) => {
        qa.saves.push(JSON.parse(JSON.stringify(config)));
        application.state.config = config;
      };
      clipboardApi.readText = async () => 'PASTE-QA';
      clipboardApi.writeText = async (text) => {
        qa.copied.push(text);
      };
      const host = {
        ...hostInput(),
        id: 'qa-shortcuts',
        name: 'Shortcuts QA',
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
        const id = `shortcuts-${qa.receivers.length}`;
        qa.receivers.push(receive);
        queueMicrotask(() => {
          receive({ type: 'state', state: 'connected', code: null, message: null });
          receive({
            type: 'data',
            sequence: 1,
            data: [...new TextEncoder().encode('SHORTCUT-QA\r\nqa$ ')],
          });
        });
        return { id, hostId: host.id, transportId: id, routeHostIds: [host.id], shell: 'QA' };
      };
      Object.assign(terminalApi, {
        open: async (_host, _size, receive) => open(receive),
        openLocal: async (_size, receive) => open(receive),
        close: async (id) => {
          qa.closed.push(id);
        },
        resize: async () => {},
        ack: async () => {},
        input: async (id, data) => {
          qa.input.push({ id, data: [...data] });
        },
      });
      useTerminalsStore().open(kind === 'local' ? null : host);
      useWorkspaceStore().navigate('terminals', kind === 'local' ? '' : host.id);
      window.shortcutMount();
      (await import('/src/stores/notifications.ts')).useNotificationsStore().items = [];
    }, kind);
    const visiblePanes = page.locator('.split-pane:not(.terminal-hidden)');
    const focus = () => visiblePanes.last().locator('.xterm-helper-textarea').focus();
    const snapshot = () =>
      page.evaluate(async () => {
        const store = (await import('/src/stores/terminals.ts')).useTerminalsStore();
        return {
          active: store.active,
          focused: store.focused,
          tabs: store.tabs.map((tab) => ({
            key: tab.key,
            layout: tab.layout,
            panes: tab.panes.map((pane) => ({ key: pane.key, sessionId: pane.sessionId })),
          })),
          fontSize: (await import('/src/stores/application.ts')).useApplicationStore().state.config
            .terminalFontSize,
        };
      });
    await page.locator('.terminal-pane[data-state="connected"]').waitFor();
    await focus();
    const initial = await snapshot();
    await page.keyboard.press('Control+Shift+E');
    assert.equal(await visiblePanes.count(), 1);
    await page.keyboard.press('Control+Shift+L');
    await page.waitForFunction(
      () => document.querySelectorAll('.split-pane:not(.terminal-hidden)').length === 2,
    );
    let current = await snapshot();
    assert.equal(current.tabs[0].layout.axis, 'columns');
    assert.deepEqual(current.tabs[0].panes[0], initial.tabs[0].panes[0]);
    const boxes = await visiblePanes.evaluateAll((panes) =>
      panes.map((pane) => {
        const { x, y, width, height } = pane.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    assert(boxes[1].x > boxes[0].x && boxes[1].y === boxes[0].y);
    assert(boxes.every((box) => box.width > 100 && box.height > 100));
    await page.screenshot({ path: `${output}/${kind}-columns.png` });
    await focus();
    await page.keyboard.press('Control+Shift+H');
    await page.waitForFunction(
      () => document.querySelectorAll('.split-pane:not(.terminal-hidden)').length === 3,
    );
    current = await snapshot();
    assert.equal(current.tabs[0].layout.second.axis, 'rows');
    await page.screenshot({ path: `${output}/${kind}-rows.png` });

    await focus();
    await page.keyboard.press('Control+Shift+T');
    await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 2);
    const secondTab = (await snapshot()).active;
    await focus();
    await page.keyboard.press('Control+Shift+ArrowLeft');
    await page.waitForFunction(
      () =>
        document
          .querySelector('.terminal-tab.active [role="tab"]')
          .getAttribute('aria-selected') === 'true' &&
        document.querySelectorAll('.split-pane:not(.terminal-hidden)').length === 3,
    );
    assert.equal((await snapshot()).active, initial.active);
    await focus();
    await page.keyboard.press('Control+Shift+ArrowRight');
    assert.equal((await snapshot()).active, secondTab);

    await focus();
    await page.keyboard.press('Control+Shift+Equal');
    await page.waitForFunction(
      () => window.shortcutsQa.application.state.config.terminalFontSize === 17,
    );
    assert.equal((await snapshot()).fontSize, 17);
    await page.keyboard.press('Control+Shift+Minus');
    await page.waitForFunction(
      () => window.shortcutsQa.application.state.config.terminalFontSize === 16,
    );
    assert.equal((await snapshot()).fontSize, 16);

    await page.keyboard.press('Control+Shift+F');
    await page.getByRole('textbox', { name: '终端查找内容', exact: true }).fill('SHORTCUT-QA');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.terminal-find').count(), 0);
    await page.evaluate(() => window.shortcutsQa.terminals.at(-1).select(0, 0, 11));
    await page.keyboard.press('Control+Shift+C');
    await page.waitForFunction(() => window.shortcutsQa.copied.length === 1);
    assert.deepEqual(await page.evaluate(() => window.shortcutsQa.copied), ['SHORTCUT-QA']);
    await page.keyboard.press('Control+Shift+V');
    await page.waitForFunction(() =>
      window.shortcutsQa.input.some((input) =>
        new TextDecoder().decode(new Uint8Array(input.data)).includes('PASTE-QA'),
      ),
    );
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() =>
      [3, 26].every((byte) => window.shortcutsQa.input.some((input) => input.data.includes(byte))),
    );

    await page.keyboard.press('Control+k');
    await page.locator('dialog[open]').waitFor();
    assert((await page.locator('dialog[open]').innerText()).includes('Shortcuts QA'));
    await page.keyboard.press('Control+Shift+P');
    assert.equal(await page.locator('.settings-page:visible').count(), 0);
    assert(await page.locator('dialog[open]').isVisible());
    await page.keyboard.press('Escape');
    await focus();
    await page.keyboard.press('Control+Comma');
    assert.equal(await page.locator('.settings-page:visible').count(), 0);
    for (const fixture of [
      { type: 'keyup', key: ',', code: '' },
      { type: 'keyup', key: 'P', code: 'KeyP', shiftKey: true },
    ]) {
      const inputCount = await page.evaluate(() => window.shortcutsQa.input.length);
      const handled = await page
        .locator('.xterm-helper-textarea:focus')
        .evaluate((input, fixture) => {
          const event = new KeyboardEvent(fixture.type, {
            key: fixture.key,
            code: fixture.code,
            ctrlKey: true,
            shiftKey: fixture.shiftKey ?? false,
            bubbles: true,
            cancelable: true,
          });
          input.dispatchEvent(event);
          return event.defaultPrevented;
        }, fixture);
      assert(!handled, `Keyup must not trigger navigation: ${JSON.stringify(fixture)}`);
      assert.equal(await page.locator('.settings-page:visible').count(), 0);
      assert.equal(await page.evaluate(() => window.shortcutsQa.input.length), inputCount);
    }
    await page.keyboard.press('Control+Shift+P');
    await page.locator('.settings-page').waitFor({ state: 'visible' });
    await page
      .locator('.settings-navigation')
      .getByRole('button', { name: '快捷键', exact: true })
      .click();
    const splitBinding = page.getByRole('textbox', { name: '垂直分屏（左右）快捷键', exact: true });
    await splitBinding.focus();
    await page.keyboard.press('Control+Shift+G');
    await page.waitForFunction(
      () =>
        window.shortcutsQa.application.state.config.terminal.shortcuts.splitColumns ===
        'Ctrl+Shift+G',
    );
    if (kind === 'local')
      await page
        .locator('.activity-rail')
        .getByRole('button', { name: '本地终端', exact: true })
        .click();
    else {
      await page
        .locator('.activity-rail')
        .getByRole('button', { name: '首页', exact: true })
        .click();
      await page.locator('.workspace-tab[data-host-id="qa-shortcuts"] [role="tab"]').click();
    }
    await focus();
    await page.keyboard.press('Control+Shift+L');
    assert.equal(await visiblePanes.count(), 1);
    await page.keyboard.press('Control+Shift+G');
    await page.waitForFunction(
      () => document.querySelectorAll('.split-pane:not(.terminal-hidden)').length === 2,
    );
    const beforeClose = await snapshot();
    const closedId = beforeClose.tabs.find((tab) => tab.key === secondTab).panes.at(-1).sessionId;
    await focus();
    await page.keyboard.press('Control+Shift+W');
    await page.waitForFunction(
      () => document.querySelectorAll('.split-pane:not(.terminal-hidden)').length === 1,
    );
    assert((await page.evaluate(() => window.shortcutsQa.closed)).includes(closedId));
    assert.equal((await snapshot()).tabs.length, 2);
    assert.deepEqual(errors, []);
    results.push({
      kind,
      shortcuts: 13,
      checks:
        'split geometry, session identity, tabs, font, find, clipboard, control keys, new settings and split bindings, no keyup navigation, remapping, close',
      errors,
    });
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
  await writeFile(`${output}/results.json`, `${JSON.stringify(results, null, 2)}\n`);
}
console.log(JSON.stringify(results, null, 2));
