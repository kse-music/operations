import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import SettingsPanel from './SettingsPanel.vue';
import { useApplicationStore } from '../stores/application';
import * as ipc from '../services/ipc';
import {
  defaultProductPreferences,
  settingsCategories,
  type SettingsCategory,
} from '../types/product';
import { defaultTerminalPreferences } from '../types/preferences';

let app: App, pinia: Pinia, root: HTMLDivElement;
const category = ref<SettingsCategory>('general');
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
    databaseVersion: 5,
    dataDirectory: '',
    logDirectory: '',
    config: {
      version: 1,
      theme: 'dark',
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
  app = createApp({
    render: () =>
      h(SettingsPanel, {
        category: category.value,
        onCategory: (value) => {
          category.value = value;
        },
      }),
  }).use(pinia);
  app.mount(root);
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

it('shows the selected menu category and saves drafts from all four categories together', async () => {
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  expect(root.querySelector('[role="tablist"]')).toBeNull();
  for (let index = 0; index < settingsCategories.length; index++) {
    await select(index);
    expect(visiblePanels()).toHaveLength(1);
    expect(root.querySelector('h1')?.textContent).toBe(settingsCategories[index]!.label);
    expect(visiblePanels()[0]!.id).toBe(`settings-panel-${settingsCategories[index]!.id}`);
  }
  await input('[aria-label="默认下载目录"]', 'D:\\Downloads');
  await select(2);
  root
    .querySelector('[aria-label="复制快捷键"]')!
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', ctrlKey: true, shiftKey: true }),
    );
  await select(1);
  await input('[aria-label="终端字体"]', 'Consolas');
  await select(0);
  await input('[data-testid="theme-select"]', 'light', 'change');
  expect(useApplicationStore().state?.config.theme).toBe('dark');
  await select(1);
  expect(root.querySelector<HTMLInputElement>('[aria-label="终端字体"]')!.value).toBe('Consolas');
  expect(save).not.toHaveBeenCalled();
  await submit();
  await vi.waitFor(() => expect(useApplicationStore().saving).toBe(false));
  expect(save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      theme: 'light',
      terminal: expect.objectContaining({
        fontFamily: 'Consolas',
        shortcuts: expect.objectContaining({ copy: 'Ctrl+Shift+X' }),
      }),
      product: expect.objectContaining({ downloadDirectory: 'D:\\Downloads' }),
    }),
  );
  expect(useApplicationStore().notice).toContain('设置已保存');
});

it('keeps quick copy and paste off by default and saves it only after enabling and submitting', async () => {
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await select(1);
  const checkbox = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (input) => input.parentElement?.textContent?.includes('选中即复制，右键即粘贴'),
  )!;
  expect(checkbox.checked).toBe(false);
  checkbox.click();
  await nextTick();
  await select(0);
  expect(useApplicationStore().state?.config.terminal.quickCopyPaste).toBe(false);
  expect(save).not.toHaveBeenCalled();
  await submit();
  await vi.waitFor(() => expect(useApplicationStore().saving).toBe(false));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ terminal: expect.objectContaining({ quickCopyPaste: true }) }),
  );
  expect(useApplicationStore().state?.config.terminal.quickCopyPaste).toBe(true);
});

it('requests the menu containing an invalid field before reporting validity', async () => {
  const save = vi.spyOn(ipc, 'saveConfig');
  await select(1);
  const invalid = await input('[aria-label="终端行高"]', '99');
  const report = vi.spyOn(invalid, 'reportValidity');
  await select(0);
  await submit();
  expect(category.value).toBe('terminal');
  expect(visiblePanels()[0]!.contains(invalid)).toBe(true);
  expect(document.activeElement).toBe(invalid);
  expect(report).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

it('validates conditional proxy fields even after switching to another tab', async () => {
  const save = vi.spyOn(ipc, 'saveConfig');
  await select(1);
  await input('[aria-label="全局默认代理"]', 'socks5', 'change');
  const invalid = await input('[aria-label="默认代理地址"]', '');
  await select(2);
  await submit();
  expect(visiblePanels()[0]!.id).toBe('settings-panel-terminal');
  expect(document.activeElement).toBe(invalid);
  expect(save).not.toHaveBeenCalled();
});

it('disables every category during saving and retains edits after a failed save', async () => {
  let rejectSave: (error: Error) => void;
  vi.spyOn(ipc, 'saveConfig').mockImplementation(
    () => new Promise((_resolve, reject) => (rejectSave = reject)),
  );
  await input('[data-testid="theme-select"]', 'light', 'change');
  await submit();
  expect([...root.querySelectorAll('fieldset')].every((field) => field.disabled)).toBe(true);
  expect(root.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  await select(3);
  expect(visiblePanels()[0]!.querySelector('fieldset')!.disabled).toBe(true);
  rejectSave!(new Error('保存失败，请重试'));
  await vi.waitFor(() => expect(useApplicationStore().saving).toBe(false));
  await select(0);
  expect(root.querySelector<HTMLSelectElement>('[data-testid="theme-select"]')!.value).toBe(
    'light',
  );
  expect(useApplicationStore().error).toBe('保存失败，请重试');
  expect(useApplicationStore().notice).toBeNull();
  expect(root.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false);
});

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

it('groups language, SSH defaults, shortcuts and storage under their corresponding categories', async () => {
  const panel = (selector: string) =>
    root.querySelector(selector)?.closest('.settings-category')?.id;
  expect(panel('[aria-label="界面语言"]')).toBe('settings-panel-general');
  expect(panel('[aria-label="全局默认代理"]')).toBe('settings-panel-terminal');
  expect(panel('[aria-label="打开设置全局快捷键"]')).toBe('settings-panel-shortcuts');
  expect(panel('[aria-label="默认下载目录"]')).toBe('settings-panel-storage');
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
  await submit();
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
  await submit();
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
        version: 1,
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
  await submit();
  await vi.waitFor(() => expect(useApplicationStore().error).toBe('目标目录必须为空'));
  expect(migrate).not.toHaveBeenCalled();
  expect(root.querySelector<HTMLInputElement>('[aria-label="数据根目录"]')!.value).toBe(
    'D:\\ServerDeck',
  );
  expect(document.querySelector('dialog')).toBeNull();
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
  await submit();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')]
    .find((b) => b.textContent?.trim() === '确认迁移并重启')!
    .click();
  await vi.waitFor(() => expect(useApplicationStore().state!.config.theme).toBe('light'));
  expect(useApplicationStore().notice).toContain('无需重启');
});
