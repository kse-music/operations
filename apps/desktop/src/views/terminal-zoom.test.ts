import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import TerminalsView from './TerminalsView.vue';
import { useApplicationStore } from '../stores/application';
import { useTerminalsStore } from '../stores/terminals';
import { useNotificationsStore } from '../stores/notifications';
import * as ipc from '../services/ipc';
import { defaultTerminalPreferences } from '../types/preferences';
import { resolveTerminalFontFamily, resolveTerminalLineHeight } from '../services/terminal-font';
import { defaultProductPreferences } from '../types/product';
import type { AppConfig } from '../types/ipc';

const xterm = vi.hoisted(() => ({
  instances: [] as {
    options: { fontSize: number; fontFamily: string; lineHeight: number };
    keyHandler: (event: KeyboardEvent) => boolean;
  }[],
  fit: vi.fn(),
  open: vi.fn(),
  observers: [] as (() => void)[],
  wheel: vi.fn(),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    keyHandler: (event: KeyboardEvent) => boolean = () => true;
    parser = { registerOscHandler: vi.fn() };
    constructor(public options: { fontSize: number; fontFamily: string; lineHeight: number }) {
      xterm.instances.push(this);
    }
    loadAddon() {}
    open(container: HTMLElement) {
      xterm.open(container);
      const screen = document.createElement('div');
      screen.className = 'test-terminal-screen';
      screen.addEventListener('wheel', xterm.wheel);
      container.append(screen);
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    onSelectionChange() {}
    onData() {}
    onBinary() {}
    onResize() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = xterm.fit;
  },
}));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));

let app: App, pinia: Pinia, root: HTMLDivElement;
const visible = ref(true);
beforeEach(async () => {
  vi.clearAllMocks();
  xterm.instances.length = 0;
  xterm.observers.length = 0;
  visible.value = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        xterm.observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  pinia = createPinia();
  setActivePinia(pinia);
  useApplicationStore().state = {
    appVersion: 'test',
    databaseVersion: 5,
    dataDirectory: '',
    logDirectory: '',
    config: {
      version: 1,
      theme: 'dark',
      interfaceFontSize: 'standard',
      sidebarWidth: 260,
      terminalFontSize: 14,
      connectTimeoutSecs: 10,
      monitorIntervalSecs: 5,
      transferConcurrency: 3,
      logLevel: 'info',
      terminal: defaultTerminalPreferences(),
      product: defaultProductPreferences(),
    },
  };
  const terminals = useTerminalsStore();
  terminals.open(null);
  terminals.split(terminals.focused, 'columns');
  for (const pane of terminals.panes) {
    terminals.update(pane.key, { connectRequested: false, state: 'idle' });
  }
  root = document.createElement('div');
  document.body.append(root);
  app = createApp({ setup: () => () => h(TerminalsView, { visible: visible.value }) }).use(pinia);
  app.mount(root);
  await nextTick();
});
afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  root.remove();
  document.querySelectorAll('dialog').forEach((dialog) => dialog.remove());
  vi.unstubAllGlobals();
});
function wheel(init: WheelEventInit, target = root.querySelector('.test-terminal-screen')!) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
async function savedSize(size: number) {
  await vi.waitFor(() => {
    expect(useApplicationStore().state!.config.terminalFontSize).toBe(size);
    expect(useApplicationStore().saving).toBe(false);
    expect(xterm.instances.map((terminal) => terminal.options.fontSize)).toEqual([size, size]);
  });
}

it('zooms all terminal fonts with Ctrl+wheel, saves the setting and refits the panes', async () => {
  const original = { ...useApplicationStore().state!.config };
  xterm.fit.mockClear();
  expect(wheel({ ctrlKey: true, deltaY: -120 }).defaultPrevented).toBe(true);
  await savedSize(15);
  expect(ipc.saveConfig).toHaveBeenLastCalledWith({ ...original, terminalFontSize: 15 });
  expect(xterm.fit).toHaveBeenCalledTimes(2);
  expect(wheel({ ctrlKey: true, deltaY: 120 }).defaultPrevented).toBe(true);
  await savedSize(14);
  expect(xterm.wheel).not.toHaveBeenCalled();
});

it('keeps xterm content at the terminal font size during interface preview and save', async () => {
  const application = useApplicationStore();
  application.interfaceFontSizePreview = 'ultraLarge';
  await nextTick();
  expect(xterm.instances.map((terminal) => terminal.options.fontSize)).toEqual([14, 14]);
  await application.save({ ...application.state!.config, interfaceFontSize: 'ultraLarge' });
  application.interfaceFontSizePreview = undefined;
  await nextTick();
  expect(xterm.instances.map((terminal) => terminal.options.fontSize)).toEqual([14, 14]);
});

it('leaves ordinary, horizontal and non-terminal wheel events untouched', () => {
  const screen = root.querySelector('.test-terminal-screen')!;
  for (const init of [
    { deltaY: 120 },
    { deltaY: -120, shiftKey: true },
    { ctrlKey: true, deltaX: 100 },
  ]) {
    expect(wheel(init, screen).defaultPrevented).toBe(false);
  }
  expect(xterm.wheel).toHaveBeenCalledTimes(3);
  expect(
    wheel({ ctrlKey: true, deltaY: -120 }, root.querySelector('.terminal-session-header')!)
      .defaultPrevented,
  ).toBe(false);
  expect(ipc.saveConfig).not.toHaveBeenCalled();
});

it('does not zoom hidden panes or act behind a modal', async () => {
  visible.value = false;
  await nextTick();
  expect(wheel({ ctrlKey: true, deltaY: -120 }).defaultPrevented).toBe(false);
  visible.value = true;
  await nextTick();
  const dialog = document.createElement('dialog');
  dialog.open = true;
  document.body.append(dialog);
  expect(wheel({ ctrlKey: true, deltaY: -120 }).defaultPrevented).toBe(false);
  expect(ipc.saveConfig).not.toHaveBeenCalled();
});

it('defers opening a hidden terminal until its container has both dimensions', async () => {
  const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(0);
  const terminals = useTerminalsStore();
  terminals.split(terminals.focused, 'rows');
  terminals.update(terminals.focused, { connectRequested: false, state: 'idle' });
  await nextTick();
  expect(xterm.open).toHaveBeenCalledTimes(2);
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(0);
  height.mockReturnValue(600);
  xterm.observers.forEach((callback) => callback());
  expect(xterm.open).toHaveBeenCalledTimes(2);
  width.mockReturnValue(800);
  xterm.observers.forEach((callback) => callback());
  expect(xterm.open).toHaveBeenCalledTimes(3);
  xterm.observers.forEach((callback) => callback());
  expect(xterm.open).toHaveBeenCalledTimes(3);
});

it('applies font changes after hidden panes become visible', async () => {
  visible.value = false;
  await nextTick();
  const config = useApplicationStore().state!.config;
  config.terminalFontSize = 18;
  config.terminal.fontFamily = 'monospace';
  config.terminal.lineHeight = 150;
  await nextTick();
  expect(xterm.instances.map((terminal) => terminal.options.fontSize)).toEqual([14, 14]);
  expect(xterm.instances.map((terminal) => terminal.options.fontFamily)).toEqual([
    resolveTerminalFontFamily(defaultTerminalPreferences().fontFamily),
    resolveTerminalFontFamily(defaultTerminalPreferences().fontFamily),
  ]);
  expect(xterm.instances.map((terminal) => terminal.options.lineHeight)).toEqual([
    resolveTerminalLineHeight(100),
    resolveTerminalLineHeight(100),
  ]);
  visible.value = true;
  await vi.waitFor(() => {
    expect(xterm.instances.map((terminal) => terminal.options.fontSize)).toEqual([18, 18]);
    expect(xterm.instances.map((terminal) => terminal.options.fontFamily)).toEqual([
      'monospace',
      'monospace',
    ]);
    expect(xterm.instances.map((terminal) => terminal.options.lineHeight)).toEqual([1.5, 1.5]);
  });
  expect(xterm.open).toHaveBeenCalledTimes(2);
});

it.each([10, 32])('enforces the %i font boundary without redundant saves', async (size) => {
  useApplicationStore().state!.config.terminalFontSize = size;
  await nextTick();
  const deltaY = size === 32 ? -1 : 1;
  expect(wheel({ ctrlKey: true, deltaY }).defaultPrevented).toBe(true);
  expect(ipc.saveConfig).not.toHaveBeenCalled();
  wheel({ ctrlKey: true, deltaY: -deltaY });
  await savedSize(size === 32 ? 31 : 11);
});

it('coalesces rapid wheel steps during saving and preserves direction changes at the limit', async () => {
  const pending: { config: AppConfig; resolve: (config: AppConfig) => void }[] = [];
  vi.mocked(ipc.saveConfig).mockImplementation(
    (config) =>
      new Promise((resolve) => {
        pending.push({ config, resolve });
      }),
  );
  useApplicationStore().state!.config.terminalFontSize = 30;
  await nextTick();
  for (let index = 0; index < 5; index++) wheel({ ctrlKey: true, deltaY: -120 });
  wheel({ ctrlKey: true, deltaY: 120 });
  wheel({ ctrlKey: true, deltaY: 120 });
  expect(ipc.saveConfig).toHaveBeenCalledOnce();
  expect(pending[0]!.config.terminalFontSize).toBe(31);
  pending[0]!.resolve(pending[0]!.config);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[1]!.config.terminalFontSize).toBe(30);
  pending[1]!.resolve(pending[1]!.config);
  await savedSize(30);
  expect(ipc.saveConfig).toHaveBeenCalledTimes(2);
});

it('keeps keyboard font shortcuts using the same zoom path', async () => {
  const event = new KeyboardEvent('keydown', {
    key: '=',
    code: 'Equal',
    ctrlKey: true,
    shiftKey: true,
    cancelable: true,
  });
  expect(xterm.instances[0]!.keyHandler(event)).toBe(false);
  expect(event.defaultPrevented).toBe(true);
  await savedSize(15);
});

it('reports save failures, retains the saved font and allows a later retry', async () => {
  vi.mocked(ipc.saveConfig).mockRejectedValueOnce({ message: '无法保存设置。' });
  wheel({ ctrlKey: true, deltaY: -120 });
  await vi.waitFor(() => expect(useApplicationStore().error).toBe('无法保存设置。'));
  await savedSize(14);
  expect(
    useNotificationsStore().items.some((item) => item.error && item.text === '无法保存设置。'),
  ).toBe(true);
  wheel({ ctrlKey: true, deltaY: -120 });
  await savedSize(15);
  expect(ipc.saveConfig).toHaveBeenCalledTimes(2);
});
