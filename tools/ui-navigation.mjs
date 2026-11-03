// UI navigation shared by browser fixtures and isolated native WebView2 checks.
const hostTools = new Set(['SSH 终端', 'SFTP 文件', '服务器管理']);
const menuModules = {
  批量运维: 'tools',
  自动运维: 'tools',
  网络诊断: 'tools',
  任务中心: 'tools',
  安全凭据: 'assets',
  备份恢复: 'assets',
  通用: 'system',
  终端: 'system',
  快捷键: 'system',
  工作区与连接: 'system',
  关于: 'system',
};

export async function terminalAction(page, pane, name) {
  await pane.locator('.xterm-helper-textarea').press('Shift+F10');
  await page
    .getByRole('menu', { name: '终端操作', exact: true })
    .getByRole('menuitem', { name, exact: true })
    .click();
}

export async function terminalTabAction(page, name, tab = page.locator('.terminal-tab.active')) {
  await tab.click({ button: 'right' });
  await page.getByRole('menuitem', { name, exact: true }).click();
}

export async function showHostTree(page) {
  await page.locator('.module-navigation [data-module="hosts"]').click();
  if (!(await page.locator('.sidebar').isVisible())) {
    const expand = page.getByRole('button', { name: '展开主机栏', exact: true });
    if (await expand.isVisible()) await expand.click();
  }
}

export async function hostTreeAction(page, folderId, action) {
  await showHostTree(page);
  // Expanding folders never opens a connection; reveal the context target explicitly.
  for (;;) {
    const collapsed = page.locator('.group-toggle[aria-expanded=false]');
    if (!(await collapsed.count())) break;
    await collapsed.first().click();
  }
  const target = page.locator(
    `.tree-group[data-group-id=${JSON.stringify(folderId ?? '')}] > .group-toggle`,
  );
  await target.click({ button: 'right' });
  await page
    .getByRole('menu', { name: '主机树操作', exact: true })
    .getByRole('menuitem', { name: action, exact: true })
    .click();
}

export async function hostContextAction(page, target, action) {
  await target.click({ button: 'right' });
  await page
    .getByRole('menu', { name: '主机树操作', exact: true })
    .getByRole('menuitem', { name: action, exact: true })
    .click();
}

export async function reloadHosts(page) {
  // Test-only catalog synchronization after direct IPC fixture changes, with real service errors.
  await page.evaluate(async () => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const store = pinia._s.get('hosts');
    await store.load();
    if (store.error) throw new Error(store.error);
  });
}

export async function navigateWorkspace(page, name) {
  const module = hostTools.has(name) ? 'hosts' : menuModules[name];
  if (!module) throw new Error(`Unknown navigation target: ${name}`);
  await page.locator(`.module-navigation [data-module="${module}"]`).click();
  if (hostTools.has(name)) {
    const remote = page.getByRole('navigation', { name: '当前主机工具', exact: true });
    if (!(await remote.count())) {
      await showHostTree(page);
      const selectedHost = page.locator('.tree-host[aria-current="true"]');
      if (await selectedHost.count()) await selectedHost.click();
    }
    if (name === 'SSH 终端' && !(await remote.count()))
      await page.getByRole('button', { name: '本地终端', exact: true }).click();
    else {
      if (await page.evaluate(() => innerWidth <= 720)) {
        const collapse = page.getByRole('button', { name: '收起主机栏', exact: true });
        if (await collapse.isVisible()) await collapse.click();
      }
      await remote.getByRole('button', { name, exact: true }).click();
    }
  } else {
    if (!(await page.locator('.sidebar').isVisible()))
      await page.getByRole('button', { name: '展开主机栏', exact: true }).click();
    await page
      .getByRole('navigation', { name: '主导航', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
  }
  if (await page.evaluate(() => innerWidth <= 720)) {
    const collapse = page.getByRole('button', { name: '收起主机栏', exact: true });
    if (await collapse.isVisible()) await collapse.click();
  }
}

export async function selectHostWorkspace(page, id) {
  if (await page.evaluate(() => innerWidth <= 720)) {
    const collapse = page.getByRole('button', { name: '收起主机栏', exact: true });
    if (await collapse.isVisible()) await collapse.click();
  }
  const tab = page.locator(`.workspace-tab[data-host-id=${JSON.stringify(id)}] [role=tab]`);
  if (await tab.count()) {
    await tab.click();
  } else if (!id) {
    await showHostTree(page);
    await page.getByRole('button', { name: '本地终端', exact: true }).click();
  } else {
    await showHostTree(page);
    await page.getByLabel('搜索主机', { exact: true }).fill('');
    for (const group of await page.locator('.group-toggle[aria-expanded=false]').all())
      await group.click();
    await page.locator(`.tree-host[data-host-id=${JSON.stringify(id)}]`).click();
  }
  if (await page.evaluate(() => innerWidth <= 720)) {
    const collapse = page.getByRole('button', { name: '收起主机栏', exact: true });
    if (await collapse.isVisible()) await collapse.click();
  }
}
