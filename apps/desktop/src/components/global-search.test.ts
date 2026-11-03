import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import GlobalSearch from './GlobalSearch.vue';
import { useHostsStore } from '../stores/hosts';
import { hostInput } from '../types/hosts';

vi.mock('../services/automation', () => ({
  automationApi: { catalog: vi.fn().mockResolvedValue({ entries: [] }) },
}));
let app: App, root: HTMLDivElement, pinia: Pinia;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root?.remove();
  vi.restoreAllMocks();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});

it.each(['主机 ·', '工作区 · 通用'])(
  'distinguishes host selection from global asset navigation: %s',
  async (label) => {
    pinia = createPinia();
    setActivePinia(pinia);
    const hosts = useHostsStore();
    hosts.catalog = {
      hosts: [{ ...hostInput(), id: 'a', name: 'Server A', createdAt: '', updatedAt: '' }],
      groups: [],
      credentials: [],
      pendingSecretDeletions: 0,
    };
    hosts.selectedId = 'a';
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
    const selectHost = vi.fn(),
      navigate = vi.fn(),
      close = vi.fn();
    root = document.createElement('div');
    document.body.append(root);
    app = createApp(GlobalSearch, {
      onSelectHost: selectHost,
      onNavigate: navigate,
      onClose: close,
    }).use(pinia);
    app.mount(root);
    await nextTick();
    expect(
      [...document.querySelectorAll('.search-result')].some((button) =>
        button.textContent?.includes('主机管理'),
      ),
    ).toBe(false);
    const result = [...document.querySelectorAll<HTMLButtonElement>('.search-result')].find(
      (button) => button.textContent?.trim().startsWith(label),
    );
    expect(result).toBeDefined();
    result!.click();
    if (label === '主机 ·') {
      expect(selectHost).toHaveBeenCalledExactlyOnceWith('a');
      expect(navigate).not.toHaveBeenCalled();
    } else {
      expect(navigate).toHaveBeenCalledExactlyOnceWith('settings', 'a', '');
      expect(selectHost).not.toHaveBeenCalled();
    }
    expect(close).toHaveBeenCalledOnce();
  },
);
