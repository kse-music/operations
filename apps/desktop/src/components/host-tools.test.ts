import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import HostTools from './HostTools.vue';
import { createPinia } from 'pinia';
import { usePluginsStore } from '../stores/plugins';
import { systemPluginFixtures } from '../services/system-plugins.fixture';
import { hasPluginFunction, primaryPluginPage } from '../services/plugin-pages';

let app: App, root: HTMLDivElement;
function mount(props: InstanceType<typeof HostTools>['$props'], pinia = createPinia()) {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostTools, { ...props }).use(pinia);
  app.mount(root);
}
afterEach(() => {
  app?.unmount();
  root?.remove();
});

it('chooses a function contribution before settings even if the package lists settings first', () => {
  const plugin = systemPluginFixtures()[0]!;
  plugin.manifest = {
    ...plugin.manifest,
    contributions: [
      { id: 'settings', label: '设置', kind: 'settings' },
      { id: 'run', label: '执行', kind: 'command' },
    ],
  };
  expect(hasPluginFunction(plugin)).toBe(true);
  expect(primaryPluginPage(plugin)).toBe('run');
  plugin.manifest.contributions = [plugin.manifest.contributions[0]!];
  expect(hasPluginFunction(plugin)).toBe(false);
});

it.each([false, true])('scopes secondary tools to the selected host (local=%s)', (local) => {
  const navigate = vi.fn();
  mount({
    active: local ? 'terminals' : 'files',
    local,
    onNavigate: navigate,
  });
  expect(root.querySelectorAll('button')).toHaveLength(local ? 1 : 2);
  expect(root.querySelector('[aria-current="page"]')?.textContent).toContain(
    local ? '本地终端' : 'SFTP 文件',
  );
  root.querySelector<HTMLButtonElement>('[aria-current="page"]')!.click();
  expect(navigate).toHaveBeenCalledWith(local ? 'terminals' : 'files');
  expect(root.querySelector('[aria-label="网络诊断"]')).toBeNull();
  expect([...root.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(
    local ? ['本地终端'] : ['SSH 终端', 'SFTP 文件'],
  );
});
it('shows enabled plugin functions beside SSH and SFTP without requiring host grants', async () => {
  const pinia = createPinia();
  const plugins = usePluginsStore(pinia);
  const items = systemPluginFixtures();
  items[0]!.enabled = true;
  items[1]!.enabled = true;
  items[1]!.source = 'user';
  items[1]!.manifest = { ...items[1]!.manifest, contributions: [] };
  plugins.installed = items;
  const select = vi.fn();
  mount({ active: 'terminals', local: false, onPlugin: select }, pinia);
  const toolbar = root.querySelector<HTMLElement>('[aria-label="当前主机工具"]')!;
  expect(toolbar.querySelectorAll('[data-plugin-id]')).toHaveLength(1);
  expect(toolbar.querySelector('[aria-haspopup]')).toBeNull();
  expect(document.querySelector('.host-plugin-menu')).toBeNull();
  expect(
    toolbar.querySelector(`[data-plugin-id="${items[0]!.manifest.id}"] svg.lucide-container`),
  ).not.toBeNull();
  expect(
    [...toolbar.querySelectorAll('button')].map((button) => button.textContent?.trim()),
  ).toEqual(['SSH 终端', 'SFTP 文件', items[0]!.manifest.name]);
  toolbar.querySelector<HTMLButtonElement>(`[data-plugin-id="${items[0]!.manifest.id}"]`)!.click();
  await nextTick();
  expect(select).toHaveBeenCalledWith(items[0]!.manifest.id, 'server');
  expect(toolbar.querySelector(`[data-plugin-id="${items[1]!.manifest.id}"]`)).toBeNull();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  items[0]!.enabled = false;
  items[1]!.enabled = false;
  plugins.installed = [...items];
  await nextTick();
  expect(
    [...toolbar.querySelectorAll('button')].map((button) => button.textContent?.trim()),
  ).toEqual(['SSH 终端', 'SFTP 文件']);
});

it('highlights the current plugin and hides remote plugins on the local device', async () => {
  const pinia = createPinia();
  const plugins = usePluginsStore(pinia);
  plugins.installed = systemPluginFixtures().map((plugin) => ({ ...plugin, enabled: true }));
  const props = {
    active: 'extension' as const,
    activePlugin: plugins.installed[1]!.manifest.id,
    local: false,
  };
  mount(props, pinia);
  expect(root.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(root.querySelector('[aria-current="page"]')?.getAttribute('data-plugin-id')).toBe(
    props.activePlugin,
  );
  expect(root.querySelector('.host-tool.active')?.getAttribute('data-plugin-id')).toBe(
    props.activePlugin,
  );
  app.unmount();
  root.remove();
  mount({ ...props, active: 'terminals', local: true }, pinia);
  await nextTick();
  expect(root.querySelectorAll('button')).toHaveLength(1);
  expect(root.querySelector('[data-plugin-id]')).toBeNull();
});
