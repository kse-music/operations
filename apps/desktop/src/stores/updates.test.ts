import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { useUpdatesStore } from './updates';
import { useNotificationsStore } from './notifications';
import { updatesApi, type UpdateStatus } from '../services/updates';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('../services/updates', () => ({
  updatesApi: {
    status: vi.fn(),
    check: vi.fn(),
    autoCheck: vi.fn(),
    download: vi.fn(),
    cancel: vi.fn(),
    install: vi.fn(),
  },
}));
let pinia: Pinia;
const status = (phase: UpdateStatus['phase'] = 'idle'): UpdateStatus => ({
  supported: true,
  phase,
  release:
    phase === 'idle' || phase === 'upToDate' ? null : { version: '1.0.0', notes: '修复连接' },
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
  preferences: { version: 1, autoCheck: true, lastAttemptAt: null, lastCheckedAt: null },
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  vi.mocked(updatesApi.status).mockResolvedValue(status());
  vi.mocked(updatesApi.check).mockResolvedValue(status('upToDate'));
});
afterEach(() => {
  disposePinia(pinia);
  vi.useRealTimers();
});

it('checks after startup without blocking initialization and starts only once', async () => {
  const store = useUpdatesStore();
  await store.initialize();
  await store.initialize();
  expect(updatesApi.status).toHaveBeenCalledTimes(1);
  expect(updatesApi.check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(updatesApi.check).toHaveBeenCalledExactlyOnceWith(true);
});
it('disabling auto checks cancels the scheduled startup check and stores the returned preference', async () => {
  const store = useUpdatesStore();
  await store.initialize();
  const disabled = status();
  disabled.preferences.autoCheck = false;
  vi.mocked(updatesApi.autoCheck).mockResolvedValue(disabled);
  await store.setAutoCheck(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(updatesApi.check).not.toHaveBeenCalled();
  expect(store.state?.preferences.autoCheck).toBe(false);
});
it('automatic check failure never reports the app as current and manual failures notify', async () => {
  const store = useUpdatesStore();
  vi.mocked(updatesApi.check).mockRejectedValue({ code: 'UPDATE_CHECK', message: '检查失败' });
  await store.check(true);
  expect(store.state).toBeNull();
  expect(store.error).toBe('检查失败');
  expect(useNotificationsStore().items).toHaveLength(0);
  await store.check(false);
  expect(useNotificationsStore().items).toHaveLength(1);
});

it('retains a backend update failure when the webview reloads', async () => {
  const failed = { ...status('error'), error: '检查失败' };
  vi.mocked(updatesApi.status).mockResolvedValue(failed);
  const store = useUpdatesStore();
  await store.initialize();
  expect(store.error).toBe('检查失败');
  expect(store.state?.phase).toBe('error');
});
it('only verified downloads permit requesting installation and installation requires confirmation', async () => {
  const store = useUpdatesStore();
  store.state = status('available');
  store.requestInstall();
  expect(store.installRequested).toBe(false);
  await expect(store.install()).rejects.toThrow();
  expect(updatesApi.install).not.toHaveBeenCalled();
  vi.mocked(updatesApi.download).mockImplementation(async (receive) => {
    receive({ downloadedBytes: 100, totalBytes: 100 });
    expect(store.state?.phase).toBe('available');
    expect(store.installRequested).toBe(false);
    return { ...status('ready'), downloadedBytes: 100, totalBytes: 100 };
  });
  await store.download();
  expect(store.state?.phase).toBe('ready');
  expect(updatesApi.install).not.toHaveBeenCalled();
  store.requestInstall();
  vi.mocked(updatesApi.install).mockResolvedValue();
  await store.install();
  expect(updatesApi.install).toHaveBeenCalledOnce();
});
it('failed signature validation keeps installation unavailable and allows retry', async () => {
  const store = useUpdatesStore();
  store.state = status('available');
  vi.mocked(updatesApi.download).mockRejectedValue({
    code: 'UPDATE_DOWNLOAD',
    message: '签名验证失败',
  });
  await store.download();
  store.requestInstall();
  expect(store.installRequested).toBe(false);
  expect(store.downloading).toBe(false);
  expect(store.error).toBe('签名验证失败');
});
it('explicit cancellation keeps the release retryable without an error notification', async () => {
  const store = useUpdatesStore();
  store.state = status('available');
  vi.mocked(updatesApi.download).mockRejectedValue({ code: 'UPDATE_CANCELLED', message: '已取消' });
  await store.download();
  expect(store.available).toBe(true);
  expect(store.error).toBeNull();
  expect(useNotificationsStore().items).toHaveLength(0);
});
