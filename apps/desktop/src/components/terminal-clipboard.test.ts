import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import TerminalPane from './TerminalPane.vue';
import { useApplicationStore } from '../stores/application';
import { useTerminalsStore, type TerminalPaneModel } from '../stores/terminals';
import { useNotificationsStore } from '../stores/notifications';
import { terminalApi } from '../services/terminal';
import { defaultTerminalPreferences } from '../types/preferences';
import { defaultProductPreferences } from '../types/product';
import { hostInput } from '../types/hosts';
import { clipboardApi } from '../services/clipboard';
import type { ITerminalOptions } from '@xterm/xterm';

vi.mock('../services/clipboard', () => ({
  clipboardApi: { writeText: vi.fn(), readText: vi.fn() },
}));

const xterm = vi.hoisted(() => ({
  selection: '',
  selectionChanged: () => {},
  input: vi.fn() as (data: string) => void,
  keyHandler: vi.fn(() => true) as (event: KeyboardEvent) => boolean,
  pasted: vi.fn(),
  options: {} as ITerminalOptions,
  activateLink: (() => {}) as (event: MouseEvent, url: string) => void,
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options: ITerminalOptions) {
      xterm.options = options;
    }
    buffer = { active: { type: 'normal', baseY: 0, viewportY: 0 } };
    options = {};
    cols = 80;
    rows = 24;
    parser = { registerOscHandler: vi.fn() };
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    write() {}
    onResize() {}
    onBinary() {}
    attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean) {
      xterm.keyHandler = callback;
    }
    onSelectionChange(callback: () => void) {
      xterm.selectionChanged = callback;
    }
    onData(callback: (data: string) => void) {
      xterm.input = callback;
    }
    getSelection() {
      return xterm.selection;
    }
    hasSelection() {
      return xterm.selection.length > 0;
    }
    paste(text: string) {
      xterm.pasted(text);
      xterm.input(text);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    clearDecorations() {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(activate: (event: MouseEvent, url: string) => void) {
      xterm.activateLink = activate;
    }
  },
}));

let app: App, pinia: Pinia, root: HTMLDivElement, tab: TerminalPaneModel;
const active = ref(true);
const events = {
  server: vi.fn(),
  close: vi.fn(),
};
const PaneHarness = {
  setup: () => () =>
    h(TerminalPane, {
      tab,
      active: active.value,
      onServer: events.server,
      onClose: events.close,
    }),
};
const writeText = vi.mocked(clipboardApi.writeText),
  readText = vi.mocked(clipboardApi.readText);
const browserRead = vi.fn(() => {
    throw new Error('Browser clipboard must not be used');
  }),
  browserWrite = vi.fn(() => {
    throw new Error('Browser clipboard must not be used');
  });
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
beforeEach(async () => {
  vi.clearAllMocks();
  xterm.selection = '';
  active.value = true;
  writeText.mockResolvedValue(undefined);
  readText.mockResolvedValue('clipboard text');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: browserWrite, readText: browserRead },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  pinia = createPinia();
  setActivePinia(pinia);
  useApplicationStore().state = {
    appVersion: 'test',
    databaseVersion: 10,
    dataDirectory: '',
    logDirectory: '',
    config: {
      version: 2,
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
  const store = useTerminalsStore();
  store.open(null);
  tab = store.tabs[0]!.panes[0]!;
  vi.spyOn(terminalApi, 'openLocal').mockImplementation(async (_size, receive) => {
    receive({ type: 'state', state: 'connected', code: null, message: null });
    return { id: 'local:test', shell: 'test shell' };
  });
  vi.spyOn(terminalApi, 'input').mockResolvedValue();
  vi.spyOn(terminalApi, 'close').mockResolvedValue();
  vi.spyOn(terminalApi, 'openLink').mockResolvedValue();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(PaneHarness).use(pinia);
  app.mount(root);
  await vi.waitFor(() => expect(tab.sessionId).toBe('local:test'));
});
afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  root.remove();
  document.querySelectorAll('dialog').forEach((dialog) => dialog.remove());
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.unstubAllGlobals();
  expect(browserRead).not.toHaveBeenCalled();
  expect(browserWrite).not.toHaveBeenCalled();
});
function enable(value = true) {
  useApplicationStore().state!.config.terminal.quickCopyPaste = value;
}
it('opens plain HTTP/HTTPS and OSC 8 links on a left click without sending shell input', async () => {
  const url = 'http://localhost:8080/login?state=abc&next=%2Fhome#result';
  const event = new MouseEvent('click', { button: 0, cancelable: true });
  xterm.activateLink(event, url);
  expect(event.defaultPrevented).toBe(true);
  expect(terminalApi.openLink).toHaveBeenCalledExactlyOnceWith(url);
  expect(terminalApi.input).not.toHaveBeenCalled();
  expect(xterm.options.linkHandler?.allowNonHttpProtocols).toBe(false);
  xterm.options.linkHandler!.activate(event, 'https://example.com/path', {
    start: { x: 1, y: 1 },
    end: { x: 20, y: 1 },
  });
  expect(terminalApi.openLink).toHaveBeenLastCalledWith('https://example.com/path');
  await nextTick();
});

it('does not activate links with a right click, a hidden pane, or another modal', async () => {
  const url = 'https://example.com/';
  xterm.activateLink(new MouseEvent('click', { button: 2 }), url);
  active.value = false;
  await nextTick();
  xterm.activateLink(new MouseEvent('click'), url);
  active.value = true;
  await nextTick();
  const dialog = document.createElement('dialog');
  dialog.open = true;
  document.body.append(dialog);
  xterm.activateLink(new MouseEvent('click'), url);
  expect(terminalApi.openLink).not.toHaveBeenCalled();
});

it('does not open a link while dragging to select its text', () => {
  xterm.selection = 'https://example.com/selected';
  xterm.activateLink(new MouseEvent('click'), xterm.selection);
  expect(terminalApi.openLink).not.toHaveBeenCalled();
  expect(terminalApi.input).not.toHaveBeenCalled();
});

it('shows browser opening errors through notifications', async () => {
  vi.mocked(terminalApi.openLink).mockRejectedValueOnce({ message: '无法打开默认浏览器' });
  xterm.activateLink(new MouseEvent('click'), 'https://example.com/');
  await vi.waitFor(() =>
    expect(useNotificationsStore().items.some((item) => item.text === '无法打开默认浏览器')).toBe(
      true,
    ),
  );
});
function rightClick(selector = '.xterm-container', button = 2, shiftKey = false) {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button,
    shiftKey,
  });
  root.querySelector(selector)!.dispatchEvent(event);
  return event;
}
async function menuAction(label: string): Promise<void> {
  rightClick('.xterm-container', 2, true);
  await nextTick();
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('[aria-label="终端操作"] [role="menuitem"]'),
  ].find((item) => item.getAttribute('aria-label') === label);
  expect(button).toBeDefined();
  button!.click();
  await nextTick();
}

it('removes persistent terminal bars while retaining copy and paste in the local context menu', async () => {
  expect(root.querySelector('.terminal-toolbar')).toBeNull();
  expect(root.querySelector('.terminal-identity')).toBeNull();
  expect(root.querySelector('.terminal-footnote')).toBeNull();
  expect(root.querySelector('.terminal-pane')?.firstElementChild).toBe(
    root.querySelector('.xterm-container'),
  );
  expect(root.querySelector('.terminal-pane')?.lastElementChild).toBe(
    root.querySelector('.xterm-container'),
  );
  xterm.selection = 'selected from menu';
  await menuAction('复制');
  expect(writeText).toHaveBeenCalledExactlyOnceWith('selected from menu');
  await menuAction('粘贴');
  await vi.waitFor(() => expect(xterm.pasted).toHaveBeenCalledExactlyOnceWith('clipboard text'));
  expect(document.querySelector('[aria-label="终端操作"]')).toBeNull();
});

it('keeps quick right-click paste and opens the menu with Shift+right-click or Shift+F10', async () => {
  enable();
  rightClick();
  await nextTick();
  expect(readText).toHaveBeenCalledOnce();
  expect(document.querySelector('[aria-label="终端操作"]')).toBeNull();
  rightClick('.xterm-container', 2, true);
  await nextTick();
  expect(readText).toHaveBeenCalledOnce();
  const menu = document.querySelector('[aria-label="终端操作"]')!;
  expect(menu).not.toBeNull();
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(buttons.at(-1));
  menu.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(buttons[0]);
  menu.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  await nextTick();
  expect(document.querySelector('[aria-label="终端操作"]')).toBeNull();
  const key = new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, cancelable: true });
  expect(xterm.keyHandler(key)).toBe(false);
  await nextTick();
  expect(key.defaultPrevented).toBe(true);
  expect(document.querySelector('[aria-label="终端操作"]')).not.toBeNull();
});

it('limits the local context menu to copy and paste', async () => {
  rightClick();
  await nextTick();
  const menu = document.querySelector('[aria-label="终端操作"]')!;
  expect(
    [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.getAttribute('aria-label')),
  ).toEqual(['复制', '粘贴']);
  expect(menu.querySelector('.terminal-menu-heading')).toBeNull();
});

it('limits the remote context menu to copy and paste without connection metadata', async () => {
  app.unmount();
  const store = useTerminalsStore();
  store.tabs = [];
  const host = {
    ...hostInput(),
    id: 'menu-host',
    name: 'Menu Host',
    hostname: 'menu.example',
    username: 'operator',
    createdAt: '',
    updatedAt: '',
  };
  store.open(host);
  tab = store.panes[0]!;
  tab.cwd = '/srv/project';
  vi.spyOn(terminalApi, 'open').mockImplementation(async (_id, _size, receive) => {
    receive({ type: 'state', state: 'connected', code: null, message: null });
    return { id: 'remote:menu', hostId: host.id, transportId: 'transport', routeHostIds: [] };
  });
  app = createApp(PaneHarness).use(pinia);
  app.mount(root);
  await vi.waitFor(() => expect(tab.sessionId).toBe('remote:menu'));
  rightClick();
  await nextTick();
  const menu = document.querySelector('[aria-label="终端操作"]')!;
  expect(
    [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.getAttribute('aria-label')),
  ).toEqual(['复制', '粘贴']);
  expect(menu.textContent).not.toContain(host.hostname);
  expect(menu.textContent).not.toContain(host.username);
});

it('opens an idle SSH pane once after an explicit connection request and keeps trust confirmation', async () => {
  app.unmount();
  const store = useTerminalsStore();
  store.tabs = [];
  store.open({
    ...hostInput(),
    id: 'ssh-host',
    name: 'SSH Host',
    hostname: 'host.example',
    createdAt: '',
    updatedAt: '',
  });
  tab = store.panes[0]!;
  store.update(tab.key, { state: 'idle', connectRequested: false });
  const open = vi.spyOn(terminalApi, 'open').mockImplementation(async (_hostId, _size, receive) => {
    receive({ type: 'state', state: 'awaiting_trust', code: null, message: null });
    receive({
      type: 'trust',
      hostname: 'host.example',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:test',
    });
    return { id: 'ssh-session', hostId: 'ssh-host', transportId: 'transport', routeHostIds: [] };
  });
  const trust = vi.spyOn(terminalApi, 'trust').mockResolvedValue();
  app = createApp(PaneHarness).use(pinia);
  app.mount(root);
  await nextTick();
  expect(open).not.toHaveBeenCalled();
  store.update(tab.key, { connectRequested: true });
  await vi.waitFor(() => expect(tab.sessionId).toBe('ssh-session'));
  expect(open).toHaveBeenCalledExactlyOnceWith(
    'ssh-host',
    expect.any(Object),
    expect.any(Function),
  );
  expect(tab.state).toBe('awaiting_trust');
  expect(document.querySelector('dialog[open]')?.textContent).toContain('SHA256:test');
  expect(trust).not.toHaveBeenCalled();
  store.update(tab.key, { connectRequested: true });
  active.value = false;
  await nextTick();
  active.value = true;
  await nextTick();
  expect(open).toHaveBeenCalledOnce();
});

it('does not read or write the clipboard by default and reacts to saved preference changes', async () => {
  xterm.selection = 'selected text';
  xterm.selectionChanged();
  expect(rightClick().defaultPrevented).toBe(true);
  expect(writeText).not.toHaveBeenCalled();
  expect(readText).not.toHaveBeenCalled();
  enable();
  xterm.selectionChanged();
  expect(writeText).toHaveBeenCalledExactlyOnceWith('selected text');
  expect(rightClick().defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(xterm.pasted).toHaveBeenCalledExactlyOnceWith('clipboard text'));
  expect(terminalApi.input).toHaveBeenCalledWith(
    'local:test',
    new TextEncoder().encode('clipboard text'),
  );
  enable(false);
  xterm.selectionChanged();
  rightClick();
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(readText).toHaveBeenCalledTimes(1);
});

it('copies only a nonempty selection from an active pane', async () => {
  enable();
  xterm.selectionChanged();
  expect(writeText).not.toHaveBeenCalled();
  active.value = false;
  await nextTick();
  xterm.selection = 'inactive text';
  xterm.selectionChanged();
  rightClick();
  expect(writeText).not.toHaveBeenCalled();
  expect(readText).not.toHaveBeenCalled();
});

it('intercepts right mouse events only inside the terminal and does not also invoke xterm handlers', () => {
  enable();
  root.addEventListener('contextmenu', (event) => event.preventDefault(), true);
  const child = document.createElement('div');
  root.querySelector('.xterm-container')!.append(child);
  const handler = vi.fn();
  child.addEventListener('mousedown', handler);
  child.addEventListener('contextmenu', handler);
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
  child.dispatchEvent(down);
  child.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
  );
  expect(down.defaultPrevented).toBe(true);
  expect(handler).not.toHaveBeenCalled();
  expect(readText).toHaveBeenCalledOnce();
  rightClick('.terminal-pane');
  rightClick('.xterm-container', 0);
  expect(readText).toHaveBeenCalledOnce();
});

it('keeps large paste behind confirmation and cancellation sends no input', async () => {
  enable();
  readText.mockResolvedValue('x'.repeat(4096));
  rightClick();
  await vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
  expect(xterm.pasted).not.toHaveBeenCalled();
  expect(terminalApi.input).not.toHaveBeenCalled();
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
    (button) => button.textContent === '取消',
  )!;
  cancel.click();
  await nextTick();
  expect(document.querySelector('dialog')).toBeNull();
  rightClick();
  await vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
  const approve = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
    (button) => button.textContent === '确认粘贴',
  )!;
  approve.click();
  await vi.waitFor(() => expect(xterm.pasted).toHaveBeenCalledExactlyOnceWith('x'.repeat(4096)));
});

it('rejects oversize or disconnected pastes and does not act behind an open dialog', async () => {
  enable();
  readText.mockResolvedValue('x'.repeat(2 * 1024 * 1024 + 1));
  rightClick();
  await vi.waitFor(() =>
    expect(
      useNotificationsStore().items.some(
        (item) => item.error && item.text.includes('单次粘贴最多 2 MiB'),
      ),
    ).toBe(true),
  );
  expect(xterm.pasted).not.toHaveBeenCalled();
  tab.state = 'disconnected';
  rightClick();
  await nextTick();
  expect(readText).toHaveBeenCalledOnce();
  expect(
    useNotificationsStore().items.some(
      (item) => item.error && item.text.includes('请先连接终端再粘贴'),
    ),
  ).toBe(true);
  expect(root.querySelector('[role="alert"]')).toBeNull();
  tab.state = 'connected';
  const dialog = document.createElement('dialog');
  dialog.open = true;
  document.body.append(dialog);
  rightClick();
  expect(readText).toHaveBeenCalledOnce();
});

it('reports clipboard permission errors without sending terminal input', async () => {
  enable();
  writeText.mockRejectedValue(new Error('private failure details'));
  readText.mockRejectedValue(new Error('private failure details'));
  xterm.selection = 'text';
  xterm.selectionChanged();
  await vi.waitFor(() =>
    expect(useNotificationsStore().items.some((item) => item.text.includes('无法写入剪贴板'))).toBe(
      true,
    ),
  );
  rightClick();
  await vi.waitFor(() =>
    expect(useNotificationsStore().items.some((item) => item.text.includes('无法读取剪贴板'))).toBe(
      true,
    ),
  );
  expect(root.querySelector('[role="alert"]')).toBeNull();
  expect(
    useNotificationsStore().items.some((item) => item.text.includes('private failure details')),
  ).toBe(false);
  expect(root.textContent).not.toContain('private failure details');
  expect(xterm.pasted).not.toHaveBeenCalled();
  expect(terminalApi.input).not.toHaveBeenCalled();
});

it('drops an asynchronous clipboard read if the pane reconnects before it finishes', async () => {
  enable();
  const pane = root.querySelector('.terminal-pane');
  let finish!: (text: string) => void;
  const reading = new Promise<string>((resolve) => (finish = resolve));
  readText.mockReturnValueOnce(reading);
  rightClick();
  expect(readText).toHaveBeenCalledOnce();
  vi.mocked(terminalApi.openLocal).mockImplementationOnce(async (_size, receive) => {
    receive({ type: 'state', state: 'connected', code: null, message: null });
    return { id: 'local:reconnected', shell: 'test shell' };
  });
  const store = useTerminalsStore();
  store.update(tab.key, { state: 'idle', connectRequested: false });
  await nextTick();
  store.update(tab.key, { connectRequested: true });
  await vi.waitFor(() => expect(tab.sessionId).toBe('local:reconnected'));
  expect(terminalApi.openLocal).toHaveBeenCalledTimes(2);
  expect(terminalApi.close).toHaveBeenCalledExactlyOnceWith('local:test');
  expect(tab.state).toBe('connected');
  expect(root.querySelector('.terminal-pane')).toBe(pane);
  finish('stale clipboard');
  await reading;
  await nextTick();
  expect(xterm.pasted).not.toHaveBeenCalled();
  expect(terminalApi.input).not.toHaveBeenCalled();

  readText.mockResolvedValueOnce('fresh clipboard');
  rightClick();
  await vi.waitFor(() =>
    expect(terminalApi.input).toHaveBeenCalledExactlyOnceWith(
      'local:reconnected',
      new TextEncoder().encode('fresh clipboard'),
    ),
  );
  expect(xterm.pasted).toHaveBeenCalledExactlyOnceWith('fresh clipboard');
});
