import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import AppShell from './App.vue';
import { useApplicationStore } from './stores/application';
import { useHostsStore } from './stores/hosts';
import { useTerminalsStore } from './stores/terminals';
import { useWorkspaceStore } from './stores/workspace';
import { useFilesStore } from './stores/files';
import { terminalApi } from './services/terminal';
import { hostsApi } from './services/hosts';
import { hostInput } from './types/hosts';

// Exercise the shell and both tab bars without xterm's browser canvas or a remote connection.
vi.mock('./components/TerminalPane.vue', () => ({ default: { render: () => null } }));
let app: App | undefined, pinia: Pinia, root: HTMLDivElement;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const flush = async () => {
  await vi.dynamicImportSettled();
  await nextTick();
};
beforeEach(async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  pinia = createPinia();
  setActivePinia(pinia);
  vi.spyOn(useApplicationStore(), 'initialize').mockResolvedValue();
  useHostsStore().catalog = {
    hosts: ['a', 'b'].map((id) => ({
      ...hostInput(),
      id,
      name: `Host ${id}`,
      hostname: `${id}.example`,
      createdAt: '',
      updatedAt: '',
    })),
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(AppShell).use(pinia);
  app.mount(root);
  await flush();
});
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root?.remove();
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.unstubAllGlobals();
});

it.each(['.topbar', '.sidebar', '.content-scroll', '.sidebar input'])(
  'suppresses the native context menu in %s even before the backend is ready',
  (selector) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    expect(root.querySelector(selector)).not.toBeNull();
    root.querySelector(selector)!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  },
);

it('covers body-level inputs and stops the native menu before a child stops propagation', () => {
  const input = document.createElement('textarea');
  document.body.append(input);
  let preventedAtTarget = false;
  const childHandler = vi.fn((event: Event) => {
    preventedAtTarget = event.defaultPrevented;
    event.stopPropagation();
  });
  input.addEventListener('contextmenu', childHandler);
  try {
    input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(childHandler).toHaveBeenCalledOnce();
    expect(preventedAtTarget).toBe(true);
    for (const type of ['keydown', 'copy', 'paste']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    input.removeEventListener('contextmenu', childHandler);
    app!.unmount();
    app = undefined;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  } finally {
    input.remove();
  }
});

it('suppresses host context menus while keeping terminal tab menus working', async () => {
  const host = root.querySelector<HTMLButtonElement>('.tree-host')!;
  host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  host.click();
  await flush();
  expect(useTerminalsStore().panes[0]?.host?.id).toBe('a');
  root
    .querySelector('.terminal-tab [role="tab"]')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  const close = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent?.trim() === '关闭标签',
  );
  expect(close).toBeDefined();
  close!.click();
  await flush();
  expect(useTerminalsStore().panes).toHaveLength(0);
});

it('removes the host management page and keeps creation available in the workspace', async () => {
  expect(root.querySelector('.activity-rail [aria-label="主机管理"]')).toBeNull();
  expect(root.querySelector('.hosts-view')).toBeNull();
  root.querySelector<HTMLButtonElement>('.host-sidebar-actions [aria-label="新建主机"]')!.click();
  await nextTick();
  expect(document.querySelector<HTMLDialogElement>('dialog[aria-label="新建主机"]')!.open).toBe(
    true,
  );
  expect(useTerminalsStore().panes).toHaveLength(0);
});

it.each(['a', 'b'])(
  'has no host context or three-dot actions and keeps the active session (%s)',
  async (id) => {
    const hosts = useHostsStore(),
      terminals = useTerminalsStore(),
      workspace = useWorkspaceStore();
    root.querySelector<HTMLButtonElement>('.tree-host')!.click();
    await flush();
    const active = workspace.active,
      focused = terminals.focused,
      selected = hosts.selectedId;
    const panes = terminals.panes.map((pane) => pane.key);
    const update = vi.spyOn(hostsApi, 'update'),
      copy = vi.spyOn(hostsApi, 'copy'),
      remove = vi.spyOn(hostsApi, 'remove');
    const host = root.querySelector('.tree-host[data-host-id="' + id + '"]')!;
    for (const target of [host, ...host.querySelectorAll('span')]) {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      await nextTick();
      expect(event.defaultPrevented).toBe(true);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.querySelector('.context-backdrop')).toBeNull();
    }
    expect(root.querySelector('.tree-host-more, [aria-label^="主机操作 "]')).toBeNull();
    expect(workspace.active).toBe(active);
    expect(terminals.focused).toBe(focused);
    expect(terminals.panes.map((pane) => pane.key)).toEqual(panes);
    expect(hosts.selectedId).toBe(selected);
    expect(update).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(
      document.querySelector(
        '[aria-label="编辑主机"], [aria-label="确认删除主机"], [aria-label="关闭主机全部连接"]',
      ),
    ).toBeNull();
  },
);

it('opens SSH on a single sidebar host click and reuses the existing terminal', async () => {
  const selector = '.tree-host';
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  const host = root.querySelector<HTMLButtonElement>(selector)!;
  host.click();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: 'a' });
  expect(terminals.panes).toHaveLength(1);
  expect(terminals.panes[0]).toMatchObject({ host: { id: 'a' }, connectRequested: true });
  const key = terminals.active;
  workspace.navigate('settings');
  await nextTick();
  root.querySelector<HTMLButtonElement>(selector)!.click();
  root
    .querySelector<HTMLButtonElement>('.tree-host')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  expect(workspace.current?.view).toBe('terminals');
  expect(terminals.tabs).toHaveLength(1);
  expect(terminals.active).toBe(key);
  root.querySelectorAll<HTMLButtonElement>('.tree-host')[1]!.click();
  await flush();
  expect(workspace.current?.hostId).toBe('b');
  expect(terminals.tabs).toHaveLength(2);
  root.querySelector<HTMLButtonElement>('.tree-host')!.click();
  await flush();
  expect(terminals.active).toBe(key);
  expect(terminals.tabs).toHaveLength(2);
});

it('middle-click closes navigation tabs without closing independent terminals', async () => {
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  workspace.navigate('settings');
  terminals.open(useHostsStore().catalog!.hosts[0]!);
  workspace.navigate('terminals', 'a');
  await flush();
  const inactive = root.querySelector('.workspace-tab:not(.active) button')!;
  for (const button of [0, 2])
    inactive.dispatchEvent(new MouseEvent('auxclick', { button, bubbles: true }));
  expect(workspace.tabs).toHaveLength(2);
  const down = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true });
  inactive.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  inactive.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
  await flush();
  expect(workspace.tabs).toHaveLength(1);
  expect(workspace.current?.view).toBe('terminals');
  root
    .querySelector('.workspace-tab button')!
    .dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
  await flush();
  expect(workspace.current).toBeUndefined();
  expect(workspace.tabs).toHaveLength(0);
  expect(root.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
  expect(terminals.tabs).toHaveLength(1);
});

it('shows welcome after the last terminal closes and opens a new local terminal only on request', async () => {
  const terminals = useTerminalsStore(),
    workspace = useWorkspaceStore();
  terminals.open(null);
  workspace.navigate('terminals');
  await flush();
  expect(
    [...root.querySelectorAll('.workspace-tabs [role="tab"]')].map((tab) =>
      tab.textContent?.trim(),
    ),
  ).toEqual(['本地设备']);
  root.querySelector<HTMLButtonElement>('.terminal-tab [aria-label="关闭标签 会话 1"]')!.click();
  await flush();
  expect(terminals.panes).toHaveLength(0);
  expect(workspace.tabs).toHaveLength(0);
  expect(root.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
  root.querySelector<HTMLButtonElement>('[aria-label="欢迎页面"] .primary')!.click();
  await flush();
  expect(terminals.panes).toHaveLength(1);
  expect(terminals.panes[0]!.host).toBeNull();
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: '' });
});

it('middle-click closes only the target terminal session and retains a tab if close fails', async () => {
  const terminals = useTerminalsStore(),
    close = vi.spyOn(terminalApi, 'close').mockResolvedValue();
  for (const host of useHostsStore().catalog!.hosts) {
    terminals.open(host);
    terminals.update(terminals.focused, { sessionId: `session-${host.id}` });
  }
  terminals.open(useHostsStore().catalog!.hosts[1]!);
  terminals.update(terminals.focused, { sessionId: 'session-b2' });
  useWorkspaceStore().navigate('terminals', 'b');
  await flush();
  const inactive = root.querySelector('.terminal-tab button')!;
  for (const button of [0, 2])
    inactive.dispatchEvent(new MouseEvent('auxclick', { button, bubbles: true }));
  expect(close).not.toHaveBeenCalled();
  const down = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true });
  inactive.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  inactive.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
  await flush();
  expect(close).toHaveBeenCalledExactlyOnceWith('session-b');
  expect(terminals.tabs).toHaveLength(2);
  expect(terminals.panes[0]!.sessionId).toBe('session-a');
  close.mockRejectedValueOnce(new Error('close failed'));
  root
    .querySelector('.terminal-tab button')!
    .dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
  await flush();
  expect(terminals.tabs).toHaveLength(2);
  expect(terminals.error).toBeTruthy();
  root
    .querySelector('.terminal-tab button')!
    .dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
  await flush();
  expect(terminals.tabs).toHaveLength(1);
  expect(terminals.panes[0]!.sessionId).toBe('session-a');
  expect(useWorkspaceStore().hostId).toBe('b');
  expect(root.querySelector('.terminal-tab')).toBeNull();
});

it('removes the topbar settings and exit actions while keeping the settings navigation', () => {
  expect(root.querySelector('.topbar [aria-label="退出应用"]')).toBeNull();
  expect(root.querySelector('.topbar [aria-label="打开全局设置"]')).toBeNull();
  expect(root.querySelector('nav [aria-label="全局设置"]')).not.toBeNull();
});

it('selecting the local device opens a local terminal and preserves remote panes', async () => {
  root.querySelector<HTMLButtonElement>('.tree-host')!.click();
  await flush();
  root.querySelector<HTMLButtonElement>('[aria-label="打开本地工作区"]')!.click();
  await flush();
  expect(useWorkspaceStore().current).toMatchObject({ view: 'terminals', hostId: '' });
  const terminals = useTerminalsStore();
  expect(terminals.panes.find((p) => p.key === terminals.focused)?.host).toBeNull();
  expect(terminals.panes.some((p) => p.host?.id === 'a')).toBe(true);
  root.querySelector<HTMLButtonElement>('.workspace-tab.active [role="tab"]')!.click();
  await flush();
  expect(terminals.panes.filter((p) => p.host === null)).toHaveLength(1);
});

it('restores each host tool, file connection and terminal session through primary workspace tabs', async () => {
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore(),
    files = useFilesStore();
  const hosts = useHostsStore().catalog!.hosts;
  files.local = { path: 'C:/', parent: null, entries: [] };
  for (const host of hosts)
    files.connections[host.id] = {
      host,
      id: `files-${host.id}`,
      state: 'connected',
      error: null,
      trust: null,
      path: `/${host.id}`,
      loading: false,
      listing: { path: `/${host.id}`, parent: '/', entries: [] },
    };
  root.querySelector<HTMLButtonElement>('.tree-host')!.click();
  await flush();
  root.querySelector<HTMLButtonElement>('.split-toolbar [aria-label="新建终端"]')!.click();
  await flush();
  const lastSession = terminals.active;
  const selectHost = async (id: string) => {
    const name = id ? `Host ${id}` : '本地设备';
    [...root.querySelectorAll<HTMLButtonElement>('.workspace-tabs [role="tab"]')]
      .find((button) => button.textContent?.trim() === name)!
      .click();
    await flush();
  };
  root.querySelectorAll<HTMLButtonElement>('.tree-host')[1]!.click();
  await flush();
  await selectHost('b');
  expect(root.querySelectorAll('.terminal-tab')).toHaveLength(1);
  expect(workspace.tabs).toHaveLength(2);
  root.querySelector<HTMLButtonElement>('.host-tools [aria-label="SFTP 文件"]')!.click();
  await flush();
  expect(files.current?.id).toBe('files-b');
  expect(root.querySelector('[aria-label="文件管理主机"]')).toBeNull();
  expect(root.querySelector('.files-host-tabs')).toBeNull();
  await selectHost('a');
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: 'a' });
  expect(terminals.active).toBe(lastSession);
  expect(root.querySelectorAll('.terminal-tab')).toHaveLength(2);
  root.querySelector<HTMLButtonElement>('.host-tools [aria-label="SFTP 文件"]')!.click();
  await flush();
  expect(files.current).toMatchObject({ id: 'files-a', path: '/a' });
  expect(files.connections.b?.id).toBe('files-b');
  await selectHost('b');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'b' });
  expect(files.current).toMatchObject({ id: 'files-b', path: '/b' });
  root.querySelector<HTMLButtonElement>('nav [aria-label="全局设置"]')!.click();
  await flush();
  expect(workspace.hostId).toBe('b');
  expect((root.querySelector('.sidebar') as HTMLElement).style.display).toBe('none');
  expect(root.querySelector('.host-tools')).toBeNull();
  await selectHost('a');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'a' });
  expect(root.querySelector('[aria-label="当前工作区主机"]')).toBeNull();
  expect(
    [...root.querySelectorAll('.workspace-tabs [role="tab"]')].map((t) => t.textContent?.trim()),
  ).toEqual(['Host a', 'Host b', '全局设置']);
  root.querySelector<HTMLButtonElement>('[aria-label="打开本地工作区"]')!.click();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: '' });
  expect(root.querySelectorAll('.host-tools button')).toHaveLength(1);
  expect(files.connections.a?.id).toBe('files-a');
  expect(files.connections.b?.id).toBe('files-b');
});

it('retains a batch draft and explicit diagnostic source across host workspace switches', async () => {
  root.querySelector<HTMLButtonElement>('.tree-host')!.click();
  await flush();
  root.querySelector<HTMLButtonElement>('.activity-rail [aria-label="批量运维"]')!.click();
  await flush();
  const checkbox = root.querySelector<HTMLInputElement>('[aria-label="选择批量目标 Host b"]')!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  const command = root.querySelector<HTMLTextAreaElement>('[aria-label="批量统一命令"]')!;
  command.value = 'hostname';
  command.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  root.querySelector<HTMLButtonElement>('.workspace-tabs [role="tab"]')!.click();
  await flush();
  root.querySelector<HTMLButtonElement>('.activity-rail [aria-label="批量运维"]')!.click();
  await flush();
  expect(root.querySelector<HTMLInputElement>('[aria-label="选择批量目标 Host b"]')!.checked).toBe(
    true,
  );
  expect(root.querySelector<HTMLTextAreaElement>('[aria-label="批量统一命令"]')!.value).toBe(
    'hostname',
  );
  root.querySelector<HTMLButtonElement>('.activity-rail [aria-label="网络诊断"]')!.click();
  await flush();
  const source = root.querySelector<HTMLSelectElement>('[aria-label="诊断来源"]')!;
  source.value = 'remote';
  source.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  const host = root.querySelector<HTMLSelectElement>('[aria-label="诊断主机"]')!;
  host.value = 'b';
  host.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  root.querySelector<HTMLButtonElement>('.workspace-tabs [role="tab"]')!.click();
  await flush();
  root.querySelectorAll<HTMLButtonElement>('.tree-host')[1]!.click();
  await flush();
  root.querySelector<HTMLButtonElement>('.activity-rail [aria-label="网络诊断"]')!.click();
  await flush();
  expect(root.querySelector<HTMLSelectElement>('[aria-label="诊断主机"]')!.value).toBe('b');
  expect(root.querySelector<HTMLSelectElement>('[aria-label="诊断来源"]')!.value).toBe('remote');
});

it.each([
  ['关闭', ['host:', 'batch:', 'network:'], 'network:'],
  ['关闭右侧', ['host:', 'host:a'], 'host:a'],
  ['关闭其它', ['host:a'], 'host:a'],
  ['关闭所有', [], ''],
])(
  'workspace tab menu %s uses the clicked tab and retains sessions',
  async (label, keys, active) => {
    const workspace = useWorkspaceStore(),
      terminals = useTerminalsStore(),
      files = useFilesStore();
    terminals.open(useHostsStore().catalog!.hosts[0]!);
    const pane = terminals.panes[0]!;
    terminals.update(pane.key, {
      state: 'connected',
      sessionId: 'existing-session',
      connectRequested: false,
    });
    const close = vi.spyOn(terminalApi, 'close');
    workspace.navigate('terminals', '');
    workspace.navigate('files', 'a');
    workspace.navigate('batch');
    workspace.navigate('network');
    files.connections.a = {
      host: useHostsStore().catalog!.hosts[0]!,
      id: 'existing-files',
      state: 'connected',
      error: null,
      trust: null,
      path: '/home',
      loading: false,
      listing: null,
    };
    await flush();
    root.querySelector('.workspace-tab[data-host-id="a"]')!.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 300,
        clientY: 90,
      }),
    );
    await nextTick();
    expect(workspace.active).toBe('network:');
    const menu = document.querySelector('[role="menu"][aria-label="工作区标签操作"]')!;
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      '关闭',
      '关闭右侧',
      '关闭其它',
      '关闭所有',
    ]);
    buttons.find((button) => button.textContent?.trim() === label)!.click();
    await flush();
    expect(workspace.tabs.map((tab) => tab.key)).toEqual(keys);
    expect(workspace.active).toBe(active);
    expect(document.querySelector('[aria-label="工作区标签操作"]')).toBeNull();
    expect(terminals.panes).toHaveLength(1);
    expect(terminals.panes[0]).toMatchObject({
      key: pane.key,
      sessionId: 'existing-session',
      state: 'connected',
    });
    expect(files.connections.a).toMatchObject({ id: 'existing-files', state: 'connected' });
    expect(close).not.toHaveBeenCalled();
    if (!keys.length) expect(root.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
  },
);

it('disables empty workspace close ranges and dismisses the menu outside', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  await flush();
  const tab = root.querySelector('.workspace-tab')!;
  const context = () =>
    tab.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 90 }),
    );
  context();
  await nextTick();
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[aria-label="工作区标签操作"] [role="menuitem"]',
    ),
  ];
  expect(buttons.map((button) => button.disabled)).toEqual([false, true, true, false]);
  buttons[1]!.click();
  buttons[2]!.click();
  expect(workspace.tabs).toHaveLength(1);
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await nextTick();
  expect(document.querySelector('[aria-label="工作区标签操作"]')).toBeNull();
  context();
  await nextTick();
  window.dispatchEvent(new Event('resize'));
  await nextTick();
  expect(document.querySelector('[aria-label="工作区标签操作"]')).toBeNull();
});

it('supports keyboard opening, navigation and Escape without activating the target tab', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  workspace.navigate('settings');
  await flush();
  const tab = root.querySelector<HTMLButtonElement>('.workspace-tab [role="tab"]')!;
  tab.focus();
  tab.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
  );
  await nextTick();
  const menu = document.querySelector('[aria-label="工作区标签操作"]')!;
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(document.activeElement).toBe(buttons[0]);
  buttons[0]!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(buttons[3]);
  buttons[3]!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(buttons[0]);
  buttons[0]!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  await nextTick();
  expect(document.querySelector('[aria-label="工作区标签操作"]')).toBeNull();
  expect(document.activeElement).toBe(tab);
  expect(workspace.active).toBe('settings:');
});

it('activating an empty host workspace does not silently create a replacement Shell', async () => {
  const terminals = useTerminalsStore(),
    workspace = useWorkspaceStore();
  terminals.open(null);
  workspace.navigate('terminals', '');
  root.querySelector<HTMLButtonElement>('.tree-host')!.click();
  await flush();
  const local = terminals.hostTabs('')[0]!;
  await terminals.close(local.key);
  workspace.selectHost('');
  await flush();
  expect(root.textContent).toContain('没有打开的终端');
  expect(terminals.hostTabs('')).toHaveLength(0);
  root.querySelector<HTMLButtonElement>('.activity-rail [aria-label="主机工作区"]')!.click();
  await flush();
  expect(terminals.hostTabs('')).toHaveLength(0);
  root.querySelector<HTMLButtonElement>('.workspace-tab.active [role="tab"]')!.click();
  await flush();
  expect(terminals.hostTabs('')).toHaveLength(0);
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: '' });
  expect(terminals.hostTabs('a')).toHaveLength(1);
});
