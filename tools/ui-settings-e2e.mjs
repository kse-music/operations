import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace } from './ui-navigation.mjs';

// Isolated browser fixtures only; no persisted settings or replacement IPC implementation.
const url = process.env.SERVERDECK_SETTINGS_URL ?? 'http://127.0.0.1:1421';
const output = process.env.SERVERDECK_SETTINGS_OUTPUT ?? '.local/settings-navigation/ui';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.SERVERDECK_BROWSER ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const results = [];
try {
  for (const [name, width, height, theme] of [
    ['desktop-dark', 1440, 900, 'dark'],
    ['desktop-light', 1440, 900, 'light'],
    ['small-window', 900, 600, 'dark'],
    ['narrow-window', 390, 844, 'light'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await page.evaluate(async (theme) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const { useApplicationStore } = await import('/src/stores/application.ts');
      const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
      const { defaultProductPreferences } = await import('/src/types/product.ts');
      const { useNotificationsStore } = await import('/src/stores/notifications.ts');
      const application = useApplicationStore(pinia);
      application.state = {
        appVersion: 'ui-test',
        databaseVersion: 5,
        dataDirectory: '',
        logDirectory: '',
        config: {
          version: 1,
          theme,
          sidebarWidth: 260,
          terminalFontSize: 14,
          connectTimeoutSecs: 10,
          monitorIntervalSecs: 5,
          transferConcurrency: 3,
          logLevel: 'info',
          terminal: defaultTerminalPreferences(),
          product: defaultProductPreferences(),
        },
      };
      application.error = null;
      useNotificationsStore(pinia).items = [];
    }, theme);
    await navigateWorkspace(page, '通用');
    const settings = page.locator('.settings-panel');
    const categories = ['通用', '终端', '快捷键', '工作区与连接'];
    const select = async (index) => navigateWorkspace(page, categories[index]);
    const activeMenu = () => page.locator('.module-menu [aria-current="page"]');
    assert.equal(await settings.getByRole('tablist').count(), 0);
    assert.deepEqual(
      (await page.locator('.module-menu .nav-label').allTextContents()).map((text) => text.trim()),
      [...categories, '关于'],
    );
    for (let index = 0; index < categories.length; index++) {
      await select(index);
      assert.equal(await settings.locator('.settings-category:visible').count(), 1);
      assert.equal(await activeMenu().getAttribute('aria-label'), categories[index]);
      assert.equal(await settings.locator('h1').textContent(), categories[index]);
    }
    const header = await page.locator('.module-header').evaluate((el) => {
      const system = el.querySelector('[data-module="system"]').getBoundingClientRect();
      const assets = el.querySelector('[data-module="assets"]').getBoundingClientRect();
      return {
        rightGap: el.getBoundingClientRect().right - system.right,
        moduleGap: system.left - assets.right,
      };
    });
    assert(header.rightGap <= 1, `${name}: settings must align with header right edge`);
    if (width >= 900)
      assert(header.moduleGap > 100, `${name}: settings must be separated from other modules`);
    assert.equal(await page.locator('[data-module="system"]').textContent(), '设置');
    await select(1);
    const quickCopyPaste = settings.getByRole('checkbox', {
      name: '选中即复制，右键即粘贴',
      exact: true,
    });
    assert.equal(
      await quickCopyPaste.isChecked(),
      false,
      `${name}: quick copy/paste must default off`,
    );
    await quickCopyPaste.check();
    await select(0);
    await select(1);
    assert.equal(
      await quickCopyPaste.isChecked(),
      true,
      `${name}: menu switch lost quick copy/paste draft`,
    );
    await page.screenshot({ path: `${output}/${name}-terminal.png` });
    await settings.getByLabel('终端行高', { exact: true }).fill('99');
    await select(0);
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    assert.equal(await activeMenu().getAttribute('aria-label'), '终端');
    assert.equal(
      await page.locator('.workspace-tab.active').getAttribute('data-view'),
      'settingsTerminal',
    );
    assert.equal(
      await settings
        .getByLabel('终端行高', { exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await settings.getByLabel('终端行高', { exact: true }).fill('120');
    await select(3);
    await settings.getByLabel('默认下载目录', { exact: true }).fill('D:\\Downloads');
    await settings.getByLabel('全局默认代理', { exact: true }).selectOption('socks5');
    await settings.getByLabel('默认代理地址', { exact: true }).fill('');
    await select(0);
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    assert.equal(await activeMenu().getAttribute('aria-label'), '工作区与连接');
    assert.equal(
      await page.locator('.workspace-tab.active').getAttribute('data-view'),
      'settingsWorkspace',
    );
    assert.equal(
      await settings
        .getByLabel('默认代理地址', { exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await settings.getByLabel('默认代理地址', { exact: true }).fill('127.0.0.1');
    await select(1);
    assert.equal(await settings.getByLabel('终端行高', { exact: true }).inputValue(), '120');
    await select(3);
    assert.equal(
      await settings.getByLabel('默认下载目录', { exact: true }).inputValue(),
      'D:\\Downloads',
    );
    assert(await settings.getByLabel('默认代理地址', { exact: true }).isVisible());
    await page.evaluate(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const { useNotificationsStore } = await import('/src/stores/notifications.ts');
      useNotificationsStore(pinia).items = [];
    });
    await page.screenshot({ path: `${output}/${name}-connection.png` });
    await navigateWorkspace(page, '关于');
    const about = page.locator('.about-view');
    assert.match(await about.textContent(), /本地环境/);
    assert.match(await about.textContent(), /vui-test/);
    assert.match(await about.textContent(), /schema v5/);
    assert.equal(await about.getByRole('button', { name: '重新检查', exact: true }).count(), 1);
    assert.equal(await page.locator('.module-menu [aria-label="本地环境"]').count(), 0);
    await navigateWorkspace(page, '关于');
    assert.equal(await page.locator('.workspace-tab[data-view="about"]').count(), 1);
    await page.screenshot({ path: `${output}/${name}-about.png` });
    await select(1);
    assert.equal(await quickCopyPaste.isChecked(), true);
    assert.equal(await settings.getByLabel('终端行高', { exact: true }).inputValue(), '120');
    await select(3);
    assert.equal(
      await settings.getByLabel('默认下载目录', { exact: true }).inputValue(),
      'D:\\Downloads',
    );

    await select(0);
    await settings.locator('#settings-panel-general').waitFor({ state: 'visible' });
    const geometry = await settings.evaluate((el) => ({
      pageOverflows: document.documentElement.scrollWidth > innerWidth,
      formOverflows: el.querySelector('form').scrollWidth > el.querySelector('form').clientWidth,
      formWidth: el.querySelector('form').clientWidth,
      formScrollWidth: el.querySelector('form').scrollWidth,
      columns: getComputedStyle(el.querySelector('#settings-panel-general fieldset'))
        .gridTemplateColumns,
      fieldRows: [...el.querySelectorAll('#settings-panel-general fieldset > label')].map(
        (field) => field.getBoundingClientRect().top,
      ),
    }));
    await page.screenshot({ path: `${output}/${name}-general.png` });
    assert(
      !geometry.pageOverflows && !geometry.formOverflows,
      `${name}: horizontal page overflow ${JSON.stringify(geometry)}`,
    );
    if (width <= 720)
      assert.equal(
        new Set(geometry.fieldRows).size,
        geometry.fieldRows.length,
        `${name}: narrow settings must use one column`,
      );
    assert.deepEqual(errors, []);
    results.push({ name, width, height, theme, ...geometry, ...header, errors });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
