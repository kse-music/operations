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

const native = vi.hoisted(() => ({
  open: vi.fn(),
  openLocal: vi.fn(),
  close: vi.fn(),
  input: vi.fn(),
  ack: vi.fn(),
  resize: vi.fn(),
  receivers: [] as ((event: TerminalEvent) => void)[],
}));
const terminals = vi.hoisted(() => ({
  instances: [] as { osc?: (value: string) => boolean; writes: unknown[] }[],
}));
vi.mock('../services/terminal', () => ({ terminalApi: native }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    buffer = { active: { type: 'normal', baseY: 0, viewportY: 0 } };
    cols = 80;
    rows = 24;
    osc?: (value: string) => boolean;
    writes: unknown[] = [];
    parser = {
      registerOscHandler: (_code: number, handler: (value: string) => boolean) => {
        this.osc = handler;
      },
    };
    constructor(public options: unknown) {
      terminals.instances.push(this);
    }
    loadAddon() {}
    open() {}
    onSelectionChange() {}
    onData() {}
    onBinary() {}
    onResize() {}
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
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));

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
