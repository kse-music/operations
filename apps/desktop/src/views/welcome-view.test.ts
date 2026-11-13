import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import WelcomeView from './WelcomeView.vue';
import { useHostsStore } from '../stores/hosts';
import { usePluginsStore } from '../stores/plugins';
import { hostInput, type Host } from '../types/hosts';
import { toolPluginState } from '../services/system-plugins.fixture';

const dockerId = 'cn.hiboot.plugins.docker';
const assistantId = 'cn.hiboot.plugins.assistant';
let app: App | undefined, root: HTMLElement, pinia: Pinia;
const events = {
  onLocalTerminal: vi.fn(),
  onCreateHost: vi.fn(),
  onImportOpenssh: vi.fn(),
  onFiles: vi.fn(),
  onPlugin: vi.fn(),
  onPluginSettings: vi.fn(),
  onManagePlugins: vi.fn(),
};
function host(id: string): Host {
  return {
    ...hostInput(),
    id,
    name: `Host ${id}`,
    hostname: `${id}.example`,
    createdAt: '',
    updatedAt: '',
  };
}
function mount() {
  app = createApp(WelcomeView, { searchShortcut: 'Ctrl+Shift+K', ...events }).use(pinia);
  app.mount(root);
}
const tool = (id: string) => root.querySelector<HTMLElement>(`[data-home-tool="${id}"]`)!;
const action = (id: string) => tool(id).querySelector<HTMLButtonElement>('.button')!;
function choose(id: string) {
  const picker = root.querySelector<HTMLSelectElement>('.welcome-target select')!;
  picker.value = id;
  picker.dispatchEvent(new Event('change', { bubbles: true }));
}
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useHostsStore().catalog = {
    hosts: [host('a'), host('b')],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  Object.assign(usePluginsStore(), toolPluginState());
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  root.remove();
  disposePinia(pinia);
  Object.values(events).forEach((event) => event.mockClear());
});

it('shows the first-host guide only for a successfully loaded empty catalog and keeps local actions usable', () => {
  useHostsStore().catalog!.hosts = [];
  mount();
  expect(root.querySelector('.welcome-host-empty h3')?.textContent).toBe('添加第一台主机');
  expect(root.querySelector('select')).toBeNull();
  expect(root.querySelector('.welcome-tool-grid')).toBeNull();
  root.querySelector<HTMLButtonElement>('.welcome-terminal .button')!.click();
  expect(events.onLocalTerminal).toHaveBeenCalledOnce();
  const buttons = root.querySelectorAll<HTMLButtonElement>('.welcome-host-empty .button');
  buttons[0]!.click();
  buttons[1]!.click();
  expect(events.onCreateHost).toHaveBeenCalledOnce();
  expect(events.onImportOpenssh).toHaveBeenCalledOnce();
  root.querySelector<HTMLButtonElement>('.welcome-guide .text-button')!.click();
  expect(events.onManagePlugins).toHaveBeenCalledOnce();
  expect(events.onFiles).not.toHaveBeenCalled();
  expect(events.onPlugin).not.toHaveBeenCalled();
});

it('distinguishes host loading and failure from the empty state and retries the existing loader', async () => {
  const hosts = useHostsStore();
  hosts.catalog = null;
  hosts.busy = true;
  mount();
  expect(root.textContent).toContain('正在读取主机…');
  expect(root.querySelector('.welcome-host-empty')).toBeNull();
  hosts.busy = false;
  hosts.error = 'unavailable';
  await nextTick();
  expect(root.textContent).toContain('主机列表读取失败。');
  expect(root.querySelector('.welcome-host-empty')).toBeNull();
  const load = vi.spyOn(hosts, 'load').mockResolvedValue();
  root.querySelector<HTMLButtonElement>('.welcome-state .text-button')!.click();
  expect(load).toHaveBeenCalledOnce();
  hosts.error = null;
  hosts.catalog = { hosts: [], groups: [], credentials: [], pendingSecretDeletions: 0 };
  await nextTick();
  expect(root.querySelector('.welcome-host-empty')).not.toBeNull();
});

it('shows a single host without a picker and falls back from an invalid saved selection', () => {
  const hosts = useHostsStore();
  hosts.catalog!.hosts = [host('a')];
  hosts.selectedId = 'deleted';
  mount();
  expect(root.querySelector('select')).toBeNull();
  expect(root.querySelector('.welcome-target-name')?.textContent).toContain('Host a');
  action('files').click();
  expect(events.onFiles).toHaveBeenCalledExactlyOnceWith('a');
});

it('selects a shared target without opening resources and routes each tool to that target', async () => {
  useHostsStore().selectedId = 'a';
  mount();
  choose('b');
  await nextTick();
  expect(useHostsStore().selectedId).toBe('b');
  Object.values(events).forEach((event) => expect(event).not.toHaveBeenCalled());
  action('files').click();
  action(dockerId).click();
  action(assistantId).click();
  expect(events.onFiles).toHaveBeenCalledExactlyOnceWith('b');
  expect(events.onPlugin.mock.calls).toEqual([
    [dockerId, 'server', 'b'],
    [assistantId, 'assistant', 'b'],
  ]);
  tool(assistantId).querySelector<HTMLButtonElement>('.text-button')!.click();
  expect(events.onPluginSettings).toHaveBeenCalledExactlyOnceWith(assistantId);
});

it('falls back when the selected host is deleted and returns to the guide after the last deletion', async () => {
  const hosts = useHostsStore();
  hosts.selectedId = 'b';
  mount();
  hosts.catalog!.hosts = [host('a')];
  await nextTick();
  action('files').click();
  expect(events.onFiles).toHaveBeenCalledExactlyOnceWith('a');
  expect(root.querySelector('select')).toBeNull();
  const previousAction = action('files');
  hosts.catalog!.hosts = [];
  previousAction.click();
  expect(events.onFiles).toHaveBeenCalledTimes(1);
  await nextTick();
  expect(root.querySelector('.welcome-host-empty')).not.toBeNull();
  expect(root.querySelector('.welcome-tool-grid')).toBeNull();
});

it.each(['missing', 'disabled', 'stale', 'ungranted'] as const)(
  'routes a %s plugin to management or settings without enabling or executing it',
  async (state) => {
    const plugins = usePluginsStore();
    const installed = plugins.installed.find((plugin) => plugin.manifest.id === dockerId)!;
    if (state === 'missing')
      plugins.installed = plugins.installed.filter((plugin) => plugin !== installed);
    else if (state === 'disabled') installed.enabled = false;
    else if (state === 'stale') plugins.grants[dockerId]!.revision = 'old-revision';
    else plugins.grants[dockerId] = null;
    mount();
    expect(tool(dockerId).textContent).toContain(
      state === 'missing'
        ? '尚未安装'
        : state === 'disabled'
          ? '插件未启用'
          : '需要检查插件授权或配置',
    );
    action(dockerId).click();
    await nextTick();
    if (state === 'missing') expect(events.onManagePlugins).toHaveBeenCalledOnce();
    else expect(events.onPluginSettings).toHaveBeenCalledExactlyOnceWith(dockerId);
    expect(events.onPlugin).not.toHaveBeenCalled();
    expect(installed.enabled).toBe(state !== 'disabled');
  },
);

it('rechecks the current UI grant when an action is clicked before the rendered state catches up', () => {
  const plugins = usePluginsStore();
  mount();
  const button = action(dockerId);
  plugins.grants[dockerId] = null;
  button.click();
  expect(events.onPlugin).not.toHaveBeenCalled();
  expect(events.onPluginSettings).toHaveBeenCalledExactlyOnceWith(dockerId);
});

it('keeps SFTP independent of plugin loading errors and retries with a visible refresh', async () => {
  const plugins = usePluginsStore();
  plugins.loaded = false;
  plugins.loading = true;
  mount();
  expect(root.textContent).toContain('正在读取插件…');
  expect(action(dockerId).disabled).toBe(true);
  expect(action('files').disabled).toBe(false);
  plugins.loading = false;
  plugins.error = 'inventory unavailable';
  await nextTick();
  expect(root.textContent).toContain('插件列表读取失败。');
  const refresh = vi.spyOn(plugins, 'refresh').mockResolvedValue();
  root.querySelector<HTMLButtonElement>('.welcome-state .text-button')!.click();
  expect(refresh).toHaveBeenCalledExactlyOnceWith();
  action('files').click();
  expect(events.onFiles).toHaveBeenCalledExactlyOnceWith('a');
  plugins.loaded = true;
  plugins.error = null;
  await nextTick();
  expect(action(dockerId).disabled).toBe(false);
});
