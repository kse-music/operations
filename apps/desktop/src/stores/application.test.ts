import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { useApplicationStore } from './application';
import * as ipc from '../services/ipc';
import type { Bootstrap } from '../types/ipc';
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
    version: 2,
    theme: 'dark',
    interfaceFontSize: 'standard',
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
  let finish!: (value: NonNullable<Bootstrap['storage']>) => void;
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
  finish({ ...value.storage!, notice: '数据迁移完成，旧副本已清理。' });
  await pending;
  expect(application.ready).toBe(true);
  expect(application.notice).toContain('旧副本已清理');
});

it('exposes a startup error instead of enabling an uncommitted candidate', async () => {
  vi.spyOn(ipc, 'bootstrap').mockResolvedValue(bootstrap());
  vi.spyOn(ipc, 'storageReady').mockRejectedValue({ message: '无法提交存储目录' });
  const application = useApplicationStore();
  await application.initialize();
  expect(application.ready).toBe(false);
  expect(application.error).toBe('无法提交存储目录');
});

it('keeps migration history in settings without replaying a startup notification', async () => {
  const value = bootstrap();
  value.storage!.notice = '数据迁移完成，旧副本已清理。';
  vi.spyOn(ipc, 'bootstrap').mockImplementation(async () => structuredClone(value));
  vi.spyOn(ipc, 'storageReady').mockResolvedValue({ ...value.storage!, notice: null });
  const application = useApplicationStore();
  application.notice = '上次提示';
  await application.initialize();
  expect(application.ready).toBe(true);
  expect(application.notice).toBeNull();
  expect(application.state?.storage?.notice).toBe(value.storage!.notice);
  await application.initialize();
  expect(application.notice).toBeNull();
  expect(application.state?.storage?.notice).toBe(value.storage!.notice);
});

it('shows a current migration result once while retaining its history on reinitialize', async () => {
  const value = bootstrap();
  vi.spyOn(ipc, 'bootstrap').mockImplementation(async () => structuredClone(value));
  const notice = '数据迁移完成，旧副本已清理。';
  vi.spyOn(ipc, 'storageReady')
    .mockResolvedValueOnce({ ...value.storage!, notice })
    .mockResolvedValue({ ...value.storage!, notice: null });
  const application = useApplicationStore();
  await application.initialize();
  expect(application.notice).toBe(notice);
  value.storage!.notice = notice;
  await application.initialize();
  expect(application.notice).toBeNull();
  expect(application.state?.storage?.notice).toBe(notice);
});

it.each([
  '新目录上次未完成启动，已恢复旧目录；目标副本保留，请检查后重新选择空目录。',
  '新目录已启用，旧副本清理未完成：旧目录文件已变化。下次启动重试。',
])('still reports current startup warnings: %s', async (notice) => {
  const value = bootstrap();
  vi.spyOn(ipc, 'bootstrap').mockResolvedValue(value);
  value.storage!.notice = notice;
  vi.spyOn(ipc, 'storageReady').mockResolvedValue({ ...value.storage!, notice });
  const application = useApplicationStore();
  await application.initialize();
  expect(application.notice).toBe(notice);
  expect(application.state?.storage?.notice).toBe(notice);
});
