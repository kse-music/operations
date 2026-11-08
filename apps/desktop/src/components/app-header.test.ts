import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import AppHeader from './AppHeader.vue';
let app: App, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
});
it('keeps global search and sidebar visibility without a duplicate application menu', () => {
  const sidebar = vi.fn(),
    search = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(AppHeader, {
    sidebarOpen: true,
    searchShortcut: 'Ctrl+J',
    onSidebar: sidebar,
    onSearch: search,
  });
  app.mount(root);
  expect(root.querySelector('.module-navigation')).toBeNull();
  expect(root.querySelector('details, [aria-label="应用菜单"]')).toBeNull();
  expect(root.querySelectorAll('button')).toHaveLength(2);
  root.querySelector<HTMLButtonElement>('[aria-label="收起主机栏"]')!.click();
  root.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click();
  expect(sidebar).toHaveBeenCalledOnce();
  expect(search).toHaveBeenCalledOnce();
  expect(root.querySelector('kbd')?.textContent).toBe('Ctrl+J');
});
