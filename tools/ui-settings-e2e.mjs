import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Isolated browser fixtures only; no persisted settings or replacement IPC implementation.
const url = process.env.SERVERDECK_SETTINGS_URL ?? 'http://127.0.0.1:1421';
const output = process.env.SERVERDECK_SETTINGS_OUTPUT ?? '.local/settings-tabs';
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
    await page.getByRole('button', { name: '全局设置', exact: true }).click();
    const settings = page.locator('.settings-panel');
    const tabs = settings.getByRole('tab');
    const panels = settings.getByRole('tabpanel');
    assert.deepEqual(await tabs.allTextContents(), [
      '界面与运行',
      '终端显示与输入',
      '终端快捷键',
      '工作区与连接',
    ]);
    for (let index = 0; index < 4; index++) {
      await tabs.nth(index).click();
      assert.equal(await panels.count(), 1, `${name}: more than one visible category`);
      assert.equal(await tabs.nth(index).getAttribute('aria-selected'), 'true');
      assert.equal(
        await panels.getAttribute('id'),
        await tabs.nth(index).getAttribute('aria-controls'),
      );
    }
    await tabs.nth(0).click();
    await tabs.nth(0).press('End');
    assert.equal(await tabs.nth(3).getAttribute('aria-selected'), 'true');
    await tabs.nth(3).press('ArrowRight');
    assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true');
    await tabs.nth(0).press('ArrowRight');
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
    await tabs.nth(0).click();
    await tabs.nth(1).click();
    assert.equal(
      await quickCopyPaste.isChecked(),
      true,
      `${name}: tab switch lost quick copy/paste draft`,
    );
    await page.screenshot({ path: `${output}/${name}-terminal.png` });
    await settings.getByLabel('终端行高', { exact: true }).fill('99');
    await tabs.nth(0).click();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
    assert.equal(
      await settings
        .getByLabel('终端行高', { exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await settings.getByLabel('终端行高', { exact: true }).fill('120');
    await tabs.nth(3).click();
    await settings.getByLabel('默认下载目录', { exact: true }).fill('D:\\Downloads');
    await settings.getByLabel('全局默认代理', { exact: true }).selectOption('socks5');
    await settings.getByLabel('默认代理地址', { exact: true }).fill('');
    await tabs.nth(0).click();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    assert.equal(await tabs.nth(3).getAttribute('aria-selected'), 'true');
    assert.equal(
      await settings
        .getByLabel('默认代理地址', { exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await settings.getByLabel('默认代理地址', { exact: true }).fill('127.0.0.1');
    await tabs.nth(1).click();
    assert.equal(await settings.getByLabel('终端行高', { exact: true }).inputValue(), '120');
    await tabs.nth(3).click();
    assert.equal(
      await settings.getByLabel('默认下载目录', { exact: true }).inputValue(),
      'D:\\Downloads',
    );
    assert(await settings.getByLabel('默认代理地址', { exact: true }).isVisible());
    await page.screenshot({ path: `${output}/${name}-connection.png` });
    await tabs.nth(0).click();
    await settings.locator('#settings-panel-general').waitFor({ state: 'visible' });
    const geometry = await settings.evaluate((el) => ({
      pageOverflows: document.documentElement.scrollWidth > innerWidth,
      formOverflows: el.querySelector('form').scrollWidth > el.querySelector('form').clientWidth,
      formWidth: el.querySelector('form').clientWidth,
      formScrollWidth: el.querySelector('form').scrollWidth,
      columns: getComputedStyle(el.querySelector('#settings-panel-general fieldset'))
        .gridTemplateColumns,
    }));
    await page.screenshot({ path: `${output}/${name}-general.png` });
    assert(
      !geometry.pageOverflows && !geometry.formOverflows,
      `${name}: horizontal page overflow ${JSON.stringify(geometry)}`,
    );
    assert.deepEqual(errors, []);
    results.push({ name, width, height, theme, ...geometry, errors });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
