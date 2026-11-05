import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import ResourceLogDialog from './ResourceLogDialog.vue';
import { LogBuffer } from '../services/log-buffer';
import type { LogEvent, LogInput, LogSession } from '../types/ops';
import { updateVisibility } from '../visibility';
const api = { logOpen: vi.fn(), logAck: vi.fn(), logPause: vi.fn(), logClose: vi.fn() };
const input: LogInput = {
  source: { kind: 'service', scope: 'user', unit: 'owned.service' },
  lines: 200,
  follow: true,
};
let app: App | undefined, root: HTMLElement, pinia: Pinia;
let receive: (event: LogEvent) => void;
const closed = vi.fn();
const reported = vi.fn();
async function settle() {
  for (let n = 0; n < 12; n++) await Promise.resolve();
  await nextTick();
}
async function mount() {
  root = document.createElement('div');
  document.body.append(root);
  pinia = createPinia();
  app = createApp(ResourceLogDialog, {
    sessionId: 'lease',
    input,
    title: 'owned.service',
    api,
    onClose: closed,
    reportError: reported,
  }).use(pinia);
  app.mount(root);
  await settle();
}
beforeEach(() => {
  vi.resetAllMocks();
  updateVisibility(true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  api.logOpen.mockImplementation(async (_id, _input, callback) => {
    receive = callback;
    return { id: 'log', sessionId: 'lease', hostId: 'host' };
  });
  api.logClose.mockResolvedValue(undefined);
  api.logAck.mockResolvedValue(undefined);
  api.logPause.mockResolvedValue(undefined);
});
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await settle();
  if (pinia) disposePinia(pinia);
  root?.remove();
  updateVisibility(true);
  vi.restoreAllMocks();
});

it('caps UTF-8 bytes and lines while retaining recent complete Unicode characters', () => {
  const buffer = new LogBuffer(16 * 1024, 100);
  buffer.append('中😀\n'.repeat(20000));
  buffer.append('last 中文😀\n');
  expect(buffer.byteLength).toBeLessThanOrEqual(16 * 1024);
  expect(buffer.value().split('\n').length - 1).toBeLessThanOrEqual(100);
  expect(buffer.value()).toContain('last 中文😀\n');
  expect(buffer.value()).not.toContain('\uFFFD');
  expect(new TextEncoder().encode(buffer.value()).length).toBe(buffer.byteLength);
  expect(buffer.dropped).toBeGreaterThan(0);
});
it('renders bounded stream bytes as plain text with separate UTF-8 decoders and ACK after rendering', async () => {
  await mount();
  expect(api.logOpen).toHaveBeenCalledWith('lease', input, expect.any(Function));
  receive({ type: 'state', state: 'running', code: null, message: null });
  receive({ type: 'data', sequence: 1, stream: 'stdout', data: [228, 184], at: 1 });
  expect(api.logAck).not.toHaveBeenCalled();
  await settle();
  receive({
    type: 'data',
    sequence: 2,
    stream: 'stderr',
    data: [...new TextEncoder().encode('stderr\n')],
    at: 2,
  });
  await settle();
  receive({
    type: 'data',
    sequence: 3,
    stream: 'stdout',
    data: [173, ...new TextEncoder().encode(' <script>literal</script>\n')],
    at: 3,
  });
  await settle();
  const output = document.querySelector('[data-testid="operations-log-output"]')!;
  expect(output.textContent).toContain('中 <script>literal</script>');
  expect(output.textContent).not.toContain('\uFFFD');
  expect(document.querySelector('script')).toBeNull();
  expect(api.logAck).toHaveBeenCalledWith('log', 3);
  const filter = document.querySelector<HTMLInputElement>('[aria-label="日志关键词"]')!;
  filter.value = 'literal';
  filter.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(output.textContent).not.toContain('stderr');
  document.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  await settle();
  expect(api.logClose).toHaveBeenCalledWith('log');
  expect(closed).toHaveBeenCalledOnce();
});
it('closes a late log session after the dialog was removed and ignores late output', async () => {
  let finish!: (value: LogSession) => void;
  api.logOpen.mockImplementation((_id, _input, callback) => {
    receive = callback;
    return new Promise<LogSession>((resolve) => {
      finish = resolve;
    });
  });
  await mount();
  app!.unmount();
  app = undefined;
  receive({ type: 'data', sequence: 1, stream: 'stdout', data: [65], at: 1 });
  finish({ id: 'late-log', sessionId: 'lease', hostId: 'host' });
  await settle();
  expect(api.logClose).toHaveBeenCalledWith('late-log');
  expect(api.logAck).not.toHaveBeenCalled();
});
it('retains a failed close for retry and releases its stream when the plugin becomes hidden', async () => {
  await mount();
  api.logClose.mockRejectedValueOnce(new Error('日志关闭失败'));
  document.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('日志关闭失败');
  expect(closed).not.toHaveBeenCalled();
  updateVisibility(false);
  await settle();
  expect(api.logClose).toHaveBeenCalledTimes(2);
  expect(closed).toHaveBeenCalledOnce();
});
it('pauses and resumes the owned log session without reopening it', async () => {
  await mount();
  receive({ type: 'state', state: 'running', code: null, message: null });
  await settle();
  [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '暂停日志')!
    .click();
  await settle();
  expect(api.logPause).toHaveBeenLastCalledWith('log', true);
  receive({ type: 'state', state: 'paused', code: null, message: null });
  await settle();
  [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '继续日志')!
    .click();
  await settle();
  expect(api.logPause).toHaveBeenLastCalledWith('log', false);
  expect(api.logOpen).toHaveBeenCalledOnce();
});
it('reports a technical cleanup failure even when a late request resolves after unmount', async () => {
  let finish!: (value: LogSession) => void;
  api.logOpen.mockImplementation(
    () =>
      new Promise<LogSession>((resolve) => {
        finish = resolve;
      }),
  );
  api.logClose.mockRejectedValue(new Error('无法释放迟到的日志流'));
  await mount();
  app!.unmount();
  app = undefined;
  finish({ id: 'late-log', sessionId: 'lease', hostId: 'host' });
  await settle();
  expect(reported).toHaveBeenCalledWith('无法释放迟到的日志流');
});
