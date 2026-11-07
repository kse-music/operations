// UI navigation shared by browser fixtures and isolated native WebView2 checks.
const hostTools = new Set(['SSH 终端', 'SFTP 文件']);
const menuModules = {
  通用: 'system',
  终端: 'system',
  快捷键: 'system',
  数据与存储: 'system',
  模型管理: 'system',
  关于: 'system',
  插件管理: 'plugins',
};

export async function terminalAction(page, pane, name) {
  await pane.locator('.xterm-helper-textarea').press('Shift+F10');
  await page
    .getByRole('menu', { name: '终端操作', exact: true })
    .getByRole('menuitem', { name, exact: true })
    .click();
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
  const details = dialog.getByRole('button', { name: '权限与详情', exact: true });
  if (await details.isVisible()) await details.click();
  const settings = dialog.getByLabel('插件设置', { exact: true });
  await settings.waitFor();
  return settings;
}

export async function openPluginSettings(page, name) {
  await navigateWorkspace(page, '插件管理');
  await page.getByRole('button', { name: `配置 ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `${name} · 配置`, exact: true });
  await dialog.waitFor();
  return dialog;
}

export async function closePluginSettings(page) {
  const dialog = page.locator('dialog[open]:has(> .plugin-config-body)');
  if (!(await dialog.count())) return;
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

export async function setPluginEnabled(page, name, enabled) {
  const settings = await openPluginDetails(page, name);
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
  await closePluginSettings(page);
  const module = hostTools.has(name) ? 'hosts' : menuModules[name];
  if (!module) {
    if (name === 'AI 运维助手') {
      // Focus the host shell before its shortcut; input focus may currently be inside an iframe.
      await page.locator('.module-navigation [data-module="hosts"]').click();
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

// Model choice belongs to the assistant's persisted plugin settings.
export async function bindAssistantModel(page, modelId) {
  const dialog = await openPluginSettings(page, 'AI 运维助手');
  const settings = dialog.frameLocator('iframe');
  await settings.locator(`input[type="radio"][value=${JSON.stringify(modelId)}]`).check();
  const save = settings.getByRole('button', { name: '保存模型绑定', exact: true });
  if (await save.isEnabled()) {
    await save.click();
  } else {
    await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  }
  await dialog.waitFor({ state: 'hidden' });
}

export async function openPluginFunction(page, name, hostId) {
  await closePluginSettings(page);
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
  if (await page.evaluate(() => innerWidth <= 720)) {
    const collapse = page.getByRole('button', { name: '收起主机栏', exact: true });
    if (await collapse.isVisible()) await collapse.click();
  }
  const tab = page.locator(`.workspace-tab[data-host-id=${JSON.stringify(id)}] [role=tab]`);
  if (await tab.count()) {
    if (!(await tab.isVisible()))
      await page.getByRole('tab', { name: '全部主机', exact: true }).click();
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
