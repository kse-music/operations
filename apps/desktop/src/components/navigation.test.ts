import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import AppNavigation from './AppNavigation.vue';

let app: App, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
});
it('puts only workspaces and independent tools in global navigation', () => {
  const navigate = vi.fn();
  const workspace = vi.fn();
  const about = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(AppNavigation, {
    active: 'operations',
    tasks: 1,
    onNavigate: navigate,
    onWorkspace: workspace,
    onAbout: about,
  });
  app.mount(root);
  const buttons = root.querySelectorAll<HTMLButtonElement>('button');
  expect(buttons).toHaveLength(9);
  for (const button of buttons) {
    expect(button.getAttribute('aria-label')).toBe(button.getAttribute('data-tooltip'));
    expect(button.querySelector('svg')).not.toBeNull();
    button.click();
  }
  expect(navigate).toHaveBeenCalledTimes(7);
  expect(workspace).toHaveBeenCalledOnce();
  expect(about).toHaveBeenCalledOnce();
  expect(root.querySelector('[aria-label="关于"] .nav-label')?.textContent).toBe('关于');
  expect(root.querySelector('[aria-label="SFTP 文件"]')).toBeNull();
  expect(root.querySelector('[aria-label="主机工作区"]')).toBeNull();
  expect(root.querySelector('[aria-label="主机管理"] .nav-label')?.textContent).toBe('主机管理');
  expect(root.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('主机管理');
  expect(root.querySelector('[aria-label="主机管理"] small')).toBeNull();
  expect(root.querySelector('[aria-label="自动运维"] .nav-label')?.textContent).toBe('自动运维');
  expect(root.querySelector('[aria-label="自动运维"] small')?.textContent).toBe('1');
});
