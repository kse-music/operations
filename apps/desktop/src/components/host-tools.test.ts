import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import HostTools from './HostTools.vue';

let app: App, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
});

it.each([false, true])('scopes secondary tools to the selected host (local=%s)', (local) => {
  const navigate = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostTools, {
    active: local ? 'terminals' : 'files',
    local,
    onNavigate: navigate,
  });
  app.mount(root);
  expect(root.querySelectorAll('button')).toHaveLength(local ? 1 : 4);
  expect(root.querySelector('[aria-current="page"]')?.textContent).toContain(
    local ? 'Shell' : 'SFTP',
  );
  root.querySelector<HTMLButtonElement>('[aria-current="page"]')!.click();
  expect(navigate).toHaveBeenCalledWith(local ? 'terminals' : 'files');
  expect(root.querySelector('[aria-label="网络诊断"]')).toBeNull();
});
