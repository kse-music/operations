import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import TerminalDropUpload from './TerminalDropUpload.vue';
import { terminalApi } from '../services/terminal';
import type { TerminalFileDrag } from '../types/terminal';

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
let pane: InstanceType<typeof TerminalDropUpload> | undefined;
let enabled = true,
  canReceive = true;
const send = vi.fn<(id: string, data: Uint8Array) => Promise<void>>(),
  interrupt = vi.fn<(id: string) => Promise<void>>();
const nonce = 'a'.repeat(32);
const encoder = new TextEncoder();
function receive(...frames: string[]): Uint8Array | undefined {
  return pane!.consume(
    encoder.encode(frames.map((frame) => '\x1eSDU:' + nonce + ':' + frame + '\x1f').join('')),
  );
}
function prepareUpload(): void {
  vi.mocked(terminalApi.prepareDrop).mockResolvedValue({
    size: 10,
    sha256: 'a'.repeat(64),
    nonce,
    command: 'start\r',
  });
  send.mockImplementation(async (id, data) => {
    expect(id).toBe('session');
    if (new TextDecoder().decode(data) === 'start\r') receive('READY:0:' + btoa('/root/current\n'));
  });
}
const showModal = HTMLDialogElement.prototype.showModal;
beforeEach(async () => {
  vi.clearAllMocks();
  send.mockReset().mockResolvedValue();
  interrupt.mockReset().mockResolvedValue();
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
  vi.spyOn(terminalApi, 'prepareDrop').mockReturnValue(new Promise(() => {}));
  vi.spyOn(terminalApi, 'uploadRead').mockResolvedValue(Array(10).fill(7));
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
        ref: (value: unknown) => {
          pane = value as InstanceType<typeof TerminalDropUpload> | undefined;
        },
        target: 'host',
        enabled,
        canReceive: () => canReceive,
        area,
        send,
        interrupt,
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
});
function drop(x = 400, y = 200): void {
  events.callback({ payload: { type: 'drop', x, y, grant: 'native-grant', names: ['unused'] } });
}
it('targets the physical drop coordinates and requires confirmation before preparing or sending', async () => {
  drop();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog')?.textContent).toContain('中文目录'),
  );
  expect(terminalApi.claimDrop).toHaveBeenCalledExactlyOnceWith('session', 'native-grant');
  expect(terminalApi.prepareDrop).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  const confirm = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === '确认上传',
  )!;
  confirm.click();
  await vi.waitFor(() =>
    expect(terminalApi.prepareDrop).toHaveBeenCalledExactlyOnceWith('session', 'token'),
  );
  expect(document.querySelector('dialog')?.textContent).toContain('正在准备');
  expect(root.querySelector('.terminal-drop-progress')).toBeNull();
  expect(send).not.toHaveBeenCalled();
});
it('ignores hidden, outside and alternate-screen targets', async () => {
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
it('releases a declined selection without starting any receiver', async () => {
  drop();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '取消')!
    .click();
  await vi.waitFor(() =>
    expect(terminalApi.uploadRelease).toHaveBeenCalledExactlyOnceWith('session', 'token'),
  );
  expect(terminalApi.prepareDrop).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it('clears stale progress and input occupation immediately when the session disconnects', async () => {
  drop();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '确认上传')!
    .click();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog')?.textContent).toContain('正在准备'),
  );
  pane!.dispose();
  await nextTick();
  expect(document.querySelector('dialog')?.textContent).toContain('终端会话已结束');
  expect(pane!.busy).toBe(false);
  expect(pane!.consume(encoder.encode('late upload command echo'))).toEqual(new Uint8Array());
  await vi.waitFor(() =>
    expect(terminalApi.uploadRelease).toHaveBeenCalledExactlyOnceWith('session', 'token'),
  );
});

it('keeps the same dialog for progress and closes only after commit, Shell return and grant release', async () => {
  prepareUpload();
  drop();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  const dialog = document.querySelector('dialog')!;
  [...dialog.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '确认上传')!
    .click();
  await vi.waitFor(() => expect(terminalApi.uploadRead).toHaveBeenCalledOnce());
  expect(document.querySelector('dialog')).toBe(dialog);
  expect(dialog.textContent).toContain('正在上传');
  expect(dialog.querySelector('progress')?.max).toBe(10);
  expect((dialog.querySelector('[aria-label="关闭对话框"]') as HTMLButtonElement).disabled).toBe(
    true,
  );
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(document.querySelector('dialog')).toBe(dialog);
  const echoed = pane!.consume(encoder.encode('/bin/sh -c sd_nonce=$1\r\n> source code\r\n'));
  expect(echoed).toEqual(new Uint8Array());
  receive('ACK:0', 'VERIFYING', 'COMMITTING', 'DONE:2');
  await nextTick();
  expect(document.querySelector('dialog')).toBe(dialog);
  expect(terminalApi.uploadRelease).not.toHaveBeenCalled();
  const prompt = receive('RETURN');
  expect(prompt).toEqual(new Uint8Array());
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  expect(terminalApi.uploadRelease).toHaveBeenCalledExactlyOnceWith('session', 'token');
  expect(document.body.textContent).not.toContain('上传完成');
  expect(root.querySelector('.terminal-upload')).toBeNull();
  expect(new TextDecoder().decode(pane!.consume(encoder.encode('user@host$ ')))).toBe(
    '\r\x1b[2Kuser@host$ ',
  );
});

it('keeps failures inside the dialog and closes them without releasing the grant twice', async () => {
  vi.mocked(terminalApi.prepareDrop).mockRejectedValue(new Error('本地文件读取失败'));
  drop();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '确认上传')!
    .click();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain(
      '本地文件读取失败',
    ),
  );
  expect(send).not.toHaveBeenCalled();
  expect(pane!.busy).toBe(false);
  [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '关闭')!
    .click();
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  expect(terminalApi.uploadRelease).toHaveBeenCalledTimes(1);
});

it('cancels from the progress dialog and closes after the receiver returns', async () => {
  prepareUpload();
  interrupt.mockImplementation(async (id) => {
    expect(id).toBe('session');
    receive('ERROR:CANCELLED:0', 'RETURN');
  });
  drop();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '确认上传')!
    .click();
  await vi.waitFor(() => expect(terminalApi.uploadRead).toHaveBeenCalledOnce());
  [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '取消上传')!
    .click();
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  expect(interrupt).toHaveBeenCalledTimes(1);
  expect(terminalApi.uploadRelease).toHaveBeenCalledTimes(1);
  expect(pane!.busy).toBe(false);
});
it('releases a claim arriving after the owning pane was removed', async () => {
  let resolve!: (value: { token: string; names: string[] }) => void;
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
  expect(send).not.toHaveBeenCalled();
});
