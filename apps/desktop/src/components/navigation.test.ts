import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import AppNavigation from './AppNavigation.vue';
import { moduleForView } from '../types/navigation';

let app: App, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
});

it.each([
  ['terminals', ['收起主机栏'], []],
  [
    'automation',
    ['收起主机栏', '批量运维', '自动运维', '网络诊断', '任务中心'],
    ['batch', 'automation', 'network', 'tasks'],
  ],
  ['credentials', ['收起主机栏', '安全凭据', '备份恢复'], ['credentials', 'backup']],
  [
    'settings',
    ['收起主机栏', '通用', '终端', '快捷键', '工作区与连接', '关于'],
    ['settings', 'settingsTerminal', 'settingsShortcuts', 'settingsWorkspace', 'about'],
  ],
] as const)('shows only menus belonging to the module containing %s', (active, labels, views) => {
  const navigate = vi.fn(),
    collapse = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(AppNavigation, {
    active,
    module: moduleForView(active),
    tasks: 1,
    onNavigate: navigate,
    onCollapse: collapse,
  });
  app.mount(root);
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
  if (active === 'automation')
    expect(root.querySelector('[aria-label="自动运维"] .nav-badge')?.textContent).toBe('1');
  if (active !== 'terminals')
    expect(root.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(
      labels[active === 'automation' ? 2 : 1],
    );
});
