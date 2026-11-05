import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import Docker from './App.vue';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import { hostInput } from '@serverdeck/plugin-sdk/types/hosts';
const api = vi.hoisted(() => ({ query: vi.fn(), feedback: vi.fn(async () => []) }));
vi.mock('@serverdeck/plugin-sdk/services/ops', () => ({ opsApi: api }));
let app: App, pinia: Pinia, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await nextTick();
};
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.restoreAllMocks();
});
it('loads its container details without environment secrets and requires the exact image target before removal', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  pinia = createPinia();
  setActivePinia(pinia);
  useOpsStore().connections.host = {
    host: { ...hostInput(), id: 'host', createdAt: '', updatedAt: '' },
    state: 'connected',
    error: null,
    trust: null,
    session: { id: 'lease', hostId: 'host', transportId: 'transport', routeHostIds: ['host'] },
  };
  api.query.mockImplementation(async (_id, request) => ({
    success: true,
    message: null,
    code: null,
    detail:
      request.kind === 'capabilities'
        ? { dockerState: 'running' }
        : request.kind === 'container_details'
          ? { id: 'container', image: 'owned-image', environment: ['TOKEN=[已隐藏]'] }
          : null,
    records:
      request.kind === 'containers'
        ? [{ ID: 'container', Names: 'owned-container' }]
        : request.kind === 'images'
          ? [{ ID: 'image', Repository: 'owned-image' }]
          : [],
  }));
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(Docker, { hostId: 'host' }).use(pinia);
  app.mount(root);
  await settle();
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    button!.click();
    await settle();
  };
  await click('详情');
  expect(api.query).toHaveBeenCalledWith('lease', {
    kind: 'container_details',
    id: 'container',
    revealEnv: false,
    confirmed: false,
  });
  expect(document.querySelector('dialog')?.textContent).toContain('TOKEN=[已隐藏]');
  document.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  await settle();
  await click('镜像');
  await click('删除镜像');
  expect(api.query.mock.calls.some(([, request]) => request.kind === 'image_remove')).toBe(false);
  const target = document.querySelector<HTMLInputElement>('[aria-label="确认运维目标"]')!;
  target.value = 'image';
  target.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  await click('确认执行');
  expect(api.query).toHaveBeenCalledWith('lease', {
    kind: 'image_remove',
    id: 'image',
    confirmed: true,
  });
  api.query.mockResolvedValue({
    success: false,
    message: 'Docker daemon unavailable',
    code: 'UNAVAILABLE',
    detail: null,
    records: [],
  });
  await click('刷新运维列表');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('Docker daemon unavailable');
  expect(root.querySelector('.docker-summary strong')?.textContent).toBe('—');
});
