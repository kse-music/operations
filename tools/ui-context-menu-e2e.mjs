import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Isolated rendering fixtures only; no persisted data or SSH/SFTP operations.
const output = process.env.SERVERDECK_MENU_OUTPUT ?? '.local/context-menu-qa';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.SERVERDECK_BROWSER ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const results = [];
const i18nUrl = `/@fs/${path.resolve('packages/plugin-sdk/src/i18n.ts').replaceAll('\\', '/')}`;
const server = process.env.SERVERDECK_MENU_URL
  ? null
  : await createServer({
      root: path.resolve('apps/desktop'),
      configFile: path.resolve('apps/desktop/vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
await server?.listen();
const url = process.env.SERVERDECK_MENU_URL ?? server.resolvedUrls.local[0];
try {
  for (const [name, width, height, theme, scale, language] of [
    ['desktop-dark', 1280, 820, 'dark', 1, 'zh-CN'],
    ['desktop-light', 1280, 820, 'light', 1, 'zh-CN'],
    ['small-large', 960, 600, 'dark', 1.45, 'zh-CN'],
    ['short-english', 960, 280, 'light', 1.45, 'en-US'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.evaluate(
      async ({ theme, scale, language, i18nUrl }) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const { useHostsStore } = await import('/src/stores/hosts.ts');
        const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
        const { useTerminalsStore } = await import('/src/stores/terminals.ts');
        const { useFilesStore } = await import('/src/stores/files.ts');
        const { useNotificationsStore } = await import('/src/stores/notifications.ts');
        const { hostInput } = await import('/src/types/hosts.ts');
        const { filesApi } = await import('/src/services/files.ts');
        const { setLocale } = await import(i18nUrl);
        Object.assign(filesApi, {
          tasks: async () => [],
          connections: async () => [],
          localDrives: async () => [],
        });
        const hosts = useHostsStore(pinia),
          terminals = useTerminalsStore(pinia),
          files = useFilesStore(pinia);
        hosts.catalog = {
          hosts: ['a', 'b'].map((id) => ({
            ...hostInput(),
            id,
            name: `Server ${id}`,
            hostname: `${id}.example`,
            username: 'operator',
            createdAt: '',
            updatedAt: '',
          })),
          groups: [{ id: 'folder', name: 'Servers', sortOrder: 0, parentId: null }],
          credentials: [],
          pendingSecretDeletions: 0,
        };
        const entry = {
          name: 'folder',
          path: '/srv/folder',
          kind: 'directory',
          size: null,
          modified: null,
          permissions: 0o755,
          uid: 1000,
          gid: 1000,
        };
        const entries = [
          entry,
          { ...entry, name: 'config.ini', path: '/srv/config.ini', kind: 'file', size: 20 },
        ];
        files.local = { path: 'C:/', parent: null, entries };
        files.active = 'a';
        files.connections.a = {
          host: hosts.catalog.hosts[0],
          id: 'sftp-a',
          state: 'connected',
          error: null,
          trust: null,
          path: '/srv',
          loading: false,
          listing: { path: '/srv', parent: '/', entries },
        };
        for (const host of hosts.catalog.hosts) {
          terminals.open(host);
          terminals.update(terminals.focused, { state: 'disconnected', connectRequested: false });
          useWorkspaceStore(pinia).navigate('terminals', host.id);
        }
        terminals.activateHost('a');
        useWorkspaceStore(pinia).navigate('terminals', 'a');
        useNotificationsStore(pinia).items = [];
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty('--interface-font-scale', String(scale));
        setLocale(language);
      },
      { theme, scale, language, i18nUrl },
    );

    const measured = [];
    async function checkMenu(kind, selector, icons = false) {
      const menu = page.locator(selector);
      await menu.waitFor();
      // Positioning runs after Vue's DOM update; wait for the final viewport clamp.
      await page
        .waitForFunction((selector) => {
          const bounds = document.querySelector(selector)?.getBoundingClientRect();
          return (
            bounds &&
            bounds.left >= 7.5 &&
            bounds.top >= 7.5 &&
            bounds.right <= innerWidth - 7 &&
            bounds.bottom <= innerHeight - 7
          );
        }, selector)
        .catch(async (error) => {
          console.error(
            name,
            kind,
            await menu.evaluate((element) => ({
              html: element.outerHTML,
              position: getComputedStyle(element).position,
              left: getComputedStyle(element).left,
              top: getComputedStyle(element).top,
              rect: element.getBoundingClientRect().toJSON(),
            })),
          );
          await page.screenshot({ path: `${output}/${name}-${kind}-failure.png` });
          throw error;
        });
      const info = await menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const items = [...element.querySelectorAll('[role="menuitem"]')];
        return {
          width: rect.width,
          height: rect.height,
          scrolls: element.scrollHeight > element.clientHeight,
          horizontalOverflow: element.scrollWidth > element.clientWidth,
          rows: items.map((item) => {
            const bounds = item.getBoundingClientRect(),
              style = getComputedStyle(item);
            const svg = item.querySelector('svg');
            return {
              height: bounds.height,
              font: parseFloat(style.fontSize),
              lineHeight: style.lineHeight,
              padding: style.padding,
              icon: svg?.getAttribute('aria-hidden'),
              iconLeft: svg?.getBoundingClientRect().left,
              text: item.textContent.trim(),
            };
          }),
        };
      });
      assert(info.rows.length > 0);
      assert(!info.horizontalOverflow, `${name}/${kind}: horizontal overflow`);
      for (const row of info.rows) {
        assert(
          row.height >= 28 && row.height <= Math.max(28, row.font * 1.4 + 8) + 1,
          `${name}/${kind}: sparse or clipped row ${JSON.stringify(row)}`,
        );
        if (icons) assert.equal(row.icon, 'true');
      }
      if (icons) assert(info.rows.every((row) => row.iconLeft === info.rows[0].iconLeft));
      measured.push({ kind, ...info });
      await page.screenshot({ path: `${output}/${name}-${kind}.png` });
      if (name === 'desktop-dark' && kind === 'remote-file')
        await menu.screenshot({ path: `${output}/sftp-menu-preview.png` });
      return menu;
    }
    const atEdge = { clientX: width - 1, clientY: height - 1, bubbles: true, cancelable: true };
    for (const [kind, trigger, selector] of [
      ['root', '.group-toggle', '.host-tree-menu'],
      ['folder', '[data-group-id="folder"] .group-toggle', '.host-tree-menu'],
      ['host', '.tree-host', '.host-tree-menu'],
      ['workspace-tab', '.workspace-tab', '.workspace-tab-menu'],
      ['session', '.terminal-tab', '.terminal-session-menu'],
      ['terminal', '.terminal-pane:visible .xterm-container', '.terminal-context-menu'],
    ]) {
      await page
        .locator(trigger)
        .first()
        .evaluate((element, event) => {
          element.dispatchEvent(new MouseEvent('contextmenu', event));
        }, atEdge);
      const menu = await checkMenu(kind, selector);
      await menu.dispatchEvent('keydown', { key: 'Escape', bubbles: true });
      await menu.waitFor({ state: 'hidden' });
    }
    await page.evaluate(async () => {
      const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
      useWorkspaceStore().navigate('files', 'a');
    });
    await page.locator('.files-view').waitFor();
    // Browser preview reports the unavailable native drag/drop API; it is outside this layout check.
    await page.evaluate(async () => {
      const { useNotificationsStore } = await import('/src/stores/notifications.ts');
      useNotificationsStore().items = [];
    });
    for (const side of ['local', 'remote']) {
      for (const [index, kind] of ['directory', 'file'].entries()) {
        await page
          .locator('.file-side')
          .nth(side === 'local' ? 0 : 1)
          .locator('tbody tr')
          .nth(index)
          .evaluate((element, event) => {
            element.dispatchEvent(new MouseEvent('contextmenu', event));
          }, atEdge);
        const menu = await checkMenu(`${side}-${kind}`, '.file-context-menu', true);
        if (side === 'remote' && kind === 'file' && height === 280) {
          assert(measured.at(-1).scrolls, 'long menu in short viewport must scroll');
          const last = menu.getByRole('menuitem').last();
          await last.scrollIntoViewIfNeeded();
          const menuBox = await menu.boundingBox(),
            lastBox = await last.boundingBox();
          assert(
            lastBox.y >= menuBox.y && lastBox.y + lastBox.height <= menuBox.y + menuBox.height,
          );
          await page.screenshot({ path: `${output}/${name}-remote-file-scrolled.png` });
        }
        await page.locator('.context-backdrop').click({ position: { x: 10, y: 10 }, force: true });
        await menu.waitFor({ state: 'hidden' });
      }
    }
    assert.deepEqual(errors, []);
    results.push({ name, width, height, theme, scale, language, measured });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} viewport/theme/font/language groups, 10 menu variants each`);
} finally {
  await browser.close();
  await server?.close();
}
