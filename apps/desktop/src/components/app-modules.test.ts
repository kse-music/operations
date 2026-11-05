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
  app = createApp(AppModules, { active: 'assets', onSelect: select });
  app.mount(root);
  expect(
    [...root.querySelectorAll('.module-navigation button')].map((button) =>
      button.textContent?.trim(),
    ),
  ).toEqual(['主机运维', '资产管理', '插件', '设置']);
  expect(root.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('资产管理');
  for (const button of root.querySelectorAll<HTMLButtonElement>('button')) button.click();
  expect(select.mock.calls.map((call) => call[0])).toEqual([
    'hosts',
    'assets',
    'plugins',
    'system',
  ]);
});
