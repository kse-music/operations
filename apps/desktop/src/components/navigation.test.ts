import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import AppNavigation from './AppNavigation.vue';

let app: App, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
});
it('keeps every module accessible with named icons, current page and task counts', () => {
  const navigate = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(AppNavigation, {
    active: 'operations',
    terminals: 3,
    transfers: 2,
    tasks: 1,
    onNavigate: navigate,
  });
  app.mount(root);
  const buttons = root.querySelectorAll<HTMLButtonElement>('button');
  expect(buttons).toHaveLength(12);
  for (const button of buttons) {
    expect(button.getAttribute('aria-label')).toBe(button.getAttribute('data-tooltip'));
    expect(button.querySelector('svg')).not.toBeNull();
    button.click();
  }
  expect(navigate).toHaveBeenCalledTimes(12);
  expect(navigate).toHaveBeenCalledWith('files');
  expect(root.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(
    'Linux 运维',
  );
  expect(root.querySelector('[aria-label="SSH 终端"] small')?.textContent).toBe('3');
});
