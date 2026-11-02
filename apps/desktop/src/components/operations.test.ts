/* eslint-disable vue/one-component-per-file -- Tests mount isolated components. */
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { LogBuffer } from '../services/log-buffer';
const mocks = vi.hoisted(() => ({
  logOpen: vi.fn(),
  logAck: vi.fn(),
  logPause: vi.fn(),
  logClose: vi.fn(),
}));
vi.mock('../services/ops', () => ({ opsApi: mocks }));
import OpsLogPanel from './OpsLogPanel.vue';
import type { LogEvent, LogInput } from '../types/ops';
let app: App | undefined, root: HTMLDivElement | undefined;
let pinia: Pinia;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  app = undefined;
  root?.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
});
it('caps UTF-8 bytes and lines while retaining recent complete Unicode characters', () => {
  const buffer = new LogBuffer(16 * 1024, 100);
  buffer.append('中😀\n'.repeat(20000));
  buffer.append('last 中文😀\n');
  expect(buffer.byteLength).toBeLessThanOrEqual(16 * 1024);
  expect(buffer.value().split('\n').length - 1).toBeLessThanOrEqual(100);
  expect(buffer.value()).toContain('last 中文😀');
  expect(buffer.value()).not.toContain('\uFFFD');
  expect(new TextEncoder().encode(buffer.value()).length).toBe(buffer.byteLength);
  expect(buffer.dropped).toBeGreaterThan(0);
});
it('renders newly streamed log bytes, separates UTF-8 decoders, and ACKs only after rendering', async () => {
  vi.useFakeTimers();
  let receive: (event: LogEvent) => void = () => {};
  mocks.logOpen.mockImplementation(async (_id, _input, callback) => {
    receive = callback;
    return { id: 'log', sessionId: 'lease', hostId: 'host' };
  });
  mocks.logAck.mockResolvedValue(undefined);
  mocks.logClose.mockResolvedValue(undefined);
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(OpsLogPanel, { sessionId: 'lease', hostName: 'Actual host' });
  const component = app.mount(root) as unknown as {
    open: (input: LogInput, title: string) => Promise<void>;
  };
  await component.open(
    { source: { kind: 'file', path: '/tmp/file' }, lines: 10, follow: true },
    'File',
  );
  receive({ type: 'state', state: 'running', code: null, message: null });
  receive({ type: 'data', sequence: 1, stream: 'stdout', data: [228, 184], at: 1 });
  expect(mocks.logAck).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60);
  receive({
    type: 'data',
    sequence: 2,
    stream: 'stderr',
    data: Array.from(new TextEncoder().encode('stderr\n')),
    at: 2,
  });
  await vi.advanceTimersByTimeAsync(60);
  receive({
    type: 'data',
    sequence: 3,
    stream: 'stdout',
    data: [173, ...new TextEncoder().encode(' <script>literal</script>\n')],
    at: 3,
  });
  await vi.advanceTimersByTimeAsync(60);
  await nextTick();
  expect(root.querySelector('[data-testid="operations-log-output"]')?.textContent).toContain(
    '中 <script>literal</script>',
  );
  expect(root.querySelector('[data-testid="operations-log-output"]')?.textContent).not.toContain(
    '\uFFFD',
  );
  expect(root.querySelector('script')).toBeNull();
  expect(mocks.logAck).toHaveBeenCalledWith('log', 3);
  app.unmount();
  app = undefined;
  await Promise.resolve();
  expect(mocks.logClose).toHaveBeenCalledWith('log');
});
it('closes a log request that resolves after the view was removed', async () => {
  let finish: (value: unknown) => void = () => {};
  mocks.logOpen.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mocks.logClose.mockResolvedValue(undefined);
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(OpsLogPanel, { sessionId: 'lease', hostName: 'Host' });
  const component = app.mount(root) as unknown as {
    open: (input: LogInput, title: string) => Promise<void>;
  };
  const opening = component.open(
    { source: { kind: 'file', path: '/tmp/file' }, lines: 10, follow: true },
    'File',
  );
  app.unmount();
  app = undefined;
  finish({ id: 'late-log', sessionId: 'lease', hostId: 'host' });
  await opening;
  expect(mocks.logClose).toHaveBeenCalledWith('late-log');
});
