import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@serverdeck/plugin-sdk', () => ({
  invoke,
  errorMessage: (value: Error) => value.message,
}));
import Example from './App.vue';
let app: App | undefined, root: HTMLElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.resetAllMocks();
});
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
it('calls its own greeting action and displays the actual result', async () => {
  invoke.mockResolvedValue({ output: 'Hello Ada' });
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(Example);
  app.mount(root);
  const input = root.querySelector('input')!;
  input.value = 'Ada';
  input.dispatchEvent(new Event('input'));
  await nextTick();
  root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  expect(invoke).toHaveBeenCalledWith('greet', { name: 'Ada' });
  expect(root.textContent).toContain('Hello Ada');
});
it('passes an explicit host to its own inspection action and shows errors without stale data', async () => {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(Example, { page: { id: 'host' } as never, hostId: 'host-a' });
  app.mount(root);
  invoke.mockResolvedValueOnce({
    total: 1000,
    used: 200,
    available: 800,
    status: 'Healthy',
    sampledAt: 0,
  });
  root.querySelector('button')!.click();
  await settle();
  expect(invoke).toHaveBeenCalledWith('inspect_memory', { hostId: 'host-a' });
  expect(root.textContent).toContain('Healthy');
  invoke.mockRejectedValueOnce(new Error('SSH unavailable'));
  root.querySelector('button')!.click();
  await settle();
  expect(root.textContent).toContain('SSH unavailable');
  expect(root.textContent).not.toContain('Healthy');
});
