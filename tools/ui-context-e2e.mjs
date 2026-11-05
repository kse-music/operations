import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace, selectHostWorkspace, terminalTabAction } from './ui-navigation.mjs';

// Rendering fixtures are confined to these browser pages; no persisted data or remote operations.
const output = process.env.SERVERDECK_CONTEXT_OUTPUT ?? '.local/ui-context';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.SERVERDECK_BROWSER ?? '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const results = [];
try {
  for (const [name, width, height, theme] of [
    ['desktop-dark', 1440, 900, 'dark'],
    ['desktop-light', 1440, 900, 'light'],
    ['small-window', 900, 600, 'dark'],
    ['mobile', 390, 844, 'light'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.SERVERDECK_CONTEXT_URL ?? 'http://127.0.0.1:1421');
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.evaluate(async (theme) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const { useHostsStore } = await import('/src/stores/hosts.ts');
      const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      const { useFilesStore } = await import('/src/stores/files.ts');
      const { useNotificationsStore } = await import('/src/stores/notifications.ts');
      const { hostInput } = await import('/src/types/hosts.ts');
      const hosts = useHostsStore(pinia),
        workspace = useWorkspaceStore(pinia),
        terminals = useTerminalsStore(pinia),
        files = useFilesStore(pinia);
      hosts.catalog = {
        hosts: ['a', 'b'].map((id) => ({
          ...hostInput(),
          id,
          name: `Production ${id}`,
          hostname: `${id}.example`,
          username: 'operator',
          createdAt: '',
          updatedAt: '',
        })),
        groups: [],
        credentials: [],
        pendingSecretDeletions: 0,
      };
      files.local = { path: 'C:/', parent: null, entries: [] };
      for (const host of hosts.catalog.hosts) {
        files.connections[host.id] = {
          host,
          id: `files-${host.id}`,
          state: 'connected',
          error: null,
          trust: null,
          path: `/${host.id}`,
          loading: false,
          listing: { path: `/${host.id}`, parent: '/', entries: [] },
        };
        terminals.open(host);
        // Retain disconnected terminal metadata without invoking SSH in this rendering suite.
        terminals.update(terminals.focused, { state: 'idle', connectRequested: false });
      }
      terminals.activateHost('a');
      workspace.navigate('terminals', 'a');
      useNotificationsStore(pinia).items = [];
      document.documentElement.dataset.theme = theme;
    }, theme);
    const nav = (label) => navigateWorkspace(page, label);
    const assertHost = async (id, view) => {
      assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), id);
      assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-view'), view);
    };
    await page.getByRole('tab', { name: /会话 1/ }).waitFor();
    await assertHost('a', 'terminals');
    const existingTabs = await page.locator('.workspace-tab').count();
    for (const module of ['assets', 'system']) {
      await page.locator(`.module-navigation [data-module="${module}"]`).click();
      assert.equal(await page.getByRole('heading', { name: '请选择功能', exact: true }).count(), 0);
      await assertHost('a', 'terminals');
      assert.equal(await page.locator('.terminal-pane:visible[data-host-id="a"]').count(), 1);
      assert.equal(await page.locator('.workspace-tab').count(), existingTabs);
      assert.equal(await page.locator('.workspace-tab.active').count(), 1);
      assert.equal(await page.locator('.module-menu [aria-current="page"]').count(), 0);
      assert.equal(await page.locator('.host-tree-section').isVisible(), false);
      assert.equal(
        await page.locator('.module-navigation [aria-current="page"]').getAttribute('data-module'),
        module,
      );
    }
    await page.screenshot({ path: `${output}/${name}-module-without-default.png` });
    await page.locator('.module-navigation [data-module="hosts"]').click();
    await assertHost('a', 'terminals');
    assert.equal(await page.locator('[aria-controls="workspace-file-panel"]').count(), 0);
    assert.equal(await page.locator('.workspace-file-panel').count(), 0);
    assert.equal(await page.locator('.sidebar [aria-label="当前主机工具"]').count(), 0);
    await nav('SFTP 文件');
    assert.equal(await page.getByLabel('远程路径', { exact: true }).inputValue(), '/a');
    assert.equal(await page.getByLabel('本地路径', { exact: true }).count(), 1);
    assert.equal(await page.locator('.files-view').count(), 1);
    await nav('SSH 终端');
    assert.equal(await page.locator('.files-view').count(), 0);
    await page.evaluate(async () => {
      const { useFilesStore } = await import('/src/stores/files.ts');
      if (useFilesStore().connections.a.id !== 'files-a')
        throw new Error('switching tools disconnected SFTP');
    });
    assert.equal(await page.locator('.workspace-context').count(), 0);
    assert.deepEqual(
      (await page.locator('.workspace-header .host-tools button').allTextContents()).map((text) =>
        text.trim(),
      ),
      ['SSH 终端', 'SFTP 文件', '服务器管理'],
    );
    assert.equal(await page.locator('.terminal-tab').count(), 1);
    assert.equal(await page.getByText(/已恢复布局，所有窗格保持未连接/).count(), 0);
    const sessionActions = page.getByRole('toolbar', { name: '会话操作', exact: true });
    assert.equal(await sessionActions.count(), 0);
    assert.equal(await page.locator('.split-toolbar').count(), 0);
    await terminalTabAction(page, '复制');
    await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 2);
    await page.evaluate(async () => {
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      const store = useTerminalsStore();
      const added = store.tabs.find((tab) => tab.key === store.active);
      const pane = added.panes[0];
      if (pane.host?.id !== 'a' || added.panes.length !== 1 || pane.key !== store.focused)
        throw new Error('duplicate must open and focus a single new session for the source host');
    });
    assert.equal(await page.getByRole('menu').count(), 0);
    await page.locator('.terminal-tab').first().click({ button: 'right' });
    assert.deepEqual(
      (await page.getByRole('menuitem').allTextContents()).map((text) => text.trim()),
      ['复制', '重命名', '关闭所有', '关闭'],
    );
    await page.screenshot({ path: `${output}/${name}-session-menu.png` });
    await page.getByRole('menuitem', { name: '关闭', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.terminal-tab').length === 1);
    const compactHeader = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const host = box('.workspace-header'),
        sessions = box('.terminal-session-header'),
        area = box('.split-area'),
        workspace = box('.workspace-tabs'),
        tools = box('.workspace-header .host-tools'),
        add = box('[aria-label="新建终端会话"]');
      return {
        hostHeight: host.height,
        toolsInsideToolbar:
          tools.left >= host.left &&
          tools.right <= host.right &&
          tools.top >= host.top &&
          tools.bottom <= host.bottom,
        toolsAfterSessions: tools.left >= add.right || tools.top >= sessions.bottom,
        toolsSameRow: Math.abs(tools.top - sessions.top) <= 4,
        sessionHeight: sessions.height,
        terminalGap: area.top - host.bottom,
        sessionsInsideToolbar: sessions.top >= host.top && sessions.bottom <= host.bottom,
        totalHeight: area.top - workspace.bottom,
      };
    });
    assert(compactHeader.toolsInsideToolbar, JSON.stringify({ name, compactHeader }));
    assert(compactHeader.toolsAfterSessions, JSON.stringify({ name, compactHeader }));
    if (width >= 900) assert(compactHeader.toolsSameRow, JSON.stringify({ name, compactHeader }));
    assert(compactHeader.terminalGap <= 4, JSON.stringify({ name, compactHeader }));
    assert(compactHeader.sessionsInsideToolbar, JSON.stringify({ name, compactHeader }));
    assert(compactHeader.sessionHeight <= 40, JSON.stringify({ name, compactHeader }));
    assert(
      compactHeader.totalHeight <= (width >= 1200 ? 84 : width > 720 ? 116 : 200),
      JSON.stringify({ name, compactHeader }),
    );
    await page.screenshot({ path: `${output}/${name}-compact-header.png` });
    await selectHostWorkspace(page, 'b');
    await assertHost('b', 'terminals');
    assert.equal(await page.locator('.terminal-tab').count(), 1);
    assert.equal(await page.locator('.workspace-tab').count(), 2);
    await nav('SFTP 文件');
    await page.getByLabel('远程路径', { exact: true }).waitFor();
    await assertHost('b', 'files');
    assert.equal(await page.getByLabel('远程路径', { exact: true }).inputValue(), '/b');
    await selectHostWorkspace(page, 'a');
    await assertHost('a', 'terminals');
    await nav('SFTP 文件');
    await page.waitForFunction(
      () => document.querySelector('[aria-label="远程路径"]')?.value === '/a',
    );
    assert.equal(await page.locator('.files-host-tabs, [aria-label="文件管理主机"]').count(), 0);
    await page.screenshot({ path: `${output}/${name}-files.png` });
    await selectHostWorkspace(page, 'b');
    await assertHost('b', 'files');
    assert.equal(await page.getByLabel('远程路径', { exact: true }).inputValue(), '/b');
    await nav('通用');
    assert.equal(await page.locator('.host-tree-section').isVisible(), false);
    assert.equal(await page.getByRole('navigation', { name: '当前主机工具' }).count(), 0);
    await selectHostWorkspace(page, 'a');
    await assertHost('a', 'files');
    await selectHostWorkspace(page, '');
    await assertHost('', 'terminals');
    assert.equal(await page.locator('.host-tools button').count(), 1);
    assert.equal(await page.getByLabel('当前工作区主机', { exact: true }).count(), 0);
    await nav('网络诊断');
    await page.getByLabel('诊断来源', { exact: true }).selectOption('remote');
    await page.getByLabel('诊断主机', { exact: true }).selectOption('b');
    await page.getByLabel('诊断目标', { exact: true }).fill('independent.example');
    await selectHostWorkspace(page, 'a');
    await nav('网络诊断');
    assert.equal(await page.getByLabel('诊断主机', { exact: true }).inputValue(), 'b');
    assert.equal(
      await page.getByLabel('诊断目标', { exact: true }).inputValue(),
      'independent.example',
    );
    assert.equal(await page.getByLabel('诊断来源', { exact: true }).inputValue(), 'remote');
    await selectHostWorkspace(page, 'b');
    await nav('SSH 终端');
    await assertHost('b', 'terminals');
    await page.getByRole('tab', { name: /会话 1/ }).waitFor();
    await page.waitForFunction(
      () => {
        const bounds = document.querySelector('.workspace-tab.active')?.getBoundingClientRect();
        return bounds && bounds.width > 50 && bounds.left >= 0 && bounds.right <= innerWidth;
      },
      undefined,
      { timeout: 3000 },
    );
    const bounds = await page.locator('.workspace-tab.active').boundingBox();
    assert(
      bounds && bounds.width > 50 && bounds.x >= 0 && bounds.x + bounds.width <= width,
      JSON.stringify({ name, width, bounds }),
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/${name}-terminal.png` });
    await terminalTabAction(page, '关闭所有');
    await page.getByRole('heading', { name: '没有打开的终端', exact: true }).waitFor();
    await page.evaluate(async () => {
      const { useTerminalsStore } = await import('/src/stores/terminals.ts');
      const store = useTerminalsStore();
      if (store.hostTabs('a').length !== 1 || store.hostTabs('b').length !== 0)
        throw new Error('close-all must close only the target host sessions');
    });
    await page.screenshot({ path: `${output}/${name}-closed-all.png` });
    await nav('网络诊断');
    assert.equal(
      await page.locator('.module-navigation [aria-current="page"]').textContent(),
      '主机运维',
    );
    assert.deepEqual(
      (await page.locator('.module-menu .nav-label').allTextContents()).map((text) => text.trim()),
      [],
    );
    await nav('任务中心');
    await page.getByRole('heading', { name: '任务中心', exact: true }).waitFor();
    assert.equal(await page.locator('.statusbar button').count(), 1);
    assert.equal(await page.getByRole('dialog', { name: '任务中心', exact: true }).count(), 1);
    await page.screenshot({ path: `${output}/${name}-task-center.png` });
    await nav('备份恢复');
    assert.equal(
      await page.locator('.module-navigation [aria-current="page"]').textContent(),
      '资产管理',
    );
    assert.deepEqual(
      (await page.locator('.module-menu .nav-label').allTextContents()).map((text) => text.trim()),
      ['安全凭据', '模型管理', '备份恢复'],
    );
    await page.screenshot({ path: `${output}/${name}-assets-module.png` });
    await nav('关于');
    assert.deepEqual(
      (await page.locator('.module-menu .nav-label').allTextContents()).map((text) => text.trim()),
      ['通用', '终端', '快捷键', '工作区与连接', '插件管理', '关于'],
    );
    await page.locator('.module-navigation [data-module="assets"]').click();
    assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-view'), 'about');
    await nav('备份恢复');
    await page.locator('.module-navigation [data-module="system"]').click();
    assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-view'), 'backup');
    await nav('网络诊断');
    assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-view'), 'network');
    assert.equal(
      await page.getByLabel('诊断目标', { exact: true }).inputValue(),
      'independent.example',
    );
    await page.locator('.module-navigation [data-module="hosts"]').click();
    assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-view'), 'network');
    assert.equal(await page.locator('.terminal-pane[data-host-id="b"]').count(), 0);
    await selectHostWorkspace(page, 'b');
    await assertHost('b', 'terminals');
    await page.locator('.terminal-pane:visible[data-host-id="b"]').waitFor();
    assert.equal(await page.locator('.module-navigation button').count(), 5);
    assert.equal(await page.locator('.workspace-header .host-tools').count(), 1);
    assert.deepEqual(errors, []);
    results.push({ name, width, height, theme, compactHeader, passed: true });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(`PASS ${results.length} host context and layout scenarios. Artifacts: ${output}`);
} finally {
  await browser.close();
}
