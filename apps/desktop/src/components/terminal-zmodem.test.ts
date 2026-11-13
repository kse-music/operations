import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import Zmodem from 'zmodem.js';
import TerminalPane from './TerminalPane.vue';
import { terminalApi } from '../services/terminal';
import { useTerminalsStore, type TerminalPaneModel } from '../stores/terminals';
import { hostInput } from '../types/hosts';
import type { TerminalEvent, TerminalUploadSelection } from '../types/terminal';

const xterm = vi.hoisted(() => ({
  input: vi.fn() as (data: string) => void,
  output: [] as number[],
  focus: vi.fn(),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    buffer = { active: { type: 'normal', baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0 } };
    options = {};
    cols = 80;
    rows = 24;
    parser = { registerOscHandler: vi.fn() };
    loadAddon() {}
    open() {}
    focus() {
      xterm.focus();
    }
    dispose() {}
    onResize() {}
    onCursorMove() {}
    onBinary() {}
    onSelectionChange() {}
    attachCustomKeyEventHandler() {}
    onData(callback: (data: string) => void) {
      xterm.input = callback;
    }
    write(data: string | Uint8Array, callback?: () => void) {
      if (data instanceof Uint8Array) xterm.output.push(...data);
      callback?.();
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));

let app: App, pinia: Pinia, root: HTMLDivElement, tab: TerminalPaneModel;
let receive: (event: TerminalEvent) => void;
// Real lrzsz ZRINIT from the reported terminal, including its high-bit LF.
const header = Uint8Array.from('**\x18B0100000023be50\r\x8a\x11', (char) => char.charCodeAt(0));
const showModal = HTMLDialogElement.prototype.showModal;
interface Receiver {
  set_sender(callback: (data: number[]) => void): void;
  on(event: 'offer', callback: (offer: { accept(): Promise<void> }) => void): void;
  consume(data: number[]): void;
  start(): void;
}
function receiver(): Receiver {
  const Protocol = Zmodem as unknown as { Session: { Receive: new () => Receiver } };
  const peer = new Protocol.Session.Receive();
  let sequence = 0;
  peer.set_sender((data) =>
    queueMicrotask(() => receive({ type: 'data', sequence: ++sequence, data })),
  );
  peer.on('offer', (offer) => void offer.accept());
  vi.mocked(terminalApi.input).mockImplementation(async (_id, data) => peer.consume([...data]));
  return peer;
}
beforeEach(async () => {
  vi.clearAllMocks();
  xterm.output = [];
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  pinia = createPinia();
  setActivePinia(pinia);
  const store = useTerminalsStore();
  store.open({
    ...hostInput(),
    id: 'remote',
    name: 'Test remote',
    hostname: '127.0.0.1',
    createdAt: '',
    updatedAt: '',
  });
  tab = store.tabs[0]!.panes[0]!;
  vi.spyOn(terminalApi, 'open').mockImplementation(async (_host, _size, callback) => {
    receive = callback;
    receive({ type: 'state', state: 'connected', code: null, message: null });
    return { id: 'session', transportId: 'transport', hostId: 'remote', routeHostIds: ['remote'] };
  });
  vi.spyOn(terminalApi, 'input').mockResolvedValue();
  vi.spyOn(terminalApi, 'ack').mockResolvedValue();
  vi.spyOn(terminalApi, 'close').mockResolvedValue();
  vi.spyOn(terminalApi, 'zmodemRead').mockResolvedValue(new Uint8Array());
  vi.spyOn(terminalApi, 'zmodemWrite').mockImplementation((id, _token, data) =>
    terminalApi.input(id, data),
  );
  vi.spyOn(terminalApi, 'uploadRelease').mockResolvedValue();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp({ setup: () => () => h(TerminalPane, { tab, active: true }) }).use(pinia);
  app.mount(root);
  await vi.waitFor(() => expect(tab.sessionId).toBe('session'));
});
afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  root.remove();
  HTMLDialogElement.prototype.showModal = showModal;
  vi.unstubAllGlobals();
});
it('opens only the native picker on fragmented rz output while continuing ACKs and isolating input', async () => {
  const openModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  const pick = vi.spyOn(terminalApi, 'uploadPick').mockReturnValue(new Promise(() => {}));
  receive({ type: 'data', sequence: 1, data: Array.from(header.slice(0, 3)) });
  receive({ type: 'data', sequence: 2, data: Array.from(header.slice(3)) });
  await vi.waitFor(() => expect(pick).toHaveBeenCalledExactlyOnceWith('session'));
  expect(terminalApi.ack).toHaveBeenCalledWith('session', 1);
  expect(terminalApi.ack).toHaveBeenCalledWith('session', 2);
  expect(xterm.output).toEqual([]);
  expect(document.querySelector('dialog')).toBeNull();
  expect(openModal).not.toHaveBeenCalled();
  expect(root.querySelector('.terminal-upload')).toBeNull();
  xterm.focus.mockClear();
  vi.mocked(terminalApi.input).mockClear();
  xterm.input('ordinary key');
  await nextTick();
  expect(terminalApi.input).not.toHaveBeenCalled();
  xterm.input('\x03');
  await vi.waitFor(() => expect(terminalApi.input).toHaveBeenCalled());
  expect(vi.mocked(terminalApi.input).mock.calls[0]![1].slice(0, 5)).toEqual(
    Uint8Array.of(24, 24, 24, 24, 24),
  );
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  expect(xterm.focus).not.toHaveBeenCalled();
  xterm.input('x');
  await vi.waitFor(() =>
    expect(
      vi.mocked(terminalApi.input).mock.calls.map(([id, bytes]) => [id, Array.from(bytes)]),
    ).toContainEqual(['session', [120]]),
  );
});

it('never reads a file chosen after the terminal disconnected', async () => {
  let choose!: (value: TerminalUploadSelection) => void;
  vi.spyOn(terminalApi, 'uploadPick').mockReturnValue(
    new Promise((resolve) => {
      choose = resolve;
    }),
  );
  receive({ type: 'data', sequence: 1, data: Array.from(header) });
  await vi.waitFor(() => expect(terminalApi.uploadPick).toHaveBeenCalled());
  xterm.focus.mockClear();
  receive({
    type: 'state',
    state: 'failed',
    code: 'SSH_DISCONNECTED',
    message: 'SSH disconnected',
  });
  choose({ token: 'late', files: [{ name: 'secret.bin', size: 10, modified: 1645594860 }] });
  await vi.waitFor(() =>
    expect(terminalApi.uploadRelease).toHaveBeenCalledExactlyOnceWith('session', 'late'),
  );
  expect(terminalApi.zmodemRead).not.toHaveBeenCalled();
  expect(terminalApi.input).not.toHaveBeenCalled();
  await nextTick();
  expect(document.querySelector('dialog')).toBeNull();
  expect(xterm.focus).not.toHaveBeenCalled();
});

it('opens the upload modal after selection and keeps it until protocol completion and grant release', async () => {
  const openModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  const peer = receiver();
  let choose!: (selection: TerminalUploadSelection) => void;
  vi.spyOn(terminalApi, 'uploadPick').mockReturnValue(
    new Promise((resolve) => {
      choose = resolve;
    }),
  );
  let read!: (data: Uint8Array) => void;
  vi.mocked(terminalApi.zmodemRead).mockReturnValue(
    new Promise((resolve) => {
      read = resolve;
    }),
  );
  let released!: () => void;
  vi.mocked(terminalApi.uploadRelease).mockReturnValue(
    new Promise((resolve) => {
      released = resolve;
    }),
  );
  peer.start();
  await vi.waitFor(() => expect(terminalApi.uploadPick).toHaveBeenCalledOnce());
  expect(document.querySelector('dialog')).toBeNull();
  expect(openModal).not.toHaveBeenCalled();
  choose({ token: 'chosen', files: [{ name: 'selected.bin', size: 10, modified: 1645594860 }] });
  await vi.waitFor(() => expect(terminalApi.zmodemRead).toHaveBeenCalledOnce());
  expect(openModal).toHaveBeenCalledOnce();
  const dialog = document.querySelector('dialog[open]')!;
  expect(dialog.textContent).toContain('selected.bin');
  expect(dialog.textContent).toContain('正在上传');
  expect(dialog.querySelector('progress')?.max).toBe(10);
  xterm.focus.mockClear();
  read(new Uint8Array(10).fill(7));
  await vi.waitFor(() =>
    expect(terminalApi.uploadRelease).toHaveBeenCalledWith('session', 'chosen'),
  );
  expect(document.querySelector('dialog')).toBe(dialog);
  expect(dialog.textContent).toContain('等待远端确认完成');
  released();
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  expect(terminalApi.uploadRelease).toHaveBeenCalledTimes(1);
  expect(xterm.focus).toHaveBeenCalledOnce();
});

it('never opens an upload modal when native file selection is cancelled, including during cleanup', async () => {
  const openModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  const peer = receiver();
  let choose!: (selection: TerminalUploadSelection) => void;
  vi.spyOn(terminalApi, 'uploadPick').mockReturnValue(
    new Promise((resolve) => {
      choose = resolve;
    }),
  );
  let released!: () => void;
  vi.mocked(terminalApi.uploadRelease).mockReturnValue(
    new Promise((resolve) => {
      released = resolve;
    }),
  );
  xterm.focus.mockClear();
  peer.start();
  await vi.waitFor(() => expect(terminalApi.uploadPick).toHaveBeenCalledOnce());
  expect(document.querySelector('dialog')).toBeNull();
  choose({ token: 'cancelled', files: [] });
  await vi.waitFor(() =>
    expect(terminalApi.uploadRelease).toHaveBeenCalledWith('session', 'cancelled'),
  );
  expect(document.querySelector('dialog')).toBeNull();
  expect(openModal).not.toHaveBeenCalled();
  expect(terminalApi.zmodemRead).not.toHaveBeenCalled();
  released();
  await nextTick();
  await nextTick();
  vi.mocked(terminalApi.input).mockResolvedValue();
  xterm.input('x');
  await vi.waitFor(() =>
    expect(
      vi.mocked(terminalApi.input).mock.calls.map(([id, data]) => [id, Array.from(data)]),
    ).toContainEqual(['session', [120]]),
  );
  expect(document.querySelector('dialog')).toBeNull();
  expect(openModal).not.toHaveBeenCalled();
  expect(xterm.focus).not.toHaveBeenCalled();
});

it.each(['hidden pane', 'newer dialog'])(
  'does not restore focus over a %s when cancellation finishes',
  async (state) => {
    vi.spyOn(terminalApi, 'uploadPick').mockResolvedValue({
      token: 'chosen',
      files: [{ name: 'selected.bin', size: 10, modified: 1645594860 }],
    });
    receive({ type: 'data', sequence: 1, data: Array.from(header) });
    await vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
    if (state === 'hidden pane') root.setAttribute('inert', '');
    else {
      const newer = document.createElement('dialog');
      newer.open = true;
      root.append(newer);
    }
    xterm.focus.mockClear();
    document.querySelector<HTMLButtonElement>('dialog footer button')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('dialog[aria-label="终端文件上传"]')).toBeNull(),
    );
    expect(xterm.focus).not.toHaveBeenCalled();
  },
);
