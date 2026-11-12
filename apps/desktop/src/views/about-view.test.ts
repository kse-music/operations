import { expect, it } from 'vitest';
import { createApp } from 'vue';
import { createPinia, disposePinia } from 'pinia';
import AboutView from './AboutView.vue';
import { useApplicationStore } from '../stores/application';
import type { Bootstrap } from '../types/ipc';
import { defaultProductPreferences } from '../types/product';

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
