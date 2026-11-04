import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import AppNavigation from './AppNavigation.vue';
import { moduleForView } from '../types/navigation';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import { usePluginsStore } from '../stores/plugins';
import type { InstalledPlugin, PluginGrant } from '../types/plugins';

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
  ['tasks', ['收起主机栏', '任务中心'], ['tasks']],
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
    tasks: 1,
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

it.each(['plugins', 'system'] as const)(
  'scopes plugin navigation and settings in %s',
  async (module) => {
    pinia = createPinia();
    const plugins = usePluginsStore(pinia);
    plugins.installed = [
      {
        enabled: true,
        revision: 'r1',
        manifest: {
          id: 'dev.example',
          name: 'Example',
          contributions: [
            { id: 'main', label: '插件主页面', kind: 'navigation' },
            { id: 'settings', label: '插件独立设置', kind: 'settings' },
            { id: 'host', label: '主机工具', kind: 'workspace' },
          ],
        },
      } as InstalledPlugin,
    ];
    plugins.grants['dev.example'] = {
      revision: 'r1',
      permissions: ['ui.contribute'],
      operations: ['ui.contribute'],
    } as PluginGrant;
    const open = vi.fn();
    mountNavigation({ active: null, module, tasks: 0, onPlugin: open });
    if (module === 'system') {
      expect(root.querySelector('[aria-label="运维工具导航"]')).toBeNull();
      return;
    }
    expect(
      [...root.querySelectorAll('.module-menu .nav-label')].map((el) => el.textContent),
    ).toEqual(['Example', '任务中心']);
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      '[aria-label="运维工具导航"] [data-plugin-id]',
    ))
      button.click();
    expect(open.mock.calls).toEqual([['dev.example', 'main']]);
    plugins.grants['dev.example'] = null;
    await nextTick();
    expect(root.querySelectorAll('[aria-label="运维工具导航"] [data-plugin-id]')).toHaveLength(1);
    expect(root.querySelector('.plugin-source')).toBeNull();
    root.querySelector<HTMLButtonElement>('[aria-label="运维工具导航"] [data-plugin-id]')!.click();
    expect(open).toHaveBeenLastCalledWith('dev.example', 'main');
  },
);
