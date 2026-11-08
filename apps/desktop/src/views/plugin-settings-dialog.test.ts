import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import PluginSettingsDialog from '../components/PluginSettingsDialog.vue';
import { usePluginsStore } from '../stores/plugins';
import { useHostsStore } from '../stores/hosts';
import { useWorkspaceStore } from '../stores/workspace';
import { pluginsApi } from '../services/plugins';
import { systemPluginFixtures } from '../services/system-plugins.fixture';
vi.mock('../components/PluginFrame.vue', () => ({
  default: {
    props: ['hostId', 'page'],
    template: '<div data-frame :data-host="hostId" :data-page="page.id" />',
  },
}));
let app: App, container: HTMLElement, root: HTMLDialogElement, pinia: Pinia;
const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
async function mount(pluginId: string) {
  const workspace = useWorkspaceStore();
  container = document.createElement('div');
  document.body.append(container);
  app = createApp({
    render: () => (workspace.pluginConfiguration ? h(PluginSettingsDialog, { pluginId }) : null),
  }).use(pinia);
  app.mount(container);
  workspace.openPluginSettings(pluginId);
  await settle();
  root = document.querySelector<HTMLDialogElement>('dialog[open]')!;
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await nextTick();
};
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
});
afterEach(() => {
  app?.unmount();
  container?.remove();
  if (showModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (pinia) disposePinia(pinia);
  vi.restoreAllMocks();
});
it.each(['system', 'user'] as const)(
  'opens permission and source controls in a dialog for disabled %s plugins',
  async (source) => {
    pinia = createPinia();
    setActivePinia(pinia);
    const plugins = usePluginsStore();
    const plugin = { ...systemPluginFixtures()[0]!, source };
    plugins.installed = [plugin];
    plugins.grants[plugin.manifest.id] = null;
    if (source === 'system')
      plugins.grants[plugin.manifest.id] = {
        version: 1,
        pluginId: plugin.manifest.id,
        pluginVersion: plugin.manifest.version,
        publisher: null,
        packageDigest: plugin.packageDigest,
        revision: plugin.revision,
        permissions: plugin.manifest.permissions,
        operations: ['ui.contribute', 'ui.notify', 'system.read', 'system.manage', 'system.shell'],
        readRoots: [],
        writeRoots: [],
      };
    const ui = vi.spyOn(pluginsApi, 'ui');
    const grant = vi.spyOn(pluginsApi, 'grant').mockResolvedValue({} as never);
    vi.spyOn(plugins, 'refresh').mockResolvedValue();
    useHostsStore().catalog = { hosts: [], groups: [], credentials: [], pendingSecretDeletions: 0 };
    await mount(plugin.manifest.id);
    expect(useWorkspaceStore().tabs).toEqual([]);
    expect(root.textContent).toContain(source === 'system' ? '系统内置' : '用户上传');
    expect(root.querySelector('[aria-label="插件设置"]')).not.toBeNull();
    expect(root.querySelector('.plugin-management-header svg.lucide-container')).not.toBeNull();
    expect(ui).not.toHaveBeenCalled();
    expect(root.querySelector('.plugin-workspace')).toBeNull();
    expect(root.textContent).not.toContain('允许访问的主机');
    expect(root.textContent).toContain('适用于所有主机');
    if (source === 'system') {
      for (const field of root.querySelectorAll<HTMLInputElement>('form input')) {
        expect(field.checked).toBe(true);
        expect(field.disabled).toBe(true);
      }
      expect(root.textContent).not.toContain('保存并授权');
      expect(root.textContent).not.toContain('撤销授权');
      root
        .querySelector<HTMLFormElement>('form')!
        .dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
      expect(grant).not.toHaveBeenCalled();
      return;
    }
    for (const permission of ['ui.contribute', 'system.read', 'system.manage']) {
      const field = root.querySelector<HTMLInputElement>(`[aria-label="${permission}"]`)!;
      field.checked = true;
      field.dispatchEvent(new Event('change'));
      await nextTick();
    }
    root
      .querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(grant).toHaveBeenCalledWith(
      plugin.manifest.id,
      expect.objectContaining({
        expectedRevision: plugin.revision,
        permissions: ['ui.contribute', 'system.read', 'system.manage'],
        operations: ['ui.contribute', 'ui.notify', 'system.read', 'system.manage'],
        confirmed: true,
      }),
    );
    expect(grant.mock.calls[0]![1].operations).not.toContain('system.shell');
    expect(grant.mock.calls[0]![1]).not.toHaveProperty('hostIds');
  },
);
it('does not overwrite permission edits when the installed list refreshes with unchanged grants', async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  const plugins = usePluginsStore();
  const plugin = { ...systemPluginFixtures()[0]!, source: 'user' as const };
  plugins.installed = [plugin];
  plugins.grants[plugin.manifest.id] = null;
  await mount(plugin.manifest.id);
  const check = root.querySelector<HTMLInputElement>('[aria-label="system.read"]')!;
  check.checked = true;
  check.dispatchEvent(new Event('change'));
  await nextTick();
  plugins.installed = [{ ...plugin }];
  plugins.grants = { ...plugins.grants };
  await settle();
  expect(root.querySelector<HTMLInputElement>('[aria-label="system.read"]')!.checked).toBe(true);
});

it('opens an independent settings frontend in a hostless dialog and closes it on cancel', async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  const plugins = usePluginsStore(),
    plugin = { ...systemPluginFixtures()[0]!, enabled: true };
  plugin.manifest = {
    ...plugin.manifest,
    permissions: ['ui.contribute'],
    contributions: [{ id: 'settings', label: '插件配置', kind: 'settings' }],
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
  plugins.schemas[plugin.manifest.id] = {
    revision: plugin.revision,
    ui: {
      uiVersion: 4,
      frontend: { script: 'frontend.js', style: 'frontend.css' },
      title: '配置',
      pages: [
        {
          id: 'settings',
          surface: { kind: 'frontend' },
          title: '插件配置',
          initialAction: null,
          log: null,
          actions: [],
          fields: [
            {
              id: 'setting',
              label: '配置项',
              kind: 'text',
              default: '配置草稿',
              readonly: false,
              documentField: null,
            },
          ],
        },
      ],
    },
  };
  vi.spyOn(pluginsApi, 'context').mockResolvedValue();
  vi.spyOn(pluginsApi, 'activate').mockResolvedValue({ state: 'active' } as never);
  const workspace = useWorkspaceStore();
  workspace.navigate('plugins');
  await mount(plugin.manifest.id);
  expect(root.querySelector('[data-frame]')?.getAttribute('data-host')).toBe('');
  expect(root.querySelector('[data-frame]')?.getAttribute('data-page')).toBe('settings');
  expect(root.querySelector<HTMLElement>('.plugin-management-panel')!.style.display).toBe('none');
  expect(workspace.current?.view).toBe('plugins');
  expect(workspace.tabs).toHaveLength(1);
  expect(pluginsApi.context).toHaveBeenCalledWith(plugin.manifest.id, null);
  root.querySelector<HTMLButtonElement>('.plugin-config-footer button')!.click();
  await settle();
  expect(document.querySelector('dialog[open]')).toBeNull();
  expect(workspace.pluginConfiguration).toBeUndefined();
});
