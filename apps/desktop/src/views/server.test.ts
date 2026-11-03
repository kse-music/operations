import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import ServerView from './ServerView.vue';
import { useHostsStore } from '../stores/hosts';
import { useOpsStore } from '../stores/ops';
import { hostInput } from '../types/hosts';
import type { ServerSection } from '../types/server';
import type { MonitorSnapshot } from '../types/monitor';
import type { OpsResponse } from '../types/ops';
const mocks = vi.hoisted(() => ({
  monitor: { open: vi.fn(), snapshot: vi.fn(), visible: vi.fn(), stop: vi.fn() },
  ops: {
    query: vi.fn(),
    feedback: vi.fn(),
    connections: vi.fn(),
    logOpen: vi.fn(),
    logClose: vi.fn(),
  },
}));
vi.mock('../services/monitor', () => ({ monitorApi: mocks.monitor }));
vi.mock('../services/ops', () => ({ opsApi: mocks.ops }));
let app: App, pinia: Pinia, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await nextTick();
};
const response = (detail: Record<string, unknown> | null = null): OpsResponse => ({
  success: true,
  message: null,
  code: null,
  records: [],
  detail,
});
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  pinia = createPinia();
  setActivePinia(pinia);
  const host = {
    ...hostInput(),
    id: 'a',
    name: 'Server A',
    hostname: '192.0.2.1',
    createdAt: '',
    updatedAt: '',
  };
  useHostsStore().catalog = {
    hosts: [host],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  useOpsStore().connections.a = {
    host,
    state: 'connected',
    error: null,
    trust: null,
    session: { id: 'ops-a', hostId: 'a', transportId: 'transport-a', routeHostIds: ['a'] },
  };
  mocks.monitor.open.mockResolvedValue({ id: 'monitor-a' });
  mocks.monitor.visible.mockResolvedValue(undefined);
  mocks.monitor.snapshot.mockResolvedValue({
    hostId: 'a',
    sessionId: 'monitor-a',
    revision: 1,
    state: 'running',
    intervalSecs: 3,
    error: null,
    history: [],
    sample: {
      sampledAt: 1,
      uptime: 900,
      load: [1, 2, 3],
      cpus: [{ name: 'cpu', usage: 20, iowait: 1 }],
      memory: null,
      disks: [],
      network: [],
      warnings: [],
      rateStatus: 'ok',
      system: {
        hostname: 'server-a',
        distribution: 'Linux',
        kernel: '6',
        architecture: 'x86_64',
        cpuModel: 'CPU',
        cores: 4,
        systemTime: null,
        timezone: null,
      },
    },
  } satisfies MonitorSnapshot);
  mocks.ops.feedback.mockResolvedValue([]);
  mocks.ops.logClose.mockResolvedValue(undefined);
  mocks.ops.connections.mockResolvedValue([]);
  mocks.ops.query.mockImplementation(async (_id, request) => {
    if (request.kind === 'capabilities') return response({ dockerState: 'running' });
    if (request.kind === 'process_details')
      return response({ pid: 123, startTicks: '99', bootId: 'boot-a', executable: '/bin/sleep' });
    return {
      ...response(),
      records:
        request.kind === 'processes'
          ? [{ pid: 123, command: 'sleep', cpu: 0 }]
          : request.kind === 'containers'
            ? [{ ID: 'container-a', Names: 'web' }]
            : [],
    };
  });
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
});
async function mount(section: ServerSection = 'overview') {
  app = createApp(ServerView, { hostId: 'a', initialSection: section }).use(pinia);
  app.mount(root);
  await flush();
}
async function tab(section: ServerSection) {
  root.querySelector<HTMLButtonElement>(`#server-tab-${section}`)!.click();
  await flush();
}
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  expect(button, text).toBeDefined();
  button!.click();
  await flush();
}

it('separates resource panels, reuses sampling between resource tabs, and pauses when entering operations', async () => {
  await mount();
  expect(root.querySelectorAll('.server-tabs [role=tab]')).toHaveLength(9);
  expect(root.querySelectorAll('.monitor-cards article')).toHaveLength(4);
  expect(root.querySelectorAll('.trend-chart')).toHaveLength(2);
  expect(root.textContent).not.toContain('磁盘与挂载点');
  await tab('disks');
  expect(root.textContent).toContain('磁盘与挂载点');
  expect(root.querySelector('.monitor-cards, .trend-chart')).toBeNull();
  await tab('network');
  expect(root.textContent).toContain('网络接口');
  expect(root.querySelectorAll('.trend-chart')).toHaveLength(2);
  expect(mocks.monitor.open).toHaveBeenCalledTimes(1);
  await tab('processes');
  expect(mocks.monitor.visible).toHaveBeenLastCalledWith('a', false);
  expect(mocks.monitor.stop).not.toHaveBeenCalled();
  expect(root.querySelector('[data-ops-target="123"]')).not.toBeNull();
  await tab('overview');
  expect(mocks.monitor.open).toHaveBeenCalledTimes(2);
});
it('puts system information in a dialog and supports keyboard tab selection', async () => {
  await mount();
  await click('系统信息');
  expect(root.querySelector('.monitor-system')).toBeNull();
  expect(document.querySelector('dialog')?.textContent).toContain('server-a');
  document.querySelector<HTMLButtonElement>('dialog [aria-label="关闭对话框"]')!.click();
  await flush();
  root
    .querySelector('#server-tab-overview')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await flush();
  expect(document.activeElement?.id).toBe('server-tab-disks');
  expect(root.querySelector('#server-tab-disks')?.getAttribute('aria-selected')).toBe('true');
});
it('does not reopen a closed process dialog when its delayed response arrives', async () => {
  await mount('processes');
  let finish!: (value: OpsResponse) => void;
  mocks.ops.query.mockImplementationOnce(
    () =>
      new Promise<OpsResponse>((resolve) => {
        finish = resolve;
      }),
  );
  await click('进程详情 / 信号');
  expect(document.querySelector('dialog')?.textContent).toContain('正在读取详情');
  document.querySelector<HTMLButtonElement>('dialog [aria-label="关闭对话框"]')!.click();
  await flush();
  finish(response({ executable: '/bin/stale' }));
  await flush();
  expect(document.querySelector('dialog')).toBeNull();
  expect(root.textContent).not.toContain('/bin/stale');
});
it('shows detail failures without stale details and clears the dialog on section changes', async () => {
  await mount('processes');
  mocks.ops.query.mockRejectedValueOnce(new Error('读取详情失败'));
  await click('进程详情 / 信号');
  expect(document.querySelector('dialog [role=alert]')?.textContent).toContain('读取详情失败');
  expect(document.querySelector('[data-testid=operations-detail]')).toBeNull();
  await tab('ports');
  expect(document.querySelector('dialog')).toBeNull();
});
it('opens container logs in the Logs tab and closes the stream when leaving that tab', async () => {
  mocks.ops.logOpen.mockResolvedValue({ id: 'log-a' });
  await mount('containers');
  root
    .querySelector<HTMLButtonElement>('[data-ops-target="container-a"] button:nth-last-child(2)')!
    .click();
  await flush();
  expect(root.querySelector('#server-tab-logs')?.getAttribute('aria-selected')).toBe('true');
  expect(mocks.ops.logOpen).toHaveBeenCalledWith(
    'ops-a',
    { source: { kind: 'container', id: 'container-a' }, lines: 200, follow: true },
    expect.any(Function),
  );
  await tab('containers');
  expect(mocks.ops.logClose).toHaveBeenCalledWith('log-a');
});
