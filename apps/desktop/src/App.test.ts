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
import * as ipc from './services/ipc';
import { defaultTerminalPreferences } from './types/preferences';
import { defaultProductPreferences } from './types/product';

// Exercise the shell and both tab bars without xterm's browser canvas or a remote connection.
vi.mock('./components/TerminalPane.vue', () => ({ default: { render: () => null } }));
let app: App | undefined, pinia: Pinia, root: HTMLDivElement;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const flush = async () => {
  await vi.dynamicImportSettled();
  await nextTick();
};
async function sessionAction(index: number, label: string): Promise<void> {
  root
    .querySelectorAll('.terminal-tab')
    [index]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.trim() === label)!
    .click();
  await flush();
}
function loadSidebarConfig(): void {
  useApplicationStore().state = {
    appVersion: 'test',
    databaseVersion: 6,
    dataDirectory: '',
    logDirectory: '',
    config: {
      version: 1,
      theme: 'dark',
      sidebarWidth: 248,
      terminalFontSize: 14,
      connectTimeoutSecs: 15,
      monitorIntervalSecs: 3,
      transferConcurrency: 3,
      logLevel: 'info',
      terminal: defaultTerminalPreferences(),
      product: defaultProductPreferences(),
    },
  };
}
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

it.each([
  [324.25, 375.75, 300],
  [324.75, -200.25, 200],
  [324.25, 900.75, 400],
])(
  'persists integer sidebar width for fractional pointer coordinates (%s → %s)',
  async (start, end, expected) => {
    loadSidebarConfig();
    const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => {
      if (!Number.isInteger(config.sidebarWidth)) throw 'invalid args: sidebarWidth must be u16';
      return config;
    });
    await flush();
    const resizer = root.querySelector('[aria-label="调整主机侧栏宽度"]')!;
    resizer.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: start, bubbles: true, cancelable: true }),
    );
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: end }));
    await nextTick();
    const previewWidth = resizer.getAttribute('aria-valuenow');
    window.dispatchEvent(new MouseEvent('pointerup'));
    await vi.waitFor(() => expect(useApplicationStore().saving).toBe(false));
    expect(useApplicationStore().error).toBeNull();
    expect(previewWidth).toBe(String(expected));
    expect(save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sidebarWidth: expected }),
    );
    expect(useApplicationStore().state?.config.sidebarWidth).toBe(expected);
    expect(
      root.querySelector<HTMLElement>('.app-shell')!.style.getPropertyValue('--sidebar-width'),
    ).toBe(`${expected}px`);
  },
);

it('keeps keyboard sidebar resizing in eight-pixel steps and within the saved bounds', async () => {
  loadSidebarConfig();
  vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await flush();
  const resizer = root.querySelector('[aria-label="调整主机侧栏宽度"]')!;
  for (const [key, expected] of [
    ['ArrowRight', 256],
    ['ArrowLeft', 248],
  ] as const) {
    resizer.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(useApplicationStore().state?.config.sidebarWidth).toBe(expected));
  }
  useApplicationStore().state!.config.sidebarWidth = 399;
  resizer.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(useApplicationStore().state?.config.sidebarWidth).toBe(400));
});

it.each(['.activity-rail', '.sidebar', '.content-scroll', '.sidebar input'])(
  'suppresses the native context menu in %s even before the backend is ready',
  (selector) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    expect(root.querySelector(selector)).not.toBeNull();
    root.querySelector(selector)!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  },
);

it('removes the brand header and opens About without changing the active workspace', async () => {
  loadSidebarConfig();
  useApplicationStore().state!.appVersion = '0.1.0-beta.1';
  const workspace = useWorkspaceStore();
  workspace.navigate('terminals', 'a');
  await flush();
  const tabs = workspace.tabs.map((tab) => ({ ...tab }));
  const active = workspace.active;
  expect(root.querySelector('.topbar')).toBeNull();
  root.querySelector<HTMLButtonElement>('.activity-rail [aria-label="关于"]')!.click();
  await nextTick();
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="关于 ServerDeck"]')!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('v0.1.0-beta.1');
  expect(dialog.textContent).toContain('SSH 终端、SFTP 文件管理和服务器监控');
  expect(workspace.tabs).toEqual(tabs);
  expect(workspace.active).toBe(active);
  dialog.querySelector<HTMLButtonElement>('.dialog-actions button')!.click();
  await nextTick();
  expect(document.querySelector('dialog[aria-label="关于 ServerDeck"]')).toBeNull();
  expect(document.activeElement).toBe(root.querySelector('.activity-rail [aria-label="关于"]'));
});

it('keeps About available before bootstrap and supports dismissing it with Escape', async () => {
  const open = root.querySelector<HTMLButtonElement>('.activity-rail [aria-label="关于"]')!;
  open.click();
  await nextTick();
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="关于 ServerDeck"]')!;
  expect(dialog.textContent).toContain('暂不可用（本地后端未就绪）');
  useApplicationStore().loading = true;
  await nextTick();
  expect(dialog.textContent).toContain('读取中…');
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  await nextTick();
  expect(document.querySelector('dialog[aria-label="关于 ServerDeck"]')).toBeNull();
  expect(document.activeElement).toBe(open);
  open.click();
  await nextTick();
  document
    .querySelector<HTMLButtonElement>(
      'dialog[aria-label="关于 ServerDeck"] [aria-label="关闭对话框"]',
    )!
    .click();
  await nextTick();
  expect(document.querySelector('dialog[aria-label="关于 ServerDeck"]')).toBeNull();
});

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
    (button) => button.textContent?.trim() === '关闭',
  );
  expect(close).toBeDefined();
  close!.click();
  await flush();
  expect(useTerminalsStore().panes).toHaveLength(0);
});

it('removes the host management page and keeps creation available in the workspace', async () => {
  expect(root.querySelector('.topbar [aria-label="当前主机上下文"]')).toBeNull();
  expect(root.querySelector('.topbar [aria-label="打开全局搜索"]')).toBeNull();
  expect(root.querySelectorAll('.activity-rail [aria-label="主机管理"]')).toHaveLength(1);
  expect(root.querySelector('.activity-rail [aria-label="主机工作区"]')).toBeNull();
  expect(root.querySelector('.hosts-view')).toBeNull();
  root.querySelector<HTMLButtonElement>('.host-sidebar-actions [aria-label="新建主机"]')!.click();
  await nextTick();
  expect(document.querySelector<HTMLDialogElement>('dialog[aria-label="新建主机"]')!.open).toBe(
    true,
  );
  expect(useTerminalsStore().panes).toHaveLength(0);
});

it('removes the host heading text and keeps collapse and expansion available', async () => {
  expect(root.querySelector('.topbar')).toBeNull();
  const title = root.querySelector('.host-sidebar-title')!;
  const collapse = title.querySelector<HTMLButtonElement>('[aria-label="收起主机栏"]')!;
  expect(collapse).not.toBeNull();
  expect(root.querySelector('.host-sidebar-heading')?.textContent?.trim()).toBe('');
  expect(title.querySelector('h2')).toBeNull();
  expect(collapse.getAttribute('aria-expanded')).toBe('true');
  const hosts = useHostsStore();
  hosts.search = 'Host a';
  await nextTick();
  collapse.click();
  await flush();
  expect(root.querySelector<HTMLElement>('.sidebar')!.style.display).toBe('none');
  const expand = root.querySelector<HTMLButtonElement>(
    '.workspace-tabs [aria-label="展开主机栏"]',
  )!;
  expect(expand).not.toBeNull();
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(expand);
  expand.click();
  await flush();
  expect(root.querySelector<HTMLElement>('.sidebar')!.style.display).not.toBe('none');
  expect(document.activeElement).toBe(collapse);
  expect(hosts.search).toBe('Host a');
  expect(root.querySelectorAll('.tree-host')).toHaveLength(1);
  expect(useTerminalsStore().panes).toHaveLength(0);
  expect(root.querySelector('.workspace-tabs [aria-label="展开主机栏"]')).toBeNull();
  await useWorkspaceStore().navigate('credentials');
  await flush();
  expect(root.querySelector('.workspace-tabs [aria-label="展开主机栏"]')).toBeNull();
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

it.each([false, true])(
  'connects only the selected restored pane on a host click (existing workspace=%s)',
  async (existing) => {
    const terminals = useTerminalsStore(),
      workspace = useWorkspaceStore();
    const hosts = useHostsStore().catalog!.hosts;
    terminals.open(hosts[0]!);
    terminals.split(terminals.focused, 'rows');
    terminals.open(hosts[1]!);
    const saved = terminals.snapshot();
    terminals.tabs = [];
    vi.spyOn(terminalApi, 'workspaceLoad').mockResolvedValueOnce(saved);
    vi.spyOn(terminalApi, 'workspaceSave').mockResolvedValue();
    await terminals.restore(hosts);
    if (existing) workspace.navigate('terminals', 'a');
    await flush();
    expect(terminals.panes.every((pane) => pane.state === 'idle' && !pane.connectRequested)).toBe(
      true,
    );
    const keys = terminals.panes.map((pane) => pane.key);
    const click = () =>
      root.querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!.click();
    click();
    await flush();
    const selected = terminals.panes.find((pane) => pane.key === terminals.focused)!;
    expect(selected).toMatchObject({ host: { id: 'a' }, connectRequested: true });
    expect(terminals.panes.filter((pane) => pane.connectRequested).map((pane) => pane.key)).toEqual(
      [selected.key],
    );
    click();
    click();
    await flush();
    expect(terminals.panes.map((pane) => pane.key)).toEqual(keys);
    expect(terminals.tabs).toHaveLength(2);
  },
);

it('connects the selected idle shell when its host workspace tab is clicked', async () => {
  const terminals = useTerminalsStore(),
    workspace = useWorkspaceStore();
  terminals.open(useHostsStore().catalog!.hosts[0]!);
  const pane = terminals.panes[0]!;
  terminals.update(pane.key, { state: 'idle', connectRequested: false });
  workspace.navigate('terminals', 'a');
  workspace.navigate('settings');
  await flush();
  expect(pane.connectRequested).toBe(false);
  root.querySelector<HTMLButtonElement>('.workspace-tab[data-host-id="a"] [role="tab"]')!.click();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: 'a' });
  expect(pane.connectRequested).toBe(true);
  expect(terminals.panes).toHaveLength(1);
});

it.each(['connecting', 'awaiting_trust', 'connected', 'failed'])(
  'reuses a %s pane on host selection',
  async (state) => {
    const terminals = useTerminalsStore(),
      workspace = useWorkspaceStore();
    terminals.open(useHostsStore().catalog!.hosts[0]!);
    const pane = terminals.panes[0]!;
    terminals.update(pane.key, { state, sessionId: 'existing-session' });
    workspace.navigate('terminals', 'a');
    await flush();
    root.querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!.click();
    await flush();
    expect(terminals.panes).toHaveLength(1);
    expect(terminals.panes[0]).toMatchObject({
      key: pane.key,
      state,
      sessionId: 'existing-session',
    });
  },
);

it('creates a shell in an existing empty workspace only after the host tree is clicked', async () => {
  const terminals = useTerminalsStore(),
    workspace = useWorkspaceStore();
  terminals.open(useHostsStore().catalog!.hosts[1]!);
  workspace.navigate('terminals', 'a');
  workspace.navigate('settings');
  await flush();
  root.querySelector<HTMLButtonElement>('.activity-rail [aria-label="主机管理"]')!.click();
  await flush();
  expect(terminals.panes).toHaveLength(1);
  expect(workspace.current).toMatchObject({ hostId: 'a', view: 'terminals' });
  root.querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!.click();
  await flush();
  expect(terminals.panes).toHaveLength(2);
  expect(terminals.panes.find((pane) => pane.key === terminals.focused)).toMatchObject({
    host: { id: 'a' },
    connectRequested: true,
  });
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

it('opens a local terminal from welcome and preserves remote panes without a tabbar launch icon', async () => {
  expect(root.querySelector('[aria-label="打开本地工作区"]')).toBeNull();
  root.querySelector<HTMLButtonElement>('.tree-host')!.click();
  await flush();
  expect(root.querySelector('[aria-label="打开本地工作区"]')).toBeNull();
  useWorkspaceStore().close(useWorkspaceStore().active, 'all');
  await flush();
  root.querySelector<HTMLButtonElement>('[aria-label="欢迎页面"] .primary')!.click();
  await flush();
  expect(useWorkspaceStore().current).toMatchObject({ view: 'terminals', hostId: '' });
  const terminals = useTerminalsStore();
  expect(terminals.panes.find((p) => p.key === terminals.focused)?.host).toBeNull();
  expect(terminals.panes.some((p) => p.host?.id === 'a')).toBe(true);
  root.querySelector<HTMLButtonElement>('.workspace-tab.active [role="tab"]')!.click();
  await flush();
  expect(terminals.panes.filter((p) => p.host === null)).toHaveLength(1);
});

it('keeps restored sessions disconnected, removes session tools and retains tab menu actions', async () => {
  const terminals = useTerminalsStore();
  const host = useHostsStore().catalog!.hosts[0]!;
  terminals.open(host);
  const saved = terminals.snapshot();
  terminals.tabs = [];
  vi.spyOn(terminalApi, 'workspaceLoad').mockResolvedValueOnce(saved);
  vi.spyOn(terminalApi, 'workspaceSave').mockResolvedValue();
  await terminals.restore([host]);
  useWorkspaceStore().navigate('terminals', host.id);
  await flush();
  expect(terminals.panes[0]).toMatchObject({ state: 'idle', connectRequested: false });
  expect(root.textContent).not.toContain('已恢复布局');
  expect(root.querySelector('.workspace-header .host-tools')).not.toBeNull();
  expect(root.querySelector('.workspace-header .workspace-context')).toBeNull();
  expect(
    [...root.querySelectorAll('.workspace-header button')].map((button) =>
      button.textContent?.trim(),
    ),
  ).toEqual(['Shell', 'SFTP', '监控', 'Linux 运维']);
  expect(root.querySelector('.terminal-session-header .terminal-tabs')).not.toBeNull();
  expect(root.querySelector('.split-toolbar, [aria-label="会话操作"]')).toBeNull();
  expect(root.querySelectorAll('.terminal-session-header button')).toHaveLength(2);
  await sessionAction(0, '复制');
  expect(terminals.tabs).toHaveLength(2);
  const current = terminals.active;
  terminals.open(host);
  await flush();
  await sessionAction(2, '关闭');
  await sessionAction(0, '关闭');
  expect(terminals.tabs).toHaveLength(1);
  expect(terminals.tabs[0]!.key).toBe(current);
  await sessionAction(0, '重命名');
  const dialog = document.querySelector('dialog[aria-label="重命名标签"]')!;
  const input = dialog.querySelector<HTMLInputElement>('input')!;
  input.value = '新会话';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  expect(terminals.tabs[0]!.title).toBe('新会话');
  expect(document.querySelector('dialog[aria-label="重命名标签"]')).toBeNull();
  await vi.waitFor(() =>
    expect(terminalApi.workspaceSave).toHaveBeenLastCalledWith(terminals.snapshot()),
  );
});

it.each(['remote', 'local'])(
  'duplicates the right-clicked inactive %s tab as a fresh single-pane session',
  async (target) => {
    const terminals = useTerminalsStore();
    const host = target === 'remote' ? useHostsStore().catalog!.hosts[0]! : null;
    terminals.open(host);
    const source = terminals.tabs[0]!;
    terminals.update(source.panes[0]!.key, {
      state: 'connected',
      sessionId: 'existing-session',
      transportId: 'existing-transport',
      cwd: '/previous',
    });
    if (host)
      terminals.update(source.panes[0]!.key, {
        fileAction: { kind: 'tail', path: '/previous.log' },
      });
    terminals.rename(source.key, '源会话');
    terminals.split(source.panes[0]!.key, 'columns');
    terminals.open(host);
    const previous = terminals.active;
    useWorkspaceStore().navigate('terminals', host?.id ?? '');
    await flush();
    const original = JSON.stringify(terminals.tabs);
    root
      .querySelector('.terminal-tab')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await nextTick();
    expect(terminals.active).toBe(previous);
    root.querySelector<HTMLButtonElement>('[aria-label="关闭标签菜单"]')!.click();
    await sessionAction(0, '复制');
    expect(terminals.tabs).toHaveLength(3);
    const added = terminals.tabs[2]!;
    expect(added.key).not.toBe(source.key);
    expect(terminals.active).toBe(added.key);
    expect(added.panes).toHaveLength(1);
    expect(added.panes[0]).toMatchObject({ host, state: 'opening', connectRequested: true });
    expect(added.panes[0]!.key).not.toBe(source.panes[0]!.key);
    expect(added.layout).toEqual({ kind: 'leaf', pane: added.panes[0]!.key });
    expect(terminals.focused).toBe(added.panes[0]!.key);
    expect(added.panes[0]!.sessionId).toBeUndefined();
    expect(added.panes[0]!.transportId).toBeUndefined();
    expect(added.panes[0]!.cwd).toBeUndefined();
    expect(added.panes[0]!.fileAction).toBeUndefined();
    expect(JSON.stringify(terminals.tabs.slice(0, 2))).toBe(original);
    expect(root.querySelector('[role="menu"]')).toBeNull();
  },
);

it.each(['remote', 'local'])(
  'orders the %s tab menu and closes one/all relative to the unselected right-click target',
  async (kind) => {
    const terminals = useTerminalsStore();
    const close = vi.spyOn(terminalApi, 'close').mockResolvedValue();
    const hosts = useHostsStore().catalog!.hosts;
    terminals.open(hosts[1]!);
    const other = terminals.tabs[0]!;
    terminals.update(other.panes[0]!.key, { sessionId: 'other-host-session' });
    const host = kind === 'remote' ? hosts[0]! : null;
    for (let index = 0; index < 3; index++) terminals.open(host);
    const [first, target, selected] = terminals.tabs.slice(1);
    terminals.split(target!.panes[0]!.key, 'columns');
    terminals.select(selected!.key);
    for (const pane of terminals.panes.slice(1))
      terminals.update(pane.key, { sessionId: pane.key });
    useWorkspaceStore().navigate('terminals', host?.id ?? '');
    await flush();
    root
      .querySelectorAll('.terminal-tab')[1]!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await nextTick();
    expect(terminals.active).toBe(selected!.key);
    const menu = root.querySelector('[role="menu"]')!;
    expect([...menu.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
      '复制',
      '重命名',
      '关闭所有',
      '关闭',
    ]);
    menu.querySelectorAll<HTMLButtonElement>('button')[3]!.click();
    await flush();
    expect(terminals.tabs.map((tab) => tab.key)).toEqual([other.key, first!.key, selected!.key]);
    expect(terminals.active).toBe(selected!.key);
    expect(terminals.focused).toBe(selected!.panes[0]!.key);
    expect(close.mock.calls.flat().sort()).toEqual(target!.panes.map((pane) => pane.key).sort());
    expect(root.querySelector('[role="menu"]')).toBeNull();
    terminals.open(host);
    const added = terminals.tabs[3]!;
    terminals.update(added.panes[0]!.key, { sessionId: added.panes[0]!.key });
    await flush();
    expect(terminals.active).toBe(added.key);
    await sessionAction(0, '关闭所有');
    expect(terminals.tabs.map((tab) => tab.key)).toEqual([other.key]);
    expect(terminals.active).toBe('');
    expect(terminals.focused).toBe('');
    expect(close).toHaveBeenCalledTimes(5);
    expect(close).not.toHaveBeenCalledWith('other-host-session');
    expect(root.querySelector('.workspace-empty')?.textContent).toContain('没有打开的终端');
    expect(root.querySelector('[role="menu"]')).toBeNull();
  },
);

it('reports the terminal limit when duplicating and keeps the existing sessions selected', async () => {
  const terminals = useTerminalsStore();
  const host = useHostsStore().catalog!.hosts[0]!;
  for (let index = 0; index < 32; index++) terminals.open(host);
  const original = JSON.stringify(terminals.tabs),
    active = terminals.active,
    focused = terminals.focused;
  useWorkspaceStore().navigate('terminals', host.id);
  await flush();
  await sessionAction(0, '复制');
  expect(terminals.tabs).toHaveLength(32);
  expect(JSON.stringify(terminals.tabs)).toBe(original);
  expect(terminals.active).toBe(active);
  expect(terminals.focused).toBe(focused);
  expect(document.querySelector('.toast[role="alert"]')?.textContent).toContain(
    '最多打开 32 个终端窗格',
  );
  expect(root.querySelector('[role="alert"]')).toBeNull();
  expect(root.querySelector('[role="menu"]')).toBeNull();
});

it('shows a shared store failure exactly once in notifications across terminal and settings pages', async () => {
  useWorkspaceStore().navigate('terminals', 'a');
  await flush();
  useApplicationStore().error = '配置项无效：工作区标识重复';
  await flush();
  expect(document.querySelectorAll('.toast[role="alert"]')).toHaveLength(1);
  expect(document.querySelector('.toast')?.textContent).toContain('配置项无效：工作区标识重复');
  expect(root.textContent).not.toContain('配置项无效：工作区标识重复');
  useWorkspaceStore().navigate('settings');
  await flush();
  expect(document.querySelectorAll('.toast[role="alert"]')).toHaveLength(1);
  expect(root.querySelector('[role="alert"]')).toBeNull();
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
  await sessionAction(0, '复制');
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
  workspace.close(workspace.active, 'all');
  await flush();
  root.querySelector<HTMLButtonElement>('[aria-label="欢迎页面"] .primary')!.click();
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
  root.querySelector<HTMLButtonElement>('.activity-rail [aria-label="主机管理"]')!.click();
  await flush();
  expect(terminals.hostTabs('')).toHaveLength(0);
  root.querySelector<HTMLButtonElement>('.workspace-tab.active [role="tab"]')!.click();
  await flush();
  expect(terminals.hostTabs('')).toHaveLength(0);
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: '' });
  expect(terminals.hostTabs('a')).toHaveLength(1);
});
