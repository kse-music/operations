import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import StreamDialog from './StreamDialog.vue';
import { LogBuffer } from '../services/log-buffer';
import { updateVisibility } from '../visibility';
const api = vi.hoisted(() => ({ call: vi.fn(), copy: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../platform', () => ({ call: api.call }));
vi.mock('../services/clipboard', () => ({ clipboardApi: { writeText: api.copy } }));
let app: App | undefined, root: HTMLDivElement;
let resized: () => void;
const disconnected = vi.fn();
const closed = vi.fn();
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await nextTick();
};
async function mount() {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(StreamDialog, { streamId: 'owned', title: 'Command output', onClose: closed });
  app.mount(root);
  await settle();
}
beforeEach(() => {
  vi.useFakeTimers();
  api.call.mockReset();
  api.copy.mockClear();
  closed.mockClear();
  disconnected.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect = disconnected;
    },
  );
  updateVisibility(true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  api.call.mockImplementation(async (input) =>
    input.kind === 'stream_poll' ? { events: [] } : null,
  );
});
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await settle();
  root?.remove();
  updateVisibility(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('caps UTF-8 bytes and lines while retaining recent complete Unicode characters', () => {
  const buffer = new LogBuffer(16 * 1024, 100);
  buffer.append('中😀\n'.repeat(20000));
  buffer.append('last 中文😀\n');
  expect(buffer.byteLength).toBeLessThanOrEqual(16 * 1024);
  expect(buffer.value().split('\n').length - 1).toBeLessThanOrEqual(100);
  expect(buffer.value()).toContain('last 中文😀\n');
  expect(buffer.value()).not.toContain('�');
  expect(new TextEncoder().encode(buffer.value()).length).toBe(buffer.byteLength);
  expect(buffer.dropped).toBeGreaterThan(0);
});
it('clears retained log data and resets its budget before receiving new output', () => {
  const buffer = new LogBuffer(16 * 1024, 100);
  buffer.append('old 中文😀\n'.repeat(20000));
  expect(buffer.dropped).toBeGreaterThan(0);
  buffer.clear();
  expect(buffer.value()).toBe('');
  expect(buffer.byteLength).toBe(0);
  expect(buffer.dropped).toBe(0);
  const fresh = 'new 中文😀\n'.repeat(100);
  buffer.append(fresh);
  expect(buffer.value()).toBe(fresh);
});

it('clears all local history, keeps the filter and copies/exports only subsequently received logs', async () => {
  let line = 'old visible\nold hidden\n';
  api.call.mockImplementation(async (input) =>
    input.kind === 'stream_poll' ? { events: [{ type: 'data', dataBase64: btoa(line) }] } : null,
  );
  await mount();
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === label,
    )!;
  const filter = document.querySelector<HTMLInputElement>('[aria-label="过滤输出"]')!;
  filter.value = 'visible';
  filter.dispatchEvent(new Event('input'));
  await settle();
  const output = document.querySelector<HTMLPreElement>('pre')!;
  Object.defineProperties(output, {
    scrollHeight: { get: () => 1000 },
    clientHeight: { get: () => 200 },
  });
  output.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
  output.scrollTop = 100;
  output.dispatchEvent(new Event('scroll'));
  await settle();
  expect(document.body.textContent).toContain('查看历史 · 新日志继续接收');
  const calls = api.call.mock.calls.length;
  button('清屏').click();
  await settle();
  expect(api.call).toHaveBeenCalledTimes(calls);
  expect(filter.value).toBe('visible');
  expect(document.querySelector('pre')?.textContent).not.toContain('old');
  filter.value = '';
  filter.dispatchEvent(new Event('input'));
  await settle();
  expect(document.querySelector('pre')?.textContent).toContain('等待输出');
  line = 'new log\n';
  await vi.advanceTimersByTimeAsync(200);
  await settle();
  expect(document.querySelector('pre')?.textContent).toBe(line);
  expect(document.body.textContent).toContain('实时跟踪 · 自动滚动到最新');
  button('复制').click();
  await settle();
  expect(api.copy).toHaveBeenLastCalledWith(line);
  const exportedParts: BlobPart[][] = [];
  const BrowserBlob = Blob;
  vi.stubGlobal(
    'Blob',
    class extends BrowserBlob {
      constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
        super(parts, options);
        exportedParts.push(parts);
      }
    },
  );
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:cleared'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  button('导出').click();
  expect(exportedParts).toEqual([[line]]);
  expect(api.call.mock.calls.every(([input]) => input.kind === 'stream_poll')).toBe(true);
});

it.each(['paused', 'failed'])(
  'clears displayed logs while preserving the %s state',
  async (state) => {
    api.call.mockImplementation(async (input) =>
      input.kind === 'stream_poll'
        ? {
            events: [
              { type: 'data', dataBase64: btoa('old log\n') },
              ...(state === 'failed' ? [{ type: 'state', state, message: 'remote failed' }] : []),
            ],
          }
        : null,
    );
    await mount();
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === label,
      )!;
    if (state === 'paused') {
      button('暂停').click();
      await settle();
    }
    const calls = api.call.mock.calls.length;
    button('清屏').click();
    await settle();
    expect(api.call).toHaveBeenCalledTimes(calls);
    expect(document.querySelector('pre')?.textContent).not.toContain('old log');
    if (state === 'paused') {
      expect(button('继续')).toBeDefined();
      expect(document.body.textContent).toContain('已暂停');
    } else {
      expect(document.querySelector('[role="alert"]')?.textContent).toBe('remote failed');
      expect(document.body.textContent).toContain('读取失败');
    }
  },
);
it('renders split UTF-8 streams as plain text and never reopens the command', async () => {
  let count = 0;
  api.call.mockImplementation(async (input) =>
    input.kind === 'stream_poll'
      ? {
          events:
            ++count === 1
              ? [
                  {
                    type: 'data',
                    stream: 'stdout',
                    dataBase64: btoa(String.fromCharCode(228, 184)),
                  },
                  {
                    type: 'data',
                    stream: 'stderr',
                    dataBase64: btoa('<script>remote()</script>\n'),
                  },
                ]
              : [
                  { type: 'data', stream: 'stdout', dataBase64: btoa(String.fromCharCode(173)) },
                  { type: 'state', state: 'closed' },
                ],
        }
      : null,
  );
  await mount();
  expect(document.querySelector('script')).toBeNull();
  await vi.advanceTimersByTimeAsync(200);
  await settle();
  expect(document.querySelector('pre')?.textContent).toContain('中');
  expect(document.querySelector('pre')?.textContent).toContain('<script>remote()</script>');
  expect(
    api.call.mock.calls.every(([input]) => !['stream_open', 'execute'].includes(input.kind)),
  ).toBe(true);
});
it('ignores a late poll response after unmount and still closes its owned stream', async () => {
  let finish!: (value: unknown) => void;
  api.call.mockImplementation((input) =>
    input.kind === 'stream_poll'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(null),
  );
  await mount();
  app!.unmount();
  app = undefined;
  finish({ events: [{ type: 'data', dataBase64: btoa('late') }] });
  await settle();
  expect(api.call).toHaveBeenCalledWith({ kind: 'stream_stop', streamId: 'owned' });
  expect(closed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('retains a failed close for retry and stops when hidden', async () => {
  let attempts = 0;
  api.call.mockImplementation(async (input) => {
    if (input.kind === 'stream_stop' && ++attempts === 1)
      throw { code: 'IO', message: 'close failed' };
    return input.kind === 'stream_poll' ? { events: [] } : null;
  });
  await mount();
  document.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  await settle();
  expect(document.body.textContent).toContain('close failed');
  expect(closed).not.toHaveBeenCalled();
  updateVisibility(false);
  await settle();
  expect(attempts).toBe(2);
  expect(closed).toHaveBeenCalledOnce();
});
it('pauses and resumes the owned stream without reopening it and copies only visible text', async () => {
  api.call.mockImplementation(async (input) =>
    input.kind === 'stream_poll'
      ? { events: [{ type: 'data', dataBase64: btoa('one\ntwo\n') }] }
      : null,
  );
  await mount();
  const button = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === '暂停' || node.textContent?.trim() === '继续',
    )!;
  button().click();
  await settle();
  expect(api.call).toHaveBeenCalledWith({ kind: 'stream_pause', streamId: 'owned', paused: true });
  button().click();
  await settle();
  expect(api.call).toHaveBeenCalledWith({ kind: 'stream_pause', streamId: 'owned', paused: false });
  const filter = document.querySelector<HTMLInputElement>('[aria-label="过滤输出"]')!;
  filter.value = 'two';
  filter.dispatchEvent(new Event('input'));
  await settle();
  [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === '复制')!
    .click();
  await settle();
  expect(api.copy).toHaveBeenCalledWith('two');
});
it('records a cleanup fault on unmount instead of silently swallowing it', async () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  api.call.mockImplementation(async (input) => {
    if (input.kind === 'stream_stop') throw { code: 'IO', message: 'private details' };
    return { events: [] };
  });
  await mount();
  app!.unmount();
  app = undefined;
  await settle();
  expect(report).toHaveBeenCalledWith('Plugin stream cleanup failed', 'IO');
  expect(report.mock.calls.flat()).not.toContain('private details');
});

it('follows the rendered tail, preserves history and returns to latest after resume or resize', async () => {
  let line = 'initial';
  api.call.mockImplementation(async (input) =>
    input.kind === 'stream_poll'
      ? { events: [{ type: 'data', dataBase64: btoa(`${line}\n`) }] }
      : null,
  );
  await mount();
  const output = document.querySelector<HTMLPreElement>('.platform-stream-output')!;
  let height = 1000;
  Object.defineProperties(output, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => 200 },
  });
  const scrollTop = vi.spyOn(output, 'scrollTop', 'set');
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === label,
    )!;
  line = 'first poll';
  await vi.advanceTimersByTimeAsync(200);
  await settle();
  expect(scrollTop).toHaveBeenLastCalledWith(1000);
  expect(output.textContent).toContain(line);
  output.scrollTop = 100;
  output.dispatchEvent(new Event('scroll'));
  await settle();
  expect(document.body.textContent).toContain('查看历史 · 新日志继续接收');
  scrollTop.mockClear();
  height = 1200;
  line = 'arrived while reading history';
  await vi.advanceTimersByTimeAsync(200);
  await settle();
  expect(output.textContent).toContain(line);
  expect(output.scrollTop).toBe(100);
  expect(scrollTop).not.toHaveBeenCalled();
  resized();
  expect(scrollTop).not.toHaveBeenCalled();
  button('最新日志').click();
  await settle();
  expect(scrollTop).toHaveBeenLastCalledWith(1200);
  button('暂停').click();
  await settle();
  scrollTop.mockClear();
  height = 1400;
  line = 'queued output after pause';
  await vi.advanceTimersByTimeAsync(200);
  await settle();
  expect(scrollTop).not.toHaveBeenCalled();
  resized();
  expect(scrollTop).not.toHaveBeenCalled();
  button('继续').click();
  await settle();
  expect(scrollTop).toHaveBeenLastCalledWith(1400);
  height = 1600;
  resized();
  expect(scrollTop).toHaveBeenLastCalledWith(1600);
  // Manually returning within the tail threshold also resumes following.
  output.scrollTop = 1380;
  output.dispatchEvent(new Event('scroll'));
  line = 'manual tail follow';
  await vi.advanceTimersByTimeAsync(200);
  await settle();
  expect(scrollTop).toHaveBeenLastCalledWith(1600);
  app!.unmount();
  app = undefined;
  expect(disconnected).toHaveBeenCalledOnce();
});

it('preserves follow intent when resize scroll arrives before ResizeObserver and filtering clamps history', async () => {
  api.call.mockImplementation(async (input) =>
    input.kind === 'stream_poll'
      ? { events: [{ type: 'data', dataBase64: btoa('match line\nother line\n') }] }
      : null,
  );
  await mount();
  const output = document.querySelector<HTMLPreElement>('.platform-stream-output')!;
  let height = 1000,
    viewport = 200,
    top = 0;
  Object.defineProperties(output, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => viewport },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - viewport));
      },
      configurable: true,
    },
  });
  resized();
  expect(top).toBe(800);
  // Shrinking a viewport changes the tail gap without moving the scroll offset.
  viewport = 100;
  output.dispatchEvent(new Event('scroll'));
  await settle();
  expect(document.body.textContent).toContain('实时跟踪 · 自动滚动到最新');
  resized();
  expect(top).toBe(900);
  // A real upward movement still opts out, including during a layout change.
  output.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
  viewport = 150;
  output.scrollTop = 300;
  output.dispatchEvent(new Event('scroll'));
  await settle();
  expect(document.body.textContent).toContain('查看历史 · 新日志继续接收');
  const filter = document.querySelector<HTMLInputElement>('[aria-label="过滤输出"]')!;
  filter.value = 'no matches';
  height = viewport;
  top = 0; // Browser clamps the offset as filtered content becomes empty.
  filter.dispatchEvent(new Event('input'));
  await settle();
  output.dispatchEvent(new Event('scroll'));
  await settle();
  expect(output.textContent).toContain('没有匹配的日志');
  expect(document.body.textContent).toContain('查看历史 · 新日志继续接收');
  height = 1000;
  filter.value = '';
  filter.dispatchEvent(new Event('input'));
  await settle();
  resized();
  expect(top).toBe(0);
  expect(output.textContent).toContain('match line');
  output.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }));
  app!.unmount();
  app = undefined;
  expect(vi.getTimerCount()).toBe(0);
});
