/* eslint-disable vue/one-component-per-file -- Each test mounts an isolated component. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createApp, h, ref, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  snapshot: vi.fn(),
  visible: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../services/monitor', () => ({ monitorApi: mocks }));
import MonitorView from '../views/MonitorView.vue';
import TrendChart from './TrendChart.vue';
import type { Disk, HistoryPoint, MonitorSnapshot } from '../types/monitor';
import type { MonitorSection } from '../types/server';
import { useNotificationsStore } from '../stores/notifications';
let app: App | undefined, pinia: Pinia | undefined, root: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
};
afterEach(() => {
  app?.unmount();
  app = undefined;
  if (pinia) disposePinia(pinia);
  pinia = undefined;
  root?.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});
function mount(component: typeof MonitorView, section?: MonitorSection): void {
  root = document.createElement('div');
  document.body.append(root);
  pinia = createPinia();
  app = createApp(component, { hostId: 'host-a', section }).use(pinia);
  app.mount(root);
}
describe('monitor view lifecycle and trends', () => {
  it('pauses the backend sampler when the page unmounts without disconnecting a shared transport', async () => {
    mocks.open.mockResolvedValue({ id: 'monitor-session' });
    mocks.visible.mockResolvedValue(undefined);
    mocks.snapshot.mockResolvedValue(null);
    mount(MonitorView);
    await flush();
    expect(mocks.open).toHaveBeenCalledTimes(1);
    app!.unmount();
    app = undefined;
    await flush();
    expect(mocks.visible).toHaveBeenCalledWith('host-a', false);
    expect(mocks.stop).not.toHaveBeenCalled();
  });
  it('pauses a connection that finishes opening after the user has left the view', async () => {
    let finish: (v: unknown) => void = () => {};
    mocks.open.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.visible.mockResolvedValue(undefined);
    mount(MonitorView);
    await flush();
    app!.unmount();
    app = undefined;
    finish({ id: 'late-session' });
    await flush();
    expect(mocks.visible).toHaveBeenCalledWith('host-a', false);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it('retains its SVG across samples and leaves missing values as gaps', async () => {
    const point = (sampledAt: number, cpu: number | null): HistoryPoint => ({
      sampledAt,
      cpu,
      uptime: 1,
      memory: null,
      receiveRate: null,
      sendRate: null,
    });
    const points = ref([point(1000, 10), point(2000, null), point(3000, 20)]);
    root = document.createElement('div');
    document.body.append(root);
    app = createApp({
      render: () =>
        h(TrendChart, { points: points.value, field: 'cpu', label: 'CPU', unit: '%', max: 100 }),
    });
    app.mount(root);
    await nextTick();
    const svg = root.querySelector('svg');
    expect(root.querySelectorAll('polyline')).toHaveLength(2);
    points.value.push(point(4000, 50));
    await nextTick();
    expect(root.querySelector('svg')).toBe(svg);
    expect(root.querySelectorAll('polyline')).toHaveLength(2);
    expect(root.textContent).toContain('4 点');
  });
});

const missingCapacity = 'df 未返回该挂载点：可能是伪文件系统、重复挂载、无权限或不可访问';
function disk(overrides: Partial<Disk>): Disk {
  return {
    mount: '/',
    source: '/dev/sda1',
    filesystem: 'ext4',
    device: '8:1',
    pseudo: false,
    image: false,
    container: false,
    duplicateOf: null,
    total: null,
    used: null,
    available: null,
    usage: null,
    error: missingCapacity,
    ...overrides,
  };
}
function sampled(disks: Disk[]): MonitorSnapshot {
  return {
    hostId: 'host-a',
    sessionId: 'monitor-session',
    revision: 1,
    state: 'running',
    intervalSecs: 3,
    error: null,
    history: [],
    sample: {
      sampledAt: 1,
      uptime: 100,
      load: [0, 0, 0],
      cpus: [],
      memory: null,
      disks,
      network: [],
      warnings: [],
      rateStatus: 'initial',
      system: {
        hostname: null,
        distribution: null,
        kernel: null,
        architecture: null,
        cpuModel: null,
        cores: null,
        systemTime: null,
        timezone: null,
      },
    },
  };
}
async function showSample(snapshot: MonitorSnapshot, section?: MonitorSection) {
  mocks.open.mockResolvedValue({ id: 'monitor-session' });
  mocks.visible.mockResolvedValue(undefined);
  mocks.snapshot.mockResolvedValue(snapshot);
  mount(MonitorView, section);
  await flush();
}
describe('mount capacity notifications', () => {
  it('does not report expected missing capacity on pseudo filesystems, images or duplicate mounts, even when showing all mounts', async () => {
    await showSample(
      sampled([
        disk({ error: null, total: 1024, used: 512, available: 512, usage: 50 }),
        disk({ mount: '/proc', filesystem: 'proc', pseudo: true }),
        disk({ mount: '/snap/base', filesystem: 'squashfs', image: true }),
        disk({ mount: '/bind', duplicateOf: '/' }),
      ]),
      'disks',
    );
    const notifications = useNotificationsStore(pinia);
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(notifications.items).toHaveLength(0);
    root.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    await nextTick();
    expect(root.querySelectorAll('tbody tr')).toHaveLength(4);
    expect(root.textContent).toContain('不可用');
    expect(notifications.items).toHaveLength(0);
  });
  it('reports real persistent and container mount failures with their paths and does not repeat unchanged errors on polling', async () => {
    vi.useFakeTimers();
    const snapshot = sampled([
      disk({ mount: '/data' }),
      disk({ mount: '/containers/root', filesystem: 'overlay', container: true }),
    ]);
    snapshot.state = 'partial';
    snapshot.sample!.warnings = ['2 个挂载点容量不可用，详见磁盘列表'];
    await showSample(snapshot);
    const notifications = useNotificationsStore(pinia);
    expect(notifications.items.map((item) => item.text)).toEqual([
      `挂载点 /data：${missingCapacity}`,
      `挂载点 /containers/root：${missingCapacity}`,
    ]);
    expect(root.textContent).toContain('部分指标不可用');
    expect(root.textContent).toContain('查看采集警告（1）');
    for (const item of [...notifications.items]) notifications.dismiss(item.id);
    mocks.snapshot.mockResolvedValue({ ...snapshot, revision: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(notifications.items).toHaveLength(0);
  });
  it('still reports overall collector errors', async () => {
    await showSample({ ...sampled([]), state: 'error', error: '采集命令执行超时', sample: null });
    expect(useNotificationsStore(pinia).items).toEqual([
      expect.objectContaining({ text: '采集命令执行超时', error: true }),
    ]);
  });
});
