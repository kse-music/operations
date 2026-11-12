// UI navigation shared by browser fixtures and isolated native WebView2 checks.
const hostTools = new Set(['SSH 终端', 'SFTP 文件']);
const menuModules = {
  通用: 'system',
  终端: 'system',
  快捷键: 'system',
  数据与存储: 'system',
  模型: 'system',
  关于: 'system',
  插件管理: 'system',
};

export async function terminalAction(page, pane, name) {
  if (name === 'SFTP 文件') return navigateWorkspace(page, name);
  const shortcut = { 关闭终端: 'Control+Shift+w', 查找: 'Control+Shift+f' }[name];
  if (shortcut) return pane.locator('.xterm-helper-textarea').press(shortcut);
  await pane.locator('.xterm-helper-textarea').press('Shift+F10');
  await page
    .getByRole('menu', { name: '终端操作', exact: true })
    .getByRole('menuitem', { name, exact: true })
    .click();
}

export async function showHostTree(page) {
  if (!(await page.locator('.host-tree-section').isVisible())) {
    await page.locator('.activity-rail').getByRole('button', { name: '首页', exact: true }).click();
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

export async function previewPluginPackage(page, packagePath) {
  await navigateWorkspace(page, '插件管理');
  // Only the native file picker result is substituted. Package validation uses real IPC.
  const restorePicker = await page.evaluateHandle((selectedPath) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = (command, ...args) =>
      command === 'plugin_pick'
        ? Promise.resolve(selectedPath)
        : invoke.call(bridge, command, ...args);
    return () => {
      bridge.invoke = invoke;
    };
  }, packagePath);
  try {
    await page
      .locator('.plugin-heading-actions')
      .getByRole('button', { name: '安装插件', exact: true })
      .click();
    const preview = page.getByRole('dialog', { name: '安装插件', exact: true });
    await preview.waitFor();
    return preview;
  } finally {
    await restorePicker.evaluate((restore) => restore());
    await restorePicker.dispose();
  }
}

export async function openPluginDetails(page, name) {
  const dialog = await openPluginSettings(page, name);
  const details = dialog.getByRole('tab', { name: '基本信息', exact: true });
  if (await details.isVisible()) await details.click();
  const settings = dialog.getByLabel('插件设置', { exact: true });
  await settings.waitFor();
  return settings;
}

export async function openPluginSettings(page, name) {
  await navigateWorkspace(page, '插件管理');
  await page.getByRole('button', { name: `配置 ${name}`, exact: true }).click();
  const dialog = page.locator('.settings-page');
  await dialog.getByRole('region', { name: `${name} · 配置`, exact: true }).waitFor();
  return dialog;
}

export async function closePluginSettings(page) {
  const panel = page.locator('.plugin-configuration');
  if (!(await panel.isVisible())) return;
  await panel.getByRole('button', { name: '返回插件列表', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
}

export async function setPluginEnabled(page, name, enabled) {
  await navigateWorkspace(page, '插件管理');
  const card = page
    .locator('.plugin-installed-row')
    .filter({ has: page.getByRole('button', { name, exact: true }) });
  const action = card.getByRole('button', {
    name: `${enabled ? '启用' : '禁用'} ${name}`,
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
  await card
    .getByRole('button', { name: `${enabled ? '禁用' : '启用'} ${name}`, exact: true })
    .waitFor();
  return card;
}

export async function navigateWorkspace(page, name) {
  await closePluginSettings(page);
  const module = hostTools.has(name) ? 'hosts' : menuModules[name];
  if (!module) {
    if (name === 'AI 运维助手' || name === '服务器管理') {
      // Focus the host shell before its shortcut; input focus may currently be inside an iframe.
      await closeApplicationSettings(page);
      await page
        .locator('.app-header')
        .getByRole('button', { name: '全局搜索', exact: true })
        .click();
      const search = page.getByRole('dialog', { name: '全局搜索', exact: true });
      await search.getByLabel('全局搜索内容', { exact: true }).fill(name);
      await search
        .getByRole('option')
        .filter({ hasText: `工作区 · ${name}` })
        .click();
    } else await openPluginFunction(page, name);
    return;
  }
  if (module !== 'system') await closeApplicationSettings(page);
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
      await remote.getByRole('button', { name, exact: true }).click();
    }
  } else {
    const dialog = page.locator('.settings-page');
    if (!(await dialog.isVisible()))
      await page
        .getByRole('navigation', { name: '应用导航', exact: true })
        .getByRole('button', { name: '设置', exact: true })
        .click();
    await page
      .getByRole('navigation', { name: '设置分类', exact: true })
      .getByRole('button', { name: name === '插件管理' ? '插件' : name, exact: true })
      .click();
  }
}

export async function closeApplicationSettings(page) {
  if (!(await page.locator('.settings-page').isVisible())) return;
  // Explicit draft disposal invokes the same guard used by application exit.
  // Area switches in the product preserve the draft instead.
  await page.evaluate(() => {
    const workspace = document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$pinia._s.get('workspace');
    void workspace.closeSettings();
  });
  await page.locator('.settings-page').waitFor({ state: 'hidden' });
}

// Model choice belongs to the assistant's persisted plugin settings.
export async function bindAssistantModel(page, modelId) {
  const dialog = await openPluginSettings(page, 'AI 运维助手');
  const settings = dialog.frameLocator('iframe');
  const option = settings.locator(`input[type="radio"][value=${JSON.stringify(modelId)}]`);
  if (!(await option.isChecked())) {
    await option.check();
    await settings.getByText('模型绑定已保存', { exact: true }).waitFor();
  }
  await closePluginSettings(page);
  await closeApplicationSettings(page);
}

export async function openPluginFunction(page, name, hostId) {
  await closePluginSettings(page);
  await closeApplicationSettings(page);
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
    .getByRole('navigation', { name: '当前主机工具', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
}

export async function selectHostWorkspace(page, id) {
  await closeApplicationSettings(page);
  if (id) await showHostTree(page);
  else {
    await page
      .locator('.activity-rail')
      .getByRole('button', { name: '本地终端', exact: true })
      .click();
    return;
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
    await page.locator(`.tree-host[data-host-id=${JSON.stringify(id)}]`).dblclick();
  }
}
