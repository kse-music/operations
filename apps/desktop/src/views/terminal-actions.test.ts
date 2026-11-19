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
import { useNotificationsStore } from '../stores/notifications';
import { usePluginsStore } from '../stores/plugins';
import { useTerminalsStore } from '../stores/terminals';
import TerminalsView from './TerminalsView.vue';
import type { ITerminalOptions } from '@xterm/xterm';

const native = vi.hoisted(() => ({
  open: vi.fn(),
  openLocal: vi.fn(),
  openSavedLocal: vi.fn(),
  saveLocalSession: vi.fn(),
  saveSshSession: vi.fn(),
  savedSshSessions: vi.fn(),
  removeSavedSshSession: vi.fn(),
  removeSavedLocalSession: vi.fn(),
  savedLocalSessions: vi.fn(),
  savedTitleCommands: vi.fn(),
  close: vi.fn(),
  input: vi.fn(),
  ack: vi.fn(),
  resize: vi.fn(),
  trust: vi.fn(),
  receivers: [] as ((event: TerminalEvent) => void)[],
}));
const terminals = vi.hoisted(() => ({
  instances: [] as {
    osc7?: (value: string) => boolean;
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
    osc7?: (value: string) => boolean;
    writes: unknown[] = [];
    parser = {
      registerOscHandler: (code: number, handler: (value: string) => boolean) => {
        if (code === 7) this.osc7 = handler;
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

let app: App | undefined, pinia: Pinia, root: HTMLElement;
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
async function backgroundMenu(x = 80, y = 60): Promise<HTMLElement> {
  root
    .querySelector('.terminal-session-header')!
    .dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  await flush();
  return document.querySelector<HTMLElement>('[role="menu"][aria-label="终端会话操作"]')!;
}
async function savedMenu(parent?: Element) {
  button('已保存会话', parent ?? (await backgroundMenu())).dispatchEvent(new Event('pointerenter'));
  await flush();
  return document.querySelector('[role="menu"][aria-label="已保存会话"]')!;
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
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
  native.openLocal.mockImplementation((size, receive, elevated) =>
    open(null, size, receive).then(({ id }) => ({ id, shell: 'PowerShell', elevated: !!elevated })),
  );
  native.savedLocalSessions.mockResolvedValue([]);
  native.savedTitleCommands.mockResolvedValue({});
  native.savedSshSessions.mockResolvedValue([]);
  native.saveSshSession.mockImplementation(async (_host, input) => ({
    id: input.id ?? 'saved-ssh',
    title: input.title,
    paneCount: input.sessionIds.length,
    layout: input.layout,
  }));
  native.removeSavedLocalSession.mockResolvedValue(undefined);
  native.openSavedLocal.mockImplementation((_id, _pane, size, receive) =>
    open(null, size, receive).then(({ id }) => ({ id, shell: 'PowerShell', elevated: false })),
  );
  native.saveLocalSession.mockImplementation((input) =>
    Promise.resolve({
      id: input.id ?? 'saved-local',
      title: input.title,
      panes: input.sessionIds.map(() => ({ directory: 'C:\\project', elevated: false })),
      layout: input.layout,
    }),
  );
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

it.each([false, true])(
  'chooses local elevation=%s from the background menu before opening a new session',
  async (elevated) => {
    const store = useTerminalsStore();
    hostId.value = '';
    store.open(null);
    await flush();
    const original = store.panes.at(-1)!;
    const count = store.panes.length;
    expect(root.querySelector('[aria-label="新建终端会话"]')).toBeNull();
    const menu = await backgroundMenu();
    expect(store.panes).toHaveLength(count);
    expect(native.openLocal).toHaveBeenCalledTimes(1);
    expect(
      [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()),
    ).toEqual(['新建', '新建(管理员)', '已保存会话', '关闭所有']);
    button(elevated ? '新建(管理员)' : '新建', menu).click();
    await flush();
    expect(document.querySelector('[role="menu"][aria-label="终端会话操作"]')).toBeNull();
    expect(store.panes).toHaveLength(count + 1);
    expect(store.panes.at(-1)?.elevated).toBe(elevated);
    expect(native.openLocal).toHaveBeenCalledTimes(2);
    expect(native.openLocal.mock.calls.at(-1)?.[2]).toBe(elevated ? true : undefined);
    expect(store.panes).toContain(original);
    expect(original.elevated).toBe(false);
  },
);

it.each([
  { x: 180, y: 80, left: 180, top: 80 },
  { x: 270, y: 90, left: 270, top: 90 },
  {
    x: window.innerWidth - 1,
    y: window.innerHeight - 1,
    left: window.innerWidth - 208,
    top: window.innerHeight - 88,
  },
])('positions the local session menu at right-click $x,$y within the viewport', async (point) => {
  const store = useTerminalsStore();
  hostId.value = '';
  store.open(null);
  await flush();
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('terminal-session-menu')
      ? new DOMRect(0, 0, 200, 80)
      : bounds.call(this);
  });
  const menu = await backgroundMenu(point.x, point.y);
  expect(menu.style.left).toBe(`${point.left}px`);
  expect(menu.style.top).toBe(`${point.top}px`);
  expect(native.openLocal).toHaveBeenCalledTimes(1);
});

it('anchors the local session menu to the list when opened with Shift+F10', async () => {
  const store = useTerminalsStore();
  hostId.value = '';
  store.open(null);
  await flush();
  const list = root.querySelector<HTMLElement>('.terminal-session-header')!;
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 60, 248, 36));
  list.focus();
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
  await flush();
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="终端会话操作"]')!;
  expect(menu.style.left).toBe('40px');
  expect(menu.style.top).toBe('96px');
  expect(document.activeElement).toBe(menu.querySelector('[role="menuitem"]'));
  expect(native.openLocal).toHaveBeenCalledTimes(1);
});

it('dismisses the background menu with Escape or outside click and restores list focus', async () => {
  const store = useTerminalsStore();
  hostId.value = '';
  store.open(null);
  await flush();
  const count = store.panes.length;
  const list = root.querySelector('.terminal-session-header');
  const menu = await backgroundMenu();
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  expect(document.activeElement).toBe(items[0]);
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(items[1]);
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  expect(document.activeElement).toBe(list);
  await backgroundMenu();
  button('关闭会话菜单').click();
  await flush();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(store.panes).toHaveLength(count);
  expect(native.openLocal).toHaveBeenCalledTimes(1);
});

it('closes the background menu when switching hosts without applying the old local action', async () => {
  const store = useTerminalsStore();
  hostId.value = '';
  store.open(null);
  await flush();
  const menu = await backgroundMenu();
  const oldAction = button('新建(管理员)', menu);
  hostId.value = 'host';
  await flush();
  oldAction.click();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(store.hostTabs('')).toHaveLength(1);
  expect(store.hostTabs('host')).toHaveLength(1);
  expect(native.openLocal).toHaveBeenCalledTimes(1);
});

it.each(['Linux x86_64', 'MacIntel'])(
  'creates a regular session from an empty local list on %s',
  async (platform) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    const store = useTerminalsStore();
    hostId.value = '';
    await flush();
    expect(store.hostTabs('')).toHaveLength(0);
    const menu = await backgroundMenu();
    expect(
      [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()),
    ).toEqual(['新建', '已保存会话']);
    button('新建', menu).click();
    await flush();
    expect(store.hostTabs('')).toHaveLength(1);
    expect(store.panes.at(-1)?.elevated).toBe(false);
  },
);

it('opens an SSH session directly from plus', async () => {
  const store = useTerminalsStore();
  const menu = await backgroundMenu();
  expect(
    [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()),
  ).toEqual(['已保存会话', '关闭所有']);
  button('关闭会话菜单').click();
  await flush();
  const count = store.panes.length;
  button('新建终端会话').click();
  await flush();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(store.panes).toHaveLength(count + 1);
  expect(store.panes.at(-1)?.elevated).not.toBe(true);
});

it('marks administrator sessions and preserves elevation after cancellation and retry', async () => {
  const store = useTerminalsStore();
  hostId.value = '';
  native.openLocal.mockRejectedValueOnce({
    code: 'LOCAL_TERMINAL',
    message: '已取消管理员终端授权',
  });
  store.open(null, undefined, undefined, true);
  await flush();
  expect(store.panes.at(-1)?.state).toBe('failed');
  expect(useNotificationsStore().items).toContainEqual(
    expect.objectContaining({ text: '已取消管理员终端授权', error: true }),
  );
  expect(root.textContent).toContain('会话 1（管理员）');
  await store.reconnect(store.active);
  await flush();
  expect(store.panes.at(-1)?.state).toBe('connected');
  expect(native.openLocal).toHaveBeenCalledTimes(2);
  for (const call of native.openLocal.mock.calls) expect(call[2]).toBe(true);
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
  terminals.instances[0]!.osc7!('file:///srv/project');
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
    '保存Ctrl+S',
    '重命名F2',
    '重新连接',
    '断开连接',
    '已保存会话',
    '关闭所有',
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
    const tab = root.querySelector('.terminal-tab.active [role=tab]')!;
    const connectedIcon = () =>
      tab.querySelector('.terminal-session-name > .terminal-connected-icon');
    expect(connectedIcon()?.getAttribute('aria-label')).toBe('已连接');
    expect(connectedIcon()?.nextElementSibling?.textContent).toBe('会话 1');
    expect(tab.textContent).not.toContain('已连接');
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
    const icon = tab.querySelector('.terminal-session-name > .terminal-disconnected-icon');
    expect(icon?.getAttribute('aria-label')).toBe('已断开连接');
    expect(icon?.nextElementSibling?.textContent).toContain('会话');
    expect(connectedIcon()).toBeNull();
    expect(tab.textContent).not.toContain('已断开连接');
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
    expect(tab.querySelector('.terminal-disconnected-icon')).toBeNull();
    expect(connectedIcon()).not.toBeNull();
    expect(tab.textContent).not.toContain('已连接');
    expect(native.input).not.toHaveBeenCalled();
  },
);

it('marks a split session as connected only when all panes are connected', async () => {
  const store = useTerminalsStore();
  store.split(store.focused, 'rows');
  await flush();
  const tab = root.querySelector('.terminal-tab.active [role=tab]')!;
  expect(tab.querySelector('.terminal-connected-icon')).not.toBeNull();
  expect(tab.querySelector('small')?.textContent).toBe('2 个窗格');

  native.receivers[1]!({ type: 'state', state: 'disconnected', code: null, message: null });
  await flush();
  expect(store.tabs[0]?.panes[0]?.state).toBe('connected');
  expect(tab.querySelector('.terminal-connected-icon')).toBeNull();
  expect(tab.querySelector('.terminal-disconnected-icon')).not.toBeNull();
  expect(tab.querySelector('small')?.textContent).toBe('2 个窗格');
});

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
      root.querySelector(
        '.terminal-tab [role=tab] .terminal-session-name > .terminal-disconnected-icon',
      ),
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

it.each(['local', 'ssh'])(
  'renames %s inline and saves the targeted tab via menu and keyboard',
  async (kind) => {
    const store = useTerminalsStore();
    const targetHost = kind === 'ssh' ? host : null;
    hostId.value = targetHost?.id ?? '';
    if (!targetHost) store.open(null);
    await flush();
    const target = store.tabs.at(-1)!;
    store.open(targetHost);
    await flush();
    const activeKey = store.active;
    const tabButton = () =>
      root.querySelector<HTMLButtonElement>(`[data-session-key="${target.key}"] [role=tab]`)!;
    expect(button('关闭标签 会话 1', root).querySelector('.lucide-x')).toBeTruthy();
    const keyboard = (el: HTMLElement | Window, key: string, ctrlKey = false) => {
      const event = new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event;
    };
    expect(keyboard(tabButton(), 'F2').defaultPrevented).toBe(true);
    await flush();
    const edit = () => root.querySelector<HTMLInputElement>('.terminal-tab input')!;
    expect(document.activeElement).toBe(edit());
    expect(edit().value).toBe('会话 1');
    edit().value = '项目 A';
    edit().dispatchEvent(new Event('input', { bubbles: true }));
    keyboard(edit(), 'Enter');
    await flush();
    expect(target.title).toBe('项目 A');
    expect(native.saveLocalSession).not.toHaveBeenCalled();
    expect(native.saveSshSession).not.toHaveBeenCalled();
    const menu = await tabMenu(0);
    expect(button('保存', menu).querySelector('kbd')?.textContent).toBe('Ctrl+S');
    expect(button('重命名', menu).querySelector('kbd')?.textContent).toBe('F2');
    expect([...menu.querySelectorAll('button')].some((b) => b.textContent === '关闭')).toBe(false);
    button('保存', menu).click();
    await vi.waitFor(() => expect(target.savedId).toBeTruthy());
    const input = {
      id: null,
      title: '项目 A',
      sessionIds: [target.panes[0]!.sessionId],
      layout: { kind: 'leaf', pane: 0 },
    };
    if (targetHost) expect(native.saveSshSession).toHaveBeenCalledExactlyOnceWith(host.id, input);
    else expect(native.saveLocalSession).toHaveBeenCalledExactlyOnceWith(input);
    expect(button('关闭标签 项目 A', root).querySelector('.lucide-x')).toBeTruthy();
    expect(store.active).toBe(activeKey);
    button('重命名', await tabMenu(0)).click();
    await flush();
    edit().value = '取消';
    edit().dispatchEvent(new Event('input', { bubbles: true }));
    keyboard(edit(), 'Escape');
    await flush();
    expect(target.title).toBe('项目 A');
    expect(
      keyboard(pane().querySelector<HTMLElement>('.xterm-container')!, 's', true).defaultPrevented,
    ).toBe(true);
    await flush();
    const api = targetHost ? native.saveSshSession : native.saveLocalSession;
    expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.lastCall?.at(-1).sessionIds).toEqual([store.tabs.at(-1)!.panes[0]!.sessionId]);
    expect(document.querySelector('dialog')).toBeNull();
  },
);

it('reopens the saved SSH split on the same host and preserves its snapshot when closing the workspace', async () => {
  const store = useTerminalsStore();
  await store.close(store.active);
  const record = {
    id: 'saved',
    title: '部署',
    paneCount: 2,
    layout: {
      kind: 'split',
      axis: 'rows',
      ratio: 63,
      first: { kind: 'leaf', pane: 1 },
      second: { kind: 'leaf', pane: 0 },
    },
  };
  native.savedSshSessions.mockResolvedValue([record]);
  await store.loadHostSessions(host);
  button('部署', await savedMenu()).click();
  await flush();
  const restored = store.tabs[0]!;
  expect(restored.layout).toMatchObject({
    ratio: 63,
    first: { pane: restored.panes[1]!.key },
    second: { pane: restored.panes[0]!.key },
  });
  for (const index of [0, 1])
    expect(native.open).toHaveBeenCalledWith(host.id, expect.anything(), expect.any(Function), {
      id: 'saved',
      pane: index,
    });
  native.saveSshSession.mockResolvedValueOnce({ ...record, title: '新名称' });
  await store.rename(restored.key, '新名称');
  expect(native.saveSshSession).toHaveBeenLastCalledWith(host.id, {
    id: 'saved',
    title: '新名称',
    layout: null,
    sessionIds: [],
  });
  await store.closeWorkspace(host.id);
  expect(store.tabs).toEqual([]);
  expect(native.removeSavedSshSession).not.toHaveBeenCalled();
  button('新名称', await savedMenu()).click();
  await flush();
  const running = store.tabs[0]!;
  const sessions = running.panes.map((pane) => pane.sessionId);
  native.close.mockClear();
  button('删除“新名称”的保存记录', await savedMenu(await tabMenu())).click();
  expect(usePluginsStore().prompt).toBeNull();
  await flush();
  expect(native.removeSavedSshSession).toHaveBeenCalledExactlyOnceWith(host.id, 'saved');
  expect(native.close).not.toHaveBeenCalled();
  expect(store.tabs).toEqual([running]);
  expect(running.savedId).toBeUndefined();
  expect(running.panes.map((pane) => pane.sessionId)).toEqual(sessions);
});
it('keeps an SSH rename draft after a write error and reports a layout-only save', async () => {
  native.saveSshSession.mockResolvedValueOnce({
    id: 'saved-ssh',
    title: '会话 1',
    paneCount: 1,
    layoutOnlyPanes: 1,
    layout: { kind: 'leaf', pane: 0 },
  });
  button('保存', await tabMenu()).click();
  await vi.waitFor(() =>
    expect(useNotificationsStore().items.some((n) => n.text.includes('仅支持恢复布局'))).toBe(true),
  );
  native.saveSshSession.mockRejectedValueOnce(new Error('写入失败'));
  button('重命名', await tabMenu()).click();
  await flush();
  const input = root.querySelector<HTMLInputElement>('.terminal-tab input')!;
  input.value = '新名称';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() =>
    expect(root.querySelector('.terminal-tab [role=alert]')?.textContent).toContain('写入失败'),
  );
  expect(input.isConnected).toBe(true);
  expect(input.value).toBe('新名称');
  expect(useTerminalsStore().tabs[0]!.title).toBe('会话 1');
});

it('opens a saved local shell from the blank area menu and selects it without another open', async () => {
  hostId.value = '';
  native.savedLocalSessions.mockResolvedValue([
    {
      id: 'saved-one',
      title: '保存的目录',
      panes: [{ directory: 'C:\\one', elevated: false }],
      layout: { kind: 'leaf', pane: 0 },
    },
  ]);
  const store = useTerminalsStore();
  await store.loadSaved();
  await flush();
  expect(store.hostTabs('')).toEqual([]);
  expect(native.openSavedLocal).not.toHaveBeenCalled();
  store.activateHost('');
  await flush();
  expect(native.openSavedLocal).not.toHaveBeenCalled();
  button('保存的目录', await savedMenu()).click();
  await flush();
  expect(native.openSavedLocal).toHaveBeenCalledWith(
    'saved-one',
    0,
    expect.anything(),
    expect.any(Function),
  );
  const saved = store.hostTabs('')[0]!;
  expect(saved.panes[0]!.sessionId).toBeTruthy();
  expect(root.querySelector('[role=tab] .terminal-connected-icon')).not.toBeNull();
  expect(root.querySelector('[role=tab]')?.textContent).toContain('已保存');
  store.open(null);
  await flush();
  button('保存的目录', await savedMenu(await tabMenu(1))).click();
  await flush();
  expect(store.active).toBe(saved.key);
  expect(native.openSavedLocal).toHaveBeenCalledTimes(1);
});
it.each(['local', 'ssh'] as const)(
  'shows the saved command beside a generated %s name and lets an explicit rename replace it',
  async (kind) => {
    const store = useTerminalsStore();
    const base = {
      id: 'generated',
      title: '会话 1',
      titleCommandPane: 0,
      layout: { kind: 'leaf', pane: 0 },
    };
    if (kind === 'local') {
      hostId.value = '';
      store.open(null);
      native.saveLocalSession.mockResolvedValueOnce({
        ...base,
        panes: [{ directory: 'C:\\one', elevated: false }],
      });
      await flush();
    } else {
      native.saveSshSession.mockResolvedValueOnce({ ...base, paneCount: 1, layoutOnlyPanes: 0 });
    }
    native.savedTitleCommands.mockResolvedValue({ generated: 'npm run dev' });
    const activeKey = store.active;
    const save = kind === 'local' ? native.saveLocalSession : native.saveSshSession;
    button('保存', await tabMenu()).click();
    await vi.waitFor(() =>
      expect(root.querySelector('.terminal-session-title')?.textContent).toBe(
        '会话 1 · npm run dev',
      ),
    );
    expect(save.mock.lastCall?.at(-1)).toMatchObject({ title: '会话 1', titleCommandPane: 0 });
    const submenu = await savedMenu(await tabMenu());
    expect(button('会话 1 · npm run dev', submenu)).toBeTruthy();

    // Custom names can exactly match a default label and still take precedence.
    expect(await store.rename(activeKey, '会话 1')).toBe(true);
    await flush();
    expect(save.mock.lastCall?.at(-1)).not.toHaveProperty('titleCommandPane');
    expect(root.querySelector('.terminal-session-title')?.textContent).toBe('会话 1');
    expect(button('会话 1', submenu)).toBeTruthy();
  },
);
it('keeps an explicitly restored shell running on repeated local entry', async () => {
  hostId.value = '';
  native.savedLocalSessions.mockResolvedValue([
    {
      id: 'first',
      title: '第一个',
      panes: [{ directory: 'C:\\one', elevated: false }],
      layout: { kind: 'leaf', pane: 0 },
    },
    {
      id: 'second',
      title: '第二个',
      panes: [{ directory: 'C:\\two', elevated: true }],
      layout: { kind: 'leaf', pane: 0 },
    },
  ]);
  const store = useTerminalsStore();
  await store.loadSaved();
  await flush();
  expect(native.openSavedLocal).not.toHaveBeenCalled();
  store.activateHost('');
  await flush();
  expect(native.openSavedLocal).not.toHaveBeenCalled();
  button('第一个', await savedMenu()).click();
  await flush();
  expect(native.openSavedLocal).toHaveBeenCalledExactlyOnceWith(
    'first',
    0,
    expect.anything(),
    expect.any(Function),
  );
  expect(native.openLocal).not.toHaveBeenCalled();
  expect(store.hostTabs('').map((tab) => tab.savedId)).toEqual(['first']);
  expect(store.savedSessions('').map((entry) => entry.id)).toEqual(['first', 'second']);
  store.activateHost('');
  await flush();
  expect(native.openSavedLocal).toHaveBeenCalledTimes(1);
  expect(native.close).not.toHaveBeenCalled();
});
it.each(['button', 'all'])(
  'keeps saved records after the %s close action and deletes them directly from the empty bar',
  async (action) => {
    hostId.value = '';
    native.savedLocalSessions.mockResolvedValue([
      {
        id: 'saved-one',
        title: '项目',
        panes: [{ directory: 'C:\\project', elevated: false }],
        layout: { kind: 'leaf', pane: 0 },
      },
      {
        id: 'saved-two',
        title: '第二项',
        panes: [{ directory: 'C:\\two', elevated: false }],
        layout: { kind: 'leaf', pane: 0 },
      },
    ]);
    const store = useTerminalsStore();
    await store.loadSaved();
    button('项目', await savedMenu()).click();
    const saved = store.tabs.find((tab) => tab.savedId === 'saved-one')!;
    await flush();
    const sessionId = saved.panes[0]!.sessionId;
    if (action === 'all') button('关闭所有', await tabMenu()).click();
    else button('关闭标签 项目', root).click();
    await flush();
    expect(native.close).toHaveBeenCalledWith(sessionId);
    expect(native.removeSavedLocalSession).not.toHaveBeenCalled();
    expect(store.hostTabs('')).toEqual([]);
    const submenu = await savedMenu();
    expect(button('项目', submenu)).toBeTruthy();
    const remove = button('删除“项目”的保存记录', submenu);
    remove.focus();
    remove.click();
    expect(usePluginsStore().prompt).toBeNull();
    await flush();
    expect(native.removeSavedLocalSession).toHaveBeenCalledExactlyOnceWith('saved-one');
    expect(submenu.isConnected).toBe(true);
    expect(submenu.textContent).not.toContain('项目');
    const next = button('删除“第二项”的保存记录', submenu);
    expect(document.activeElement).toBe(next);
    next.click();
    await flush();
    expect(native.removeSavedLocalSession.mock.calls).toEqual([['saved-one'], ['saved-two']]);
    expect(submenu.textContent).toContain('没有已保存的会话');
    store.activateHost('');
    await flush();
    expect(native.openSavedLocal).toHaveBeenCalledTimes(1);
    expect(native.openLocal).not.toHaveBeenCalled();
  },
);
it('keeps saved records when the terminal view unmounts on application exit', async () => {
  hostId.value = '';
  native.savedLocalSessions.mockResolvedValue([
    {
      id: 'saved-one',
      title: '项目',
      panes: [{ directory: 'C:\\project', elevated: false }],
      layout: { kind: 'leaf', pane: 0 },
    },
  ]);
  const store = useTerminalsStore();
  await store.loadSaved();
  store.restoreSavedSession(null, 'saved-one');
  await flush();
  app!.unmount();
  app = undefined;
  await flush();
  expect(native.removeSavedLocalSession).not.toHaveBeenCalled();
});
