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
    ['wide-window', 2400, 1000, 'dark'],
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
      const root = 'D:\\ServerDeck\\' + '目录迁移与超长路径验证\\'.repeat(6);
      application.state = {
        appVersion: 'ui-test',
        databaseVersion: 5,
        dataDirectory: root,
        logDirectory: `${root}logs`,
        storage: {
          rootDirectory: root,
          databasePath: `${root}serverdeck.sqlite3`,
          pluginDirectory: `${root}plugins`,
          logDirectory: `${root}logs`,
          webviewDirectory: `${root}webview`,
          notice: null,
        },
        config: {
          version: 1,
          theme,
          interfaceFontSize: 'standard',
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
    const categories = ['通用', '终端', '快捷键', '数据与存储'];
    const select = async (index) => navigateWorkspace(page, categories[index]);
    const activeMenu = () => page.locator('.module-menu [aria-current="page"]');
    const layouts = [];
    const dismissNotices = async () => {
      for (const close of await page.getByRole('button', { name: '关闭通知', exact: true }).all())
        await close.click();
    };
    assert.equal(await settings.getByRole('tablist').count(), 0);
    assert.deepEqual(await page.locator('.module-navigation button').allTextContents(), [
      '主机管理',
      '插件',
      '设置',
    ]);
    assert.deepEqual(
      (await page.locator('.module-menu .nav-label').allTextContents()).map((text) => text.trim()),
      [...categories, '模型管理', '关于'],
    );
    for (let index = 0; index < categories.length; index++) {
      await select(index);
      assert.equal(await settings.locator('.settings-category:visible').count(), 1);
      assert.equal(await activeMenu().getAttribute('aria-label'), categories[index]);
      assert.equal(await settings.locator('h1').textContent(), categories[index]);
      const restore = settings.getByRole('button', { name: '恢复默认', exact: true });
      const save = settings.getByRole('button', { name: '保存设置', exact: true });
      const restoreBox = await restore.boundingBox();
      const saveBox = await save.boundingBox();
      assert(
        restoreBox &&
          saveBox &&
          restoreBox.y === saveBox.y &&
          restoreBox.x + restoreBox.width < saveBox.x,
        `${name}: ${categories[index]} must place restore defaults to the left of save`,
      );
      const layout = await settings.locator('.settings-category:visible').evaluate((panel) => {
        const rect = (el) => el.getBoundingClientRect();
        const groups = [...panel.querySelectorAll(':scope > fieldset')];
        return {
          category: panel.id,
          shortcuts: panel.classList.contains('settings-shortcuts'),
          overflows: panel.scrollWidth > panel.clientWidth,
          groupGaps: groups.slice(1).map((group, i) => rect(group).top - rect(groups[i]).bottom),
          headingGaps: groups
            .filter((group) => group.querySelector('.settings-fields'))
            .map(
              (group) =>
                rect(group.querySelector('.settings-fields')).top -
                rect(group.querySelector('legend')).bottom,
            ),
          fields: [...panel.querySelectorAll('.settings-fields > label:not(.checkbox-label)')].map(
            (label) => {
              const control = label.querySelector('input, select');
              const title = document.createRange();
              title.setStart(label, 0);
              title.setEndBefore(control);
              return {
                width: rect(label).width,
                gridWidth: rect(label.parentElement).width,
                columns: getComputedStyle(label.parentElement).gridTemplateColumns.split(' ')
                  .length,
                controlHeight: rect(control).height,
                labelGap: rect(control).top - title.getBoundingClientRect().bottom,
                inline:
                  getComputedStyle(label).display === 'grid' &&
                  getComputedStyle(label).gridTemplateColumns.split(' ').length > 1,
                centerGap: Math.abs(
                  (rect(control).top +
                    rect(control).bottom -
                    title.getBoundingClientRect().top -
                    title.getBoundingClientRect().bottom) /
                    2,
                ),
              };
            },
          ),
        };
      });
      assert(!layout.overflows, `${name}: ${categories[index]} overflows`);
      assert(
        layout.groupGaps.every((gap) => gap >= 19 && gap <= 21),
        `${name}: inconsistent group spacing ${JSON.stringify(layout)}`,
      );
      assert(
        layout.headingGaps.every((gap) => gap >= 15 && gap <= 17),
        `${name}: inconsistent heading spacing ${JSON.stringify(layout)}`,
      );
      for (const field of layout.fields) {
        if (layout.shortcuts && field.gridWidth > 460)
          assert(field.inline, `${name}: shortcut labels must sit beside their controls`);
        assert(
          field.controlHeight === 36,
          `${name}: inconsistent control height ${JSON.stringify(field)}`,
        );
        if (field.inline) assert(field.centerGap <= 4, `${name}: shortcut label is misaligned`);
        else
          assert(
            field.labelGap >= 6 && field.labelGap <= 14,
            `${name}: crowded field label ${JSON.stringify(field)}`,
          );
        assert(
          field.width <= field.gridWidth / field.columns + 1,
          `${name}: field stretches its column`,
        );
      }
      layouts.push(layout);
      await page.screenshot({
        path: `${output}/${name}-${['general', 'terminal', 'shortcuts', 'storage'][index]}.png`,
      });
    }
    const header = await page.locator('.module-header').evaluate((el) => {
      const system = el.querySelector('[data-module="system"]').getBoundingClientRect();
      const plugins = el.querySelector('[data-module="plugins"]').getBoundingClientRect();
      return {
        rightGap: el.getBoundingClientRect().right - system.right,
        moduleGap: system.left - plugins.right,
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
    await dismissNotices();
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
    await select(1);
    await settings.getByLabel('全局默认代理', { exact: true }).selectOption('socks5');
    await settings.getByLabel('默认代理地址', { exact: true }).fill('');
    await select(0);
    await dismissNotices();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    assert.equal(await activeMenu().getAttribute('aria-label'), '终端');
    assert.equal(
      await page.locator('.workspace-tab.active').getAttribute('data-view'),
      'settingsTerminal',
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
    await select(1);
    assert(await settings.getByLabel('默认代理地址', { exact: true }).isVisible());
    await page.evaluate(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const { useNotificationsStore } = await import('/src/stores/notifications.ts');
      useNotificationsStore(pinia).items = [];
    });
    await settings.getByRole('checkbox', { name: '代理需要认证', exact: true }).check();
    await settings.getByLabel('代理用户名', { exact: true }).waitFor();
    assert(await settings.getByLabel('代理用户名', { exact: true }).isVisible());
    assert(await settings.getByLabel('代理安全凭据', { exact: true }).isVisible());
    assert.equal(await settings.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: `${output}/${name}-connection.png` });
    await navigateWorkspace(page, '关于');
    const about = page.locator('.about-view');
    assert.match(await about.textContent(), /本地环境/);
    assert.match(await about.textContent(), /vui-test/);
    assert.match(await about.textContent(), /schema v5/);
    assert.equal(await about.getByRole('button', { name: '重新检查', exact: true }).count(), 1);
    assert.equal(await about.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    assert.equal(await page.locator('.module-menu [aria-label="本地环境"]').count(), 0);
    await navigateWorkspace(page, '关于');
    assert.equal(await page.locator('.workspace-tab[data-view="about"]').count(), 1);
    await page.screenshot({ path: `${output}/${name}-about.png` });
    await navigateWorkspace(page, '模型管理');
    await page.getByRole('region', { name: '模型管理', exact: true }).waitFor();
    assert.equal(
      await page.locator('.module-navigation [aria-current="page"]').getAttribute('data-module'),
      'system',
    );
    assert.equal(await activeMenu().getAttribute('aria-label'), '模型管理');
    assert.equal(await page.locator('.workspace-tab[data-view="models"]').count(), 1);
    await select(1);
    assert.equal(await quickCopyPaste.isChecked(), true);
    assert.equal(await settings.getByLabel('终端行高', { exact: true }).inputValue(), '120');
    await select(3);
    assert.equal(
      await settings.getByLabel('默认下载目录', { exact: true }).inputValue(),
      'D:\\Downloads',
    );

    const storageGeometry = await settings.evaluate((el) => ({
      pageOverflows: document.documentElement.scrollWidth > innerWidth,
      formOverflows: el.querySelector('form').scrollWidth > el.querySelector('form').clientWidth,
    }));
    assert(
      !storageGeometry.pageOverflows && !storageGeometry.formOverflows,
      `${name}: storage paths overflow`,
    );
    await page.screenshot({ path: `${output}/${name}-storage.png` });

    await select(0);
    await settings.locator('#settings-panel-general').waitFor({ state: 'visible' });
    const geometry = await settings.evaluate((el) => ({
      pageOverflows: document.documentElement.scrollWidth > innerWidth,
      formOverflows: el.querySelector('form').scrollWidth > el.querySelector('form').clientWidth,
      formWidth: el.querySelector('form').clientWidth,
      formScrollWidth: el.querySelector('form').scrollWidth,
      columns: getComputedStyle(el.querySelector('#settings-panel-general .settings-fields'))
        .gridTemplateColumns,
      fieldRows: [
        ...el.querySelectorAll('#settings-panel-general fieldset .settings-fields > label'),
      ].map((field) => field.getBoundingClientRect().top),
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
    results.push({ name, width, height, theme, ...geometry, ...header, layouts, errors });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify(
      results.map(({ name, width, height, theme, pageOverflows, formOverflows, errors }) => ({
        name,
        width,
        height,
        theme,
        pageOverflows,
        formOverflows,
        errors,
      })),
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
