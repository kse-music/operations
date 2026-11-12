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
    ['small-window', 960, 600, 'dark'],
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
        databaseVersion: 10,
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
          version: 2,
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
    const activeMenu = () => page.locator('.settings-navigation [aria-current="page"]');
    const layouts = [];
    const dismissNotices = async () => {
      for (const close of await page.getByRole('button', { name: '关闭通知', exact: true }).all())
        await close.click();
    };
    assert.equal(await settings.getByRole('tablist').count(), 0);
    assert.equal(await page.locator('.settings-page:visible').count(), 1);
    assert.deepEqual(
      (await page.locator('.settings-navigation .nav-item').allTextContents()).map((text) =>
        text.trim(),
      ),
      [...categories, '模型', '插件', '关于'],
    );
    for (let index = 0; index < categories.length; index++) {
      await select(index);
      assert.equal(await settings.locator('.settings-category:visible').count(), 1);
      assert.equal(await activeMenu().getAttribute('aria-label'), categories[index]);
      assert.equal(await settings.locator('h1').textContent(), categories[index]);
      const restore = settings.getByRole('button', { name: '恢复默认', exact: true });
      const save = settings.getByRole('button', { name: '保存设置', exact: true });
      assert(await restore.isVisible(), `${name}: restore defaults is missing`);
      assert.equal(await save.count(), 0, `${name}: ${categories[index]} must save automatically`);
      assert(await settings.getByRole('status').isVisible());
      assert.equal(
        await settings.getByRole('button', { name: '迁移并重启', exact: true }).count(),
        0,
      );
      const layout = await settings.locator('.settings-category:visible').evaluate((panel) => {
        const rect = (el) => el.getBoundingClientRect();
        const groups = [...panel.querySelectorAll(':scope > fieldset')];
        const workspace = panel.closest('.settings-page');
        const workspaceStyle = getComputedStyle(workspace);
        return {
          category: panel.id,
          shortcuts: panel.classList.contains('settings-shortcuts'),
          workspaceWidth:
            workspace.clientWidth -
            parseFloat(workspaceStyle.paddingLeft) -
            parseFloat(workspaceStyle.paddingRight),
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
        if (layout.shortcuts && layout.workspaceWidth > 640)
          assert(field.inline, `${name}: shortcut labels must sit beside their controls`);
        assert(
          field.controlHeight >= 36 && field.controlHeight <= 38,
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
    const header = await page.locator('.app-header').evaluate((el) => {
      const search = el.querySelector('.app-search-button').getBoundingClientRect();
      return { rightGap: el.getBoundingClientRect().right - search.right };
    });
    assert(header.rightGap <= 20, `${name}: global search must remain reachable at the right edge`);
    assert.equal(await page.getByLabel('应用菜单', { exact: true }).count(), 0);
    assert.equal(await page.locator('.sidebar-app-actions [aria-label="设置"]').count(), 1);
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
    await select(3);
    await settings.locator('form').evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(await activeMenu().getAttribute('aria-label'), '终端');
    assert.equal(await activeMenu().getAttribute('aria-label'), '终端');
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
    await select(3);
    await settings.locator('form').evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(await activeMenu().getAttribute('aria-label'), '终端');
    assert.equal(await activeMenu().getAttribute('aria-label'), '终端');
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
    assert.match(await about.textContent(), /schema v10/);
    assert.equal(await about.getByRole('button', { name: '重新检查', exact: true }).count(), 1);
    assert.equal(await about.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    assert.equal(await page.locator('.settings-navigation [aria-label="本地环境"]').count(), 0);
    await navigateWorkspace(page, '关于');
    assert.equal(await page.locator('.workspace-tab[data-view="about"]').count(), 0);
    await page.screenshot({ path: `${output}/${name}-about.png` });
    await navigateWorkspace(page, '模型');
    await page.getByRole('region', { name: '模型', exact: true }).waitFor();
    assert.equal(await activeMenu().getAttribute('aria-label'), '模型');
    assert.equal(await activeMenu().getAttribute('aria-label'), '模型');
    assert.equal(await page.locator('.workspace-tab[data-view="models"]').count(), 0);
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
    await settings.getByLabel('数据根目录', { exact: true }).fill('D:\\PendingMigration');
    const migrationAction = settings.getByRole('button', { name: '迁移并重启', exact: true });
    assert(await migrationAction.isVisible(), `${name}: migration must keep an explicit action`);
    assert.equal(await settings.getByRole('button', { name: '保存设置', exact: true }).count(), 0);
    await settings
      .getByLabel('数据根目录', { exact: true })
      .fill(
        await page.evaluate(
          () =>
            document
              .querySelector('#app')
              .__vue_app__.config.globalProperties.$pinia._s.get('application').state.storage
              .rootDirectory,
        ),
      );
    assert.equal(await migrationAction.count(), 0);
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

    // Category changes preserve the draft; closing the whole window reviews it once.
    for (const category of categories.slice(1)) {
      await navigateWorkspace(page, category);
      assert.equal(
        await page.getByRole('dialog', { name: '设置尚未保存', exact: true }).count(),
        0,
      );
    }
    await navigateWorkspace(page, '关于');
    const settingsDialog = page.locator('.settings-page:visible');
    await page.evaluate(() => {
      void document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
        .closeSettings();
    });
    const closeDialog = page.getByRole('dialog', { name: '设置尚未保存', exact: true });
    await closeDialog.waitFor();
    const closeGeometry = await closeDialog.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return {
        overflows: el.scrollWidth > el.clientWidth,
        visible:
          box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
        focus: el.contains(document.activeElement),
      };
    });
    assert(!closeGeometry.overflows && closeGeometry.visible && closeGeometry.focus, name);
    await page.screenshot({ path: `${output}/${name}-unsaved-settings.png` });
    await closeDialog.press('Escape');
    await closeDialog.waitFor({ state: 'detached' });
    assert.equal(await settingsDialog.count(), 1);
    await page.evaluate(() => {
      void document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
        .closeSettings();
    });
    await closeDialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await closeDialog.waitFor({ state: 'detached' });
    const closeAgain = async () => {
      await page.evaluate(() => {
        void document
          .querySelector('#app')
          .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
          .closeSettings();
      });
      await closeDialog.waitFor();
    };
    await closeAgain();
    await closeDialog.getByRole('button', { name: '继续编辑', exact: true }).click();
    await closeDialog.waitFor({ state: 'detached' });
    await select(1);
    assert.equal(await settings.getByLabel('终端行高', { exact: true }).inputValue(), '120');
    await closeAgain();
    await closeDialog.getByRole('button', { name: '放弃更改并关闭', exact: true }).click();
    await settingsDialog.waitFor({ state: 'detached' });
    await select(1);
    assert.equal(await settings.getByLabel('终端行高', { exact: true }).inputValue(), '100');
    await page.evaluate(() => {
      void document
        .querySelector('#app')
        .__vue_app__.config.globalProperties.$pinia._s.get('workspace')
        .closeSettings();
    });
    await settings.waitFor({ state: 'detached' });
    assert.equal(await closeDialog.count(), 0);
    assert.deepEqual(errors, []);
    results.push({
      name,
      width,
      height,
      theme,
      ...geometry,
      ...header,
      layouts,
      closeGeometry,
      errors,
    });
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
