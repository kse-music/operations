import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import PluginSettingsPanel from '../components/PluginSettingsPanel.vue';
import { usePluginsStore } from '../stores/plugins';
import { useHostsStore } from '../stores/hosts';
import { useWorkspaceStore } from '../stores/workspace';
import { pluginsApi } from '../services/plugins';
import { systemPluginFixtures } from '../services/system-plugins.fixture';
vi.mock('../components/PluginFrame.vue', () => ({
  default: {
    props: ['hostId', 'page'],
    emits: ['saving'],
    template:
      '<div data-frame :data-host="hostId" :data-page="page.id"><button data-start-saving @click="$emit(\'saving\', true)">开始保存</button><button data-finish-saving @click="$emit(\'saving\', false)">保存完成</button></div>',
  },
}));
let app: App, container: HTMLElement, root: HTMLElement, pinia: Pinia;
async function mount(pluginId: string) {
  const workspace = useWorkspaceStore();
  container = document.createElement('div');
  document.body.append(container);
  app = createApp({
    render: () => (workspace.pluginConfiguration ? h(PluginSettingsPanel, { pluginId }) : null),
  }).use(pinia);
  app.mount(container);
  workspace.openPluginSettings(pluginId);
  await settle();
  root = container.querySelector<HTMLElement>('.plugin-configuration')!;
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await nextTick();
};
afterEach(() => {
  app?.unmount();
  container?.remove();
  if (pinia) disposePinia(pinia);
  vi.restoreAllMocks();
});
it.each(['system', 'user'] as const)(
  'opens permission and source controls in a settings panel for disabled %s plugins',
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
        operations: ['ui.contribute', 'ui.notify', 'hosts.read', 'ssh.execute', 'network.connect'],
        readRoots: [],
        writeRoots: [],
      };
    const ui = vi.spyOn(pluginsApi, 'ui');
    const grant = vi.spyOn(pluginsApi, 'grant').mockResolvedValue({} as never);
    vi.spyOn(plugins, 'refresh').mockResolvedValue();
    useHostsStore().catalog = { hosts: [], groups: [], credentials: [], pendingSecretDeletions: 0 };
    await mount(plugin.manifest.id);
    expect(
      [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim()),
    ).toEqual(['基本信息', '插件配置']);
    expect(useWorkspaceStore().tabs).toEqual([]);
    expect(root.textContent).toContain(source === 'system' ? '系统内置' : '用户上传');
    expect(root.querySelector('[aria-label="插件设置"]')).not.toBeNull();
    expect(root.querySelector('.plugin-state-section')).toBeNull();
    expect(root.textContent).not.toContain('启用插件');
    expect(root.textContent).not.toContain('禁用插件');
    expect(root.querySelector('.plugin-management-header svg.lucide-container')).not.toBeNull();
    expect(ui).not.toHaveBeenCalled();
    expect(root.querySelector('.plugin-workspace')).toBeNull();
    expect(root.textContent).not.toContain('允许访问的主机');
    expect(root.textContent).toContain('适用于所有主机');
    const settingsTab = root.querySelector<HTMLButtonElement>('#plugin-tab-settings')!;
    settingsTab.click();
    await settle();
    expect(root.querySelector('#plugin-panel-settings')?.textContent).toContain('无需单独配置');
    expect(root.querySelector<HTMLElement>('#plugin-panel-info')?.style.display).toBe('none');
    settingsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await settle();
    expect(document.activeElement).toBe(root.querySelector('#plugin-tab-info'));
    expect(root.querySelector('#plugin-tab-info')?.getAttribute('aria-selected')).toBe('true');
    if (source === 'system') {
      expect(root.querySelectorAll('form input')).toHaveLength(0);
      expect(root.querySelectorAll('.plugin-capability-icon')).toHaveLength(
        plugin.manifest.permissions.length,
      );
      expect(root.textContent).toContain('仅供查阅和排查权限问题');
      expect(root.textContent).not.toContain('保存并授权');
      expect(root.textContent).not.toContain('撤销授权');
      root
        .querySelector<HTMLFormElement>('form')!
        .dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
      expect(grant).not.toHaveBeenCalled();
      return;
    }
    for (const permission of ['ui.contribute', 'hosts.read', 'ssh.execute']) {
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
        permissions: ['ui.contribute', 'hosts.read', 'ssh.execute'],
        operations: ['ui.contribute', 'ui.notify', 'hosts.read', 'ssh.execute'],
        confirmed: true,
      }),
    );
    expect(grant.mock.calls[0]![1].operations).not.toContain('network.connect');
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
  const check = root.querySelector<HTMLInputElement>('[aria-label="hosts.read"]')!;
  check.checked = true;
  check.dispatchEvent(new Event('change'));
  await nextTick();
  plugins.installed = [{ ...plugin }];
  plugins.grants = { ...plugins.grants };
  await settle();
  expect(root.querySelector<HTMLInputElement>('[aria-label="hosts.read"]')!.checked).toBe(true);
});

it('shows exact preset commands and grants them only after a separate explicit selection', async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  const plugins = usePluginsStore();
  const plugin = { ...systemPluginFixtures()[0]!, source: 'user' as const };
  plugin.manifest = {
    ...plugin.manifest,
    permissions: ['ui.contribute', 'ssh.execute', 'ssh.execute.preapproved'],
    preapprovedCommands: [{ program: 'fixture-tool', args: ['literal; value'], timeoutSecs: 30 }],
  };
  plugins.installed = [plugin];
  plugins.grants[plugin.manifest.id] = null;
  const grant = vi.spyOn(pluginsApi, 'grant').mockResolvedValue({} as never);
  vi.spyOn(plugins, 'refresh').mockResolvedValue();
  await mount(plugin.manifest.id);
  const preset = root.querySelector<HTMLInputElement>('[aria-label="ssh.execute.preapproved"]')!;
  expect(preset.checked).toBe(false);
  expect(root.querySelector('.plugin-preset-commands pre')?.textContent).toContain(
    'literal; value',
  );
  expect(root.textContent).toContain('此授权不保证命令只读');
  const execute = root.querySelector<HTMLInputElement>('[aria-label="ssh.execute"]')!;
  execute.checked = true;
  execute.dispatchEvent(new Event('change'));
  await nextTick();
  const submit = async () => {
    root
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  };
  await submit();
  expect(grant.mock.calls[0]![1].permissions).not.toContain('ssh.execute.preapproved');
  expect(grant.mock.calls[0]![1].operations).not.toContain('ssh.execute.preapproved');
  preset.checked = true;
  preset.dispatchEvent(new Event('change'));
  await nextTick();
  await submit();
  expect(grant.mock.calls[1]![1].permissions).toContain('ssh.execute.preapproved');
  expect(grant.mock.calls[1]![1].operations).toContain('ssh.execute.preapproved');
});

it('opens an independent settings frontend without a host and returns to the plugin list on cancel', async () => {
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
  vi.spyOn(pluginsApi, 'reset').mockResolvedValue();
  vi.spyOn(pluginsApi, 'scopeVisibility').mockResolvedValue();
  vi.spyOn(pluginsApi, 'closeScope').mockResolvedValue();
  vi.spyOn(pluginsApi, 'cancelScope').mockResolvedValue();
  vi.spyOn(pluginsApi, 'activate').mockResolvedValue({ state: 'active' } as never);
  const workspace = useWorkspaceStore();
  workspace.navigate('plugins');
  await mount(plugin.manifest.id);
  expect(root.querySelector('[data-frame]')?.getAttribute('data-host')).toBe('');
  expect(root.querySelector('[data-frame]')?.getAttribute('data-page')).toBe('settings');
  expect(root.querySelector('.plugin-config-footer')).toBeNull();
  expect(root.querySelector<HTMLElement>('.plugin-management-panel')!.style.display).toBe('none');
  expect(workspace.settingsView).toBe('plugins');
  expect(workspace.current).toBeUndefined();
  expect(workspace.tabs).toHaveLength(0);
  expect(pluginsApi.reset).toHaveBeenCalledWith(plugin.manifest.id);
  root.querySelector<HTMLButtonElement>('[data-start-saving]')!.click();
  await settle();
  expect(workspace.pluginSettingsBusy).toBe(true);
  expect(
    [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].every((tab) => tab.disabled),
  ).toBe(true);
  expect(root.querySelector<HTMLButtonElement>('[aria-label="返回插件列表"]')!.disabled).toBe(true);
  workspace.navigate('models');
  await workspace.closeSettings();
  expect(workspace.settingsView).toBe('plugins');
  expect(workspace.pluginConfiguration?.pluginId).toBe(plugin.manifest.id);
  root.querySelector<HTMLButtonElement>('[data-finish-saving]')!.click();
  await settle();
  expect(workspace.pluginSettingsBusy).toBe(false);
  root.querySelector<HTMLButtonElement>('[aria-label="返回插件列表"]')!.click();
  await settle();
  expect(document.querySelector('dialog[open]')).toBeNull();
  expect(workspace.pluginConfiguration).toBeUndefined();
  expect(workspace.settingsView).toBe('plugins');
});
