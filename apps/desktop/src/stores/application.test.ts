import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { useApplicationStore } from './application';
import { useNotificationsStore } from './notifications';
import * as ipc from '../services/ipc';
import type { Bootstrap, StorageReady } from '../types/ipc';
import { defaultProductPreferences } from '../types/product';
import { defaultTerminalPreferences } from '../types/preferences';

let pinia: Pinia;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => disposePinia(pinia));

const bootstrap = (): Bootstrap => ({
  appVersion: 'test',
  databaseVersion: 10,
  dataDirectory: 'D:\\Data',
  logDirectory: 'D:\\Data\\logs',
  config: {
    version: 5,
    theme: 'dark',
    interfaceFontSize: 100,
    sidebarWidth: 248,
    terminalFontSize: 14,
    connectTimeoutSecs: 15,
    monitorIntervalSecs: 3,
    transferConcurrency: 2,
    logLevel: 'info',
    terminal: defaultTerminalPreferences(),
    product: defaultProductPreferences(),
  },
  storage: {
    rootDirectory: 'D:\\Data',
    databasePath: 'D:\\Data\\serverdeck.sqlite3',
    pluginDirectory: 'D:\\Data\\plugins',
    logDirectory: 'D:\\Data\\logs',
    webviewDirectory: 'D:\\Data\\webview',
    notice: null,
  },
});

it('keeps the candidate unavailable until storage commit acknowledges startup', async () => {
  const value = bootstrap();
  vi.spyOn(ipc, 'bootstrap').mockResolvedValue(value);
  let finish!: (value: StorageReady) => void;
  vi.spyOn(ipc, 'storageReady').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const application = useApplicationStore();
  const pending = application.initialize();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(application.ready).toBe(false);
  finish({ storage: value.storage!, startupNotice: null });
  await pending;
  expect(application.ready).toBe(true);
  expect(application.state?.storage).toEqual(value.storage);
});

it('exposes a startup error instead of enabling an uncommitted candidate', async () => {
  vi.spyOn(ipc, 'bootstrap').mockResolvedValue(bootstrap());
  vi.spyOn(ipc, 'storageReady').mockRejectedValue({ message: '无法提交存储目录' });
  const application = useApplicationStore();
  await application.initialize();
  expect(application.ready).toBe(false);
  expect(application.error).toBe('无法提交存储目录');
});

it('keeps a previous migration warning in settings without replaying it', async () => {
  const value = bootstrap();
  value.storage!.notice = '数据迁移未完成：目标目录必须为空。继续使用旧目录，旧数据未删除。';
  vi.spyOn(ipc, 'bootstrap').mockImplementation(async () => structuredClone(value));
  vi.spyOn(ipc, 'storageReady').mockResolvedValue({ storage: value.storage!, startupNotice: null });
  const application = useApplicationStore();
  const notifications = useNotificationsStore();
  await application.initialize();
  expect(application.ready).toBe(true);
  expect(notifications.items).toHaveLength(0);
  expect(application.state?.storage?.notice).toBe(value.storage!.notice);
  await application.initialize();
  expect(notifications.items).toHaveLength(0);
  expect(application.state?.storage?.notice).toBe(value.storage!.notice);
});

it('notifies once on successful cleanup and removes the previous warning from settings', async () => {
  const value = bootstrap();
  const storage = { ...value.storage! };
  value.storage!.notice = '新目录已启用，旧副本清理未完成：旧目录文件已变化。下次启动重试。';
  vi.spyOn(ipc, 'bootstrap').mockImplementation(async () => structuredClone(value));
  const startupNotice = '数据迁移完成，旧副本已清理。';
  vi.spyOn(ipc, 'storageReady')
    .mockResolvedValueOnce({ storage, startupNotice })
    .mockResolvedValue({ storage, startupNotice: null });
  const application = useApplicationStore();
  const notifications = useNotificationsStore();
  await application.initialize();
  expect(notifications.items).toEqual([
    { id: expect.any(Number), text: startupNotice, error: false },
  ]);
  expect(application.state?.storage?.notice).toBeNull();
  notifications.dismiss(notifications.items[0]!.id);
  value.storage!.notice = null;
  await application.initialize();
  expect(notifications.items).toHaveLength(0);
  expect(application.state?.storage?.notice).toBeNull();
});

it.each([
  '新目录上次未完成启动，已恢复旧目录；目标副本保留，请检查后重新选择空目录。',
  '新目录已启用，旧副本清理未完成：旧目录文件已变化。下次启动重试。',
])('still reports current startup warnings: %s', async (notice) => {
  const value = bootstrap();
  vi.spyOn(ipc, 'bootstrap').mockResolvedValue(value);
  vi.spyOn(ipc, 'storageReady').mockResolvedValue({
    storage: { ...value.storage!, notice },
    startupNotice: notice,
  });
  const application = useApplicationStore();
  await application.initialize();
  expect(useNotificationsStore().items).toEqual([expect.objectContaining({ text: notice })]);
  expect(application.state?.storage?.notice).toBe(notice);
});
