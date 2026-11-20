import { expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia, disposePinia } from 'pinia';
import AboutView from './AboutView.vue';
import { useApplicationStore } from '../stores/application';
import type { Bootstrap } from '../types/ipc';
import { defaultProductPreferences } from '../types/product';
import { useUpdatesStore } from '../stores/updates';
import * as ipc from '../services/ipc';

it('shows ordinary data and log paths without changing backend state', () => {
  const pinia = createPinia();
  const application = useApplicationStore(pinia);
  application.state = {
    appVersion: 'test',
    databaseVersion: 11,
    dataDirectory: '\\\\?\\C:\\ServerDeck',
    logDirectory: '\\\\?\\UNC\\server\\share\\logs',
    config: { product: defaultProductPreferences() },
  } as Bootstrap;
  const root = document.createElement('div');
  const app = createApp(AboutView).use(pinia);
  try {
    app.mount(root);
    expect([...root.querySelectorAll('.path')].map((item) => item.textContent)).toEqual([
      'C:\\ServerDeck',
      '\\\\server\\share\\logs',
    ]);
    expect(application.state.dataDirectory).toBe('\\\\?\\C:\\ServerDeck');
    expect(application.state.logDirectory).toBe('\\\\?\\UNC\\server\\share\\logs');
  } finally {
    app.unmount();
    disposePinia(pinia);
  }
});

it('retries only a failed environment read and hides the action during and after recovery', async () => {
  const pinia = createPinia();
  const application = useApplicationStore(pinia);
  const root = document.createElement('div');
  const app = createApp(AboutView).use(pinia);
  let finish!: (state: Bootstrap) => void;
  const read = vi
    .spyOn(ipc, 'bootstrap')
    .mockRejectedValueOnce(new Error('本地数据库读取失败'))
    .mockReturnValueOnce(
      new Promise<Bootstrap>((resolve) => {
        finish = resolve;
      }),
    );
  try {
    app.mount(root);
    const environment = root.querySelector('[aria-labelledby="system-title"]')!;
    const retry = () => environment.querySelector('button');
    application.reportUnexpectedError();
    await nextTick();
    expect(retry()).toBeNull();
    await application.initialize();
    await nextTick();
    expect(environment.querySelector('[role=alert]')?.textContent).toBe('本地数据库读取失败');
    expect(retry()?.textContent).toBe('重试');
    retry()!.click();
    await nextTick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(environment.querySelector('[role=status]')?.textContent).toContain('正在通过 IPC 读取');
    expect(retry()).toBeNull();
    finish({
      appVersion: 'test',
      databaseVersion: 11,
      dataDirectory: '/data',
      logDirectory: '/data/logs',
      config: { product: defaultProductPreferences() },
    } as Bootstrap);
    await vi.waitFor(() => expect(environment.textContent).toContain('schema v11'));
    expect(environment.querySelector('[role=alert]')).toBeNull();
    expect(retry()).toBeNull();
  } finally {
    app.unmount();
    disposePinia(pinia);
    read.mockRestore();
  }
});

it('renders release Markdown and gates installation on a verified package', async () => {
  const pinia = createPinia();
  useApplicationStore(pinia).state = {
    appVersion: '0.8.0',
    config: { product: defaultProductPreferences() },
  } as Bootstrap;
  const updates = useUpdatesStore(pinia);
  updates.state = {
    supported: true,
    phase: 'available',
    release: {
      version: '0.8.1',
      notes:
        '**Full Changelog**: https://github.com/kse-music/operations/compare/v0.9.2...v0.9.3\n\n<img src="https://untrusted.invalid/image">',
    },
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
    showNotice: false,
    preferences: { version: 1, autoCheck: true, lastAttemptAt: null, lastCheckedAt: null },
  };
  const root = document.createElement('div');
  const app = createApp(AboutView).use(pinia);
  try {
    app.mount(root);
    const changelog = root.querySelector('.update-notes a');
    expect(changelog?.textContent).toBe('完整更新日志');
    expect(changelog?.getAttribute('href')).toBe(
      'https://github.com/kse-music/operations/compare/v0.9.2...v0.9.3',
    );
    expect(root.querySelector('.update-notes')?.textContent).toContain('<img');
    expect(root.querySelector('.update-notes img')).toBeNull();
    expect(root.textContent).toContain('下载更新');
    expect(root.textContent).not.toContain('安装并重启');
    updates.state.phase = 'ready';
    await nextTick();
    expect(root.textContent).toContain('安装并重启');
    expect(
      [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '检查更新',
      )?.disabled,
    ).toBe(true);
    updates.state.release!.notes = '';
    await nextTick();
    expect(root.querySelector('.update-notes')?.textContent).toBe('此版本未提供更新说明。\n');
  } finally {
    app.unmount();
    disposePinia(pinia);
  }
});
