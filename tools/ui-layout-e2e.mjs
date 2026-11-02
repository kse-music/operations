import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace } from './ui-navigation.mjs';

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
            username: 'operator',
            groupId: n < 30 ? 'production' : 'staging',
            favorite: n < 3,
            createdAt: '',
            updatedAt: '',
          })),
          groups: [
            { id: 'production', name: 'Production', sortOrder: 0 },
            { id: 'staging', name: 'Staging', sortOrder: 1 },
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
    assert.equal(await page.locator('.topbar [aria-label="当前主机上下文"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: '打开全局搜索', exact: true }).count(), 0);
    assert.equal(
      await page.getByRole('button', { name: '打开本地工作区', exact: true }).count(),
      0,
    );
    assert.equal(await page.locator('.topbar button').count(), 0);
    const collapseButton = page
      .locator('.host-sidebar-title')
      .getByRole('button', { name: '收起主机栏', exact: true });
    const collapsePosition = await page.locator('.host-sidebar-heading').evaluate((header) => {
      const heading = header.getBoundingClientRect();
      const button = header.querySelector('[aria-label="收起主机栏"]').getBoundingClientRect();
      return {
        text: header.textContent.trim(),
        atLeft: button.left >= heading.left && button.left <= heading.left + 20,
        sameRow: Math.abs(button.top + button.height / 2 - heading.top - heading.height / 2) < 2,
      };
    });
    assert(
      collapsePosition.text === '' && collapsePosition.atLeft && collapsePosition.sameRow,
      `${name}: header must have no text and keep the collapse icon aligned at the left`,
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
        header: box('.host-sidebar-heading'),
        footer: box('.host-sidebar-footer'),
        main: box('main'),
        rail: box('.activity-rail'),
        overflow: document.documentElement.scrollWidth > innerWidth,
        listScrolls: list.scrollHeight > list.clientHeight,
        railOverflows:
          document.querySelector('.activity-rail').scrollHeight >
          document.querySelector('.activity-rail').clientHeight,
      };
    });
    assert(!geometry.overflow, `${name}: page overflows horizontally`);
    assert(!geometry.railOverflows, `${name}: navigation overflows`);
    assert.equal(await page.getByRole('button', { name: '主机管理', exact: true }).count(), 1);
    assert.equal(
      await page.locator('.activity-rail [aria-label="主机管理"] .nav-badge').count(),
      0,
    );
    const total = page.locator('.host-filter button').first().locator('.host-count');
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
    assert(geometry.list.height > height * 0.55, `${name}: host list is too small`);
    assert(geometry.listScrolls, `${name}: long host list cannot scroll`);
    if (width > 720)
      assert(geometry.main.x >= geometry.sidebar.right, `${name}: workspace overlaps sidebar`);
    await page.getByRole('button', { name: '主机树工具', exact: true }).click();
    const tools = page.getByRole('group', { name: '主机树工具选项', exact: true });
    await tools.waitFor();
    assert.equal(
      await tools.getByRole('button', { name: '导入 OpenSSH', exact: true }).isEnabled(),
      true,
    );
    assert.equal(
      await tools.getByRole('button', { name: '导出配置', exact: true }).isEnabled(),
      true,
    );
    assert.equal(await tools.getByLabel('主机排序', { exact: true }).count(), 1);
    assert.equal(await tools.getByLabel('按标签筛选主机', { exact: true }).count(), 1);
    const toolsFit = await tools.evaluate((element) => element.scrollWidth <= element.clientWidth);
    assert(toolsFit, `${name}: tree tools overflow`);
    const hostRow = page.locator('.tree-host-row').first();
    const actions = hostRow.locator('.tree-host-actions');
    const actionsVisible = () =>
      actions.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.opacity === '1' && style.pointerEvents === 'auto';
      });
    assert.equal(await page.locator('[aria-label^="复制主机 "]').count(), 0);
    assert.equal(await actions.locator('button').count(), 2);
    await page.locator('.host-sidebar-heading').click({ position: { x: 4, y: 4 } });
    assert.equal(await actionsVisible(), false, `${name}: actions visible without hover`);
    assert.equal(await actions.evaluate((element) => getComputedStyle(element).opacity), '0');
    assert.equal(
      await actions.evaluate((element) => getComputedStyle(element).pointerEvents),
      'none',
    );
    const labelBefore = await hostRow.locator('.host-label').boundingBox();
    await hostRow.hover();
    assert.equal(await actionsVisible(), true);
    assert.deepEqual(
      await hostRow.locator('.host-label').boundingBox(),
      labelBefore,
      `${name}: hover moved host label`,
    );
    assert.equal(
      await page
        .locator('.tree-host-row')
        .nth(1)
        .locator('.tree-host-actions')
        .evaluate((element) => getComputedStyle(element).opacity),
      '0',
    );
    await page.screenshot({ path: `${output}/${name}-host-actions-hover.png` });
    await page.locator('.host-sidebar-heading').click({ position: { x: 4, y: 4 } });
    assert.equal(await actionsVisible(), false);
    assert.equal(await actions.evaluate((element) => getComputedStyle(element).opacity), '0');
    await hostRow.locator('.tree-host').press('Shift+Tab');
    await page.keyboard.press('Tab');
    assert.equal(
      await hostRow.locator('.tree-host').evaluate((button) => document.activeElement === button),
      true,
    );
    assert.equal(await actionsVisible(), true, `${name}: keyboard row focus must reveal actions`);
    await page.keyboard.press('Tab');
    assert.equal(
      await actions
        .locator('[aria-label^="编辑主机 "]')
        .evaluate((button) => document.activeElement === button),
      true,
    );
    assert.equal(await actionsVisible(), true, `${name}: keyboard actions hidden`);
    await page.keyboard.press('Tab');
    assert.equal(
      await actions
        .locator('[aria-label^="删除主机 "]')
        .evaluate((button) => document.activeElement === button),
      true,
    );
    await page.locator('.host-sidebar-heading').click({ position: { x: 4, y: 4 } });
    assert.equal(await actionsVisible(), false);
    await page.screenshot({ path: `${output}/${name}-host-actions-hidden.png` });
    await hostRow.hover();
    await actions.locator('[aria-label^="编辑主机 "]').click();
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
    await page.screenshot({ path: `${output}/${name}-tree-tools.png` });
    await page.getByRole('button', { name: '主机树工具', exact: true }).click();
    await page.locator('.host-tree-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    assert.deepEqual(await page.locator('.host-sidebar-heading').boundingBox(), {
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
    await page.getByRole('button', { name: '收藏', exact: true }).click();
    assert.equal(await page.locator('.tree-host').count(), 3);
    assert.equal((await total.textContent()).trim(), '60');
    assert.equal(
      await page.locator('.host-tree-scroll').evaluate((el) => el.scrollHeight > el.clientHeight),
      false,
      `${name}: short list has an unnecessary scrollbar`,
    );
    await page.getByRole('button', { name: '全部主机', exact: true }).click();
    await page.locator('.tree-host').first().click();
    await page.locator('.terminal-tab').first().waitFor();
    await page.locator('.tree-host').first().dblclick();
    assert.equal(await page.locator('.terminal-tab').count(), 1, `${name}: duplicate terminal`);
    assert.equal(await page.locator('.topbar [aria-label="退出应用"]').count(), 0);
    assert.equal(await page.locator('.topbar [aria-label="打开全局设置"]').count(), 0);
    await page.locator('.tree-host').first().click({ button: 'right' });
    assert.equal(await page.getByRole('menu').count(), 0);
    assert.equal(await page.getByRole('button', { name: '关闭操作菜单', exact: true }).count(), 0);
    assert.equal(
      await page.locator('.tree-host-more, .host-tree-scroll [aria-haspopup=menu]').count(),
      0,
    );
    await page.screenshot({ path: `${output}/${name}-host-no-menu.png` });
    if (width <= 720) await page.getByRole('button', { name: '收起主机栏', exact: true }).click();
    await page.locator('.workspace-tab.active [role=tab]').click({ button: 'middle' });
    assert.equal(await page.locator('.terminal-tab').count(), 1, `${name}: terminal was lost`);
    await navigateWorkspace(page, 'SSH 终端');
    await page.locator('.terminal-tab [role=tab]').first().click({ button: 'middle' });
    assert.equal(await page.locator('.terminal-tab').count(), 0, `${name}: terminal not closed`);
    if (width <= 720) await page.getByRole('button', { name: '展开主机栏', exact: true }).click();
    await page.locator('.host-tree-scroll').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: `${output}/${name}.png` });
    await page.getByRole('button', { name: '收起主机栏', exact: true }).click();
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    await navigateWorkspace(page, 'Linux 运维');
    await page.getByRole('heading', { name: 'Linux 运维', exact: true }).waitFor();
    await page.screenshot({ path: `${output}/${name}-workspace.png` });
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
