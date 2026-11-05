import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import PluginPage from './PluginPage.vue';
import { usePluginsStore } from '../stores/plugins';
import { useHostsStore } from '../stores/hosts';
import { useWorkspaceStore } from '../stores/workspace';
import { pluginsApi } from '../services/plugins';
import { systemPluginFixtures } from '../services/system-plugins.fixture';
let app: App, root: HTMLElement, pinia: Pinia;
function mount(pluginId: string) {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(PluginPage, {
    pluginId,
  }).use(pinia);
  app.mount(root);
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await nextTick();
};
afterEach(() => {
  app?.unmount();
  root?.remove();
  if (pinia) disposePinia(pinia);
  vi.restoreAllMocks();
});
it.each(['system', 'user'] as const)(
  'opens disabled %s plugins and keeps permission/source details inside their own page',
  async (source) => {
    pinia = createPinia();
    setActivePinia(pinia);
    const plugins = usePluginsStore();
    const plugin = { ...systemPluginFixtures()[1]!, source };
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
    useWorkspaceStore().openPluginSettings(plugin.manifest.id);
    expect(useWorkspaceStore().module).toBe('system');
    expect(useWorkspaceStore().current?.pluginId).toBe(plugin.manifest.id);
    useHostsStore().catalog = { hosts: [], groups: [], credentials: [], pendingSecretDeletions: 0 };
    mount(plugin.manifest.id);
    await settle();
    expect(root.textContent).toContain(source === 'system' ? '系统内置' : '用户上传');
    expect(root.querySelector('[aria-label="插件设置"]')).not.toBeNull();
    expect(root.querySelector('.plugin-page-icon svg.lucide-container')).not.toBeNull();
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
  mount(plugin.manifest.id);
  await settle();
  const check = root.querySelector<HTMLInputElement>('[aria-label="metrics.read"]')!;
  check.checked = true;
  check.dispatchEvent(new Event('change'));
  await nextTick();
  plugins.installed = [{ ...plugin }];
  plugins.grants = { ...plugins.grants };
  await settle();
  expect(root.querySelector<HTMLInputElement>('[aria-label="metrics.read"]')!.checked).toBe(true);
});

it('keeps plugin-provided settings pages available under settings without a host selector', async () => {
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
      uiVersion: 1,
      title: '配置',
      pages: [
        {
          id: 'settings',
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
  useWorkspaceStore().openPluginSettings(plugin.manifest.id);
  mount(plugin.manifest.id);
  await settle();
  expect(useWorkspaceStore().module).toBe('system');
  expect(root.querySelector<HTMLInputElement>('.plugin-form input')?.value).toBe('配置草稿');
  // Configuration must remain the first usable section, ahead of lifecycle/permission controls.
  const configuration = root.querySelector('.plugin-configuration')!;
  const management = root.querySelector('[aria-label="插件设置"]')!;
  expect(configuration.contains(root.querySelector('.plugin-form'))).toBe(true);
  expect(
    configuration.compareDocumentPosition(management) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(root.querySelector('[aria-label="插件目标主机"]')).toBeNull();
  expect(pluginsApi.context).toHaveBeenCalledWith(plugin.manifest.id, null);
});
