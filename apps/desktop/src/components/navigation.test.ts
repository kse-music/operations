import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import AppNavigation from './AppNavigation.vue';
import { moduleForView } from '../types/navigation';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import { usePluginsStore } from '../stores/plugins';
import { systemPluginFixtures } from '../services/system-plugins.fixture';

let app: App, root: HTMLDivElement, pinia: Pinia;
function mountNavigation(props: InstanceType<typeof AppNavigation>['$props']): void {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(AppNavigation, { ...props }).use(pinia);
  app.mount(root);
}
afterEach(() => {
  app?.unmount();
  root?.remove();
  if (pinia) disposePinia(pinia);
});

it.each([
  ['terminals', ['收起主机栏'], []],
  [
    'credentials',
    ['收起主机栏', '安全凭据', '模型管理', '备份恢复'],
    ['credentials', 'models', 'backup'],
  ],
  [
    'plugins',
    ['收起主机栏', '通用', '终端', '快捷键', '工作区与连接', '插件管理', '关于'],
    ['settings', 'settingsTerminal', 'settingsShortcuts', 'settingsWorkspace', 'plugins', 'about'],
  ],
  [
    'settings',
    ['收起主机栏', '通用', '终端', '快捷键', '工作区与连接', '插件管理', '关于'],
    ['settings', 'settingsTerminal', 'settingsShortcuts', 'settingsWorkspace', 'plugins', 'about'],
  ],
] as const)('shows only menus belonging to the module containing %s', (active, labels, views) => {
  const navigate = vi.fn(),
    collapse = vi.fn();
  pinia = createPinia();
  mountNavigation({
    active,
    module: moduleForView(active),
    onNavigate: navigate,
    onCollapse: collapse,
  });
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
  expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(labels);
  for (const button of buttons) {
    expect(button.querySelector('svg')).not.toBeNull();
    button.click();
  }
  expect(navigate.mock.calls.map((call) => call[0])).toEqual(views);
  expect(collapse).toHaveBeenCalledOnce();
  expect(root.querySelector('.activity-about')).toBeNull();
  if (active === 'settings')
    expect(root.querySelector('.module-menu button:last-child')?.getAttribute('aria-label')).toBe(
      '关于',
    );
  const heading = root.querySelector('.sidebar-module-title')!;
  expect(heading.tagName).toBe('STRONG');
  expect(heading.querySelector('svg')).toBeNull();
  expect(heading.closest('button, a, [role="button"]')).toBeNull();
  expect(heading.hasAttribute('tabindex')).toBe(false);
  if (active === 'terminals') expect(heading.textContent?.trim()).toBe('主机管理');
  if (active !== 'terminals')
    expect(root.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(
      labels[active === 'plugins' ? 5 : 1],
    );
});

it.each(['hosts', 'assets', 'system'] as const)(
  'keeps installed plugins out of the %s sidebar',
  (module) => {
    pinia = createPinia();
    const plugins = usePluginsStore(pinia);
    plugins.installed = systemPluginFixtures();
    mountNavigation({ active: null, module });
    expect(root.querySelector('[aria-label="运维工具导航"]')).toBeNull();
    expect(root.querySelector('[data-plugin-id]')).toBeNull();
    expect(root.querySelector('[aria-label="插件管理"]') !== null).toBe(module === 'system');
  },
);

it('highlights plugin management while an individual plugin settings tab is active', () => {
  pinia = createPinia();
  mountNavigation({ active: 'pluginSettings', module: moduleForView('pluginSettings') });
  expect(root.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('插件管理');
  expect(root.querySelector('.nav-item.active')?.getAttribute('aria-label')).toBe('插件管理');
});

it.each(['assistant', 'extension'] as const)(
  'keeps the %s plugin function in the host module',
  (view) => expect(moduleForView(view)).toBe('hosts'),
);
