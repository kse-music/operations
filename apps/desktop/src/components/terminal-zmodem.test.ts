import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import TerminalPane from './TerminalPane.vue';
import { terminalApi } from '../services/terminal';
import { useTerminalsStore, type TerminalPaneModel } from '../stores/terminals';
import { hostInput } from '../types/hosts';
import type { TerminalEvent, TerminalUploadSelection } from '../types/terminal';

const xterm = vi.hoisted(() => ({
  input: vi.fn() as (data: string) => void,
  output: [] as number[],
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
    onResize() {}
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
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));

let app: App, pinia: Pinia, root: HTMLDivElement, tab: TerminalPaneModel;
let receive: (event: TerminalEvent) => void;
// Real lrzsz ZRINIT from the reported terminal, including its high-bit LF.
const header = Uint8Array.from('**\x18B0100000023be50\r\x8a\x11', (char) => char.charCodeAt(0));
beforeEach(async () => {
  vi.clearAllMocks();
  xterm.output = [];
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
  vi.spyOn(terminalApi, 'uploadRead').mockResolvedValue([]);
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
  vi.unstubAllGlobals();
});
it('automatically requests a native picker on fragmented rz output while continuing ACKs', async () => {
  const pick = vi.spyOn(terminalApi, 'uploadPick').mockReturnValue(new Promise(() => {}));
  receive({ type: 'data', sequence: 1, data: Array.from(header.slice(0, 3)) });
  receive({ type: 'data', sequence: 2, data: Array.from(header.slice(3)) });
  await vi.waitFor(() => expect(pick).toHaveBeenCalledExactlyOnceWith('session'));
  expect(terminalApi.ack).toHaveBeenCalledWith('session', 1);
  expect(terminalApi.ack).toHaveBeenCalledWith('session', 2);
  expect(xterm.output).toEqual([]);
  expect(root.textContent).toContain('请选择要上传');
  vi.mocked(terminalApi.input).mockClear();
  xterm.input('ordinary key');
  await nextTick();
  expect(terminalApi.input).not.toHaveBeenCalled();
  const cancel = [...root.querySelectorAll('button')].find(
    (button) => button.textContent === '取消上传',
  );
  cancel!.click();
  await vi.waitFor(() => expect(terminalApi.input).toHaveBeenCalled());
  expect(vi.mocked(terminalApi.input).mock.calls[0]![1].slice(0, 5)).toEqual(
    Uint8Array.of(24, 24, 24, 24, 24),
  );
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
  receive({
    type: 'state',
    state: 'failed',
    code: 'SSH_DISCONNECTED',
    message: 'SSH disconnected',
  });
  choose({ token: 'late', files: [{ name: 'secret.bin', size: 10 }] });
  await vi.waitFor(() =>
    expect(terminalApi.uploadRelease).toHaveBeenCalledExactlyOnceWith('session', 'late'),
  );
  expect(terminalApi.uploadRead).not.toHaveBeenCalled();
  expect(terminalApi.input).not.toHaveBeenCalled();
  await nextTick();
  expect(root.querySelector('.terminal-upload')).toBeNull();
});
