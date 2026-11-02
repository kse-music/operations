// UI navigation shared by browser fixtures and isolated native WebView2 checks.
const hostTools = new Set(['SSH 终端', 'SFTP 文件', '服务器监控', 'Linux 运维']);

export async function showHostTree(page) {
  if (!(await page.locator('.sidebar').isVisible())) {
    const expand = page.getByRole('button', { name: '展开主机栏', exact: true });
    if (!(await expand.isVisible()))
      await page.getByRole('button', { name: '主机工作区', exact: true }).click();
    if (await expand.isVisible()) await expand.click();
  }
}

export async function openHostTreeTools(page) {
  await showHostTree(page);
  const tools = page.getByRole('button', { name: '主机树工具', exact: true });
  if ((await tools.getAttribute('aria-expanded')) !== 'true') await tools.click();
}

export async function navigateWorkspace(page, name) {
  if (hostTools.has(name)) {
    if (!(await page.getByRole('navigation', { name: '当前主机工具', exact: true }).count()))
      await page.getByRole('button', { name: '主机工作区', exact: true }).click();
    await page
      .getByRole('navigation', { name: '当前主机工具', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
  } else {
    await page
      .getByRole('navigation', { name: '主导航', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
  }
}

export async function selectHostWorkspace(page, id) {
  const tab = page.locator(`.workspace-tab[data-host-id=${JSON.stringify(id)}] [role=tab]`);
  if (await tab.count()) {
    await tab.click();
  } else if (!id) {
    await page.getByRole('button', { name: '打开本地工作区', exact: true }).click();
  } else {
    await page.getByRole('button', { name: '主机工作区', exact: true }).click();
    const expand = page.getByRole('button', { name: '展开主机栏', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.getByLabel('搜索主机', { exact: true }).fill('');
    await page.getByRole('button', { name: '全部主机', exact: true }).click();
    for (const group of await page.locator('.group-toggle[aria-expanded=false]').all())
      await group.click();
    await page.locator(`.tree-host[data-host-id=${JSON.stringify(id)}]`).click();
  }
  if (await page.evaluate(() => innerWidth <= 720)) {
    const collapse = page.getByRole('button', { name: '收起主机栏', exact: true });
    if (await collapse.isVisible()) await collapse.click();
  }
}
