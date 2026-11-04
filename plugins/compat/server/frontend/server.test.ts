import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import PluginServerSurface from './LegacySurface.vue';
import { serverSections } from '@serverdeck/plugin-sdk/types/server';
import type { PluginUiPage } from '@serverdeck/plugin-sdk/types/plugins';
import { useHostsStore } from '@serverdeck/plugin-sdk/stores/hosts';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import { hostInput } from '@serverdeck/plugin-sdk/types/hosts';
import type { ServerSection } from '@serverdeck/plugin-sdk/types/server';
import type { MonitorSnapshot } from '@serverdeck/plugin-sdk/types/monitor';
import type { OpsResponse } from '@serverdeck/plugin-sdk/types/ops';
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
vi.mock('@serverdeck/plugin-sdk/services/monitor', () => ({ monitorApi: mocks.monitor }));
vi.mock('@serverdeck/plugin-sdk/services/ops', () => ({ opsApi: mocks.ops }));
vi.mock('@serverdeck/plugin-sdk/services/plugin-server', () => ({
  pluginServerRequest: async (
    _plugin: string,
    operation: {
      kind: string;
      request?: unknown;
      monitorId?: string;
      visible?: boolean;
      source?: unknown;
      lines?: number;
      follow?: boolean;
      logId?: string;
    },
  ) => {
    if (operation.kind === 'metrics_open') return mocks.monitor.open();
    if (operation.kind === 'metrics_snapshot') return mocks.monitor.snapshot();
    if (operation.kind === 'metrics_visible') return mocks.monitor.visible('a', operation.visible);
    if (operation.kind === 'metrics_close') return mocks.monitor.stop();
    if (operation.kind === 'system_query') return mocks.ops.query('ops-a', operation.request);
    if (operation.kind === 'system_feedback') return mocks.ops.feedback();
    if (operation.kind === 'system_log_start')
      return mocks.ops.logOpen(
        'ops-a',
        { source: operation.source, lines: operation.lines, follow: operation.follow },
        expect.any(Function),
      );
    if (operation.kind === 'system_log_poll') return { events: [] };
    if (operation.kind === 'system_log_stop') return mocks.ops.logClose(operation.logId);
    throw new Error('Unexpected capability ' + operation.kind);
  },
}));
const navigate = vi.fn();
let app: App, pinia: Pinia, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const flush = async () => {
  await vi.dynamicImportSettled();
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
  const monitor = ['overview', 'disks', 'network'].includes(section);
  const page: PluginUiPage = {
    id: 'server',
    title: 'Test',
    initialAction: null,
    fields: [],
    actions: [{ id: 'bridge', label: 'bridge', discardDirty: false, enabledWhen: null }],
    log: null,
    surface: {
      kind: monitor ? 'monitor' : 'operations',
      sections: serverSections
        .map((s) => s.key)
        .filter((key) => ['overview', 'disks', 'network'].includes(key) === monitor),
    },
  };
  app = createApp(PluginServerSurface, {
    pluginId: 'dev.test',
    hostId: 'a',
    page,
    initialSection: section,
    onNavigate: navigate,
  }).use(pinia);
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

it('renders the declared resource panels through plugin RPC and reuses its sampler', async () => {
  await mount();
  expect(root.querySelectorAll('.server-tabs [role=tab]')).toHaveLength(3);
  expect(root.querySelectorAll('.monitor-cards article')).toHaveLength(4);
  expect(root.querySelectorAll('.trend-chart')).toHaveLength(2);
  await tab('disks');
  expect(root.textContent).toContain('磁盘与挂载点');
  expect(root.querySelector('.monitor-cards, .trend-chart')).toBeNull();
  await tab('network');
  expect(root.textContent).toContain('网络接口');
  expect(mocks.monitor.open).toHaveBeenCalledTimes(1);
  app.unmount();
  expect(mocks.monitor.visible).toHaveBeenLastCalledWith('a', false);
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
it('routes container logs to a standard provider without opening a native log stream', async () => {
  await mount('containers');
  root
    .querySelector<HTMLButtonElement>('[data-ops-target="container-a"] button:nth-last-child(2)')!
    .click();
  await flush();
  expect(navigate).toHaveBeenCalledWith(
    'logs',
    expect.objectContaining({
      input: { source: { kind: 'container', id: 'container-a' }, lines: 200, follow: true },
    }),
  );
  expect(mocks.ops.logOpen).not.toHaveBeenCalled();
});
it('opens and closes a standard log resource when its view leaves', async () => {
  mocks.ops.logOpen.mockResolvedValue({ id: 'log-a' });
  await mount('logs');
  const path = root.querySelector<HTMLInputElement>('[aria-label="远程日志绝对路径"]')!;
  path.value = '/var/log/test.log';
  path.dispatchEvent(new Event('input'));
  await nextTick();
  await click('打开日志文件');
  expect(mocks.ops.logOpen).toHaveBeenCalled();
  await tab('containers');
  expect(mocks.ops.logClose).toHaveBeenCalledWith('log-a');
});
