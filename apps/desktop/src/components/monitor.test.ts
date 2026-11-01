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
import type { HistoryPoint } from '../types/monitor';
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
});
function mount(component: typeof MonitorView): void {
  root = document.createElement('div');
  document.body.append(root);
  pinia = createPinia();
  app = createApp(component, { hostId: 'host-a' }).use(pinia);
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
