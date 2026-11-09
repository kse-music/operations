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
  forwardList: vi.fn(),
  forwardStart: vi.fn(),
  forwardStop: vi.fn(),
  download: vi.fn(),
  receivers: [] as ((event: TerminalEvent) => void)[],
}));
const terminals = vi.hoisted(() => ({
  instances: [] as { osc?: (value: string) => boolean; writes: unknown[] }[],
}));
vi.mock('../services/terminal', () => ({ terminalApi: native }));
vi.mock('../services/download', () => ({ downloadResult: native.download }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    osc?: (value: string) => boolean;
    writes: unknown[] = [];
    parser = {
      registerOscHandler: (_code: number, handler: (value: string) => boolean) => {
        this.osc = handler;
      },
    };
    index = terminals.instances.length;
    buffer = {
      normal: {
        length: 2,
        getLine: (index: number) => ({ translateToString: () => `normal-${this.index}-${index}` }),
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
const files = vi.fn();
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
async function action(name: string) {
  button('打开终端操作', pane()).click();
  await flush();
  button(name, document.querySelector('[aria-label="终端功能"]')!).click();
  await flush();
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
  native.forwardList.mockResolvedValue([]);
  native.forwardStart.mockResolvedValue({ id: 'forward', state: 'running' });
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
    setup: () => () => h(TerminalsView, { hostId: hostId.value, onFiles: files }),
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

it('reconnects the same pane without replay and ignores old-generation data', async () => {
  const store = useTerminalsStore();
  const key = store.focused;
  const original = native.receivers[0]!;
  original({ type: 'state', state: 'disconnected', code: null, message: 'connection lost' });
  await flush();
  button('重新连接', pane()).click();
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

it('cancels a connected reconnect and blocks changed targets and consumed plugin tickets', async () => {
  await action('重新连接');
  button('取消', document.querySelector('dialog[aria-label="重新连接终端"]')!).click();
  await flush();
  expect(native.close).not.toHaveBeenCalled();
  useHostsStore().catalog!.hosts[0]!.hostname = 'changed.example';
  native.receivers[0]!({ type: 'state', state: 'failed', code: null, message: null });
  await flush();
  button('重新连接', pane()).click();
  await flush();
  expect(native.open).toHaveBeenCalledTimes(1);
  expect(native.close).not.toHaveBeenCalled();
  expect(pane().textContent).not.toContain('changed.example');
  useTerminalsStore().panes[0]!.pluginTerminal = {
    pluginId: 'plugin',
    owner: 'owner',
    ticket: 'used',
  };
  button('打开终端操作', pane()).click();
  await flush();
  expect(button('重新连接', document.querySelector('[aria-label="终端功能"]')!).disabled).toBe(
    true,
  );
});

it('binds forwards to the current session and closes its UI on disconnect', async () => {
  await action('端口转发');
  const dialog = document.querySelector('dialog[aria-label="端口转发"]')!;
  expect(native.forwardList).toHaveBeenCalledWith('session-0');
  dialog
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  expect(native.forwardStart).toHaveBeenCalledWith(
    'session-0',
    expect.objectContaining({ bindAddress: '127.0.0.1', confirmPublic: false }),
  );
  native.receivers[0]!({ type: 'state', state: 'disconnected', code: null, message: null });
  await flush();
  expect(document.querySelector('dialog[aria-label="端口转发"]')).toBeNull();
});

it('opens SFTP with only this pane host and its validated OSC 7 path', async () => {
  terminals.instances[0]!.osc!('file:///srv/project');
  await flush();
  await action('打开 SFTP 文件');
  expect(files).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'host', hostname: 'target.example' }),
    '/srv/project',
    useTerminalsStore().focused,
  );
});

it('exports only this normal buffer after confirmation and keeps content right-click minimal', async () => {
  pane()
    .querySelector('.xterm-container')!
    .dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    );
  await flush();
  expect(
    [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((item) =>
      item.getAttribute('aria-label'),
    ),
  ).toEqual(['复制', '粘贴']);
  document
    .querySelector('[role=menu]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  await action('导出终端文本');
  expect(native.download).not.toHaveBeenCalled();
  button('确认导出', document.querySelector('dialog[aria-label="导出终端文本"]')!).click();
  await flush();
  expect(native.download).toHaveBeenCalledWith(
    expect.stringMatching(/^ServerDeck-.*\.txt$/),
    'normal-0-0\nnormal-0-1',
  );
});

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

it('provides keyboard session menus and disables remote actions for local shells', async () => {
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
  button('打开终端操作', pane()).click();
  await flush();
  const actions = document.querySelector('[aria-label="终端功能"]')!;
  expect(button('端口转发', actions).disabled).toBe(true);
  expect(button('打开 SFTP 文件', actions).disabled).toBe(true);
});
