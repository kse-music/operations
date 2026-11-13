import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import TerminalDropUpload from './TerminalDropUpload.vue';
import { terminalApi } from '../services/terminal';
import type { TerminalFileDrag, TerminalDropProgress, TerminalDropResult } from '../types/terminal';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';

const events = vi.hoisted(() => ({
  callback: (_event: { payload: TerminalFileDrag }) => {
    void _event;
  },
  unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...(await original<object>()),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name, callback) => {
    events.callback = callback;
    return events.unlisten;
  }),
}));
let root: HTMLDivElement, area: HTMLDivElement, app: App;
let pane: InstanceType<typeof TerminalDropUpload>;
let enabled = true,
  canReceive = true;
let receive!: (progress: TerminalDropProgress) => void;
let finish!: (result: TerminalDropResult) => void;
const value = (extra: Partial<TerminalDropProgress> = {}): TerminalDropProgress => ({
  phase: 'uploading',
  sent: 0,
  size: 10,
  bytesPerSecond: 0,
  elapsedSeconds: 0,
  uid: '0',
  username: 'root',
  directory: '/root/current',
  ...extra,
});
function prepareUpload(username = 'root'): void {
  vi.mocked(terminalApi.runDrop).mockImplementation((_id, _token, callback) => {
    receive = callback;
    callback(value({ username: username || null }));
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
}
const showModal = HTMLDialogElement.prototype.showModal;
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  enabled = true;
  canReceive = true;
  vi.spyOn(terminalApi, 'claimDrop').mockResolvedValue({
    token: 'token',
    names: ['中文目录', 'file.bin'],
  });
  vi.spyOn(terminalApi, 'uploadRelease').mockResolvedValue();
  vi.spyOn(terminalApi, 'cancelDrop').mockResolvedValue();
  vi.spyOn(terminalApi, 'runDrop').mockReturnValue(new Promise(() => {}));
  vi.spyOn(terminalApi, 'uploadRead').mockResolvedValue([]);
  root = document.createElement('div');
  area = document.createElement('div');
  area.getBoundingClientRect = () =>
    ({ left: 100, top: 50, right: 500, bottom: 350, width: 400, height: 300 }) as DOMRect;
  document.body.append(root, area);
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
  app = createApp({
    setup: () => () =>
      h(TerminalDropUpload, {
        sessionId: 'session',
        ref: (v: unknown) => {
          pane = v as typeof pane;
        },
        target: 'host',
        enabled,
        canReceive: () => canReceive,
        area,
      }),
  });
  app.mount(root);
  await nextTick();
});
afterEach(() => {
  app.unmount();
  root.remove();
  area.remove();
  HTMLDialogElement.prototype.showModal = showModal;
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
  setLocale('zh-CN');
});
function drop(x = 400, y = 200): void {
  events.callback({ payload: { type: 'drop', x, y, grant: 'native-grant', names: ['unused'] } });
}
function click(text: string): void {
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!.click();
}
async function start(): Promise<HTMLDialogElement> {
  drop();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  const dialog = document.querySelector('dialog')!;
  click('确认上传');
  await vi.waitFor(() => expect(terminalApi.runDrop).toHaveBeenCalledOnce());
  return dialog;
}
it('targets physical coordinates and requires confirmation before starting native binary I/O', async () => {
  drop();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog')?.textContent).toContain('中文目录'),
  );
  expect(terminalApi.claimDrop).toHaveBeenCalledExactlyOnceWith('session', 'native-grant');
  expect(terminalApi.runDrop).not.toHaveBeenCalled();
  click('确认上传');
  await vi.waitFor(() =>
    expect(terminalApi.runDrop).toHaveBeenCalledExactlyOnceWith(
      'session',
      'token',
      expect.any(Function),
    ),
  );
  expect(document.querySelector('dialog')?.textContent).toContain('正在准备');
  expect(root.querySelector('.terminal-drop-progress')).toBeNull();
  expect(pane.busy).toBe(true);
  expect(terminalApi.uploadRead).not.toHaveBeenCalled();
});
it('ignores hidden, outside, inert and alternate-screen targets', async () => {
  drop(10, 10);
  area.setAttribute('inert', '');
  drop();
  area.removeAttribute('inert');
  canReceive = false;
  drop();
  canReceive = true;
  enabled = false;
  app._instance?.update();
  await nextTick();
  drop();
  expect(terminalApi.claimDrop).not.toHaveBeenCalled();
});
it('releases a declined selection without starting a receiver', async () => {
  drop();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  click('取消');
  await vi.waitFor(() =>
    expect(terminalApi.uploadRelease).toHaveBeenCalledExactlyOnceWith('session', 'token'),
  );
  expect(terminalApi.runDrop).not.toHaveBeenCalled();
  expect(terminalApi.uploadRead).not.toHaveBeenCalled();
});
it('clears stale progress and input occupation immediately after a disconnect and cancels native work', async () => {
  await start();
  pane.dispose();
  await nextTick();
  expect(document.querySelector('dialog')?.textContent).toContain('终端会话已结束');
  expect(pane.busy).toBe(false);
  expect(terminalApi.cancelDrop).toHaveBeenCalledExactlyOnceWith('session', 'token');
  await vi.waitFor(() =>
    expect(terminalApi.uploadRelease).toHaveBeenCalledExactlyOnceWith('session', 'token'),
  );
});
it('keeps the native protocol failure when the terminal-close event arrives first', async () => {
  let reject!: (error: unknown) => void;
  vi.mocked(terminalApi.runDrop).mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await start();
  pane.dispose();
  await nextTick();
  expect(document.querySelector('dialog')?.textContent).toContain('终端会话已结束');
  reject(new Error('远端二进制接收长度或帧边界异常，已关闭此会话以隔离未确认的数据'));
  await vi.waitFor(() =>
    expect(document.querySelector('dialog')?.textContent).toContain('二进制接收长度或帧边界异常'),
  );
  expect(document.querySelector('dialog')?.textContent).not.toContain('终端会话已结束');
  expect(pane.busy).toBe(false);
});
it('keeps one dialog and waits for native commit, Shell recovery and grant release', async () => {
  prepareUpload();
  const dialog = await start();
  expect(dialog.textContent).toContain('正在上传');
  expect(dialog.querySelector('progress')?.max).toBe(10);
  expect((dialog.querySelector('[aria-label="关闭对话框"]') as HTMLButtonElement).disabled).toBe(
    true,
  );
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  receive(value({ phase: 'verifying', sent: 10 }));
  await nextTick();
  expect(document.querySelector('dialog')).toBe(dialog);
  expect(terminalApi.uploadRelease).not.toHaveBeenCalled();
  receive(value({ phase: 'committing', sent: 10 }));
  await nextTick();
  expect(document.querySelector('dialog')).toBe(dialog);
  let released!: () => void;
  vi.mocked(terminalApi.uploadRelease).mockImplementation(
    () =>
      new Promise((resolve) => {
        released = resolve;
      }),
  );
  finish({ code: null, committed: 2, recovery: null });
  await vi.waitFor(() => expect(terminalApi.uploadRelease).toHaveBeenCalledOnce());
  expect(document.querySelector('dialog')).toBe(dialog);
  expect(pane.busy).toBe(true);
  released();
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  expect(document.body.textContent).not.toContain('上传完成');
  expect(root.querySelector('.terminal-upload')).toBeNull();
  expect(terminalApi.uploadRead).not.toHaveBeenCalled();
});
it('shows native acknowledged bytes, speed, remaining size and times through upload phases in both languages', async () => {
  prepareUpload();
  const dialog = await start();
  receive(value({ size: 131072 }));
  await nextTick();
  expect(dialog.querySelector('[aria-label="平均上传速度"]')?.textContent).toBe('0 B/s');
  expect(dialog.textContent).toContain('0 B / 128.0 KiB');
  expect(dialog.querySelector('.terminal-drop-statistics')?.textContent).toContain(
    '剩余 128.0 KiB',
  );
  expect(dialog.querySelector('[data-time="elapsed"]')?.textContent).toContain('已用时间：0:00:00');
  expect(dialog.querySelector('[data-time="remaining"]')?.textContent).toContain(
    '预计剩余时间：估算中',
  );
  receive(value({ size: 131072, sent: 65536, bytesPerSecond: 32768, elapsedSeconds: 2 }));
  await nextTick();
  expect(dialog.querySelector('[aria-label="平均上传速度"]')?.textContent).toBe('32.0 KiB/s');
  expect(dialog.textContent).toContain('64.0 KiB / 128.0 KiB');
  expect(dialog.querySelector('.terminal-drop-statistics')?.textContent).toContain('剩余 64.0 KiB');
  expect(dialog.querySelector('[data-time="elapsed"]')?.textContent).toContain('已用时间：0:00:02');
  expect(dialog.querySelector('[data-time="remaining"]')?.textContent).toContain(
    '预计剩余时间：0:00:02',
  );
  expect(dialog.querySelector('progress')?.value).toBe(65536);
  setLocale('en-US');
  await nextTick();
  expect(dialog.querySelector('[data-time="elapsed"]')?.textContent).toContain('Elapsed: 0:00:02');
  expect(dialog.querySelector('[data-time="remaining"]')?.textContent).toContain(
    'Estimated remaining: 0:00:02',
  );
  setLocale('zh-CN');
  receive(value({ phase: 'verifying', size: 131072, sent: 131072, elapsedSeconds: 4 }));
  await nextTick();
  expect(dialog.querySelector('[aria-label="平均上传速度"]')).toBeNull();
  expect(dialog.textContent).toContain('128.0 KiB / 128.0 KiB');
  expect(dialog.querySelector('.terminal-drop-statistics')?.textContent).toContain('剩余 0 B');
  expect(dialog.querySelector('[data-time="elapsed"]')?.textContent).toContain('已用时间：0:00:04');
  expect(dialog.querySelector('[data-time="remaining"]')?.textContent).toContain('预计剩余时间：—');
  expect(dialog.textContent).toContain('正在校验文件');
  finish({ code: null, committed: 2, recovery: null });
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
});
it.each([
  ['deploy', 'deploy · /root/current'],
  ['', 'UID 0 · /root/current'],
])('shows receiver account %j with UID fallback', async (username, expected) => {
  prepareUpload(username);
  await start();
  expect(document.querySelector('.terminal-drop-destination')?.textContent?.trim()).toBe(expected);
  finish({ code: null, committed: 2, recovery: null });
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
});
it('keeps errors in its dialog and does not release twice when dismissed', async () => {
  vi.mocked(terminalApi.runDrop).mockRejectedValue(new Error('本地文件读取失败'));
  await start();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain(
      '本地文件读取失败',
    ),
  );
  expect(pane.busy).toBe(false);
  expect(terminalApi.uploadRead).not.toHaveBeenCalled();
  await nextTick();
  click('关闭');
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  expect(terminalApi.uploadRelease).toHaveBeenCalledOnce();
});
it('cancels once and waits for confirmed native recovery before closing', async () => {
  prepareUpload();
  const dialog = await start();
  click('取消上传');
  expect(terminalApi.cancelDrop).toHaveBeenCalledExactlyOnceWith('session', 'token');
  expect(pane.busy).toBe(true);
  expect(document.querySelector('dialog')).toBe(dialog);
  receive(value({ phase: 'cancelling' }));
  await nextTick();
  expect(dialog.textContent).toContain('正在停止上传并恢复终端');
  finish({ code: 'CANCELLED', committed: 0, recovery: null });
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  expect(terminalApi.uploadRelease).toHaveBeenCalledOnce();
  expect(pane.busy).toBe(false);
});
it('releases a claim arriving after its owning pane was removed', async () => {
  let resolve!: (v: { token: string; names: string[] }) => void;
  vi.mocked(terminalApi.claimDrop).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  drop();
  app.unmount();
  resolve({ token: 'late', names: ['late.bin'] });
  await vi.waitFor(() => expect(terminalApi.uploadRelease).toHaveBeenCalledWith('session', 'late'));
  expect(terminalApi.runDrop).not.toHaveBeenCalled();
});
