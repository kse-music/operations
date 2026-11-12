import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import AppHeader from './AppHeader.vue';
let app: App, root: HTMLDivElement;
let pinia: Pinia;
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
});
it('keeps the brand and global search without sidebar controls or a duplicate application menu', () => {
  const search = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  pinia = createPinia();
  app = createApp(AppHeader, {
    searchShortcut: 'Ctrl+J',
    onSearch: search,
  }).use(pinia);
  app.mount(root);
  expect(root.querySelector('.module-navigation')).toBeNull();
  expect(root.querySelector('details, [aria-label="应用菜单"]')).toBeNull();
  expect(root.querySelectorAll('button')).toHaveLength(1);
  expect(
    root.querySelector('[aria-controls="host-sidebar"], [aria-controls="host-tree-panel"]'),
  ).toBeNull();
  expect(root.querySelector('.app-brand')?.textContent).toBe('ServerDeck');
  root.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click();
  expect(search).toHaveBeenCalledOnce();
  expect(root.querySelector('kbd')?.textContent).toBe('Ctrl+J');
});
