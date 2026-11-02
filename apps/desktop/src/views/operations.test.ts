import { afterEach, it, expect, vi } from 'vitest';
import { createApp, h, ref, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  feedback: vi.fn(),
  connections: vi.fn(),
  logClose: vi.fn(),
}));
vi.mock('../services/ops', () => ({ opsApi: mocks }));
import OperationsView from './OperationsView.vue';
import { useOpsStore } from '../stores/ops';
import { useHostsStore } from '../stores/hosts';
import { useNotificationsStore } from '../stores/notifications';
import type { Host } from '../types/hosts';
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
let app: App | undefined, pinia: Pinia | undefined, root: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await nextTick();
};
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.useRealTimers();
  vi.resetAllMocks();
});
it('binds confirmation to its SSH session and sends only the strict process identity fields', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  vi.useFakeTimers();
  pinia = createPinia();
  setActivePinia(pinia);
  const store = useOpsStore();
  for (const key of ['a', 'b'])
    store.connections[key] = {
      host: { id: key, name: key, hostname: '127.0.0.1', username: 'test' } as Host,
      state: 'connected',
      error: null,
      trust: null,
      session: {
        id: 'session-' + key,
        hostId: key,
        transportId: 'transport-' + key,
        routeHostIds: [key],
      },
    };
  store.active = 'a';
  useHostsStore().catalog = {
    hosts: Object.values(store.connections).map((c) => c.host),
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  mocks.feedback.mockResolvedValue([]);
  mocks.connections.mockResolvedValue([]);
  mocks.query.mockImplementation(async (_id, request) => ({
    success: true,
    message: null,
    code: null,
    detail:
      request.kind === 'capabilities'
        ? { dockerState: 'running' }
        : request.kind === 'process_details'
          ? {
              pid: 123,
              startTicks: '999',
              bootId: '11111111-1111-1111-1111-111111111111',
              executable: '/bin/sleep',
              status: { Name: 'sleep' },
            }
          : null,
    records:
      request.kind === 'processes'
        ? [{ pid: 123, user: 'test', cpu: 0, memory: 0, elapsed: '1', command: 'sleep' }]
        : [],
  }));
  root = document.createElement('div');
  document.body.append(root);
  const hostId = ref('a');
  app = createApp({ render: () => h(OperationsView, { hostId: hostId.value }) }).use(pinia);
  app.mount(root);
  await flush();
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === label,
    );
    expect(button, label).toBeDefined();
    button!.click();
    await flush();
  };
  await click('进程');
  await click('进程详情 / 信号');
  await click('发送信号…');
  expect(root.querySelector('[aria-label="运维主机"]')).toBeNull();
  hostId.value = 'b';
  await flush();
  let input = document.querySelector<HTMLInputElement>('[aria-label="确认运维目标"]')!;
  input.value = '123';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  await click('确认执行');
  expect(mocks.query.mock.calls.some(([, request]) => request.kind === 'signal')).toBe(false);
  expect(
    useNotificationsStore().items.some(
      (item) => item.error && item.text.includes('主机上下文已变化'),
    ),
  ).toBe(true);
  expect(root.textContent).not.toContain('主机上下文已变化');
  hostId.value = 'a';
  await flush();
  await click('进程详情 / 信号');
  await click('发送信号…');
  input = document.querySelector<HTMLInputElement>('[aria-label="确认运维目标"]')!;
  input.value = '123';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  await click('确认执行');
  const sent = mocks.query.mock.calls.find(([, request]) => request.kind === 'signal');
  expect(sent).toEqual([
    'session-a',
    {
      kind: 'signal',
      pid: 123,
      startTicks: '999',
      bootId: '11111111-1111-1111-1111-111111111111',
      signal: 'TERM',
      confirmed: true,
    },
  ]);
});
