import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import TerminalPane from './TerminalPane.vue';
import { terminalApi } from '../services/terminal';
import { useTerminalsStore } from '../stores/terminals';
import { useNotificationsStore } from '../stores/notifications';
import { hostInput } from '../types/hosts';
import type { TerminalEvent, TerminalSize } from '../types/terminal';
import type { ITerminalOptions } from '@xterm/xterm';

const xterm = vi.hoisted(() => ({
  resize: vi.fn() as (size: TerminalSize) => void,
  input: vi.fn() as (data: string) => void,
  parsed: [] as (() => void)[],
  options: {} as ITerminalOptions,
  cursorMove: () => {},
  buffer: { type: 'normal', baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0 },
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    buffer = { active: xterm.buffer };
    constructor(public options: ITerminalOptions) {
      xterm.options = options;
    }
    cols = 80;
    rows = 24;
    parser = { registerOscHandler: vi.fn() };
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    onBinary() {}
    onSelectionChange() {}
    onCursorMove(callback: () => void) {
      xterm.cursorMove = callback;
    }
    attachCustomKeyEventHandler() {}
    onResize(callback: (size: TerminalSize) => void) {
      xterm.resize = (size) => {
        this.cols = size.cols;
        this.rows = size.rows;
        callback(size);
      };
    }
    onData(callback: (data: string) => void) {
      xterm.input = callback;
    }
    write(_data: unknown, callback?: () => void) {
      if (callback) xterm.parsed.push(callback);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    clearDecorations() {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const missing = { code: 'NOT_FOUND', message: '记录不存在或已被删除' };
const size = { cols: 100, rows: 30 };
let app: App, pinia: Pinia, root: HTMLDivElement;
let store: ReturnType<typeof useTerminalsStore>;
let receive: (event: TerminalEvent) => void;
let id: string;
async function settle() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
}

describe.each(['local', 'ssh'])('%s terminal lifecycle', (kind) => {
  beforeEach(async () => {
    vi.clearAllMocks();
    xterm.parsed = [];
    xterm.buffer.cursorX = 0;
    xterm.buffer.cursorY = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    pinia = createPinia();
    setActivePinia(pinia);
    store = useTerminalsStore();
    store.open(
      kind === 'local'
        ? null
        : {
            ...hostInput(),
            id: 'host',
            name: 'Test',
            hostname: '127.0.0.1',
            createdAt: '',
            updatedAt: '',
          },
    );
    id = kind === 'local' ? 'local:test' : 'ssh:test';
    function connected(callback: (event: TerminalEvent) => void) {
      receive = callback;
      receive({ type: 'state', state: 'connected', code: null, message: null });
    }
    vi.spyOn(terminalApi, 'openLocal').mockImplementation(async (_size, callback) => {
      connected(callback);
      return { id, shell: 'test shell' };
    });
    vi.spyOn(terminalApi, 'open').mockImplementation(async (_host, _size, callback) => {
      connected(callback);
      return { id, hostId: 'host', transportId: 'transport', routeHostIds: ['host'] };
    });
    vi.spyOn(terminalApi, 'resize').mockResolvedValue();
    vi.spyOn(terminalApi, 'input').mockResolvedValue();
    vi.spyOn(terminalApi, 'ack').mockResolvedValue();
    vi.spyOn(terminalApi, 'close').mockResolvedValue();
    root = document.createElement('div');
    document.body.append(root);
    app = createApp({
      setup: () => () =>
        store.panes.map((tab) => h(TerminalPane, { key: tab.key, tab, active: true })),
    }).use(pinia);
    app.mount(root);
    await settle();
    expect(store.panes[0]?.sessionId).toBe(id);
    vi.useFakeTimers();
  });

  afterEach(() => {
    app.unmount();
    disposePinia(pinia);
    root.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function startRequest(operation: 'resize' | 'input' | 'ack') {
    if (operation === 'resize') {
      xterm.resize(size);
      await vi.advanceTimersByTimeAsync(80);
      expect(terminalApi.resize).toHaveBeenCalledWith(id, size);
    } else if (operation === 'input') {
      xterm.input('x');
      expect(terminalApi.input).toHaveBeenCalledWith(id, new TextEncoder().encode('x'));
    } else {
      receive({ type: 'data', sequence: 1, data: [65] });
      xterm.parsed.shift()!();
      await settle();
      expect(terminalApi.ack).toHaveBeenCalledWith(id, 1);
    }
  }

  it('publishes one-based cursor coordinates and current dimensions, including pending wrap', () => {
    expect(store.panes[0]?.screen).toEqual({ rows: 24, cols: 80, cursorRow: 1, cursorCol: 1 });
    xterm.buffer.cursorX = 9;
    xterm.buffer.cursorY = 16;
    xterm.cursorMove();
    expect(store.panes[0]?.screen).toEqual({ rows: 24, cols: 80, cursorRow: 17, cursorCol: 10 });
    xterm.resize(size);
    expect(store.panes[0]?.screen).toEqual({ ...size, cursorRow: 17, cursorCol: 10 });
    xterm.buffer.cursorX = size.cols;
    xterm.cursorMove();
    expect(store.panes[0]?.screen?.cursorCol).toBe(size.cols);
  });

  it('clears negotiated metadata on reconnect and ignores old connection events', async () => {
    receive({ type: 'connection', cipher: 'aes256-ctr' });
    expect(store.panes[0]?.cipher).toBe('aes256-ctr');
    const previous = receive;
    await store.disconnect(store.active);
    expect(store.panes[0]?.cipher).toBeUndefined();
    previous({ type: 'connection', cipher: 'old-connection' });
    expect(store.panes[0]?.cipher).toBeUndefined();
    await store.reconnect(store.active);
    expect(store.panes[0]?.cipher).toBeUndefined();
    receive({ type: 'connection', cipher: 'aes128-gcm@openssh.com' });
    previous({ type: 'connection', cipher: 'old-connection' });
    expect(store.panes[0]?.cipher).toBe('aes128-gcm@openssh.com');
  });

  it.each(['closing', 'disconnected', 'closed', 'failed'])(
    'stops cursor blinking and makes the terminal read-only in the %s state',
    async (state) => {
      expect(xterm.options.cursorBlink).toBe(true);
      expect(xterm.options.disableStdin).not.toBe(true);
      receive({ type: 'state', state, code: null, message: null });
      expect(xterm.options.cursorBlink).toBe(false);
      expect(xterm.options.disableStdin).toBe(true);
      xterm.input('must not send');
      expect(terminalApi.input).not.toHaveBeenCalled();
      receive({ type: 'state', state: 'connected', code: null, message: null });
      expect(xterm.options.cursorBlink).toBe(true);
      expect(xterm.options.disableStdin).toBe(false);
    },
  );

  it('restores cursor settings and input after explicit disconnect and reconnect', async () => {
    const options = xterm.options;
    await store.disconnect(store.active);
    expect(xterm.options.cursorBlink).toBe(false);
    expect(xterm.options.disableStdin).toBe(true);
    await store.reconnect(store.active);
    expect(store.panes[0]?.state).toBe('connected');
    expect(xterm.options).toBe(options);
    expect(xterm.options.cursorBlink).toBe(true);
    expect(xterm.options.disableStdin).toBe(false);
    xterm.input('ready');
    expect(terminalApi.input).toHaveBeenCalledWith(id, new TextEncoder().encode('ready'));
  });

  it.each(['resize', 'input', 'ack'] as const)(
    'stops %s during close before the backend closed event arrives',
    async (operation) => {
      const request = deferred(),
        close = deferred();
      vi.mocked(terminalApi[operation]).mockReturnValueOnce(request.promise);
      vi.mocked(terminalApi.close).mockReturnValueOnce(close.promise);
      await startRequest(operation);
      const closing = store.closePane(store.focused);
      expect(store.panes[0]?.state).toBe('closing');
      request.reject(missing);
      await settle();
      xterm.resize(size);
      xterm.input('must not send');
      await vi.advanceTimersByTimeAsync(80);
      expect(terminalApi.resize).toHaveBeenCalledTimes(operation === 'resize' ? 1 : 0);
      expect(terminalApi.input).toHaveBeenCalledTimes(operation === 'input' ? 1 : 0);
      expect(useNotificationsStore().items).toEqual([]);
      close.resolve();
      await closing;
      expect(store.panes).toEqual([]);
    },
  );

  it('discards a resize failure returned after the shell has closed', async () => {
    const request = deferred();
    vi.mocked(terminalApi.resize).mockReturnValueOnce(request.promise);
    await startRequest('resize');
    receive({ type: 'state', state: 'closed', code: null, message: null });
    request.reject(missing);
    await settle();
    expect(store.panes[0]?.state).toBe('closed');
    expect(useNotificationsStore().items).toEqual([]);
  });

  it('does not ACK buffered output after its pane is removed', async () => {
    receive({ type: 'data', sequence: 1, data: [65] });
    await store.closePane(store.focused);
    await settle();
    xterm.parsed.shift()!();
    await settle();
    expect(terminalApi.ack).not.toHaveBeenCalled();
    expect(useNotificationsStore().items).toEqual([]);
  });

  it('does not attribute an old resize failure to a replacement session', async () => {
    const request = deferred();
    vi.mocked(terminalApi.resize).mockReturnValueOnce(request.promise);
    await startRequest('resize');
    id += ':replacement';
    store.update(store.focused, { state: 'idle', connectRequested: true });
    await settle();
    expect(store.panes[0]?.sessionId).toBe(id);
    expect(store.panes[0]?.state).toBe('connected');
    request.reject(missing);
    await settle();
    expect(useNotificationsStore().items).toEqual([]);
  });

  it.each([missing, { code: 'WORKER', message: '尺寸同步失败' }])(
    'still reports $code while the same session is connected',
    async (error) => {
      const request = deferred();
      vi.mocked(terminalApi.resize).mockReturnValueOnce(request.promise);
      await startRequest('resize');
      request.reject(error);
      await settle();
      expect(useNotificationsStore().items).toEqual([
        expect.objectContaining({ text: error.message, error: true }),
      ]);
      expect(store.panes[0]?.state).toBe('connected');
    },
  );

  it('retains the pane and reports a real close failure', async () => {
    vi.mocked(terminalApi.close).mockRejectedValueOnce({ message: '关闭失败，请重试' });
    await store.closePane(store.focused);
    expect(store.panes).toHaveLength(1);
    expect(store.panes[0]?.state).toBe('connected');
    expect(useNotificationsStore().items).toEqual([
      expect.objectContaining({ text: '关闭失败，请重试', error: true }),
    ]);
    xterm.input('retry');
    expect(terminalApi.input).toHaveBeenCalledWith(id, new TextEncoder().encode('retry'));
  });

  it.each(['resize', 'input', 'ack'] as const)(
    'discards old %s failures and input after disconnect',
    async (operation) => {
      const request = deferred(),
        close = deferred();
      vi.mocked(terminalApi[operation]).mockReturnValueOnce(request.promise);
      vi.mocked(terminalApi.close).mockReturnValueOnce(close.promise);
      await startRequest(operation);
      const disconnecting = store.disconnect(store.active);
      expect(store.panes[0]?.state).toBe('closing');
      request.reject(missing);
      await settle();
      xterm.input('must not send');
      xterm.resize(size);
      await vi.advanceTimersByTimeAsync(80);
      close.resolve();
      await disconnecting;
      expect(store.panes[0]).toMatchObject({ state: 'disconnected', sessionId: undefined });
      expect(store.tabs).toHaveLength(1);
      expect(terminalApi.input).toHaveBeenCalledTimes(operation === 'input' ? 1 : 0);
      expect(terminalApi.resize).toHaveBeenCalledTimes(operation === 'resize' ? 1 : 0);
      expect(useNotificationsStore().items).toEqual([]);
    },
  );

  it('does not restore connected state when the backend reports a failed session during close', async () => {
    const close = deferred();
    vi.mocked(terminalApi.close).mockReturnValueOnce(close.promise);
    const closing = store.closePane(store.focused);
    receive({ type: 'state', state: 'failed', code: 'WORKER', message: '终端进程异常结束' });
    close.reject({ message: '关闭失败，请重试' });
    await closing;
    expect(store.panes[0]?.state).toBe('failed');
    expect(useNotificationsStore().items.map((item) => item.text)).toEqual([
      '终端进程异常结束',
      '关闭失败，请重试',
    ]);
    xterm.input('must not send');
    expect(terminalApi.input).not.toHaveBeenCalled();
  });
});
