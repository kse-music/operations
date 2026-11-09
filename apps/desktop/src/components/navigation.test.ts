import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import AppNavigation from './AppNavigation.vue';
import { isSettingsView, settingsNavigation } from '../types/navigation';
let app: App, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
});
it.each([
  ['terminals', false],
  ['plugins', false],
  [null, false],
  ['terminals', true],
  ['plugins', true],
  [null, true],
] as const)(
  'keeps application entries available with %s active and collapsed=%s',
  (active, collapsed) => {
    const navigate = vi.fn();
    const expand = vi.fn();
    root = document.createElement('div');
    document.body.append(root);
    app = createApp(AppNavigation, {
      localActive: active === 'terminals',
      settingsOpen: false,
      collapsed,
      onNavigate: navigate,
      onExpand: expand,
    });
    app.mount(root);
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((node) => node.ariaLabel)).toEqual(
      collapsed ? ['展开主机列表', '本地终端', '设置'] : ['本地终端', '设置'],
    );
    for (const node of buttons) node.click();
    expect(navigate.mock.calls.map(([view]) => view)).toEqual(['terminals', 'settings']);
    expect(expand).toHaveBeenCalledTimes(collapsed ? 1 : 0);
    expect(root.querySelectorAll('.nav-label')).toHaveLength(collapsed ? 0 : 2);
    expect(root.querySelectorAll('.sidebar-app-actions button')).toHaveLength(1);
    if (collapsed) for (const node of buttons) expect(node.title).toBe(node.ariaLabel);
    expect(root.querySelector('[aria-current="page"]')?.getAttribute('aria-label') ?? null).toBe(
      active === 'terminals' ? '本地终端' : null,
    );
  },
);
it('routes all seven settings entries to the dialog while keeping host and plugin functions in the workspace', () => {
  expect(settingsNavigation.map((item) => item.label)).toEqual([
    '通用',
    '终端',
    '快捷键',
    '数据与存储',
    '模型',
    '插件',
    '关于',
  ]);
  for (const item of settingsNavigation) expect(isSettingsView(item.view)).toBe(true);
  for (const view of ['terminals', 'files', 'server', 'extension'] as const)
    expect(isSettingsView(view)).toBe(false);
});
