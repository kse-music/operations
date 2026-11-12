/* eslint-disable vue/one-component-per-file -- Each test mounts an isolated component. */
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import GlobalSearch from './GlobalSearch.vue';
import { useHostsStore } from '../stores/hosts';
import { useWorkspaceStore } from '../stores/workspace';
import { usePluginsStore } from '../stores/plugins';
import { systemPluginFixtures } from '../services/system-plugins.fixture';
import { hostInput } from '../types/hosts';

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

async function mountSearch() {
  pinia = createPinia();
  setActivePinia(pinia);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  const navigate = vi.fn(),
    close = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(GlobalSearch, { onNavigate: navigate, onClose: close }).use(pinia);
  app.mount(root);
  await nextTick();
  const input = document.querySelector<HTMLInputElement>('.global-search-input')!;
  const options = [...document.querySelectorAll<HTMLButtonElement>('.search-result')];
  return { input, options, navigate, close };
}

it('opens and filters without selecting a result or navigating on Enter', async () => {
  const { input, navigate, close } = await mountSearch();
  expect(document.querySelector('[aria-selected="true"]')).toBeNull();
  expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(navigate).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  input.value = '设置';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  expect(document.querySelector('[aria-selected="true"]')).toBeNull();
  expect(input.hasAttribute('aria-activedescendant')).toBe(false);
});

it.each(['ArrowDown', 'ArrowUp'])(
  'starts from no selection and wraps keyboard navigation with %s',
  async (key) => {
    const { input, options, navigate, close } = await mountSearch();
    const expected = key === 'ArrowDown' ? options[0]! : options.at(-1)!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await nextTick();
    expect(expected.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(expected.id);
    for (let index = 0; index < options.length; index++)
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await nextTick();
    expect(expected.getAttribute('aria-selected')).toBe('true');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(navigate).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
);

it('selects the pointed result without moving input focus and clears selection after typing', async () => {
  const { input, options, navigate, close } = await mountSearch();
  input.focus();
  options[1]!.dispatchEvent(new Event('pointermove', { bubbles: true }));
  await nextTick();
  expect(options[1]!.getAttribute('aria-selected')).toBe('true');
  expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
  expect(document.activeElement).toBe(input);
  input.value = 'no-matching-result';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter'])
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  await nextTick();
  expect(document.querySelectorAll('.search-result')).toHaveLength(0);
  expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it('highlights a result when it receives keyboard focus', async () => {
  const { options } = await mountSearch();
  options[1]!.focus();
  await nextTick();
  expect(options[1]!.getAttribute('aria-selected')).toBe('true');
  expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
});

it.each(['主机 ·', '设置 · 通用', '设置 · 插件管理'])(
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
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        label.includes('插件管理') ? 'plugins' : 'settings',
        'a',
      );
      expect(selectHost).not.toHaveBeenCalled();
    }
    expect(close).toHaveBeenCalledOnce();
  },
);

it.each([true, false])(
  'uses only the visible workspace host for plugin commands (host context=%s)',
  async (hostContext) => {
    pinia = createPinia();
    setActivePinia(pinia);
    useHostsStore().selectedId = 'old-host';
    const workspace = useWorkspaceStore();
    workspace.navigate(hostContext ? 'files' : 'settings', 'current-host');
    const plugins = usePluginsStore(),
      plugin = { ...systemPluginFixtures()[0]!, enabled: true };
    plugin.manifest = {
      ...plugin.manifest,
      contributions: [{ id: 'command', label: '主机命令', kind: 'command' }],
    };
    plugins.installed = [plugin];
    plugins.grants[plugin.manifest.id] = {
      version: 1,
      pluginId: plugin.manifest.id,
      pluginVersion: plugin.manifest.version,
      revision: plugin.revision,
      packageDigest: plugin.packageDigest,
      publisher: null,
      permissions: ['ui.contribute'],
      operations: ['ui.contribute'],
      readRoots: [],
      writeRoots: [],
    };
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
    const open = vi.fn();
    root = document.createElement('div');
    document.body.append(root);
    app = createApp(GlobalSearch, { onPlugin: open }).use(pinia);
    app.mount(root);
    await nextTick();
    [...document.querySelectorAll<HTMLButtonElement>('.search-result')]
      .find((button) => button.textContent?.trim().startsWith('插件命令 ·'))!
      .click();
    expect(open).toHaveBeenCalledExactlyOnceWith(
      plugin.manifest.id,
      'command',
      hostContext ? 'current-host' : '',
    );
  },
);
