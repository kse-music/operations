import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace, hostTreeAction } from './ui-navigation.mjs';

// In-memory UI fixtures only. No IPC replacement, stored hosts, or remote operations.
const url = process.env.SERVERDECK_LAYOUT_URL ?? 'http://127.0.0.1:1421';
const output = process.env.SERVERDECK_LAYOUT_OUTPUT ?? '/tmp/serverdeck-layout';
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
    await page.goto(url);
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.getByRole('heading', { name: '欢迎使用 ServerDeck', exact: true }).waitFor();
    assert.equal(await page.locator('.workspace-tabs [role="tab"]').count(), 0);
    assert.equal(await page.locator('.terminal-pane').count(), 0);
    await page.evaluate(
      async ({ theme }) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

        const { useHostsStore } = await import('/src/stores/hosts.ts');
        const { useNotificationsStore } = await import('/src/stores/notifications.ts');
        const { hostInput } = await import('/src/types/hosts.ts');
        useNotificationsStore(pinia).items = [];
        useHostsStore(pinia).catalog = {
          hosts: Array.from({ length: 60 }, (_, n) => ({
            ...hostInput(),
            id: `layout-${n}`,
            name:
              n === 0
                ? 'Production API / 长名称主机布局检查'
                : `Server ${String(n + 1).padStart(2, '0')}`,
            hostname: `192.0.2.${n + 1}`,
            username: n < 3 ? 'short-list' : 'operator',
            groupId: n < 30 ? 'production' : 'staging',
            favorite: n < 3,
            createdAt: '',
            updatedAt: '',
          })),
          groups: [
            { id: 'production', name: 'Production', sortOrder: 0, parentId: null },
            { id: 'staging', name: 'Staging', sortOrder: 1, parentId: 'production' },
          ],
          credentials: [],
          pendingSecretDeletions: 0,
        };
        document.documentElement.dataset.theme = theme;
      },
      { theme },
    );
    if (width <= 720) await page.getByRole('button', { name: '展开主机栏', exact: true }).click();
    await page.locator('.tree-host').first().waitFor();
    assert.equal(await page.locator('.topbar').count(), 0);
    assert.equal(await page.getByRole('button', { name: '打开全局搜索', exact: true }).count(), 0);
    assert.equal(
      await page.getByRole('button', { name: '打开本地工作区', exact: true }).count(),
      0,
    );
    assert.equal(await page.getByRole('button', { name: '关于', exact: true }).count(), 0);
    await page.locator('.module-navigation [data-module="system"]').click();
    assert.deepEqual(
      (await page.locator('.module-menu .nav-label').allTextContents()).map((text) => text.trim()),
      ['通用', '终端', '快捷键', '数据与存储', '关于'],
    );
    const about = page.getByRole('button', { name: '关于', exact: true });
    await about.click();
    const aboutPage = page.getByRole('region', { name: '关于 ServerDeck', exact: true });
    await aboutPage.waitFor();
    assert.equal(
      await page.getByRole('dialog', { name: '关于 ServerDeck', exact: true }).count(),
      0,
    );
    assert.match(await aboutPage.textContent(), /暂不可用（本地后端未就绪）/);
    assert.equal(await about.getAttribute('aria-current'), 'page');
    await about.click();
    assert.equal(await page.locator('.workspace-tab[data-view="about"]').count(), 1);
    if (width <= 720) await page.getByRole('button', { name: '收起主机栏', exact: true }).click();
    await page.screenshot({ path: `${output}/${name}-about.png` });
    await page.locator('.workspace-tab[data-view="about"] .tab-close').click();
    assert.equal(await aboutPage.count(), 0);
    if (width <= 720) await page.getByRole('button', { name: '展开主机栏', exact: true }).click();
    await page.locator('.module-navigation [data-module="hosts"]').click();
    const collapseButton = page
      .locator('.sidebar-workspace-heading')
      .getByRole('button', { name: '收起主机栏', exact: true });
    const collapsePosition = await page.locator('.sidebar-workspace-heading').evaluate((header) => {
      const heading = header.getBoundingClientRect();
      const button = header.querySelector('[aria-label="收起主机栏"]').getBoundingClientRect();
      return {
        text: header.textContent.trim(),
        atRight: button.right <= heading.right && button.right >= heading.right - 20,
        sameRow: Math.abs(button.top + button.height / 2 - heading.top - heading.height / 2) < 2,
      };
    });
    assert(
      collapsePosition.text.includes('主机管理') &&
        collapsePosition.atRight &&
        collapsePosition.sameRow,
      `${name}: combined sidebar must have a workspace entry and a collapse action`,
    );
    await collapseButton.click();
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    const expandButton = page
      .locator('.workspace-tabs')
      .getByRole('button', { name: '展开主机栏', exact: true });
    assert.equal(await expandButton.evaluate((button) => document.activeElement === button), true);
    await expandButton.press('Enter');
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    assert.equal(
      await collapseButton.evaluate((button) => document.activeElement === button),
      true,
    );
    const geometry = await page.evaluate(() => {
      const box = (s) => document.querySelector(s).getBoundingClientRect().toJSON();
      const list = document.querySelector('.host-tree-scroll');
      return {
        sidebar: box('.sidebar'),
        list: box('.host-tree-scroll'),
        header: box('.host-list-heading'),
        footer: box('.host-sidebar-footer'),
        main: box('main'),
        rail: box('.activity-rail'),
        modules: box('.module-header'),
        overflow: document.documentElement.scrollWidth > innerWidth,
        listScrolls: list.scrollHeight > list.clientHeight,
        railOverflows:
          document.querySelector('.activity-rail').scrollHeight >
          document.querySelector('.activity-rail').clientHeight,
      };
    });
    assert(!geometry.overflow, `${name}: page overflows horizontally`);
    assert(!geometry.railOverflows, `${name}: navigation overflows`);
    for (const region of ['main', 'rail', 'sidebar'])
      assert.equal(
        geometry[region].top,
        geometry.modules.bottom,
        `${name}: ${region} must start below the module header`,
      );
    assert.equal(await page.locator('.module-navigation button').count(), 5);
    assert.equal(
      await page.locator('.module-navigation [aria-current="page"]').textContent(),
      '主机运维',
    );
    assert.equal(await page.getByRole('button', { name: '主机管理', exact: true }).count(), 0);
    assert.equal((await page.locator('.sidebar-module-title').textContent()).trim(), '主机管理');
    assert.equal(await page.locator('.sidebar-module-title svg').count(), 0);
    await page.locator('.sidebar-module-title').click();
    assert.equal(await page.locator('.workspace-tabs [role="tab"]').count(), 0);
    assert.equal(
      await page.getByRole('button', { name: '本地终端', exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await page.locator('.activity-rail [aria-label="主机管理"] .nav-badge').count(),
      0,
    );
    const total = page.locator('.host-list-heading .host-count');
    assert.equal((await total.textContent()).trim(), '60');
    const countPosition = await total.evaluate((badge) => {
      const label = document.createRange();
      label.selectNodeContents(badge.parentElement);
      label.setEndBefore(badge);
      const text = label.getBoundingClientRect(),
        count = badge.getBoundingClientRect();
      return {
        afterText: count.left >= text.right,
        sameRow: Math.abs(count.top + count.height / 2 - text.top - text.height / 2) < 2,
      };
    });
    assert(
      countPosition.afterText && countPosition.sameRow,
      `${name}: host total must follow All Hosts`,
    );
    assert.equal(await page.getByRole('button', { name: '主机工作区', exact: true }).count(), 0);
    assert(
      geometry.list.height > height * 0.18,
      `${name}: host list cannot share space with navigation`,
    );
    assert.equal(
      geometry.sidebar.x,
      geometry.rail.x,
      `${name}: navigation is outside the combined sidebar`,
    );
    assert(geometry.listScrolls, `${name}: long host list cannot scroll`);
    if (width > 720)
      assert(geometry.main.x >= geometry.sidebar.right, `${name}: workspace overlaps sidebar`);
    assert.equal(await page.getByRole('button', { name: '主机树工具', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('主机排序', { exact: true }).count(), 0);
    assert.equal(await page.locator('#host-tree-tools').count(), 0);
    const tools = page.getByRole('group', { name: '主机导入导出', exact: true });
    await tools.waitFor();
    assert.equal(
      await tools.getByRole('button', { name: '导入 OpenSSH', exact: true }).isEnabled(),
      true,
    );
    assert.equal(
      await tools.getByRole('button', { name: '导出配置', exact: true }).isEnabled(),
      true,
    );
    assert.equal(await tools.getByLabel('按标签筛选主机', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '收藏', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('已收藏', { exact: true }).count(), 0);
    const toolsFit = await tools.evaluate((element) => element.scrollWidth <= element.clientWidth);
    assert(toolsFit, `${name}: host import/export actions overflow`);
    const listHeading = page.locator('.host-list-heading');
    const toolsPosition = await tools.boundingBox(),
      listHeadingPosition = await listHeading.boundingBox();
    assert(toolsPosition.x > listHeadingPosition.x + listHeadingPosition.width / 2);
    assert.equal(
      await listHeading.evaluate(
        (element) =>
          element.nextElementSibling?.classList.contains('host-sidebar-controls') &&
          element.nextElementSibling?.nextElementSibling?.classList.contains('host-tree-scroll'),
      ),
      true,
    );
    const importButton = tools.getByRole('button', { name: '导入 OpenSSH', exact: true });
    const exportButton = tools.getByRole('button', { name: '导出配置', exact: true });
    assert.equal(await importButton.getAttribute('title'), '导入 OpenSSH');
    assert.equal(await exportButton.getAttribute('title'), '导出配置');
    await importButton.focus();
    await page.keyboard.press('Enter');
    const importDialog = page.getByRole('dialog', { name: '导入 OpenSSH Config', exact: true });
    await importDialog.waitFor();
    await importDialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await importDialog.waitFor({ state: 'hidden' });
    const folder = page.locator('[data-group-id="staging"] > .group-toggle');
    await folder.scrollIntoViewIfNeeded();
    await folder.press('Shift+F10');
    const folderMenu = page.getByRole('menu', { name: '主机树操作', exact: true });
    await folderMenu.waitFor();
    assert.deepEqual(
      (await folderMenu.getByRole('menuitem').allTextContents()).map((text) => text.trim()),
      ['新建主机', '新建文件夹', '重命名文件夹', '删除文件夹'],
    );
    await page.screenshot({ path: `${output}/${name}-folder-context-menu.png` });
    await folderMenu.getByRole('menuitem', { name: '新建文件夹', exact: true }).click();
    const folderDialog = page.getByRole('dialog', { name: '新建文件夹', exact: true });
    await folderDialog.waitFor();
    assert.match(await folderDialog.textContent(), /根目录 \/ Production \/ Staging/);
    await folderDialog.getByRole('button', { name: '取消', exact: true }).click();
    await folderDialog.waitFor({ state: 'hidden' });
    await hostTreeAction(page, null, '新建主机');
    const hostDialog = page.getByRole('dialog', { name: '新建主机', exact: true });
    await hostDialog.waitFor();
    for (const label of ['标签（逗号分隔）', '备注', '收藏此主机'])
      assert.equal(await hostDialog.getByLabel(label, { exact: true }).count(), 0);
    assert.equal(await hostDialog.getByLabel('分组', { exact: true }).count(), 0);
    await page.screenshot({ path: `${output}/${name}-host-dialog.png` });
    await hostDialog.getByRole('button', { name: '取消', exact: true }).click();
    await hostDialog.waitFor({ state: 'hidden' });
    const hostRow = page.locator('.tree-host-row').first();
    assert.equal(await page.locator('.tree-host-actions').count(), 0);
    assert.equal(await hostRow.getByRole('button').count(), 1);
    assert.equal(
      await page.locator('[aria-label^="编辑主机 "], [aria-label^="删除主机 "]').count(),
      0,
    );
    await hostRow.scrollIntoViewIfNeeded();
    const labelBefore = await hostRow.locator('.host-label').boundingBox();
    await hostRow.hover();
    assert.equal(await hostRow.getByRole('button').count(), 1);
    assert.deepEqual(await hostRow.locator('.host-label').boundingBox(), labelBefore);
    const hostButton = hostRow.locator('.tree-host');
    assert.equal(
      await hostButton.evaluate((element) => getComputedStyle(element).paddingRight),
      '10px',
    );
    await hostButton.focus();
    assert.equal(await hostRow.getByRole('button').count(), 1);
    await page.screenshot({ path: `${output}/${name}-host-row-no-icons.png` });
    await hostButton.press('Shift+F10');
    const editMenu = page.getByRole('menu', { name: '主机树操作', exact: true });
    await editMenu.waitFor();
    await page.keyboard.press('ArrowDown');
    assert.equal(
      await editMenu
        .getByRole('menuitem', { name: '编辑主机', exact: true })
        .evaluate((button) => document.activeElement === button),
      true,
    );
    await page.keyboard.press('Enter');
    const edit = page.getByRole('dialog', { name: '编辑主机', exact: true });
    assert.equal(
      await edit.getByLabel('主机名称（可选）', { exact: true }).inputValue(),
      'Production API / 长名称主机布局检查',
    );
    assert.equal(
      await page.locator('.terminal-tab').count(),
      0,
      `${name}: management opened a terminal`,
    );
    await edit.getByRole('button', { name: '取消', exact: true }).click();
    await page.screenshot({ path: `${output}/${name}-host-list-actions.png` });
    const fixedActions = await tools.boundingBox();
    await page.locator('.host-tree-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    assert.deepEqual(await tools.boundingBox(), fixedActions);
    assert.deepEqual(await page.locator('.host-list-heading').boundingBox(), {
      x: geometry.header.x,
      y: geometry.header.y,
      width: geometry.header.width,
      height: geometry.header.height,
    });
    await page.getByLabel('搜索主机', { exact: true }).fill('192.0.2.1');
    assert((await page.locator('.tree-host').count()) > 0);
    await page.getByLabel('搜索主机', { exact: true }).fill('no-matching-layout-host');
    await page.getByText('没有匹配的主机', { exact: true }).waitFor();
    assert.equal((await total.textContent()).trim(), '60');
    await page.getByLabel('搜索主机', { exact: true }).fill('');
    await page.getByLabel('搜索主机', { exact: true }).fill('192.0.2.60');
    assert.equal(await page.locator('.tree-host').count(), 1);
    await page.getByLabel('搜索主机', { exact: true }).fill('short-list');
    assert.equal(await page.locator('.tree-host').count(), 3);
    assert.equal((await total.textContent()).trim(), '60');
    if (height >= 800) {
      assert.equal(
        await page.locator('.host-tree-scroll').evaluate((el) => el.scrollHeight > el.clientHeight),
        false,
        `${name}: short list has an unnecessary scrollbar`,
      );
    } else {
      const lastMatch = page.locator('.tree-host').last();
      await lastMatch.scrollIntoViewIfNeeded();
      const row = await lastMatch.boundingBox(),
        list = await page.locator('.host-tree-scroll').boundingBox();
      assert(
        row.y >= list.y && row.y + row.height <= list.y + list.height + 1,
        `${name}: short-window search matches cannot be reached by scrolling`,
      );
    }
    await page.getByLabel('搜索主机', { exact: true }).fill('');
    await page.locator('.tree-host').first().click();
    await page.locator('.terminal-tab').first().waitFor();
    await page.locator('.tree-host').first().dblclick();
    assert.equal(await page.locator('.terminal-tab').count(), 1, `${name}: duplicate terminal`);
    assert.equal(await page.locator('.topbar [aria-label="退出应用"]').count(), 0);
    assert.equal(await page.locator('.topbar [aria-label="打开通用"]').count(), 0);
    await page.locator('.tree-host').first().click({ button: 'right' });
    const hostMenu = page.getByRole('menu', { name: '主机树操作', exact: true });
    assert.equal(await hostMenu.count(), 1);
    assert.deepEqual(
      (await hostMenu.getByRole('menuitem').allTextContents()).map((text) => text.trim()),
      ['连接主机', '编辑主机', '复制主机', '删除主机'],
    );
    assert.equal(
      await hostMenu.getByRole('menuitem', { name: '新建文件夹', exact: true }).count(),
      0,
    );
    assert.equal(await page.getByRole('button', { name: '关闭操作菜单', exact: true }).count(), 0);
    assert.equal(
      await page.locator('.tree-host-more, .host-tree-scroll [aria-haspopup=menu]').count(),
      0,
    );
    await page.screenshot({ path: `${output}/${name}-host-context-menu.png` });
    await page.keyboard.press('Escape');
    assert.equal(await hostMenu.count(), 0);
    if (width <= 720) await page.getByRole('button', { name: '收起主机栏', exact: true }).click();
    await page.locator('.workspace-tab.active [role=tab]').click({ button: 'middle' });
    assert.equal(
      await page.locator('.terminal-tab').count(),
      0,
      `${name}: host sessions were retained`,
    );
    await navigateWorkspace(page, 'SSH 终端');
    await page.locator('.terminal-tab [role=tab]').first().click({ button: 'middle' });
    assert.equal(await page.locator('.terminal-tab').count(), 0, `${name}: terminal not closed`);
    if (width <= 720) await page.getByRole('button', { name: '展开主机栏', exact: true }).click();
    await page.locator('.host-tree-scroll').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: `${output}/${name}.png` });
    await page.locator('.tree-host').first().click();
    await page.getByRole('button', { name: '收起主机栏', exact: true }).click();
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    await navigateWorkspace(page, '服务器管理');
    await page.getByRole('heading', { name: '服务器管理', exact: true }).waitFor();
    await page.screenshot({ path: `${output}/${name}-workspace.png` });
    if (!(await page.locator('.sidebar').isVisible()))
      await page.getByRole('button', { name: '展开主机栏', exact: true }).click();
    const device = page.locator('.sidebar-local-device');
    await device.waitFor();
    assert.equal((await device.locator('.sidebar-context-name').textContent()).trim(), '本地设备');
    assert.equal((await device.locator('.host-tool').textContent()).trim(), '本地终端');
    const pinned = await device.boundingBox();
    const heading = await page.locator('.host-list-heading').boundingBox();
    const list = await page.locator('.host-tree-scroll').boundingBox();
    assert(heading.y >= pinned.y + pinned.height, `${name}: All Hosts must follow the device`);
    const searchBox = await page.getByLabel('搜索主机', { exact: true }).boundingBox();
    assert(searchBox.y >= heading.y + heading.height, `${name}: search must follow All Hosts`);
    assert(list.y >= searchBox.y + searchBox.height, `${name}: list must follow search`);
    assert.equal(await page.locator('.host-tree-scroll .sidebar-local-device').count(), 0);
    const scrollTop = await page.locator('.host-tree-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    assert(scrollTop > 0, `${name}: test must actually scroll the host list`);
    assert.deepEqual(await device.boundingBox(), pinned, `${name}: device scrolled with hosts`);
    await page.getByLabel('搜索主机', { exact: true }).fill('no-matching-layout-host');
    await page.getByText('没有匹配的主机', { exact: true }).waitFor();
    assert.equal(await device.isVisible(), true);
    await page.getByLabel('搜索主机', { exact: true }).fill('');
    assert.equal(await device.isVisible(), true);
    await device.getByRole('button', { name: '本地终端', exact: true }).click();
    assert.equal(await page.locator('.workspace-tab.active').getAttribute('data-host-id'), '');
    await page.locator('.terminal-pane:visible[data-host-id=""]').waitFor();
    await page.locator('.host-tree-scroll').evaluate((element) => (element.scrollTop = 0));
    await page.screenshot({ path: `${output}/${name}-local-device.png` });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual(errors, []);
    results.push({ name, geometry, pageErrors: errors.length });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(
    `Layout checks passed for ${results.length} viewports/themes. Screenshots: ${output}`,
  );
} finally {
  await browser.close();
}
