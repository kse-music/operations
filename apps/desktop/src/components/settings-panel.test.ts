import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import SettingsPanel from './SettingsPanel.vue';
import { useApplicationStore } from '../stores/application';
import { useWorkspaceStore } from '../stores/workspace';
import * as ipc from '../services/ipc';
import { filesApi } from '../services/files';
import {
  defaultProductPreferences,
  settingsCategories,
  type SettingsCategory,
} from '../types/product';
import { defaultTerminalPreferences } from '../types/preferences';

let app: App, pinia: Pinia, root: HTMLDivElement;
const category = ref<SettingsCategory>('general');
function mountSettingsPanel(): App {
  const mounted = createApp({
    render: () =>
      h(SettingsPanel, {
        category: category.value,
        onCategory: (value) => {
          category.value = value;
        },
      }),
  }).use(pinia);
  mounted.mount(root);
  return mounted;
}
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  category.value = 'general';
  pinia = createPinia();
  setActivePinia(pinia);
  useApplicationStore().state = {
    appVersion: 'test',
    databaseVersion: 10,
    dataDirectory: '',
    logDirectory: '',
    config: {
      version: 2,
      theme: 'dark',
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
  root = document.createElement('div');
  document.body.append(root);
  app = mountSettingsPanel();
});
afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  root.remove();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});

const visiblePanels = () =>
  [...root.querySelectorAll<HTMLElement>('.settings-category')].filter(
    (panel) => panel.style.display !== 'none',
  );
async function select(index: number) {
  category.value = settingsCategories[index]!.id;
  await nextTick();
}
async function input(selector: string, value: string, event = 'input') {
  const field = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  field.value = value;
  field.dispatchEvent(new Event(event, { bubbles: true }));
  await nextTick();
  return field;
}
async function submit() {
  root
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await nextTick();
}

async function restoreDefaults() {
  const button = root.querySelector<HTMLButtonElement>('.form-footer button[type="button"]')!;
  expect(button.textContent?.trim()).toBe('恢复默认');
  button.click();
  await nextTick();
}

it('removes save buttons from all four automatic categories', async () => {
  for (let index = 0; index < settingsCategories.length; index++) {
    await select(index);
    expect(visiblePanels()).toHaveLength(1);
    expect(root.querySelector('h1')?.textContent).toBe(settingsCategories[index]!.label);
    expect(root.querySelector('[type="submit"]')).toBeNull();
    expect(root.querySelector('.form-footer .primary')).toBeNull();
  }
});

it('automatically saves language, restores it on reopen and automatically restores defaults', async () => {
  const application = useApplicationStore();
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await input('[aria-label="界面语言"]', 'en-US', 'change');
  expect(application.state!.config.product.language).toBe('zh-CN');
  await vi.waitFor(() => expect(root.querySelector('h1')?.textContent).toBe('General'));
  expect(save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ product: expect.objectContaining({ language: 'en-US' }) }),
  );
  expect(document.documentElement.lang).toBe('en-US');
  app.unmount();
  app = createApp(SettingsPanel).use(pinia);
  app.mount(root);
  expect(root.querySelector<HTMLSelectElement>('[aria-label="Interface language"]')!.value).toBe(
    'en-US',
  );
  root.querySelector<HTMLButtonElement>('.form-footer button[type="button"]')!.click();
  await vi.waitFor(() => expect(root.querySelector('h1')?.textContent).toBe('通用'));
  expect(document.documentElement.lang).toBe('zh-CN');
});

it('retains a failed automatic edit and saved language, then allows retry without a save button', async () => {
  const save = vi
    .spyOn(ipc, 'saveConfig')
    .mockRejectedValueOnce(new Error('disk failure'))
    .mockImplementation(async (config) => config);
  await input('[aria-label="界面语言"]', 'en-US', 'change');
  await vi.waitFor(() => expect(useApplicationStore().error).toBe('disk failure'));
  expect(useApplicationStore().state!.config.product.language).toBe('zh-CN');
  expect(root.querySelector<HTMLSelectElement>('[aria-label="界面语言"]')!.value).toBe('en-US');
  expect(root.querySelector('[role="status"]')?.textContent).toContain('自动保存失败');
  expect(root.querySelector('[type="submit"]')).toBeNull();
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '重试')!
    .click();
  await vi.waitFor(() =>
    expect(useApplicationStore().state!.config.product.language).toBe('en-US'),
  );
  expect(save).toHaveBeenCalledTimes(2);
});

it('coalesces rapid edits across all four categories without starting migration', async () => {
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  const preview = vi.spyOn(ipc, 'storagePreview');
  const migrate = vi.spyOn(ipc, 'storageMigrate');
  await storageDraft();
  await input('[aria-label="默认下载目录"]', 'D:\\Downloads');
  await input('[aria-label="每主机并发传输数"]', '5');
  await input('[aria-label="日志级别"]', 'debug', 'change');
  await select(2);
  root
    .querySelector('[aria-label="复制快捷键"]')!
    .dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', ctrlKey: true, shiftKey: true }));
  await select(1);
  await input('[aria-label="终端字体"]', 'Consolas');
  await select(0);
  await input('[data-testid="theme-select"]', 'light', 'change');
  await vi.waitFor(() => expect(useApplicationStore().state!.config.theme).toBe('light'));
  expect(save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      theme: 'light',
      terminal: expect.objectContaining({
        fontFamily: 'Consolas',
        shortcuts: expect.objectContaining({ copy: 'Ctrl+Shift+X' }),
      }),
      transferConcurrency: 5,
      logLevel: 'debug',
      product: expect.objectContaining({ downloadDirectory: 'D:\\Downloads' }),
    }),
  );
  expect(preview).not.toHaveBeenCalled();
  expect(migrate).not.toHaveBeenCalled();
  await select(3);
  expect(root.querySelector<HTMLInputElement>('[aria-label="默认下载目录"]')!.value).toBe(
    'D:\\Downloads',
  );
  expect(root.querySelector<HTMLInputElement>('[aria-label="每主机并发传输数"]')!.value).toBe('5');
  await reviewMigration();
  await vi.waitFor(() => expect(preview).toHaveBeenCalledWith('D:\\ServerDeck'));
});

it('flushes a pending automatic change before closing without a discard prompt', async () => {
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await input('[data-testid="theme-select"]', 'light', 'change');
  expect(await useWorkspaceStore().settingsCloseGuard!()).toBe(true);
  expect(save).toHaveBeenCalledOnce();
  expect(useApplicationStore().state!.config.theme).toBe('light');
  expect(document.querySelector('dialog')).toBeNull();
});

it('accepts external saved changes while preserving unrelated pending edits', async () => {
  const application = useApplicationStore();
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await input('[data-testid="theme-select"]', 'light', 'change');
  application.state!.config = {
    ...application.state!.config,
    sidebarWidth: 300,
    terminalFontSize: 20,
  };
  await nextTick();
  await vi.waitFor(() => expect(application.state!.config.theme).toBe('light'));
  expect(save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sidebarWidth: 300, terminalFontSize: 20 }),
  );
  expect(await useWorkspaceStore().settingsCloseGuard!()).toBe(true);
});

it('restores each automatic category independently and persists its defaults', async () => {
  const application = useApplicationStore();
  vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await input('[data-testid="theme-select"]', 'light', 'change');
  await input('[aria-label="终端字体"]', 'Consolas');
  await input('[aria-label="默认下载目录"]', 'D:\\Downloads');
  await select(2);
  root
    .querySelector('[aria-label="复制快捷键"]')!
    .dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', ctrlKey: true, shiftKey: true }));
  await select(0);
  await restoreDefaults();
  await vi.waitFor(() => expect(application.state!.config.sidebarWidth).toBe(248));
  expect(application.state!.config.theme).toBe('dark');
  expect(application.state!.config.monitorIntervalSecs).toBe(5);
  expect(application.state!.config.terminal.fontFamily).toBe('Consolas');
  expect(application.state!.config.terminal.shortcuts.copy).toBe('Ctrl+Shift+X');
  await select(1);
  await restoreDefaults();
  await vi.waitFor(() =>
    expect(application.state!.config.terminal.fontFamily).toBe(
      defaultTerminalPreferences().fontFamily,
    ),
  );
  expect(application.state!.config.terminal.shortcuts.copy).toBe('Ctrl+Shift+X');
  await select(2);
  await restoreDefaults();
  await vi.waitFor(() =>
    expect(application.state!.config.terminal.shortcuts.copy).toBe('Ctrl+Shift+C'),
  );
  expect(application.state!.config.product.downloadDirectory).toBe('D:\\Downloads');
  expect(root.querySelector<HTMLInputElement>('[aria-label="默认下载目录"]')!.value).toBe(
    'D:\\Downloads',
  );
});

it('automatically saves quick copy and paste after enabling it', async () => {
  vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await select(1);
  const checkbox = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (field) => field.parentElement?.textContent?.includes('选中即复制，右键即粘贴'),
  )!;
  expect(checkbox.checked).toBe(false);
  checkbox.click();
  await vi.waitFor(() =>
    expect(useApplicationStore().state!.config.terminal.quickCopyPaste).toBe(true),
  );
});

it('does not save incomplete or out of range inputs, and resumes after correction', async () => {
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await select(1);
  await input('[aria-label="终端行高"]', '99');
  await input('[aria-label="全局默认代理"]', 'socks5', 'change');
  await input('[aria-label="默认代理地址"]', '');
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(save).not.toHaveBeenCalled();
  await input('[aria-label="终端行高"]', '125');
  await input('[aria-label="默认代理地址"]', '127.0.0.1');
  await vi.waitFor(() => expect(useApplicationStore().state!.config.terminal.lineHeight).toBe(125));
  expect(save).toHaveBeenCalledOnce();
});

it('rejects invalid storage values and saves corrected values automatically', async () => {
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await select(3);
  await input('[aria-label="每主机并发传输数"]', '0');
  await select(0);
  await input('[data-testid="theme-select"]', 'light', 'change');
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(save).not.toHaveBeenCalled();
  expect(useApplicationStore().state!.config.transferConcurrency).toBe(3);
  await select(3);
  await input('[aria-label="每主机并发传输数"]', '4');
  await vi.waitFor(() => expect(useApplicationStore().state!.config.theme).toBe('light'));
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ transferConcurrency: 4 }));
});

it('does not let an unconfirmed or empty migration target block ordinary automatic saves', async () => {
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  const preview = vi.spyOn(ipc, 'storagePreview');
  const migrate = vi.spyOn(ipc, 'storageMigrate');
  await storageDraft();
  await input('[aria-label="数据根目录"]', '');
  await input('[aria-label="每主机并发传输数"]', '5');
  await vi.waitFor(() => expect(useApplicationStore().state!.config.transferConcurrency).toBe(5));
  expect(save).toHaveBeenCalledOnce();
  expect(useApplicationStore().state!.storage!.rootDirectory).toBe('C:\\ServerDeck');
  expect(preview).not.toHaveBeenCalled();
  expect(migrate).not.toHaveBeenCalled();
});

it.each([
  ['默认下载目录', 'D:\\Downloads', 'input'],
  ['每主机并发传输数', '5', 'input'],
  ['日志级别', 'debug', 'change'],
])('keeps failed %s changes and retries automatic saving', async (label, value, event) => {
  const save = vi
    .spyOn(ipc, 'saveConfig')
    .mockRejectedValueOnce({ message: '无法写入设置' })
    .mockImplementation(async (config) => config);
  const before = JSON.parse(JSON.stringify(useApplicationStore().state!.config));
  await select(3);
  await input(`[aria-label="${label}"]`, value, event);
  await vi.waitFor(() => expect(useApplicationStore().error).toBe('无法写入设置'));
  expect(useApplicationStore().state!.config).toEqual(before);
  expect(root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.value).toBe(value);
  expect(root.querySelector('[role="status"]')?.textContent).toContain('自动保存失败');
  expect(root.querySelector('[type="submit"]')).toBeNull();
  [...root.querySelectorAll<HTMLButtonElement>('.form-footer button')]
    .find((button) => button.textContent?.trim() === '重试')!
    .click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(useWorkspaceStore().settingsDirty).toBe(false));
  expect(useApplicationStore().error).toBeNull();
});

it('automatically saves a picked download directory and restores it when reopened', async () => {
  vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  const pick = vi.spyOn(filesApi, 'pick').mockResolvedValue(['D:\\Downloads']);
  await select(3);
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '选择下载目录')!
    .click();
  await vi.waitFor(() =>
    expect(useApplicationStore().state!.config.product.downloadDirectory).toBe('D:\\Downloads'),
  );
  expect(pick).toHaveBeenCalledExactlyOnceWith('folder');
  expect(await useWorkspaceStore().settingsCloseGuard!()).toBe(true);
  app.unmount();
  app = mountSettingsPanel();
  expect(root.querySelector<HTMLInputElement>('[aria-label="默认下载目录"]')!.value).toBe(
    'D:\\Downloads',
  );
});

it('queues storage edits made during a write without mutating the in-flight values', async () => {
  let finish!: () => void;
  const save = vi
    .spyOn(ipc, 'saveConfig')
    .mockImplementationOnce(
      (config) =>
        new Promise((resolve) => {
          finish = () => resolve(config);
        }),
    )
    .mockImplementation(async (config) => config);
  await select(3);
  await input('[aria-label="默认下载目录"]', 'D:\\First');
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(
    root.querySelector<HTMLInputElement>('[aria-label="默认下载目录"]')!.matches(':disabled'),
  ).toBe(false);
  await input('[aria-label="默认下载目录"]', 'D:\\Latest');
  await input('[aria-label="每主机并发传输数"]', '5');
  await input('[aria-label="日志级别"]', 'debug', 'change');
  expect(save.mock.calls[0]![0].product.downloadDirectory).toBe('D:\\First');
  expect(save.mock.calls[0]![0].transferConcurrency).toBe(3);
  finish();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(useApplicationStore().state!.config.product.downloadDirectory).toBe('D:\\Latest'),
  );
  expect(useApplicationStore().state!.config.transferConcurrency).toBe(5);
  expect(useApplicationStore().state!.config.logLevel).toBe('debug');
});

it.each(['Latest', defaultTerminalPreferences().fontFamily])(
  'keeps edits or reversions to %s during a save and writes detached snapshots in order',
  async (latest) => {
    let finish!: () => void;
    const save = vi
      .spyOn(ipc, 'saveConfig')
      .mockImplementationOnce(
        (config) =>
          new Promise((resolve) => {
            finish = () => resolve(config);
          }),
      )
      .mockImplementation(async (config) => config);
    await input('[aria-label="终端字体"]', 'First');
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(root.querySelector('#settings-panel-terminal fieldset')?.hasAttribute('disabled')).toBe(
      false,
    );
    await input('[aria-label="终端字体"]', latest);
    await input('[data-testid="theme-select"]', 'light', 'change');
    expect(save.mock.calls[0]![0].terminal.fontFamily).toBe('First');
    finish();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(useApplicationStore().state!.config.terminal.fontFamily).toBe(latest),
    );
    expect(useApplicationStore().state!.config.theme).toBe('light');
    expect(root.querySelector<HTMLInputElement>('[aria-label="终端字体"]')!.value).toBe(latest);
  },
);

it('waits for another configuration write instead of dropping pending edits', async () => {
  const application = useApplicationStore();
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  application.saving = true;
  await input('[data-testid="theme-select"]', 'light', 'change');
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(save).not.toHaveBeenCalled();
  application.state!.config = { ...application.state!.config, sidebarWidth: 330 };
  application.saving = false;
  await vi.waitFor(() => expect(application.state!.config.theme).toBe('light'));
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sidebarWidth: 330 }));
});

it('retains shortcut conflicts after a rejected save and saves a corrected combination', async () => {
  const save = vi
    .spyOn(ipc, 'saveConfig')
    .mockRejectedValueOnce({ message: '快捷键须唯一' })
    .mockImplementation(async (config) => config);
  await select(2);
  const field = root.querySelector<HTMLInputElement>('[aria-label="复制快捷键"]')!;
  field.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'KeyV', ctrlKey: true, shiftKey: true }),
  );
  await vi.waitFor(() => expect(useApplicationStore().error).toBe('快捷键须唯一'));
  expect(useApplicationStore().state!.config.terminal.shortcuts.copy).toBe('Ctrl+Shift+C');
  expect(field.value).toBe('Ctrl+Shift+V');
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(save).toHaveBeenCalledOnce();
  field.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'KeyX', ctrlKey: true, shiftKey: true }),
  );
  await vi.waitFor(() =>
    expect(useApplicationStore().state!.config.terminal.shortcuts.copy).toBe('Ctrl+Shift+X'),
  );
});

async function reviewMigration() {
  const button = root.querySelector<HTMLButtonElement>('.form-footer .primary')!;
  expect(button.textContent?.trim()).toBe('迁移并重启');
  button.click();
  await nextTick();
}

async function storageDraft() {
  useApplicationStore().state!.storage = {
    rootDirectory: 'C:\\ServerDeck',
    databasePath: 'C:\\ServerDeck\\serverdeck.sqlite3',
    pluginDirectory: 'C:\\ServerDeck\\plugins',
    logDirectory: 'C:\\ServerDeck\\logs',
    webviewDirectory: 'C:\\ServerDeck\\webview',
    notice: null,
  };
  await select(3);
  await input('[aria-label="数据根目录"]', 'D:\\ServerDeck');
}

it('formats storage and download directories without changing saved paths or scheduling migration', async () => {
  const application = useApplicationStore();
  const prefix = '\\\\?\\C:\\ServerDeck';
  application.state!.storage = {
    rootDirectory: prefix,
    databasePath: `${prefix}\\serverdeck.sqlite3`,
    pluginDirectory: `${prefix}\\plugins`,
    logDirectory: `${prefix}\\logs`,
    webviewDirectory: `${prefix}\\webview`,
    notice: null,
  };
  application.state!.config = {
    ...application.state!.config,
    product: {
      ...application.state!.config.product,
      downloadDirectory: '\\\\?\\UNC\\server\\share\\下载',
    },
  };
  const preview = vi.spyOn(ipc, 'storagePreview');
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await select(3);
  expect(root.querySelector<HTMLInputElement>('[aria-label="数据根目录"]')!.value).toBe(
    'C:\\ServerDeck',
  );
  expect([...root.querySelectorAll('.storage-paths dd')].map((item) => item.textContent)).toEqual([
    'C:\\ServerDeck\\serverdeck.sqlite3',
    'C:\\ServerDeck\\plugins',
    'C:\\ServerDeck\\logs',
    'C:\\ServerDeck\\webview',
  ]);
  expect(root.querySelector<HTMLInputElement>('[aria-label="默认下载目录"]')!.value).toBe(
    '\\\\server\\share\\下载',
  );
  expect(await useWorkspaceStore().settingsCloseGuard!()).toBe(true);
  await input('[aria-label="每主机并发传输数"]', '4');
  await vi.waitFor(() => expect(application.state!.config.transferConcurrency).toBe(4));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      product: expect.objectContaining({ downloadDirectory: '\\\\?\\UNC\\server\\share\\下载' }),
    }),
  );
  expect(application.state!.storage.rootDirectory).toBe(prefix);
  expect(preview).not.toHaveBeenCalled();
});

it('saves ordinary preferences on form submit without opening migration review', async () => {
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  const preview = vi.spyOn(ipc, 'storagePreview');
  const migrate = vi.spyOn(ipc, 'storageMigrate');
  await storageDraft();
  await input('[aria-label="日志级别"]', 'debug', 'change');
  await submit();
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(useApplicationStore().state!.config.logLevel).toBe('debug');
  expect(preview).not.toHaveBeenCalled();
  expect(migrate).not.toHaveBeenCalled();
  expect(document.querySelector('dialog')).toBeNull();
});

it('formats both migration preview paths while submitting the original target', async () => {
  await storageDraft();
  const raw = '\\\\?\\D:\\ServerDeck';
  vi.spyOn(ipc, 'storagePreview').mockResolvedValue({
    targetDirectory: raw,
    bytes: 1,
    availableBytes: 1024,
    unfinishedTasks: 0,
    dirtyDocuments: 0,
  });
  const migrate = vi.spyOn(ipc, 'storageMigrate').mockResolvedValue(true);
  await reviewMigration();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog[aria-label="迁移数据并重启"]')).not.toBeNull(),
  );
  const dialog = document.querySelector('dialog[aria-label="迁移数据并重启"]')!;
  expect(
    [...dialog.querySelectorAll('.storage-path')].map((item) => item.textContent?.trim()),
  ).toEqual(['当前目录：C:\\ServerDeck', '目标目录：D:\\ServerDeck']);
  [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '确认迁移并重启')!
    .click();
  await vi.waitFor(() => expect(migrate).toHaveBeenCalledWith(expect.anything(), raw, false));
});

it('warns for a changed data root alone without previewing or starting migration', async () => {
  const preview = vi.spyOn(ipc, 'storagePreview');
  const migrate = vi.spyOn(ipc, 'storageMigrate');
  await storageDraft();
  const closing = useWorkspaceStore().settingsCloseGuard!();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog[aria-label="设置尚未保存"]')).not.toBeNull(),
  );
  document.querySelector<HTMLButtonElement>('dialog [aria-label="关闭对话框"]')!.click();
  expect(await closing).toBe(false);
  expect(root.querySelector<HTMLInputElement>('[aria-label="数据根目录"]')!.value).toBe(
    'D:\\ServerDeck',
  );
  expect(preview).not.toHaveBeenCalled();
  expect(migrate).not.toHaveBeenCalled();
  await input('[aria-label="数据根目录"]', 'C:\\ServerDeck');
  expect(await useWorkspaceStore().settingsCloseGuard!()).toBe(true);
});

it('restores storage preferences and clears a pending directory change without migrating', async () => {
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  const preview = vi.spyOn(ipc, 'storagePreview');
  await input('[data-testid="theme-select"]', 'light', 'change');
  await storageDraft();
  const download = await input('[aria-label="默认下载目录"]', 'D:\\Downloads');
  const concurrency = await input('[aria-label="每主机并发传输数"]', '6');
  const logLevel = await input('[aria-label="日志级别"]', 'debug', 'change');

  await vi.waitFor(() => expect(useApplicationStore().state!.config.transferConcurrency).toBe(6));
  await restoreDefaults();
  expect(download.value).toBe('');
  expect(concurrency.value).toBe('3');
  expect(logLevel.value).toBe('info');
  expect(root.querySelector<HTMLInputElement>('[aria-label="数据根目录"]')!.value).toBe(
    'C:\\ServerDeck',
  );
  expect(root.querySelector('[type="submit"]')).toBeNull();
  expect(root.querySelector('.form-footer .primary')).toBeNull();
  await vi.waitFor(() => expect(useApplicationStore().state!.config.transferConcurrency).toBe(3));
  expect(preview).not.toHaveBeenCalled();
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      theme: 'light',
      transferConcurrency: 3,
      logLevel: 'info',
      product: expect.objectContaining({ downloadDirectory: null }),
    }),
  );
});

it('groups language, SSH defaults, shortcuts and storage under their corresponding categories', async () => {
  const panel = (selector: string) =>
    root.querySelector(selector)?.closest('.settings-category')?.id;
  expect(panel('[aria-label="界面语言"]')).toBe('settings-panel-general');
  expect(panel('[aria-label="全局默认代理"]')).toBe('settings-panel-terminal');
  expect(panel('[aria-label="打开设置全局快捷键"]')).toBe('settings-panel-shortcuts');
  expect(panel('[aria-label="默认下载目录"]')).toBe('settings-panel-storage');
});

it('shows storage settings without a credential maintenance section', async () => {
  await storageDraft();
  expect(
    [...root.querySelectorAll('#settings-panel-storage legend')].map(
      (legend) => legend.textContent,
    ),
  ).toEqual(['应用数据位置', '下载与传输', '传输与日志']);
});

it('previews migration without saving and cancellation preserves all drafts', async () => {
  const save = vi.spyOn(ipc, 'saveConfig');
  const migrate = vi.spyOn(ipc, 'storageMigrate');
  const preview = vi.spyOn(ipc, 'storagePreview').mockResolvedValue({
    targetDirectory: 'D:\\ServerDeck',
    bytes: 1024,
    availableBytes: 1e9,
    unfinishedTasks: 2,
    dirtyDocuments: 0,
  });
  await storageDraft();
  await select(0);
  await input('[data-testid="theme-select"]', 'light', 'change');
  await select(3);
  await reviewMigration();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  expect(preview).toHaveBeenCalledWith('D:\\ServerDeck');
  expect(save).not.toHaveBeenCalled();
  expect(migrate).not.toHaveBeenCalled();
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')]
    .find((b) => b.textContent?.trim() === '取消')!
    .click();
  await nextTick();
  expect(document.querySelector('dialog')).toBeNull();
  await select(3);
  expect(root.querySelector<HTMLInputElement>('[aria-label="数据根目录"]')!.value).toBe(
    'D:\\ServerDeck',
  );
  expect(useApplicationStore().state!.config.theme).toBe('dark');
});

it('requires explicit document discard and sends all preferences with confirmed migration', async () => {
  vi.spyOn(ipc, 'storagePreview').mockResolvedValue({
    targetDirectory: 'D:\\ServerDeck',
    bytes: 1024,
    availableBytes: 1e9,
    unfinishedTasks: 1,
    dirtyDocuments: 1,
  });
  const migrate = vi.spyOn(ipc, 'storageMigrate').mockResolvedValue(true);
  await storageDraft();
  await reviewMigration();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  const button = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
    (b) => b.textContent?.trim() === '确认迁移并重启',
  )!;
  expect(button.disabled).toBe(true);
  document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!.click();
  await nextTick();
  button.click();
  await vi.waitFor(() =>
    expect(migrate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        version: 2,
        product: expect.any(Object),
        terminal: expect.any(Object),
      }),
      'D:\\ServerDeck',
      true,
    ),
  );
});

it('retains target and preferences when migration preflight fails', async () => {
  vi.spyOn(ipc, 'storagePreview').mockRejectedValue({ message: '目标目录必须为空' });
  const migrate = vi.spyOn(ipc, 'storageMigrate');
  await storageDraft();
  await reviewMigration();
  await vi.waitFor(() => expect(useApplicationStore().error).toBe('目标目录必须为空'));
  expect(migrate).not.toHaveBeenCalled();
  expect(root.querySelector<HTMLInputElement>('[aria-label="数据根目录"]')!.value).toBe(
    'D:\\ServerDeck',
  );
  expect(document.querySelector('dialog')).toBeNull();
});

it('keeps migration visible and locked after restart is scheduled until the process exits', async () => {
  vi.spyOn(ipc, 'storagePreview').mockResolvedValue({
    targetDirectory: 'D:\\ServerDeck',
    bytes: 1024,
    availableBytes: 1e9,
    unfinishedTasks: 1,
    dirtyDocuments: 1,
  });
  let scheduleRestart!: (restarting: boolean) => void;
  const migrate = vi
    .spyOn(ipc, 'storageMigrate')
    .mockImplementation(() => new Promise((resolve) => (scheduleRestart = resolve)));
  await storageDraft();
  const application = useApplicationStore();
  application.state!.storage!.notice = '数据迁移完成，旧副本已清理。';
  application.notice = '上次迁移完成';
  await reviewMigration();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  const dialog = document.querySelector<HTMLDialogElement>('dialog')!;
  const discard = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  discard.click();
  await nextTick();
  const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === '确认迁移并重启',
  )!;
  confirm.click();
  await nextTick();
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain('正在保存设置');
  expect(discard.disabled).toBe(true);
  expect(application.notice).toBeNull();
  expect(root.querySelector('#settings-panel-storage')?.textContent).not.toContain('旧副本已清理');

  scheduleRestart(true);
  await vi.waitFor(() => expect(application.notice).toContain('正在安全结束任务并重启'));
  expect(document.querySelector('dialog')).toBe(dialog);
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain('请等待应用自动重新打开');
  expect(dialog.textContent).toContain('窗口关闭不代表迁移完成');
  expect(application.saving).toBe(true);
  expect([...dialog.querySelectorAll<HTMLButtonElement>('button')].every((b) => b.disabled)).toBe(
    true,
  );
  expect([...root.querySelectorAll('fieldset')].every((field) => field.disabled)).toBe(true);
  expect(await useWorkspaceStore().settingsCloseGuard!()).toBe(false);
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  confirm.click();
  await nextTick();
  expect(document.querySelector('dialog')).toBe(dialog);
  expect(migrate).toHaveBeenCalledOnce();
  expect(application.state!.storage!.rootDirectory).toBe('C:\\ServerDeck');
});

it('retains the migration dialog and drafts on preparation failure and allows retry', async () => {
  vi.spyOn(ipc, 'storagePreview').mockResolvedValue({
    targetDirectory: 'D:\\ServerDeck',
    bytes: 1024,
    availableBytes: 1e9,
    unfinishedTasks: 0,
    dirtyDocuments: 0,
  });
  const migrate = vi
    .spyOn(ipc, 'storageMigrate')
    .mockRejectedValueOnce({ message: '无法登记目录迁移' })
    .mockResolvedValue(true);
  await storageDraft();
  await select(0);
  await input('[data-testid="theme-select"]', 'light', 'change');
  await select(3);
  await reviewMigration();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  const dialog = document.querySelector<HTMLDialogElement>('dialog')!;
  const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === '确认迁移并重启',
  )!;
  confirm.click();
  const application = useApplicationStore();
  await vi.waitFor(() => expect(application.error).toBe('无法登记目录迁移'));
  expect(application.saving).toBe(false);
  expect(confirm.disabled).toBe(false);
  expect(dialog.querySelector('[role="status"]')).toBeNull();
  expect(root.querySelector<HTMLSelectElement>('[data-testid="theme-select"]')!.value).toBe(
    'light',
  );
  expect(root.querySelector<HTMLInputElement>('[aria-label="数据根目录"]')!.value).toBe(
    'D:\\ServerDeck',
  );
  confirm.click();
  await vi.waitFor(() => expect(migrate).toHaveBeenCalledTimes(2));
  expect(migrate).toHaveBeenLastCalledWith(
    expect.objectContaining({ theme: 'light' }),
    'D:\\ServerDeck',
    false,
  );
  await vi.waitFor(() => expect(application.saving).toBe(true));
  expect(document.querySelector('dialog')).toBe(dialog);
  expect(confirm.disabled).toBe(true);
});

it('applies saved preferences immediately when a path alias requires no restart', async () => {
  vi.spyOn(ipc, 'storagePreview').mockResolvedValue({
    targetDirectory: 'C:\\ServerDeck',
    bytes: 0,
    availableBytes: 1e9,
    unfinishedTasks: 0,
    dirtyDocuments: 0,
  });
  vi.spyOn(ipc, 'storageMigrate').mockResolvedValue(false);
  await storageDraft();
  await select(0);
  await input('[data-testid="theme-select"]', 'light', 'change');
  await select(3);
  await reviewMigration();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')]
    .find((b) => b.textContent?.trim() === '确认迁移并重启')!
    .click();
  await vi.waitFor(() => expect(useApplicationStore().state!.config.theme).toBe('light'));
  expect(useApplicationStore().notice).toContain('无需重启');
  expect(document.querySelector('dialog')).toBeNull();
  expect(useApplicationStore().saving).toBe(false);
  expect(await useWorkspaceStore().settingsCloseGuard!()).toBe(true);
});
