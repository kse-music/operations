import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import AppNavigation from './AppNavigation.vue';
import { isSettingsView, settingsNavigation } from '../types/navigation';
let app: App, root: HTMLDivElement;
function mountNavigation(props: Record<string, unknown>): void {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(AppNavigation, props);
  app.mount(root);
}
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.restoreAllMocks();
});
it.each(['home', 'local', 'settings'] as const)(
  'keeps the three fixed navigation entries in area %s',
  (area) => {
    const home = vi.fn(),
      local = vi.fn(),
      settings = vi.fn();
    mountNavigation({ area, onHome: home, onLocal: local, onSettings: settings });
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((button) => button.ariaLabel)).toEqual(['首页', '本地终端', '设置']);
    for (const button of buttons) {
      expect(button.title).toBe(button.ariaLabel);
      button.click();
    }
    expect(home).toHaveBeenCalledOnce();
    expect(local).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledOnce();
    expect(root.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(
      { home: '首页', local: '本地终端', settings: '设置' }[area],
    );
    expect(root.querySelectorAll('.sidebar-work-actions button')).toHaveLength(2);
    expect(root.querySelectorAll('.sidebar-app-actions button')).toHaveLength(1);
    expect(root.querySelector('[aria-label="本地终端（管理员）"]')).toBeNull();
  },
);
it('disables navigation while settings are saving', () => {
  const home = vi.fn();
  mountNavigation({ area: 'settings', disabled: true, onHome: home });
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
  expect(buttons.every((button) => button.disabled)).toBe(true);
  buttons[0]!.click();
  expect(home).not.toHaveBeenCalled();
});
it('routes all seven settings entries to the settings page while keeping host and plugin functions in the workspace', () => {
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
