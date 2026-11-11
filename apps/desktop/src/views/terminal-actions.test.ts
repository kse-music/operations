import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import type { TerminalEvent } from '../types/terminal';
import type { Host } from '../types/hosts';
import { defaultSshOptions } from '../types/connection';
import { defaultTerminalPreferences } from '../types/preferences';
import { defaultProductPreferences } from '../types/product';
import { useApplicationStore } from '../stores/application';
import { useHostsStore } from '../stores/hosts';
import { useTerminalsStore } from '../stores/terminals';
import TerminalsView from './TerminalsView.vue';
import type { ITerminalOptions } from '@xterm/xterm';

const native = vi.hoisted(() => ({
  open: vi.fn(),
  openLocal: vi.fn(),
  close: vi.fn(),
  input: vi.fn(),
  ack: vi.fn(),
  resize: vi.fn(),
  trust: vi.fn(),
  receivers: [] as ((event: TerminalEvent) => void)[],
}));
const terminals = vi.hoisted(() => ({
  instances: [] as {
    osc?: (value: string) => boolean;
    writes: unknown[];
    options: ITerminalOptions;
  }[],
}));
vi.mock('../services/terminal', () => ({ terminalApi: native }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    buffer = { active: { type: 'normal', baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0 } };
    cols = 80;
    rows = 24;
    osc?: (value: string) => boolean;
    writes: unknown[] = [];
    parser = {
      registerOscHandler: (_code: number, handler: (value: string) => boolean) => {
        this.osc = handler;
      },
    };
    constructor(public options: ITerminalOptions) {
      terminals.instances.push(this);
    }
    loadAddon() {}
    open() {}
    onSelectionChange() {}
    onData() {}
    onBinary() {}
    onResize() {}
    onCursorMove() {}
    attachCustomKeyEventHandler() {}
    write(value: unknown, callback?: () => void) {
      this.writes.push(value);
      callback?.();
    }
    focus() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    clearDecorations() {}
  },
}));

let app: App, pinia: Pinia, root: HTMLElement;
const host: Host = {
  id: 'host',
  name: '目标主机',
  hostname: 'target.example',
  port: 22,
  username: 'user',
  authType: 'agent',
  credentialId: null,
  groupId: null,
  description: '',
  favorite: false,
  connectTimeoutSecs: 15,
  ssh: defaultSshOptions(),
  createdAt: '',
  updatedAt: '',
};
const hostId = ref('host');
async function flush() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}
function pane(): HTMLElement {
  return root.querySelector<HTMLElement>('.split-pane.focused .terminal-pane')!;
}
function button(name: string, scope: ParentNode = document): HTMLButtonElement {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
  expect(result, `missing button: ${name}`).toBeTruthy();
  return result!;
}
async function tabMenu(index = 0) {
  root
    .querySelectorAll('.terminal-tab')
    [index]!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }),
    );
  await flush();
  return document.querySelector('[aria-label="终端会话操作"]')!;
}
beforeEach(async () => {
  vi.clearAllMocks();
  native.receivers.length = 0;
  terminals.instances.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  native.close.mockResolvedValue(undefined);
  native.ack.mockResolvedValue(undefined);
  const open = (_host: unknown, _size: unknown, receive: (event: TerminalEvent) => void) => {
    const id = `session-${native.receivers.length}`;
    native.receivers.push(receive);
    queueMicrotask(() => receive({ type: 'state', state: 'connected', code: null, message: null }));
    return Promise.resolve({ id, hostId: 'host', transportId: 'transport', routeHostIds: [] });
  };
  native.open.mockImplementation(open);
  native.openLocal.mockImplementation((size, receive) => open(null, size, receive));
  pinia = createPinia();
  setActivePinia(pinia);
  useHostsStore().catalog = {
    hosts: [structuredClone(host)],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  useApplicationStore().state = {
    appVersion: 'test',
    databaseVersion: 10,
    dataDirectory: '',
    logDirectory: '',
    config: {
      version: 2,
      theme: 'dark',
      interfaceFontSize: 'standard',
      sidebarWidth: 248,
      terminalFontSize: 16,
      connectTimeoutSecs: 15,
      monitorIntervalSecs: 3,
      transferConcurrency: 3,
      logLevel: 'info',
      terminal: defaultTerminalPreferences(),
      product: defaultProductPreferences(),
    },
  };
  useTerminalsStore().open(host);
  hostId.value = 'host';
  root = document.createElement('div');
  document.body.append(root);
  app = createApp({
    setup: () => () => h(TerminalsView, { hostId: hostId.value }),
  }).use(pinia);
  app.mount(root);
  await flush();
});
afterEach(async () => {
  native.close.mockResolvedValue(undefined);
  app?.unmount();
  await flush();
  if (pinia) disposePinia(pinia);
  root?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('isolates old-generation data when a connection request reuses the same pane', async () => {
  const store = useTerminalsStore();
  const key = store.focused;
  const original = native.receivers[0]!;
  original({ type: 'state', state: 'disconnected', code: null, message: 'connection lost' });
  await flush();
  store.update(key, { state: 'idle', connectRequested: true });
  await flush();
  expect(native.close).toHaveBeenCalledWith('session-0');
  expect(native.open).toHaveBeenCalledTimes(2);
  expect(store.panes).toHaveLength(1);
  expect(store.focused).toBe(key);
  expect(store.panes[0]?.sessionId).toBe('session-1');
  const count = terminals.instances[0]!.writes.length;
  original({ type: 'data', sequence: 9, data: [65] });
  expect(terminals.instances[0]!.writes).toHaveLength(count);
  expect(native.input).not.toHaveBeenCalled();
});

it('retains the validated OSC 7 path without terminal file navigation', async () => {
  terminals.instances[0]!.osc!('file:///srv/project');
  await flush();
  expect(useTerminalsStore().panes[0]?.cwd).toBe('/srv/project');
  expect(pane().querySelector('.terminal-footnote')).toBeNull();
});

it.each(['connected', 'disconnected'] as const)(
  'removes bottom actions in the %s state and keeps content right-click minimal',
  async (state) => {
    native.receivers[0]!({ type: 'state', state, code: null, message: null });
    await flush();
    expect([...pane().children]).toEqual([pane().querySelector('.xterm-container')]);
    expect(pane().textContent).not.toContain('Ctrl+');
    expect(pane().querySelector('button')).toBeNull();
    pane()
      .querySelector('.xterm-container')!
      .dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    await flush();
    expect(
      [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((item) =>
        item.getAttribute('aria-label'),
      ),
    ).toEqual(['复制', '粘贴']);
    expect(button('粘贴', document.querySelector('[role=menu]')!).disabled).toBe(
      state !== 'connected',
    );
    document
      .querySelector('[role=menu]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(document.querySelector('dialog')).toBeNull();
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(native.close).not.toHaveBeenCalled();
  },
);

it('duplicates the right-click target as an ordinary fresh shell and preserves the active tab until chosen', async () => {
  const store = useTerminalsStore();
  const original = store.tabs[0]!;
  original.panes[0]!.fileAction = { kind: 'tail', path: '/sensitive/path' };
  store.open(host);
  await flush();
  const active = store.active;
  const menu = await tabMenu(0);
  expect(store.active).toBe(active);
  expect([...menu.querySelectorAll('button')].map((item) => item.textContent)).toEqual([
    '复制',
    '重命名',
    '重新连接',
    '断开连接',
    '关闭所有',
    '关闭',
  ]);
  button('复制', menu).click();
  await flush();
  const added = store.tabs.at(-1)!;
  expect(added.panes).toHaveLength(1);
  expect(added.panes[0]!.key).not.toBe(original.panes[0]!.key);
  expect(added.panes[0]!.fileAction).toBeUndefined();
  expect(added.panes[0]!.pluginTerminal).toBeUndefined();
  expect(added.panes[0]!.host?.id).toBe('host');
  expect(native.open).toHaveBeenLastCalledWith('host', expect.anything(), expect.any(Function));
});

it.each(['ssh', 'local'])(
  'preserves output on %s disconnect and resets it on reconnect without replacing the tab',
  async (kind) => {
    const store = useTerminalsStore();
    if (kind === 'local') {
      hostId.value = '';
      store.open(null);
      await flush();
    }
    const target = store.tabs.at(-1)!;
    const pane = target.panes[0]!;
    const oldSession = pane.sessionId;
    const original = native.receivers.at(-1)!;
    const xterm = terminals.instances.at(-1)!;
    original({ type: 'data', sequence: 1, data: [72, 105] });
    await flush();
    const writes = xterm.writes.length;
    const terminalCount = terminals.instances.length;
    const layout = JSON.stringify(target.layout);
    button('断开连接', await tabMenu()).click();
    await flush();
    expect(native.close).toHaveBeenCalledExactlyOnceWith(oldSession);
    expect(pane).toMatchObject({
      state: 'disconnected',
      sessionId: undefined,
      connectRequested: false,
    });
    expect(store.tabs).toContainEqual(target);
    expect(JSON.stringify(target.layout)).toBe(layout);
    expect(xterm.writes).toHaveLength(writes);
    const icon = root.querySelector(
      '.terminal-tab.active [role=tab] > .terminal-disconnected-icon',
    );
    expect(icon?.getAttribute('aria-label')).toBe('已断开连接');
    expect(icon?.nextElementSibling?.textContent).toContain('会话');
    original({ type: 'state', state: 'connected', code: null, message: null });
    original({ type: 'data', sequence: 2, data: [88] });
    expect(pane.state).toBe('disconnected');
    expect(xterm.writes).toHaveLength(writes);
    const menu = await tabMenu();
    expect(button('断开连接', menu).disabled).toBe(true);
    expect(button('重新连接', menu).disabled).toBe(false);
    button('重新连接', menu).click();
    await flush();
    expect(pane.state).toBe('connected');
    expect(pane.sessionId).not.toBe(oldSession);
    expect(terminals.instances).toHaveLength(terminalCount);
    expect(xterm.writes.slice(writes)).toEqual(['\x18\x1bc']);
    original({ type: 'data', sequence: 3, data: [79, 76, 68] });
    expect(xterm.writes).toHaveLength(writes + 1);
    native.receivers.at(-1)!({ type: 'data', sequence: 1, data: [78, 69, 87] });
    expect(xterm.writes.at(-2)).toEqual(new Uint8Array([78, 69, 87]));
    expect(root.querySelector('.terminal-tab.active .terminal-disconnected-icon')).toBeNull();
    expect(native.input).not.toHaveBeenCalled();
  },
);

it('reconnects every pane of the right-click target without changing other tabs or focus', async () => {
  const store = useTerminalsStore();
  const target = store.tabs[0]!;
  store.split(store.focused, 'rows');
  store.rename(target.key, '部署');
  store.open(host);
  store.open({ ...host, id: 'other' });
  await flush();
  const active = store.active,
    focused = store.focused;
  const ids = target.panes.map((pane) => pane.sessionId);
  const layout = JSON.stringify(target.layout);
  const writes = terminals.instances.map((terminal) => terminal.writes.length);
  for (const pane of target.panes) store.update(pane.key, { state: 'disconnected' });
  button('重新连接', await tabMenu(0)).click();
  await vi.waitFor(() => expect(store.changingConnections).toEqual([]));
  expect(native.close.mock.calls.map(([id]) => id)).toEqual(ids);
  expect(
    target.panes.every(
      (pane, index) => pane.sessionId !== ids[index] && pane.state === 'connected',
    ),
  ).toBe(true);
  expect(target.title).toBe('部署');
  expect(JSON.stringify(target.layout)).toBe(layout);
  expect(store.active).toBe(active);
  expect(store.focused).toBe(focused);
  expect(store.tabs).toHaveLength(3);
  expect(
    terminals.instances.map((terminal, index) => terminal.writes.slice(writes[index])),
  ).toEqual([['\x18\x1bc'], ['\x18\x1bc'], [], []]);
});

it.each(['closed', 'failed', 'disconnected'])(
  'shows the disconnected icon after a %s event and allows retry',
  async (state) => {
    native.receivers[0]!({ type: 'state', state, code: null, message: null });
    await flush();
    expect(
      root.querySelector('.terminal-tab [role=tab] > .terminal-disconnected-icon'),
    ).not.toBeNull();
    button('重新连接', await tabMenu()).click();
    await flush();
    expect(native.open).toHaveBeenCalledTimes(2);
    expect(root.querySelector('.terminal-disconnected-icon')).toBeNull();
  },
);

it('keeps the connection usable and prevents replacement when disconnect fails', async () => {
  const terminal = terminals.instances[0]!;
  const output = [...terminal.writes];
  native.close.mockRejectedValueOnce(new Error('disconnect failed'));
  button('断开连接', await tabMenu()).click();
  await flush();
  expect(useTerminalsStore().panes[0]).toMatchObject({
    state: 'connected',
    sessionId: 'session-0',
  });
  expect(useTerminalsStore().error).toBe('disconnect failed');
  expect(native.open).toHaveBeenCalledTimes(1);
  expect(terminal.writes).toEqual(output);
});

it('reports reconnection failures and retains the tab with a clean display for retry', async () => {
  native.receivers[0]!({ type: 'state', state: 'disconnected', code: null, message: null });
  native.open.mockRejectedValueOnce(new Error('authentication failed'));
  button('重新连接', await tabMenu()).click();
  await flush();
  expect(useTerminalsStore().panes[0]?.state).toBe('failed');
  expect(useTerminalsStore().tabs).toHaveLength(1);
  expect(root.querySelector('.terminal-disconnected-icon')).not.toBeNull();
  button('重新连接', await tabMenu()).click();
  await flush();
  expect(useTerminalsStore().panes[0]?.state).toBe('connected');
});

it.each(['fileAction', 'containerShell', 'pluginTerminal'] as const)(
  'does not replay a %s when reconnecting',
  async (kind) => {
    const pane = useTerminalsStore().panes[0]!;
    if (kind === 'fileAction') pane.fileAction = { kind: 'tail', path: '/logs' };
    else if (kind === 'containerShell')
      pane.containerShell = { id: 'container', bash: false, confirmed: true };
    else pane.pluginTerminal = { pluginId: 'plugin', owner: 'owner', ticket: 'ticket' };
    const menu = await tabMenu();
    expect(button('断开连接', menu).disabled).toBe(false);
    native.receivers[0]!({ type: 'state', state: 'disconnected', code: null, message: null });
    await flush();
    expect(button('重新连接', menu).disabled).toBe(true);
    button('重新连接', menu).click();
    await useTerminalsStore().reconnect(useTerminalsStore().active);
    await flush();
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(native.close).not.toHaveBeenCalled();
  },
);

it('rejects reconnecting a host whose current connection configuration changed', async () => {
  native.receivers[0]!({ type: 'state', state: 'disconnected', code: null, message: null });
  useHostsStore().catalog!.hosts[0]!.hostname = 'changed.example';
  button('重新连接', await tabMenu()).click();
  await flush();
  expect(useTerminalsStore().error).toContain('主机连接配置已变更');
  expect(native.close).not.toHaveBeenCalled();
  expect(native.open).toHaveBeenCalledTimes(1);
});

it('waits for fingerprint confirmation on reconnect without trusting automatically', async () => {
  native.receivers[0]!({ type: 'state', state: 'disconnected', code: null, message: null });
  native.open.mockImplementationOnce(async (_host, _size, receive) => {
    queueMicrotask(() => {
      receive({ type: 'state', state: 'awaiting_trust', code: null, message: null });
      receive({
        type: 'trust',
        hostname: 'target.example',
        port: 22,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:test',
      });
    });
    return { id: 'replacement', hostId: 'host', transportId: 'new', routeHostIds: ['host'] };
  });
  button('重新连接', await tabMenu()).click();
  await flush();
  expect(useTerminalsStore().panes[0]).toMatchObject({
    state: 'awaiting_trust',
    sessionId: 'replacement',
  });
  expect(document.querySelector('[aria-label="确认 SSH 主机指纹"]')?.textContent).toContain(
    'SHA256:test',
  );
  expect(native.trust).not.toHaveBeenCalled();
});

it('skips disabled reconnect and disconnect items in keyboard navigation', async () => {
  native.receivers[0]!({ type: 'state', state: 'connecting', code: null, message: null });
  await flush();
  const menu = await tabMenu();
  expect(button('重新连接', menu).disabled).toBe(true);
  button('重命名', menu).focus();
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(button('断开连接', menu));
});

it.each([
  'connected',
  'idle',
  'opening',
  'connecting',
  'authenticating',
  'awaiting_trust',
  'closing',
])('greys out reconnect and ignores activation while the session is %s', async (state) => {
  native.receivers[0]!({ type: 'state', state, code: null, message: null });
  await flush();
  const terminal = terminals.instances[0]!;
  const writes = [...terminal.writes];
  const menu = await tabMenu();
  const reconnect = button('重新连接', menu);
  expect(reconnect.disabled).toBe(true);
  reconnect.click();
  await useTerminalsStore().reconnect(useTerminalsStore().active);
  await flush();
  expect(native.open).toHaveBeenCalledTimes(1);
  expect(native.close).not.toHaveBeenCalled();
  expect(terminal.writes).toEqual(writes);
});

it.each([true, false])(
  'keeps a disconnected cursor inactive after preferences change and restores blink=%s on reconnect',
  async (blink) => {
    const application = useApplicationStore();
    const preferences = application.state!.config.terminal;
    const options = terminals.instances[0]!.options;
    button('断开连接', await tabMenu()).click();
    await flush();
    preferences.cursorBlink = blink;
    preferences.theme = 'light';
    await flush();
    expect(options.cursorBlink).toBe(false);
    expect(options.disableStdin).toBe(true);
    button('重新连接', await tabMenu()).click();
    await flush();
    expect(options.cursorBlink).toBe(blink);
    expect(options.disableStdin).toBe(false);
    expect(preferences.cursorBlink).toBe(blink);
  },
);

it('closes only the menu target host and retains failed sessions and other hosts', async () => {
  const store = useTerminalsStore();
  const failed = store.tabs[0]!;
  store.open({ ...host, id: 'other' });
  const other = store.tabs.at(-1)!;
  store.open(host);
  await flush();
  native.close.mockImplementation(async (id: string) => {
    if (id === failed.panes[0]!.sessionId) throw new Error('close failed');
  });
  button('关闭所有', await tabMenu(0)).click();
  await flush();
  expect(store.tabs.map((item) => item.key).sort()).toEqual([failed.key, other.key].sort());
  expect(native.close).not.toHaveBeenCalledWith(other.panes[0]!.sessionId);
  expect(store.error).toBe('close failed');
});

it('provides keyboard session menus and leaves local shells without bottom actions', async () => {
  const trigger = root.querySelector<HTMLButtonElement>('.terminal-tab [role=tab]')!;
  trigger.focus();
  trigger.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
  );
  await flush();
  const menu = document.querySelector('[aria-label="终端会话操作"]')!;
  expect(document.activeElement?.textContent).toBe('复制');
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  expect(document.activeElement).toBe(trigger);
  hostId.value = '';
  useTerminalsStore().open(null);
  await flush();
  expect([...pane().children]).toEqual([pane().querySelector('.xterm-container')]);
  expect(pane().querySelector('button')).toBeNull();
});
