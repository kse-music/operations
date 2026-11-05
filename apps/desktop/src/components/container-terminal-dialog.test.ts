import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import ContainerTerminalDialog from './ContainerTerminalDialog.vue';
import { useTerminalsStore } from '../stores/terminals';
import { hostInput } from '../types/hosts';
import type { TerminalEvent } from '../types/terminal';
const api = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  input: vi.fn(),
  focus: vi.fn(),
  data: vi.fn() as (value: string) => void,
}));
vi.mock('../services/plugin-server', () => ({ pluginContainerShell: api.open }));
vi.mock('../services/terminal', () => ({ terminalApi: { input: api.input, close: api.close } }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    parser = { registerOscHandler() {} };
    loadAddon() {}
    open() {}
    dispose() {}
    onResize() {}
    onBinary() {}
    onSelectionChange() {}
    attachCustomKeyEventHandler() {}
    focus() {
      api.focus();
    }
    onData(callback: (value: string) => void) {
      api.data = callback;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
let app: App | undefined, pinia: Pinia, root: HTMLElement;
const closed = vi.fn();
const shell = {
  id: 'a'.repeat(64),
  bash: false,
  confirmed: false,
  pluginId: 'cn.hiboot.plugins.docker',
};
const host = { ...hostInput(), id: 'host', createdAt: '', updatedAt: '' };
const settle = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
  await nextTick();
};
beforeEach(() => {
  vi.clearAllMocks();
  api.close.mockResolvedValue(undefined);
  api.input.mockResolvedValue(undefined);
  api.open.mockImplementation(
    async (_host, _size, _shell, receive: (event: TerminalEvent) => void) => {
      receive({ type: 'state', state: 'connected', code: null, message: null });
      return {
        id: 'container-pty',
        hostId: 'host',
        transportId: 'transport',
        routeHostIds: ['host'],
      };
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(720);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
});
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await settle();
  if (pinia) disposePinia(pinia);
  root?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function mount() {
  pinia = createPinia();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(ContainerTerminalDialog, { host, shell, onClose: closed }).use(pinia);
  app.mount(root);
  await settle();
}
it('opens the container PTY immediately inside its dialog, focuses input and keeps workspace terminals untouched', async () => {
  await mount();
  expect(api.open).toHaveBeenCalledWith(
    'host',
    { cols: 80, rows: 24 },
    shell,
    expect.any(Function),
  );
  expect(
    document.querySelector('.container-terminal-dialog [data-state="connected"]'),
  ).not.toBeNull();
  expect(document.querySelector('[aria-label="确认运维目标"]')).toBeNull();
  expect(useTerminalsStore(pinia).tabs).toEqual([]);
  expect(api.focus).toHaveBeenCalled();
  api.data('whoami\r');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.input.mock.calls[0]![0]).toBe('container-pty');
  expect(Array.from(api.input.mock.calls[0]![1] as Uint8Array)).toEqual([
    ...new TextEncoder().encode('whoami\r'),
  ]);
  app!.unmount();
  app = undefined;
  await settle();
  expect(api.close).toHaveBeenCalledWith('container-pty');
});
it('closes a PTY which finishes opening after the dialog was dismissed', async () => {
  let finish!: (value: unknown) => void;
  api.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  app!.unmount();
  app = undefined;
  finish({
    id: 'late-container-pty',
    hostId: 'host',
    transportId: 'transport',
    routeHostIds: ['host'],
  });
  await settle();
  expect(api.close).toHaveBeenCalledWith('late-container-pty');
});
