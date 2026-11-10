import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import SettingsPanel from './SettingsPanel.vue';
import { useApplicationStore } from '../stores/application';
import { useWorkspaceStore } from '../stores/workspace';
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

async function restoreDefaults() {
  const button = root.querySelector<HTMLButtonElement>('.form-footer button[type="button"]')!;
  expect(button.textContent?.trim()).toBe('恢复默认');
  expect(button.nextElementSibling).toBe(root.querySelector('.form-footer [type="submit"]'));
  button.click();
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
  expect(await useWorkspaceStore().settingsCloseGuard!()).toBe(true);
  expect(document.querySelector('dialog')).toBeNull();
});

it('allows closing unchanged, reverted and externally updated settings without a prompt', async () => {
  const workspace = useWorkspaceStore();
  expect(await workspace.settingsCloseGuard!()).toBe(true);
  await input('[data-testid="theme-select"]', 'light', 'change');
  await input('[data-testid="theme-select"]', 'dark', 'change');
  expect(await workspace.settingsCloseGuard!()).toBe(true);
  const application = useApplicationStore();
  application.state!.config = { ...application.state!.config, sidebarWidth: 300 };
  await nextTick();
  expect(await workspace.settingsCloseGuard!()).toBe(true);
  expect(document.querySelector('dialog')).toBeNull();
});

it.each(['cancel', 'close'])('keeps one close prompt and preserves edits on %s', async (action) => {
  const workspace = useWorkspaceStore();
  await restoreDefaults();
  const closing = workspace.settingsCloseGuard!();
  const repeated = workspace.settingsCloseGuard!();
  await nextTick();
  expect(document.querySelectorAll('dialog[aria-label="设置尚未保存"]')).toHaveLength(1);
  const dialog = document.querySelector<HTMLDialogElement>('dialog')!;
  if (action === 'cancel') dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  else dialog.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  expect(await closing).toBe(false);
  expect(await repeated).toBe(false);
  await nextTick();
  expect(document.querySelector('dialog')).toBeNull();
  expect(root.querySelector<HTMLInputElement>('[aria-label="侧边栏宽度"]')!.value).toBe('248');
  expect(useApplicationStore().state!.config.sidebarWidth).toBe(260);
});

it('restores general, terminal and shortcut defaults independently in the shared draft', async () => {
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  const theme = await input('[data-testid="theme-select"]', 'light', 'change');
  const width = await input('[aria-label="侧边栏宽度"]', '320');
  const interfaceSize = await input('#interface-font-size', '4');
  const font = await input('[aria-label="终端字体"]', 'Consolas');
  const proxy = await input('[aria-label="全局默认代理"]', 'socks5', 'change');
  const download = await input('[aria-label="默认下载目录"]', 'D:\\Downloads');
  await select(2);
  const copy = root.querySelector<HTMLInputElement>('[aria-label="复制快捷键"]')!;
  const openSettings = root.querySelector<HTMLInputElement>('[aria-label="打开设置全局快捷键"]')!;
  copy.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', ctrlKey: true, shiftKey: true }));
  openSettings.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }));

  await select(0);
  await restoreDefaults();
  expect(theme.value).toBe('dark');
  expect(width.value).toBe('248');
  expect(interfaceSize.getAttribute('aria-valuetext')).toBe('标准');
  expect(font.value).toBe('Consolas');
  expect(proxy.value).toBe('socks5');

  await select(1);
  await restoreDefaults();
  expect(font.value).toBe(defaultTerminalPreferences().fontFamily);
  expect(proxy.value).toBe('direct');
  expect(copy.value).toBe('Ctrl+Shift+X');
  expect(openSettings.value).toBe('Ctrl+J');

  await input('[aria-label="终端字体"]', 'Consolas');
  await select(2);
  const resetButtons = [
    ...root.querySelectorAll('#settings-panel-shortcuts button, .form-footer button'),
  ].filter((button) => button.textContent?.trim().startsWith('恢复默认'));
  expect(resetButtons).toHaveLength(1);
  await restoreDefaults();
  expect(copy.value).toBe('Ctrl+Shift+C');
  expect(openSettings.value).toBe('Ctrl+,');
  expect(font.value).toBe('Consolas');
  expect(download.value).toBe('D:\\Downloads');
  expect(useApplicationStore().state!.config.sidebarWidth).toBe(260);
  expect(save).not.toHaveBeenCalled();

  await submit();
  expect(save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      theme: 'dark',
      interfaceFontSize: 'standard',
      sidebarWidth: 248,
      monitorIntervalSecs: 5,
      connectTimeoutSecs: 15,
      terminal: { ...defaultTerminalPreferences(), fontFamily: 'Consolas' },
      product: { ...defaultProductPreferences(), downloadDirectory: 'D:\\Downloads' },
    }),
  );
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
  expect(await useWorkspaceStore().settingsCloseGuard!()).toBe(false);
  expect(document.querySelector('dialog')).toBeNull();
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
  const closing = useWorkspaceStore().settingsCloseGuard!();
  await nextTick();
  expect(document.querySelector('dialog[aria-label="设置尚未保存"]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('dialog [aria-label="关闭对话框"]')!.click();
  expect(await closing).toBe(false);
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

it('warns for a changed data root alone without previewing or starting migration', async () => {
  const preview = vi.spyOn(ipc, 'storagePreview');
  const migrate = vi.spyOn(ipc, 'storageMigrate');
  await storageDraft();
  const closing = useWorkspaceStore().settingsCloseGuard!();
  await nextTick();
  expect(document.querySelector('dialog[aria-label="设置尚未保存"]')).not.toBeNull();
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

  await restoreDefaults();
  expect(download.value).toBe('');
  expect(concurrency.value).toBe('3');
  expect(logLevel.value).toBe('info');
  expect(root.querySelector<HTMLInputElement>('[aria-label="数据根目录"]')!.value).toBe(
    'C:\\ServerDeck',
  );
  expect(root.querySelector('[type="submit"]')?.textContent?.trim()).toBe('保存设置');
  expect(save).not.toHaveBeenCalled();
  await submit();
  expect(preview).not.toHaveBeenCalled();
  expect(save).toHaveBeenCalledExactlyOnceWith(
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
  await submit();
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
  await submit();
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
  await submit();
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
  await submit();
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
