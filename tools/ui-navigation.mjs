// UI navigation shared by browser fixtures and isolated native WebView2 checks.
const hostTools = new Set(['SSH 终端', 'SFTP 文件', '服务器管理']);
const menuModules = {
  'AI 运维助手': 'plugins',
  网络诊断: 'plugins',
  安全凭据: 'assets',
  备份恢复: 'assets',
  通用: 'system',
  终端: 'system',
  快捷键: 'system',
  工作区与连接: 'system',
  关于: 'system',
  插件管理: 'system',
};

async function closeTaskCenter(page) {
  const dialog = page.getByRole('dialog', { name: '任务中心', exact: true });
  if (await dialog.count())
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
}

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
  await closeTaskCenter(page);
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

// Deliver the native event shape to the registered receiver in an owned debug
// WebView. Keep real Rust package IPC and the production emitter ACL unchanged.
export async function deliverPluginDrop(page, payload) {
  await page.waitForFunction(
    () =>
      Object.getOwnPropertyNames(window).some((key) => {
        const value = Object.getOwnPropertyDescriptor(window, key)?.value;
        return value && typeof value === 'object' && Object.hasOwn(value, 'tauri://drag-drop');
      }),
    null,
    { polling: 50 },
  );
  const delivered = await page.evaluate((payload) => {
    let count = 0;
    for (const key of Object.getOwnPropertyNames(window)) {
      const value = Object.getOwnPropertyDescriptor(window, key)?.value;
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'tauri://drag-drop'))
        continue;
      const receivers = value['tauri://drag-drop'];
      for (const id of Object.getOwnPropertyNames(receivers)) {
        const listener = receivers[id];
        if (listener.target?.kind === 'Webview' && listener.target?.label === 'main') {
          window.__TAURI_INTERNALS__.runCallback(listener.handlerId, {
            event: 'tauri://drag-drop',
            id: Number(id),
            payload,
          });
          count++;
        }
      }
    }
    return count;
  }, payload);
  if (delivered !== 1)
    throw new Error(`Expected one mounted native drop receiver, got ${delivered}`);
}
export async function previewPluginPackage(page, packagePath) {
  await navigateWorkspace(page, '插件管理');
  const zone = page.getByRole('region', { name: '插件上传区域', exact: true });
  const box = await zone.boundingBox();
  if (!box) throw new Error('Plugin drop zone unavailable');
  const ratio = await page.evaluate(() => devicePixelRatio);
  await deliverPluginDrop(page, {
    paths: [packagePath],
    position: { x: (box.x + box.width / 2) * ratio, y: (box.y + box.height / 2) * ratio },
  });
  const preview = page.getByRole('dialog', { name: '安装插件', exact: true });
  await preview.waitFor();
  return preview;
}

export async function openPluginSettings(page, name) {
  await closeTaskCenter(page);
  await navigateWorkspace(page, '插件管理');
  await page.locator('.plugin-installed-row').getByRole('button', { name, exact: true }).click();
  const settings = page.locator('.plugin-page:visible [aria-label="插件设置"]');
  await settings.waitFor();
  return settings;
}

export async function setPluginEnabled(page, name, enabled) {
  const settings = await openPluginSettings(page, name);
  const action = settings.getByRole('button', {
    name: enabled ? '启用插件' : '禁用插件',
    exact: true,
  });
  if (await action.isVisible()) {
    await action.click();
    if (!enabled)
      await page
        .getByRole('dialog', { name: '禁用插件？', exact: true })
        .getByRole('button', { name: '明确确认', exact: true })
        .click();
  }
  await settings
    .getByRole('button', { name: enabled ? '禁用插件' : '启用插件', exact: true })
    .waitFor();
  return settings;
}

export async function navigateWorkspace(page, name) {
  const taskDialog = page.getByRole('dialog', { name: '任务中心', exact: true });
  if (name === '任务中心') {
    if (!(await taskDialog.count()))
      await page.locator('.statusbar').getByRole('button', { name, exact: true }).click();
    await taskDialog.waitFor();
    return;
  }
  await closeTaskCenter(page);
  const module = hostTools.has(name) ? 'hosts' : (menuModules[name] ?? 'plugins');
  if (module === 'plugins') {
    if (Object.hasOwn(menuModules, name)) {
      // Focus the host shell before its shortcut; input focus may currently be inside an iframe.
      await page.locator('.module-navigation [data-module="plugins"]').click();
      await page.keyboard.press('Control+k');
      const search = page.getByRole('dialog', { name: '全局搜索', exact: true });
      await search.getByLabel('全局搜索内容', { exact: true }).fill(name);
      await search
        .getByRole('option')
        .filter({ hasText: `工作区 · ${name}` })
        .click();
    } else await openPluginFunction(page, name);
    return;
  }
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

export async function openPluginFunction(page, name, hostId) {
  const systemPages = {
    资源监控: '资源监控',
    进程与端口: '进程与端口',
    日志查看: '日志查看',
    网络诊断: '网络诊断',
    'systemd 服务': 'systemd 服务',
  };
  const subpage = systemPages[name];
  if (subpage) name = '系统服务';
  await closeTaskCenter(page);
  const id =
    hostId ??
    (await page.evaluate(() => {
      const workspace = document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('workspace');
      return workspace.current?.hostId || workspace.hostId;
    }));
  if (!id) throw new Error(`Opening ${name} requires an explicit host workspace`);
  await selectHostWorkspace(page, id);
  await page
    .locator('.workspace-header')
    .getByRole('button', { name: '工具', exact: true })
    .click();
  await page
    .getByRole('menu', { name: '已启用的插件', exact: true })
    .getByRole('menuitem', { name, exact: true })
    .click();
  if (subpage)
    await page
      .frameLocator('.plugin-frame-container:visible iframe')
      .getByRole('tab', { name: subpage, exact: true })
      .click();
}

export async function selectHostWorkspace(page, id) {
  await closeTaskCenter(page);
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
