import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import Services from './ServiceUnits.vue';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import { useNotificationsStore } from '@serverdeck/plugin-sdk/stores/notifications';
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
it('binds queries and logs to user scope and reports a failed service action without claiming success', async () => {
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
    success: request.kind !== 'service_action',
    message: request.kind === 'service_action' ? 'permission denied' : null,
    code: request.kind === 'service_action' ? 'DENIED' : null,
    detail: { systemd: true },
    records: request.kind === 'services' ? [{ unit: 'owned.service', active: 'active' }] : [],
  }));
  const log = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(Services, { hostId: 'host', onLog: log }).use(pinia);
  app.mount(root);
  await settle();
  const scope = root.querySelector<HTMLSelectElement>('[aria-label="systemd 范围"]')!;
  scope.value = 'user';
  scope.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  expect(api.query).toHaveBeenCalledWith('lease', { kind: 'services', scope: 'user' });
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    button!.click();
    await settle();
  };
  await click('服务日志');
  expect(log).toHaveBeenCalledWith(
    { source: { kind: 'service', scope: 'user', unit: 'owned.service' }, lines: 200, follow: true },
    'owned.service',
  );
  await click('重启');
  const target = document.querySelector<HTMLInputElement>('[aria-label="确认运维目标"]')!;
  target.value = 'owned.service';
  target.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  await click('确认执行');
  expect(api.query).toHaveBeenCalledWith('lease', {
    kind: 'service_action',
    scope: 'user',
    unit: 'owned.service',
    action: 'restart',
    confirmed: true,
  });
  expect(
    useNotificationsStore().items.some(
      (item) => item.error && item.text.includes('permission denied'),
    ),
  ).toBe(true);
  expect(root.textContent).not.toContain('请求完成');
});
