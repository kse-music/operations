import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import AppModules from './AppModules.vue';

let app: App, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
});

it('switches major modules from the header and indicates the module of the active page', () => {
  const select = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(AppModules, { active: 'system', onSelect: select });
  app.mount(root);
  expect(
    [...root.querySelectorAll('.module-navigation button')].map((button) =>
      button.textContent?.trim(),
    ),
  ).toEqual(['主机管理', '插件', '设置']);
  const icons = root.querySelectorAll('.module-navigation button > svg');
  expect(icons).toHaveLength(3);
  for (const icon of icons) {
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('width')).toBe('16');
    expect(icon.getAttribute('height')).toBe('16');
  }
  expect(root.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('设置');
  for (const button of root.querySelectorAll<HTMLButtonElement>('button')) button.click();
  expect(select.mock.calls.map((call) => call[0])).toEqual(['hosts', 'plugins', 'system']);
});
