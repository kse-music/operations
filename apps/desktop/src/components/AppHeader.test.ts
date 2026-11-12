import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';
import AppHeader from './AppHeader.vue';
import { useNotificationsStore } from '../stores/notifications';

const native = vi.hoisted(() => ({
  available: true,
  maximized: false,
  isMaximized: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  onResized: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.available }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn(() => native) }));
let app: App | undefined, pinia: Pinia, root: HTMLDivElement;
let resized: (() => void) | undefined;
const search = vi.fn();
const button = (label: string) => root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
function renderHeader() {
  app = createApp(AppHeader, {
    searchShortcut: 'Ctrl+K',
    onSearch: search,
  }).use(pinia);
  app.mount(root);
}
async function mount() {
  renderHeader();
  if (native.available) await vi.waitFor(() => expect(native.isMaximized).toHaveBeenCalledOnce());
  await nextTick();
}
beforeEach(() => {
  vi.clearAllMocks();
  native.available = true;
  native.maximized = false;
  native.isMaximized.mockImplementation(async () => native.maximized);
  native.minimize.mockResolvedValue(undefined);
  native.close.mockResolvedValue(undefined);
  native.toggleMaximize.mockImplementation(async () => {
    native.maximized = !native.maximized;
  });
  native.onResized.mockImplementation(async (callback: () => void) => {
    resized = callback;
    return native.release;
  });
  pinia = createPinia();
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  disposePinia(pinia);
  root.remove();
  setLocale('zh-CN');
});

it('keeps search independent of native window actions', async () => {
  await mount();
  button('全局搜索')
    .querySelector('svg')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(search).toHaveBeenCalledOnce();
  expect(native.minimize).not.toHaveBeenCalled();
  expect(native.toggleMaximize).not.toHaveBeenCalled();
  expect(native.close).not.toHaveBeenCalled();
  button('最小化窗口').click();
  button('关闭窗口').click();
  await nextTick();
  expect(native.minimize).toHaveBeenCalledOnce();
  expect(native.close).toHaveBeenCalledOnce();
});

it('shows restore for an initially maximized window and follows native resize changes', async () => {
  native.maximized = true;
  await mount();
  button('还原窗口').click();
  await vi.waitFor(() => expect(button('最大化窗口')).not.toBeNull());
  expect(native.toggleMaximize).toHaveBeenCalledOnce();
  native.maximized = true;
  resized!();
  await vi.waitFor(() => expect(button('还原窗口')).not.toBeNull());
  setLocale('en-US');
  await nextTick();
  expect(button('Restore window')).not.toBeNull();
  expect(button('Close window')).not.toBeNull();
  app!.unmount();
  app = undefined;
  expect(native.release).toHaveBeenCalledOnce();
});

it('reports failed window actions and allows retry without changing state', async () => {
  await mount();
  native.toggleMaximize.mockRejectedValueOnce(new Error('window unavailable'));
  button('最大化窗口').click();
  await vi.waitFor(() => expect(useNotificationsStore(pinia).items).toHaveLength(1));
  expect(useNotificationsStore(pinia).items[0]).toMatchObject({
    text: '窗口操作失败：window unavailable',
    error: true,
  });
  expect(button('最大化窗口')).not.toBeNull();
  button('最大化窗口').click();
  await vi.waitFor(() => expect(button('还原窗口')).not.toBeNull());
});

it('reports subscription failure while still reading the initial native state', async () => {
  native.maximized = true;
  native.onResized.mockRejectedValueOnce(new Error('listen failed'));
  await mount();
  expect(button('还原窗口')).not.toBeNull();
  expect(useNotificationsStore(pinia).items[0]?.text).toBe('窗口操作失败：listen failed');
});

it('releases a subscription that completes after unmount', async () => {
  let finish: ((release: () => void) => void) | undefined;
  native.onResized.mockImplementationOnce(
    () => new Promise<() => void>((resolve) => (finish = resolve)),
  );
  renderHeader();
  app!.unmount();
  app = undefined;
  finish!(native.release);
  await vi.waitFor(() => expect(native.release).toHaveBeenCalledOnce());
  expect(native.isMaximized).not.toHaveBeenCalled();
});

it('keeps browser preview usable without accessing native windows', async () => {
  native.available = false;
  await mount();
  expect(root.querySelector('.window-controls')).toBeNull();
  expect(getCurrentWindow).not.toHaveBeenCalled();
  button('全局搜索').click();
  expect(search).toHaveBeenCalledOnce();
});
