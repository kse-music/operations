import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import TerminalPane from './TerminalPane.vue';
import { terminalApi } from '../services/terminal';
import { useTerminalsStore } from '../stores/terminals';
import { hostInput } from '../types/hosts';
import type { TerminalEvent, TerminalFileDrag, TerminalDropResult } from '../types/terminal';

const native = vi.hoisted(() => ({
  listeners: [] as ((event: { payload: TerminalFileDrag }) => void)[],
}));
const xterm = vi.hoisted(() => ({
  instances: [] as { textarea?: HTMLTextAreaElement }[],
  focus: vi.fn<(index: number) => void>(),
}));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...(await original<object>()),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: TerminalFileDrag }) => void) => {
    expect(name).toBe('terminal-file-drag');
    native.listeners.push(callback);
    return () => {
      native.listeners = native.listeners.filter((item) => item !== callback);
    };
  }),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    index = xterm.instances.length;
    textarea?: HTMLTextAreaElement;
    input?: (data: string) => void;
    buffer = { active: { type: 'normal', baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0 } };
    options = {};
    cols = 80;
    rows = 24;
    parser = { registerOscHandler: vi.fn() };
    constructor() {
      xterm.instances.push(this);
    }
    loadAddon() {}
    open(container: HTMLElement) {
      container.getBoundingClientRect = () => new DOMRect(this.index * 420, 0, 400, 300);
      this.textarea = document.createElement('textarea');
      this.textarea.className = 'xterm-helper-textarea';
      this.textarea.addEventListener('keydown', (event) => {
        if (event.key.length === 1) this.input?.(event.key);
      });
      container.append(this.textarea);
    }
    focus() {
      xterm.focus(this.index);
      this.textarea?.focus();
    }
    dispose() {}
    write(data: unknown, callback?: () => void) {
      void data;
      callback?.();
    }
    onResize() {}
    onCursorMove() {}
    onBinary() {}
    onSelectionChange() {}
    attachCustomKeyEventHandler() {}
    onData(callback: (data: string) => void) {
      this.input = callback;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));

const active = ref(true);
let app: App, pinia: Pinia, root: HTMLDivElement;
let store: ReturnType<typeof useTerminalsStore>;
const receivers = new Map<string, (event: TerminalEvent) => void>();
const showModal = HTMLDialogElement.prototype.showModal;
let complete!: (result: TerminalDropResult) => void;
beforeEach(async () => {
  vi.clearAllMocks();
  native.listeners = [];
  xterm.instances = [];
  receivers.clear();
  active.value = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    this.querySelector<HTMLButtonElement>('button')?.focus();
  };
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300);
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
  store.open({
    ...hostInput(),
    id: 'host',
    hostname: '127.0.0.1',
    name: 'Test',
    createdAt: '',
    updatedAt: '',
  });
  store.split(store.focused, 'columns');
  store.focused = store.panes[0]!.key;
  vi.spyOn(terminalApi, 'open').mockImplementation(async (_host, _size, callback) => {
    const id = 'session-' + receivers.size;
    receivers.set(id, callback);
    callback({ type: 'state', state: 'connected', code: null, message: null });
    return { id, transportId: 'transport', hostId: 'host', routeHostIds: ['host'] };
  });
  vi.spyOn(terminalApi, 'input').mockResolvedValue();
  vi.spyOn(terminalApi, 'ack').mockResolvedValue();
  vi.spyOn(terminalApi, 'close').mockResolvedValue();
  vi.spyOn(terminalApi, 'claimDrop').mockResolvedValue({ token: 'grant', names: ['file.bin'] });
  vi.spyOn(terminalApi, 'runDrop').mockImplementation((_id, _token, progress) => {
    progress({
      phase: 'uploading',
      size: 10,
      sent: 0,
      bytesPerSecond: 0,
      elapsedSeconds: 0,
      uid: '0',
      username: 'root',
      directory: '/root/current',
    });
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  vi.spyOn(terminalApi, 'cancelDrop').mockImplementation(async () => {
    complete({ code: 'CANCELLED', committed: 0, recovery: null });
  });
  vi.spyOn(terminalApi, 'uploadRelease').mockResolvedValue();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp({
    setup: () => () =>
      h(
        'div',
        store.panes.map((pane) =>
          h(
            'div',
            {
              key: pane.key,
              onFocusin: () => {
                store.focused = pane.key;
              },
            },
            h(TerminalPane, { tab: pane, active: active.value }),
          ),
        ),
      ),
  }).use(pinia);
  app.mount(root);
  await vi.waitFor(() => expect(store.panes.every((pane) => !!pane.sessionId)).toBe(true));
  xterm.instances[0]!.textarea!.focus();
});
afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  root.remove();
  document.querySelectorAll('dialog').forEach((dialog) => dialog.remove());
  HTMLDialogElement.prototype.showModal = showModal;
  vi.unstubAllGlobals();
});
async function upload(): Promise<void> {
  const payload: TerminalFileDrag = {
    type: 'drop',
    x: 600 * window.devicePixelRatio,
    y: 100 * window.devicePixelRatio,
    grant: 'native',
    names: ['file.bin'],
  };
  for (const callback of [...native.listeners]) callback({ payload });
  // Claiming the second pane also makes it the return target for native dialog focus.
  expect(store.focused).toBe(store.panes[1]!.key);
  expect(document.activeElement).toBe(xterm.instances[1]!.textarea);
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  const confirm = [...document.querySelectorAll('dialog button')].find(
    (button) => button.textContent?.trim() === '确认上传',
  ) as HTMLButtonElement;
  confirm.focus();
  confirm.click();
  await vi.waitFor(() => expect(terminalApi.runDrop).toHaveBeenCalledOnce());
  expect(document.activeElement).not.toBe(xterm.instances[1]!.textarea);
  xterm.focus.mockClear();
}
function finish(): void {
  complete({ code: null, committed: 1, recovery: null });
}
async function closed(): Promise<void> {
  await vi.waitFor(() =>
    expect(document.querySelector('dialog[aria-label="终端文件上传"]')).toBeNull(),
  );
  await nextTick();
}

it('returns focus to the drop target pane and sends typing without another click', async () => {
  await upload();
  finish();
  await closed();
  expect(document.activeElement).toBe(xterm.instances[1]!.textarea);
  expect(xterm.focus).toHaveBeenCalledWith(1);
  xterm.instances[1]!.textarea!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'k', bubbles: true }),
  );
  const inputs = () =>
    vi.mocked(terminalApi.input).mock.calls.map(([id, data]) => [id, Array.from(data)]);
  await vi.waitFor(() => expect(inputs()).toContainEqual(['session-1', [107]]));
  expect(inputs()).not.toContainEqual(['session-0', [107]]);
});
it('returns focus after cancellation has finished and its dialog is removed', async () => {
  await upload();
  (
    [...document.querySelectorAll('dialog button')].find(
      (button) => button.textContent?.trim() === '取消上传',
    ) as HTMLButtonElement
  ).click();
  await closed();
  expect(document.activeElement).toBe(xterm.instances[1]!.textarea);
  expect(xterm.focus).toHaveBeenCalledWith(1);
});
it('does not steal focus when the owning workspace is hidden before completion', async () => {
  await upload();
  active.value = false;
  await nextTick();
  const outside = document.createElement('input');
  root.append(outside);
  outside.focus();
  finish();
  await closed();
  expect(document.activeElement).toBe(outside);
  expect(xterm.focus).not.toHaveBeenCalled();
});
it('does not steal focus from a newer open dialog', async () => {
  await upload();
  finish();
  const dialog = document.createElement('dialog');
  dialog.open = true;
  const input = document.createElement('input');
  dialog.append(input);
  document.body.append(dialog);
  input.focus();
  await closed();
  expect(document.activeElement).toBe(input);
  expect(xterm.focus).not.toHaveBeenCalled();
});

it('does not focus a disconnected session when its failure dialog is dismissed', async () => {
  await upload();
  receivers.get('session-1')!({
    type: 'state',
    state: 'failed',
    code: 'SSH_DISCONNECTED',
    message: 'disconnected',
  });
  await vi.waitFor(() =>
    expect(document.querySelector('dialog')?.textContent).toContain('终端会话已结束'),
  );
  (
    [...document.querySelectorAll('dialog button')].find(
      (button) => button.textContent?.trim() === '关闭',
    ) as HTMLButtonElement
  ).click();
  await closed();
  expect(xterm.focus).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(xterm.instances[1]!.textarea);
});
