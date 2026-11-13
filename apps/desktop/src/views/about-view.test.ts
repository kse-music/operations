import { expect, it } from 'vitest';
import { createApp } from 'vue';
import { createPinia, disposePinia } from 'pinia';
import AboutView from './AboutView.vue';
import { useApplicationStore } from '../stores/application';
import type { Bootstrap } from '../types/ipc';
import { defaultProductPreferences } from '../types/product';
import { useUpdatesStore } from '../stores/updates';

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

it('renders release notes as text and gates installation on a verified package', async () => {
  const pinia = createPinia();
  useApplicationStore(pinia).state = {
    appVersion: '0.8.0',
    config: { product: defaultProductPreferences() },
  } as Bootstrap;
  const updates = useUpdatesStore(pinia);
  updates.state = {
    supported: true,
    phase: 'available',
    release: { version: '0.8.1', notes: '<img src="https://untrusted.invalid/image">' },
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
    preferences: { version: 1, autoCheck: true, lastAttemptAt: null, lastCheckedAt: null },
  };
  const root = document.createElement('div');
  const app = createApp(AboutView).use(pinia);
  try {
    app.mount(root);
    expect(root.querySelector('.update-notes')?.textContent).toContain('<img');
    expect(root.querySelector('.update-notes img')).toBeNull();
    expect(root.textContent).toContain('下载更新');
    expect(root.textContent).not.toContain('安装并重启');
    updates.state.phase = 'ready';
    const { nextTick } = await import('vue');
    await nextTick();
    expect(root.textContent).toContain('安装并重启');
    expect(
      [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '检查更新',
      )?.disabled,
    ).toBe(true);
  } finally {
    app.unmount();
    disposePinia(pinia);
  }
});
