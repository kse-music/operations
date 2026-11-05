import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import Docker from './App.vue';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import { hostInput } from '@serverdeck/plugin-sdk/types/hosts';
const api = vi.hoisted(() => ({
  query: vi.fn(),
  feedback: vi.fn(async () => []),
  logOpen: vi.fn(async () => ({ id: 'container-log', sessionId: 'lease', hostId: 'host' })),
  logClose: vi.fn(async () => {}),
}));
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
it('loads container details without secrets and delegates image removal to the host confirmation', async () => {
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
  const shell = vi.fn();
  app = createApp(Docker, { hostId: 'host', onShell: shell }).use(pinia);
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
  await click('日志');
  expect(document.querySelector('dialog')?.getAttribute('aria-label')).toBe(
    'owned-container · 日志',
  );
  expect(api.logOpen).toHaveBeenCalledWith(
    'lease',
    { source: { kind: 'container', id: 'container' }, lines: 200, follow: true },
    expect.any(Function),
  );
  document.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  await settle();
  expect(api.logClose).toHaveBeenCalledWith('container-log');
  await click('停止');
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
    (button) => button.textContent?.trim() === '确认执行',
  )!;
  expect(document.querySelector('[aria-label="确认运维目标"]')).not.toBeNull();
  expect(confirm.disabled).toBe(true);
  await click('取消');
  expect(api.query.mock.calls.some(([, request]) => request.kind === 'container_action')).toBe(
    false,
  );
  await click('Shell');
  expect(shell).toHaveBeenCalledWith(expect.objectContaining({ id: 'host' }), {
    id: 'container',
    bash: false,
    confirmed: false,
  });
  expect(document.querySelector('[aria-label="确认运维目标"]')).toBeNull();
  await click('镜像');
  await click('删除镜像');
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.querySelector('[aria-label="确认运维目标"]')).toBeNull();
  expect(api.query).toHaveBeenCalledWith('lease', {
    kind: 'image_remove',
    id: 'image',
    confirmed: true,
  });
  api.query.mockRejectedValueOnce({ code: 'PLUGIN_USER_CANCELLED', message: '操作已取消' });
  await click('删除镜像');
  expect(root.querySelector('[role="alert"]')).toBeNull();
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
