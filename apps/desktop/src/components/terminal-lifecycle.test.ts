import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import TerminalPane from './TerminalPane.vue';
import { terminalApi } from '../services/terminal';
import { useTerminalsStore } from '../stores/terminals';
import { useNotificationsStore } from '../stores/notifications';
import { hostInput } from '../types/hosts';
import type { TerminalEvent, TerminalSize } from '../types/terminal';

const xterm = vi.hoisted(() => ({
  resize: vi.fn() as (size: TerminalSize) => void,
  input: vi.fn() as (data: string) => void,
  parsed: [] as (() => void)[],
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    buffer = { active: { type: 'normal', baseY: 0, viewportY: 0 } };
    options = {};
    cols = 80;
    rows = 24;
    parser = { registerOscHandler: vi.fn() };
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    onBinary() {}
    onSelectionChange() {}
    attachCustomKeyEventHandler() {}
    onResize(callback: (size: TerminalSize) => void) {
      xterm.resize = callback;
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
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
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
