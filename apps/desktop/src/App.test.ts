import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import AppShell from './App.vue';
import { useApplicationStore } from './stores/application';
import { useHostsStore } from './stores/hosts';
import { useTerminalsStore } from './stores/terminals';
import { useWorkspaceStore } from './stores/workspace';
import { useFilesStore } from './stores/files';
import { useBackgroundStore } from './stores/background';
import { terminalApi } from './services/terminal';
import { hostsApi } from './services/hosts';
import { filesApi } from './services/files';
import { hostInput } from './types/hosts';
import * as ipc from './services/ipc';
import { defaultTerminalPreferences } from './types/preferences';
import { defaultProductPreferences } from './types/product';
import { pluginsApi } from './services/plugins';
import { usePluginsStore } from './stores/plugins';
import { useNotificationsStore } from './stores/notifications';
import { systemPluginFixtures, toolPluginState } from './services/system-plugins.fixture';
import { aiApi } from './services/ai';
import type { TransferInfo } from './types/files';

// Exercise the shell, workspace tabs and session tabs without xterm's browser canvas or a remote connection.
vi.mock('./components/TerminalPane.vue', () => ({ default: { render: () => null } }));
// This shell unit suite mounts the real plugin views through public SDK test
// adapters. Native iframe isolation and package loading are checked separately.
vi.mock('@serverdeck/plugin-sdk/stores/hosts', async () => import('./stores/hosts'));
vi.mock('@serverdeck/plugin-sdk/stores/ops', async () => import('./stores/ops'));
vi.mock('@serverdeck/plugin-sdk/stores/files', async () => import('./stores/files'));
vi.mock('@serverdeck/plugin-sdk/stores/models', async () => import('./stores/models'));
vi.mock('@serverdeck/plugin-sdk/services/ai', async () => import('./services/ai'));
vi.mock('./components/PluginFrame.vue', async () => {
  const { ref } = await import('vue');
  return {
    default: {
      props: ['page', 'active'],
      emits: ['saving', 'settingsAction'],
      setup: () => ({ content: ref('') }),
      template: `<div data-plugin-frame :data-active="active"><textarea v-if="page.id === 'draft'" v-model="content" /><template v-if="page.id === 'settings'"><button data-save @click="$emit('saving', true)">开始保存</button><button data-save-failed @click="$emit('saving', false)">保存失败</button><button data-cancel @click="$emit('settingsAction', 'close')">取消配置</button><button data-models @click="$emit('settingsAction', 'models')">配置平台模型</button></template></div>`,
    },
  };
});
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
let app: App | undefined, pinia: Pinia, root: HTMLDivElement;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const flush = async () => {
  await vi.dynamicImportSettled();
  await nextTick();
};
async function openNavigation(label: string): Promise<void> {
  const workspace = useWorkspaceStore();
  if (workspace.area !== 'settings') {
    document.querySelector<HTMLButtonElement>('.sidebar-app-actions [aria-label="设置"]')!.click();
    await flush();
  }
  document
    .querySelector<HTMLButtonElement>(
      `.settings-navigation [aria-label="${label === '插件管理' ? '插件' : label}"]`,
    )!
    .click();
  await flush();
}
async function openPluginModal(name: string): Promise<HTMLElement> {
  await openNavigation('插件管理');
  [...document.querySelectorAll<HTMLButtonElement>('.plugin-name-button')]
    .find((button) => button.textContent?.trim() === name)!
    .click();
  await flush();
  expect(document.querySelector(`[aria-label="${name} · 配置"]`)).not.toBeNull();
  return document.querySelector<HTMLDialogElement>('.settings-page')!;
}
async function newSession(): Promise<void> {
  document.querySelector<HTMLButtonElement>('[aria-label="新建终端会话"]')!.click();
  await flush();
  const menu = document.querySelector('[role="menu"][aria-label="新建终端会话"]');
  if (menu) {
    [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === '新建普通会话')!
      .click();
    await flush();
  }
}
async function closeSession(index: number): Promise<void> {
  root
    .querySelectorAll<HTMLButtonElement>('.terminal-tab [aria-label^="关闭标签 "]')
    [index]!.click();
  await flush();
}
function loadSidebarConfig(): void {
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

it('switches the shell and built-in plugin labels while preserving sessions and user names', async () => {
  loadSidebarConfig();
  const application = useApplicationStore();
  const workspace = useWorkspaceStore();
  const terminals = useTerminalsStore();
  const host = useHostsStore().catalog!.hosts[0]!;
  host.name = '通用';
  terminals.open(host);
  terminals.update(terminals.focused, { state: 'connected', sessionId: 'live-language-test' });
  workspace.navigate('terminals', host.id);
  const snapshot = JSON.stringify(terminals.tabs);
  const close = vi.spyOn(terminalApi, 'close').mockResolvedValue();
  vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await openNavigation('通用');
  const tree = document.querySelector('.host-tree-section');
  const field = document.querySelector<HTMLSelectElement>('[aria-label="界面语言"]')!;
  field.value = 'en-US';
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  document
    .querySelector<HTMLFormElement>('.settings-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(application.state!.config.product.language).toBe('en-US'));
  await flush();
  expect(document.querySelector('.settings-page[aria-label="Settings page"]')).not.toBeNull();
  expect(
    [...document.querySelectorAll('.settings-navigation .nav-item')].map((item) =>
      item.textContent?.trim(),
    ),
  ).toEqual(['General', 'Terminal', 'Shortcuts', 'Data and storage', 'Models', 'Plugins', 'About']);
  expect(document.querySelector('.host-tree-section')).toBe(tree);
  expect(document.querySelector('.host-tree-section')?.textContent).toContain('通用');
  expect(JSON.stringify(terminals.tabs)).toBe(snapshot);
  const plugins = usePluginsStore();
  const builtin = plugins.installed.find((item) => item.manifest.id.endsWith('.assistant'))!;
  expect(plugins.metadata(builtin, builtin.manifest.name)).toBe('AI operations assistant');
  expect(plugins.metadata({ ...builtin, source: 'user' }, builtin.manifest.name)).toBe(
    'AI 运维助手',
  );
  await workspace.closeSettings();
  await flush();
  expect(document.querySelector('.host-tools')?.textContent).toContain('Docker management');
  expect(document.querySelector('.terminal-tab')?.textContent).toContain('Session 1');
  expect(document.querySelector('.terminal-status')?.textContent).toContain(
    'SSH2 · Reading cipher',
  );
  expect(close).not.toHaveBeenCalled();
});

it('keeps terminal status on the active host, session and focused split pane only', async () => {
  const terminals = useTerminalsStore();
  const workspace = useWorkspaceStore();
  const [firstHost, secondHost] = useHostsStore().catalog!.hosts;
  terminals.open(firstHost!);
  workspace.navigate('terminals', firstHost!.id);
  const firstTab = terminals.active;
  const firstPane = terminals.focused;
  terminals.update(firstPane, {
    state: 'connected',
    cipher: 'aes256-ctr',
    screen: { rows: 53, cols: 142, cursorRow: 17, cursorCol: 10 },
  });
  await flush();
  const status = () => root.querySelector('.statusbar .terminal-status');
  expect(status()?.textContent).toContain('aes256-ctr');
  expect(status()?.textContent).toContain('光标 17:10');
  terminals.split(firstPane, 'columns');
  const splitPane = terminals.focused;
  terminals.update(splitPane, {
    state: 'connected',
    cipher: 'aes128-gcm@openssh.com',
    screen: { rows: 53, cols: 70, cursorRow: 2, cursorCol: 3 },
  });
  await flush();
  expect(status()?.textContent).toContain('aes128-gcm@openssh.com');
  expect(status()?.textContent).toContain('53 行 × 70 列');
  terminals.focused = firstPane;
  await flush();
  expect(status()?.textContent).toContain('aes256-ctr');
  terminals.open(firstHost!);
  terminals.update(terminals.focused, { state: 'connected', cipher: 'aes192-ctr' });
  await flush();
  expect(status()?.textContent).toContain('aes192-ctr');
  terminals.select(firstTab);
  terminals.focused = splitPane;
  await terminals.closePane(splitPane);
  await flush();
  expect(status()?.textContent).toContain('aes256-ctr');
  terminals.open(secondHost!);
  terminals.update(terminals.focused, { state: 'failed' });
  await flush();
  expect(status()).toBeNull();
  workspace.navigate('terminals', secondHost!.id);
  await flush();
  expect(status()?.textContent).toContain('连接失败');
  expect(status()?.textContent).not.toContain('aes256-ctr');
  terminals.select(firstTab);
  workspace.navigate('terminals', firstHost!.id);
  await flush();
  expect(status()?.textContent).toContain('aes256-ctr');
  workspace.navigate('files', firstHost!.id);
  await flush();
  expect(status()).toBeNull();
  workspace.navigate('terminals', firstHost!.id);
  terminals.open(null);
  terminals.update(terminals.focused, { state: 'connected', shell: 'PowerShell' });
  workspace.navigate('terminals', '');
  await flush();
  expect(status()?.textContent).toContain('PowerShell');
  await terminals.close(terminals.active);
  await flush();
  expect(status()).toBeNull();
});
beforeEach(async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  vi.spyOn(pluginsApi, 'inventory').mockImplementation(async () => ({
    installed: await pluginsApi.list(),
    problems: [],
  }));
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
  const pluginState = toolPluginState();
  Object.assign(usePluginsStore(), pluginState);
  vi.spyOn(pluginsApi, 'list').mockResolvedValue(pluginState.installed);
  vi.spyOn(pluginsApi, 'permissions').mockImplementation(
    async (id) => pluginState.grants[id] ?? null,
  );
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  vi.spyOn(pluginsApi, 'ui').mockImplementation(async (id) => pluginState.schemas[id]!.ui);
  vi.spyOn(pluginsApi, 'reset').mockResolvedValue();
  vi.spyOn(pluginsApi, 'scopeVisibility').mockResolvedValue();
  vi.spyOn(pluginsApi, 'closeScope').mockResolvedValue();
  vi.spyOn(pluginsApi, 'cancelScope').mockResolvedValue();
  vi.spyOn(filesApi, 'tasks').mockResolvedValue([]);
  vi.spyOn(filesApi, 'connections').mockResolvedValue([]);
  vi.spyOn(filesApi, 'close').mockResolvedValue();
  vi.spyOn(filesApi, 'clearTransfers').mockResolvedValue();
  vi.spyOn(pluginsApi, 'activate').mockResolvedValue({ state: 'active' } as never);
  vi.spyOn(aiApi, 'models').mockResolvedValue([]);
  vi.spyOn(pluginsApi, 'call').mockResolvedValue({ protocolVersion: 1, error: null, result: [] });
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
  // Awaited plugin teardown from the previous app may finish during lazy imports.
  setActivePinia(pinia);
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

it('opens the existing host and import dialogs from the welcome cards without starting a connection', async () => {
  const welcome = document.querySelector('[aria-label="欢迎页面"]')!;
  expect(welcome.classList.contains('workspace-empty')).toBe(false);
  expect(welcome.querySelectorAll('.welcome-card')).toHaveLength(3);
  expect(welcome.querySelector('[aria-label="快速上手"]')).not.toBeNull();
  expect(welcome.querySelector('[aria-label="键盘操作"]')).not.toBeNull();
  const open = vi.spyOn(useTerminalsStore(), 'open');
  const importHosts = vi.spyOn(hostsApi, 'import');
  const button = (label: string) =>
    [...welcome.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === label,
    )!;

  button('新建主机').click();
  await flush();
  const create = document.querySelector<HTMLDialogElement>('dialog[aria-label="新建主机"]')!;
  expect(create.open).toBe(true);
  create.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  await flush();
  expect(document.querySelector('dialog[aria-label="新建主机"]')).toBeNull();

  button('导入配置').click();
  await flush();
  const dialog = document.querySelector<HTMLDialogElement>(
    'dialog[aria-label="导入 OpenSSH Config"]',
  )!;
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('[aria-label="OpenSSH Config 内容"]')).not.toBeNull();
  expect(importHosts).not.toHaveBeenCalled();
  dialog.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  await flush();
  expect(document.querySelector('dialog[aria-label="导入 OpenSSH Config"]')).toBeNull();
  expect(open).not.toHaveBeenCalled();
  expect(useWorkspaceStore().tabs).toEqual([]);
});

it('opens one fresh local terminal from the welcome page even when a remote host is selected', async () => {
  useHostsStore().selectedId = 'a';
  const terminals = useTerminalsStore();
  const open = vi.spyOn(terminals, 'open');
  const button = document.querySelector<HTMLButtonElement>('.welcome-card .button')!;
  expect(button.textContent?.trim()).toBe('本地终端');
  button.click();
  await flush();
  expect(open).toHaveBeenCalledExactlyOnceWith(null);
  expect(terminals.panes).toHaveLength(1);
  expect(terminals.panes[0]?.host).toBeNull();
  expect(terminals.panes[0]?.connectRequested).toBe(true);
  expect(useWorkspaceStore().current).toMatchObject({ view: 'terminals', hostId: '' });
  expect(document.querySelector('[aria-label="欢迎页面"]')).toBeNull();
});

it('updates welcome shortcuts and translations from saved preferences', async () => {
  loadSidebarConfig();
  const config = useApplicationStore().state!.config;
  config.product.shortcuts = { search: 'Ctrl+Shift+K', settings: '' };
  await flush();
  const shortcuts = () =>
    [...document.querySelectorAll('.welcome-shortcuts kbd')].map((item) => item.textContent);
  expect(shortcuts()).toEqual(['Ctrl+Shift+K', 'Enter']);
  expect(document.querySelector('.welcome-eyebrow')).toBeNull();
  expect(
    [...document.querySelectorAll('.welcome-shortcuts dt')].map((item) => item.textContent),
  ).toEqual(['搜索主机与命令', '连接选中的主机']);
  config.product.language = 'en-US';
  await flush();
  expect(document.querySelector('.welcome-heading h1')?.textContent).toBe('Welcome to ServerDeck');
  expect(
    [...document.querySelectorAll('.welcome-card h2')].map((item) => item.textContent),
  ).toEqual(['Local terminal', 'New host', 'Import SSH configuration']);
  expect(shortcuts()).toEqual(['Ctrl+Shift+K', 'Enter']);
  config.product.language = 'zh-CN';
  await flush();
  expect(document.querySelector('.welcome-heading h1')?.textContent).toBe('欢迎使用 ServerDeck');
  expect(useTerminalsStore().panes).toEqual([]);
});

it.each(['', 'a'])(
  'starts with no terminal tabs and opens one fresh Shell for the selected host (%s)',
  async (savedHostId) => {
    app!.unmount();
    loadSidebarConfig();
    vi.spyOn(useHostsStore(), 'load').mockResolvedValue();
    vi.spyOn(useBackgroundStore(), 'start').mockImplementation(() => {});
    vi.spyOn(useFilesStore(), 'poll').mockResolvedValue();
    const terminals = useTerminalsStore();
    const open = vi.spyOn(terminals, 'open');
    app = createApp(AppShell).use(pinia);
    app.mount(root);
    await flush();
    expect(useWorkspaceStore().tabs).toEqual([]);
    expect(document.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
    const terminalWorkspace = document.querySelector<HTMLElement>('.terminal-workspace')!;
    expect(terminalWorkspace.classList.contains('terminal-hidden')).toBe(true);
    expect(terminalWorkspace.hasAttribute('inert')).toBe(true);
    expect(terminalWorkspace.getAttribute('aria-hidden')).toBe('true');
    expect(open).not.toHaveBeenCalled();
    expect(terminals.tabs).toEqual([]);
    expect(terminals.panes).toEqual([]);
    expect(terminalApi).not.toHaveProperty('workspaceLoad');
    root
      .querySelector<HTMLButtonElement>(
        savedHostId ? `.tree-host[data-host-id="${savedHostId}"]` : '[aria-label="本地终端"]',
      )!
      .dispatchEvent(new MouseEvent(savedHostId ? 'dblclick' : 'click', { bubbles: true }));
    await flush();
    expect(useWorkspaceStore().current).toMatchObject({
      view: 'terminals',
      hostId: savedHostId ?? '',
    });
    expect(terminals.tabs).toHaveLength(1);
    expect(terminals.panes).toHaveLength(1);
    expect(terminals.panes[0]?.connectRequested).toBe(true);
    expect(terminalWorkspace.classList.contains('terminal-hidden')).toBe(false);
    expect(terminalWorkspace.hasAttribute('inert')).toBe(false);
    expect(terminalWorkspace.hasAttribute('aria-hidden')).toBe(false);
    expect(terminals.tabs[0]).toMatchObject({ sessionNumber: 1 });
    expect(terminals.tabs[0]!.key).not.toMatch(/^saved-/);
    expect(open).toHaveBeenCalledOnce();
    expect(terminalApi).not.toHaveProperty('workspaceSave');
  },
);

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
    const resizer = document.querySelector('[aria-label="调整主机侧栏宽度"]')!;
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
      document.querySelector<HTMLElement>('.app-shell')!.style.getPropertyValue('--sidebar-width'),
    ).toBe(`${expected}px`);
  },
);

it('keeps keyboard sidebar resizing in eight-pixel steps and within the saved bounds', async () => {
  loadSidebarConfig();
  vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  await flush();
  const resizer = document.querySelector('[aria-label="调整主机侧栏宽度"]')!;
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
    expect(document.querySelector(selector)).not.toBeNull();
    document.querySelector(selector)!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  },
);

it('opens About inside the settings page and preserves the connected terminal', async () => {
  loadSidebarConfig();
  useApplicationStore().state!.appVersion = '9.8.7-test.1';
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  terminals.open(useHostsStore().catalog!.hosts[0]!);
  terminals.update(terminals.focused, { state: 'connected', sessionId: 'live-shell' });
  workspace.navigate('terminals', 'a');
  const original = JSON.stringify(terminals.tabs);
  const close = vi.spyOn(terminalApi, 'close').mockResolvedValue();
  await openNavigation('关于');
  const page = document.querySelector('.about-view')!;
  expect(page.querySelector('h1')?.textContent).toBe('关于 ServerDeck');
  expect(page.textContent).toContain('v9.8.7-test.1');
  expect(
    [...page.querySelectorAll('[aria-label="产品信息"] dt')].map((label) => label.textContent),
  ).toEqual(['应用版本', '发布时间']);
  expect(page.textContent).not.toContain('Rust · Tauri 2 · Vue 3');
  const releaseTime = page.querySelector('time')!;
  expect(releaseTime.dateTime).toBe(import.meta.env.APP_RELEASE_TIME);
  expect(Number.isFinite(Date.parse(releaseTime.dateTime))).toBe(true);
  expect(releaseTime.textContent).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}:\d{2}$/);
  expect(releaseTime.parentElement?.textContent).toContain('北京时间');
  expect(page.textContent).toContain('schema v10');
  expect(page.querySelector('[data-testid="backend-ready"]')).not.toBeNull();
  expect(workspace.current).toMatchObject({ key: 'host:a', view: 'terminals', hostId: 'a' });
  expect(workspace.settingsView).toBe('about');
  expect(workspace.tabs).toHaveLength(1);
  await workspace.closeSettings();
  await flush();
  expect(document.querySelector('.about-view')).toBeNull();
  expect(JSON.stringify(terminals.tabs)).toBe(original);
  expect(close).not.toHaveBeenCalled();
});

it('opens plugin management inside settings without adding a tab or changing the active host', async () => {
  loadSidebarConfig();
  vi.spyOn(pluginsApi, 'list').mockResolvedValue([]);
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  terminals.open(useHostsStore().catalog!.hosts[0]!);
  terminals.update(terminals.focused, { state: 'connected', sessionId: 'live-shell' });
  workspace.navigate('terminals', 'a');
  await flush();
  const original = JSON.stringify(terminals.tabs);
  const tree = document.querySelector('.host-tree-section');
  const close = vi.spyOn(terminalApi, 'close').mockResolvedValue();
  await openNavigation('插件管理');
  expect(document.querySelector('.plugin-manager h1')?.textContent).toBe('插件');
  expect(document.querySelector('.host-tree-section')).toBe(tree);
  expect(
    [...document.querySelectorAll('.workspace-tabs > .workspace-tab')].map((node) =>
      node.getAttribute('data-view'),
    ),
  ).toEqual(['terminals']);
  expect(workspace.settingsView).toBe('plugins');
  expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
  await openNavigation('数据与存储');
  expect(document.querySelector<HTMLSelectElement>('[aria-label="界面语言"]')?.value).toBe('zh-CN');
  expect(workspace.current?.view).toBe('terminals');
  await workspace.closeSettings();
  await flush();
  expect(workspace.tabs.filter((tab) => tab.view === 'plugins')).toHaveLength(0);
  expect(JSON.stringify(terminals.tabs)).toBe(original);
  expect(close).not.toHaveBeenCalled();
});

it('keeps shared preferences and close protection when managing plugins', async () => {
  loadSidebarConfig();
  const workspace = useWorkspaceStore();
  workspace.navigate('terminals', 'a');
  await openNavigation('通用');
  const panel = document.querySelector('.settings-panel');
  const width = document.querySelector<HTMLInputElement>('[aria-label="侧边栏宽度"]')!;
  width.value = '300';
  width.dispatchEvent(new Event('input', { bubbles: true }));
  await openNavigation('插件管理');
  const close = () => void workspace.closeSettings();
  close();
  await flush();
  const prompt = () =>
    document.querySelector<HTMLDialogElement>('dialog[aria-label="设置尚未保存"]')!;
  [...prompt().querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '继续编辑')!
    .click();
  await flush();
  expect(workspace.settingsView).toBe('plugins');
  expect(document.querySelector('.settings-panel')).toBe(panel);
  expect(width.value).toBe('300');
  close();
  await flush();
  [...prompt().querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '放弃更改并关闭')!
    .click();
  await flush();
  expect(workspace.settingsView).toBeNull();
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: 'a' });
  expect(workspace.tabs).toHaveLength(1);
});

it('shows the saved development kit path or save error and lets the user retry after cancellation', async () => {
  const save = vi
    .spyOn(pluginsApi, 'saveDevelopmentKit')
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('目录不可写'))
    .mockResolvedValueOnce('D:\\QA\\serverdeck-plugin-development-kit.zip');
  await openNavigation('插件管理');
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('.plugin-heading-actions button'),
  ].find((item) => item.textContent?.trim() === '下载插件开发包')!;
  const notices = () =>
    useNotificationsStore().items.filter((item) => item.text.startsWith('插件开发包'));
  button.click();
  await flush();
  expect(notices()).toEqual([]);
  expect(button.disabled).toBe(false);
  button.click();
  await flush();
  expect(notices()).toMatchObject([{ text: '插件开发包保存失败：目录不可写', error: true }]);
  expect(button.disabled).toBe(false);
  button.click();
  await flush();
  expect(save).toHaveBeenCalledTimes(3);
  expect(notices().at(-1)).toMatchObject({
    text: '插件开发包已保存到 D:\\QA\\serverdeck-plugin-development-kit.zip',
    error: false,
  });
});

it('keeps the About page available before bootstrap and updates its real version state', async () => {
  await openNavigation('关于');
  const page = document.querySelector('.about-view')!;
  expect(page).not.toBeNull();
  const releaseTime = page.querySelector('time')!.textContent;
  expect(releaseTime).toBeTruthy();
  expect(page.textContent).toContain('暂不可用（本地后端未就绪）');
  expect(page.textContent).toContain('后端尚未就绪，暂无运行状态。');
  useApplicationStore().loading = true;
  await nextTick();
  expect(page.textContent).toContain('读取中…');
  expect(page.textContent).toContain('正在通过 IPC 读取本地后端状态…');
  expect(page.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  loadSidebarConfig();
  useApplicationStore().loading = false;
  await nextTick();
  expect(page.textContent).toContain('vtest');
  expect(page.textContent).not.toContain('暂不可用');
  page.querySelector<HTMLButtonElement>('button')!.click();
  expect(useApplicationStore().initialize).toHaveBeenCalledTimes(2);
  await useWorkspaceStore().closeSettings();
  await flush();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
  try {
    await openNavigation('关于');
    expect(document.querySelector('.about-view time')!.textContent).toBe(releaseTime);
  } finally {
    vi.useRealTimers();
  }
  expect(document.querySelector('dialog[aria-label="关于 ServerDeck"]')).toBeNull();
});

it('preserves settings drafts across all categories and focuses invalid hidden fields', async () => {
  loadSidebarConfig();
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  const workspace = useWorkspaceStore();
  await openNavigation('终端');
  const panel = document.querySelector('.settings-panel');
  const lineHeight = document.querySelector<HTMLInputElement>('[aria-label="终端行高"]')!;
  lineHeight.value = '99';
  lineHeight.dispatchEvent(new Event('input', { bubbles: true }));
  await openNavigation('关于');
  await openNavigation('模型');
  await openNavigation('插件管理');
  await openNavigation('数据与存储');
  expect(document.querySelector('.settings-panel')).toBe(panel);
  document
    .querySelector('form.settings-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  expect(workspace.settingsView).toBe('settingsTerminal');
  expect(document.activeElement).toBe(lineHeight);
  expect(save).not.toHaveBeenCalled();
  lineHeight.value = '120';
  lineHeight.dispatchEvent(new Event('input', { bubbles: true }));
  await openNavigation('快捷键');
  document
    .querySelector('form.settings-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  expect(save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ terminal: expect.objectContaining({ lineHeight: 120 }) }),
  );
  expect(workspace.tabs).toEqual([]);
  await workspace.closeSettings();
  await flush();
  expect(document.querySelector('.settings-panel')).toBeNull();
});

it.each([
  ['通用', 'settings', '[aria-label="侧边栏宽度"]', '300'],
  ['终端', 'settingsTerminal', '[aria-label="终端行高"]', '125'],
  ['快捷键', 'settingsShortcuts', '[aria-label="复制快捷键"]', ''],
  ['数据与存储', 'settingsStorage', '[aria-label="默认下载目录"]', 'D:\\Downloads'],
])(
  'warns before discarding failed automatic %s preferences',
  async (label, view, selector, value) => {
    loadSidebarConfig();
    const save = vi.spyOn(ipc, 'saveConfig').mockRejectedValue({ message: '保存失败' });
    const workspace = useWorkspaceStore();
    await openNavigation(label);
    const field = document.querySelector<HTMLInputElement>(selector)!;
    if (value) {
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyX', ctrlKey: true, shiftKey: true }),
      );
    }
    await flush();
    void workspace.closeSettings();
    await flush();
    const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="设置尚未保存"]')!;
    expect(dialog).not.toBeNull();
    expect(workspace.settingsView).toBe(view);
    [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '继续编辑')!
      .click();
    await flush();
    expect(document.querySelector('dialog[aria-label="设置尚未保存"]')).toBeNull();
    expect(document.querySelector<HTMLInputElement>(selector)!.value).toBe(value || 'Ctrl+Shift+X');
    const closing = workspace.closeSettings();
    await flush();
    [...document.querySelectorAll<HTMLButtonElement>('dialog button')]
      .find((button) => button.textContent?.trim() === '放弃更改并关闭')!
      .click();
    await closing;
    await flush();
    expect(workspace.tabs).toHaveLength(0);
    expect(document.querySelector('.settings-panel')).toBeNull();
    expect(save).toHaveBeenCalledTimes(2);
  },
);

it.each([
  ['通用', '[aria-label="侧边栏宽度"]', '300'],
  ['终端', '[aria-label="终端行高"]', '125'],
  ['快捷键', '[aria-label="复制快捷键"]', ''],
  ['数据与存储', '[aria-label="默认下载目录"]', 'D:\\Downloads'],
])(
  'automatically persists %s preferences and closes without a discard prompt',
  async (label, selector, value) => {
    loadSidebarConfig();
    const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
    await openNavigation(label);
    expect(document.querySelector('.form-footer [type="submit"]')).toBeNull();
    const field = document.querySelector<HTMLInputElement>(selector)!;
    if (value) {
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyX', ctrlKey: true, shiftKey: true }),
      );
    }
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(useWorkspaceStore().settingsDirty).toBe(false));
    await useWorkspaceStore().closeSettings();
    await flush();
    expect(document.querySelector('dialog[aria-label="设置尚未保存"]')).toBeNull();
    await openNavigation(label);
    expect(document.querySelector<HTMLInputElement>(selector)!.value).toBe(value || 'Ctrl+Shift+X');
  },
);

it('previews interface size across settings categories and retains only the last successful save', async () => {
  loadSidebarConfig();
  const save = vi
    .spyOn(ipc, 'saveConfig')
    .mockRejectedValueOnce({ code: 'STORAGE', message: '无法保存设置' })
    .mockImplementation(async (config) => config);
  const application = useApplicationStore();
  const workspace = useWorkspaceStore();
  const scale = () => document.documentElement.style.getPropertyValue('--interface-font-scale');
  await openNavigation('通用');
  const slider = document.querySelector<HTMLInputElement>('#interface-font-size')!;
  const choose = async (step: string) => {
    slider.value = step;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
  };

  expect(slider.getAttribute('aria-valuetext')).toBe('标准');
  await choose('4');
  expect(scale()).toBe('1.45');
  expect(save).not.toHaveBeenCalled();
  await openNavigation('关于');
  expect(scale()).toBe('1.45');
  await openNavigation('通用');
  await vi.waitFor(() => expect(application.error).toBe('无法保存设置'));
  expect(application.state?.config.interfaceFontSize).toBe('standard');
  expect(scale()).toBe('1.45');

  [...document.querySelectorAll<HTMLButtonElement>('.form-footer button')]
    .find((button) => button.textContent?.trim() === '重试')!
    .click();
  await vi.waitFor(() => expect(application.state?.config.interfaceFontSize).toBe('ultraLarge'));
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ interfaceFontSize: 'ultraLarge', terminalFontSize: 14 }),
  );
  expect(application.state?.config.interfaceFontSize).toBe('ultraLarge');
  save.mockRejectedValue({ message: '无法保存设置' });
  await choose('0');
  expect(scale()).toBe('0.95');
  const closing = workspace.closeSettings();
  await flush();
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')]
    .find((button) => button.textContent?.trim() === '放弃更改并关闭')!
    .click();
  await closing;
  await flush();
  expect(scale()).toBe('1.45');
  await openNavigation('通用');
  expect(document.querySelector('#interface-font-size')?.getAttribute('aria-valuetext')).toBe(
    '超大',
  );
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

it('opens the host tree menu without connecting and closes sessions through their tabs', async () => {
  const host = document.querySelector<HTMLButtonElement>('.tree-host')!;
  host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  expect(document.querySelector('[aria-label="主机树操作"]')).not.toBeNull();
  expect(useTerminalsStore().panes).toHaveLength(0);
  document.querySelector<HTMLButtonElement>('[aria-label="关闭主机树菜单"]')!.click();
  host.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  expect(useTerminalsStore().panes[0]?.host?.id).toBe('a');
  root
    .querySelector('.terminal-tab [role="tab"]')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  const sessionMenu = document.querySelector('[role="menu"][aria-label="终端会话操作"]')!;
  expect(sessionMenu).not.toBeNull();
  expect(useTerminalsStore().panes).toHaveLength(1);
  sessionMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick();
  await closeSession(0);
  expect(useTerminalsStore().panes).toHaveLength(0);
});

it('removes the host management page and keeps creation available in the workspace', async () => {
  expect(document.querySelector('.topbar [aria-label="当前主机上下文"]')).toBeNull();
  expect(document.querySelector('.topbar [aria-label="打开全局搜索"]')).toBeNull();
  expect(document.querySelector('.workspace-group-tab')).toBeNull();
  expect(document.querySelector('[aria-label="主机管理"]')).toBeNull();
  expect(document.querySelector('.activity-rail [aria-label="主机工作区"]')).toBeNull();
  expect(document.querySelector('.hosts-view')).toBeNull();
  root
    .querySelector<HTMLButtonElement>('[data-group-id=""] .group-toggle')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent === '新建主机')!
    .click();
  await nextTick();
  expect(document.querySelector<HTMLDialogElement>('dialog[aria-label="新建主机"]')!.open).toBe(
    true,
  );
  expect(useTerminalsStore().panes).toHaveLength(0);
});

it('removes the task center from the footer, search and legacy shortcuts without changing the terminal', async () => {
  app!.unmount();
  loadSidebarConfig();
  useApplicationStore().state!.config.product.shortcuts.tasks = 'Ctrl+Shift+U';
  vi.spyOn(useHostsStore(), 'load').mockResolvedValue();
  vi.spyOn(useBackgroundStore(), 'start').mockImplementation(() => {});
  vi.spyOn(useFilesStore(), 'poll').mockResolvedValue();
  app = createApp(AppShell).use(pinia);
  app.mount(root);
  await flush();
  document.querySelector<HTMLButtonElement>('[aria-label="本地终端"]')!.click();
  await flush();
  const original = JSON.stringify(useTerminalsStore().tabs);
  expect(document.querySelector('[aria-label="任务中心"]')).toBeNull();
  const legacy = new KeyboardEvent('keydown', {
    key: 'U',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(legacy);
  await flush();
  expect(legacy.defaultPrevented).toBe(false);
  expect(document.querySelector('dialog[aria-label="任务中心"]')).toBeNull();
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush();
  const search = document.querySelector<HTMLInputElement>('[aria-label="全局搜索内容"]')!;
  expect(search).not.toBeNull();
  for (const removed of ['任务中心', '备份恢复', '资产管理']) {
    search.value = removed;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  }
  expect(useWorkspaceStore().current?.view).toBe('terminals');
  expect(JSON.stringify(useTerminalsStore().tabs)).toBe(original);
});

it('opens model management from global search in the shared settings page without creating a tab', async () => {
  loadSidebarConfig();
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  const current = workspace.current;
  document.querySelector<HTMLButtonElement>('.app-header [aria-label="全局搜索"]')!.click();
  await flush();
  const search = document.querySelector<HTMLInputElement>('[aria-label="全局搜索内容"]')!;
  search.value = '模型';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  document.querySelector<HTMLButtonElement>('[role="option"]')!.click();
  await flush();
  expect(workspace.settingsView).toBe('models');
  expect(workspace.current).toBe(current);
  expect(workspace.tabs).toHaveLength(1);
  expect(
    document
      .querySelector('.settings-navigation [aria-current="page"]')
      ?.getAttribute('aria-label'),
  ).toBe('模型');
});

it('confirms active transfer cancellation before closing a host and preserves the adjacent host', async () => {
  const workspace = useWorkspaceStore(),
    files = useFilesStore(),
    terminals = useTerminalsStore();
  const hosts = useHostsStore().catalog!.hosts;
  for (const host of hosts) {
    terminals.open(host);
    terminals.update(terminals.focused, { sessionId: `shell-${host.id}`, state: 'connected' });
    workspace.navigate('terminals', host.id);
  }
  workspace.selectHost('a');
  let nativeTasks = ['a', 'b'].map((hostId) => ({
    id: `task-${hostId}`,
    hostId,
    sessionId: `files-${hostId}`,
    direction: 'upload',
    state: 'running',
    sources: ['source.txt'],
    destination: '/srv',
    totalBytes: 100,
    transferredBytes: 0,
    remainingBytes: 100,
    bytesPerSecond: 0,
    filesTotal: 1,
    filesDone: 0,
    skipped: 0,
    message: null,
    recoveryPaths: [],
  })) as TransferInfo[];
  vi.spyOn(filesApi, 'tasks').mockImplementation(async () => nativeTasks);
  vi.spyOn(filesApi, 'connections').mockResolvedValue(
    hosts.map((host) => ({ id: `files-${host.id}`, hostId: host.id })) as never,
  );
  const closeFiles = vi.spyOn(filesApi, 'close').mockImplementation(async () => {
    nativeTasks = nativeTasks.map((task) =>
      task.hostId === 'a' ? { ...task, state: 'cancelled' } : task,
    );
  });
  const closeTerminal = vi.spyOn(terminalApi, 'close').mockResolvedValue();
  const clear = vi.spyOn(filesApi, 'clearTransfers').mockImplementation(async (hostId) => {
    nativeTasks = nativeTasks.filter((task) => task.hostId !== hostId);
  });
  await flush();
  document.querySelector<HTMLButtonElement>('.workspace-tab[data-host-id="a"] .tab-close')!.click();
  await flush();
  const dialog = () =>
    document.querySelector<HTMLDialogElement>('dialog[aria-label="取消传输并关闭主机"]');
  expect(dialog()?.textContent).toContain('1 个未完成');
  expect(closeFiles).not.toHaveBeenCalled();
  expect(closeTerminal).not.toHaveBeenCalled();
  [...dialog()!.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '取消')!
    .click();
  await flush();
  expect(workspace.current?.hostId).toBe('a');
  expect(files.tasks).toHaveLength(2);
  document.querySelector<HTMLButtonElement>('.workspace-tab[data-host-id="a"] .tab-close')!.click();
  await flush();
  [...dialog()!.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '明确确认')!
    .click();
  await flush();
  expect(dialog()).toBeNull();
  expect(workspace.tabs.map((tab) => tab.hostId)).toEqual(['b']);
  expect(terminals.hostTabs('b')).toHaveLength(1);
  expect(closeFiles).toHaveBeenCalledExactlyOnceWith('files-a', true);
  expect(closeTerminal).toHaveBeenCalledExactlyOnceWith('shell-a');
  expect(clear).toHaveBeenCalledExactlyOnceWith('a');
  expect(files.tasks.map((task) => task.hostId)).toEqual(['b']);
  workspace.selectHost('a');
  await flush();
  expect(files.tasks.filter((task) => task.hostId === 'a')).toEqual([]);
});

it('keeps all three columns and preserves the host tree and search across navigation', async () => {
  const workspace = useWorkspaceStore();
  const tree = document.querySelector('.host-tree-section');
  const sidebar = document.querySelector('.sidebar');
  const rail = document.querySelector('.activity-rail');
  useHostsStore().search = 'Host a';
  await nextTick();
  expect(
    document.querySelector('[aria-label="收起主机栏"], [aria-label="展开主机列表"]'),
  ).toBeNull();
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="本地终端"]')!.click();
  await flush();
  expect(workspace.area).toBe('local');
  expect(document.querySelector('.sidebar')).toBe(sidebar);
  expect(document.querySelector('.activity-rail')).toBe(rail);
  expect(document.querySelector('.local-session-sidebar .terminal-tabs')).not.toBeNull();
  await openNavigation('关于');
  expect(workspace.area).toBe('settings');
  expect(document.querySelector('dialog[aria-label="设置"]')).toBeNull();
  expect(document.querySelector<HTMLElement>('.settings-sidebar')!.style.display).not.toBe('none');
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="首页"]')!.click();
  await flush();
  expect(workspace.area).toBe('home');
  expect(document.querySelector('.workspace-tab[data-host-id=""]')).toBeNull();
  expect(document.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
  expect(document.querySelector('.host-tree-section')).toBe(tree);
  expect(document.querySelector<HTMLElement>('.host-tree-section')!.style.display).not.toBe('none');
  expect(useHostsStore().search).toBe('Host a');
  expect(document.querySelector('.sidebar')).toBe(sidebar);
});

it('retains remote and local sessions and settings drafts while switching the fixed rail', async () => {
  loadSidebarConfig();
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  document
    .querySelector('.tree-host')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  const remote = terminals.panes[0]!;
  const close = vi.spyOn(terminalApi, 'close');
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="本地终端"]')!.click();
  await flush();
  const local = terminals.panes.find((pane) => !pane.host)!;
  await openNavigation('通用');
  const field = document.querySelector<HTMLInputElement>('[aria-label="侧边栏宽度"]')!;
  field.value = '300';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  expect(workspace.settingsDirty).toBe(true);
  const settingsPage = document.querySelector('.settings-page');
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="首页"]')!.click();
  await flush();
  expect(workspace.current?.hostId).toBe(remote.host?.id);
  expect(document.querySelector('.workspace-tab[data-host-id=""]')).toBeNull();
  expect(
    [...document.querySelectorAll('.workspace-tabs [role="tab"]')].map((tab) =>
      tab.textContent?.trim(),
    ),
  ).toEqual(['首页', 'Host a']);
  expect(terminals.focused).toBe(remote.key);
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="本地终端"]')!.click();
  await flush();
  expect(terminals.focused).toBe(local.key);
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="设置"]')!.click();
  await flush();
  expect(document.querySelector('.settings-page')).toBe(settingsPage);
  expect(field.value).toBe('300');
  expect(document.querySelector('dialog[aria-label="设置尚未保存"]')).toBeNull();
  expect(terminals.panes).toContain(remote);
  expect(terminals.panes).toContain(local);
  expect(close).not.toHaveBeenCalled();
});

it('supports vertical keyboard selection in the local session list', async () => {
  const terminals = useTerminalsStore();
  for (let index = 0; index < 3; index++) terminals.open(null);
  useWorkspaceStore().navigate('terminals', '');
  await flush();
  const list = document.querySelector('.local-session-sidebar [role="tablist"]')!;
  expect(list.getAttribute('aria-orientation')).toBe('vertical');
  const buttons = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  buttons[0]!.focus();
  buttons[0]!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
  );
  await flush();
  expect(terminals.active).toBe(terminals.hostTabs('')[1]?.key);
  expect(document.activeElement).toBe(buttons[1]);
  buttons[1]!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
  );
  await flush();
  expect(terminals.active).toBe(terminals.hostTabs('')[2]?.key);
  expect(document.activeElement).toBe(buttons[2]);
  buttons[2]!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }),
  );
  await flush();
  expect(terminals.active).toBe(terminals.hostTabs('')[0]?.key);
  expect(document.activeElement).toBe(buttons[0]);
});

it('protects a hidden settings draft before confirming application exit', async () => {
  loadSidebarConfig();
  await openNavigation('通用');
  const field = document.querySelector<HTMLInputElement>('[aria-label="侧边栏宽度"]')!;
  field.value = '300';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="首页"]')!.click();
  await flush();
  const exit = vi.spyOn(filesApi, 'exit').mockResolvedValue();
  useFilesStore().exitReview = true;
  await flush();
  const confirm = document.querySelector<HTMLButtonElement>(
    'dialog[aria-label="确认退出 ServerDeck"] button.danger',
  )!;
  confirm.click();
  await flush();
  const prompt = () =>
    document.querySelector<HTMLDialogElement>('dialog[aria-label="设置尚未保存"]')!;
  expect(prompt()).not.toBeNull();
  expect(exit).not.toHaveBeenCalled();
  [...prompt().querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '继续编辑')!
    .click();
  await flush();
  expect(field.value).toBe('300');
  expect(exit).not.toHaveBeenCalled();
  confirm.click();
  await flush();
  [...prompt().querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '放弃更改并关闭')!
    .click();
  await flush();
  expect(exit).toHaveBeenCalledExactlyOnceWith(true);
});

it('keeps the root folder count and search without a duplicate heading count or JSON controls', () => {
  const heading = document.querySelector('.host-list-heading')!;
  expect(heading.textContent).toContain('主机');
  expect(heading.querySelector('.host-list-title')?.textContent?.trim()).toBe('主机');
  expect(heading.querySelector('.host-count')).toBeNull();
  expect(document.querySelector('[data-group-id=""] .group-count')?.textContent?.trim()).toBe('2');
  expect(heading.querySelectorAll('button')).toHaveLength(0);
  expect(document.querySelector('[aria-label="选择 ServerDeck 主机文件"]')).toBeNull();
  expect(heading.nextElementSibling?.querySelector('[aria-label="搜索主机"]')).not.toBeNull();
});

it('uses the right-clicked folder when creating a host without a group selector', async () => {
  const store = useHostsStore();
  store.catalog!.groups = [
    { id: 'parent', name: '生产', sortOrder: 0, parentId: null },
    { id: 'child', name: '上海', sortOrder: 0, parentId: 'parent' },
  ];
  await flush();
  root
    .querySelector('[data-group-id="child"] > .group-toggle')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await flush();
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.trim() === '新建主机')!
    .click();
  await flush();
  const dialog = document.querySelector('dialog[aria-label="新建主机"]')!;
  expect(dialog.querySelector('[aria-label="分组"]')).toBeNull();
  const fields = dialog.querySelectorAll<HTMLInputElement>('form .form-grid > label input');
  for (const [index, value] of [
    [1, 'server.example'],
    [3, 'ops'],
    [5, 'fixture-password'],
  ] as const) {
    fields[index]!.value = value;
    fields[index]!.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const create = vi.spyOn(hostsApi, 'create').mockImplementation(async (input) => ({
    ...input,
    id: 'created',
    createdAt: '',
    updatedAt: '',
  }));
  vi.spyOn(hostsApi, 'list').mockImplementation(async () => ({
    ...store.catalog!,
    hosts: [await create.mock.results[0]!.value],
  }));
  vi.spyOn(hostsApi, 'test').mockResolvedValue({
    status: 'connected',
    testId: 'fixture-test',
    expiresInSeconds: 300,
  });
  [...dialog.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '测试连接')!
    .click();
  await vi.waitFor(() =>
    expect(dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false),
  );
  dialog
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'child', hostname: 'server.example', username: 'ops' }),
      { kind: 'password', password: 'fixture-password' },
      'fixture-test',
    ),
  );
  await vi.waitFor(() =>
    expect(document.querySelector('dialog[aria-label="新建主机"]')).toBeNull(),
  );
  expect(document.querySelector('[data-group-id="child"] [data-host-id="created"]')).not.toBeNull();
  expect(useTerminalsStore().panes).toHaveLength(0);
});

it('selects administrator mode from the session plus menu without replacing ordinary sessions', async () => {
  const store = useTerminalsStore(),
    workspace = useWorkspaceStore();
  document.querySelector<HTMLButtonElement>('[aria-label="本地终端"]')!.click();
  await flush();
  const ordinary = store.panes[0]!;
  expect(document.querySelector('.sidebar [aria-label="本地终端（管理员）"]')).toBeNull();
  document.querySelector<HTMLButtonElement>('[aria-label="新建终端会话"]')!.click();
  await flush();
  expect(store.hostTabs('')).toHaveLength(1);
  const menu = document.querySelector('[role="menu"][aria-label="新建终端会话"]')!;
  [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((item) => item.textContent?.trim() === '以管理员身份运行')!
    .click();
  await flush();
  expect(workspace.current?.hostId).toBe('');
  expect(workspace.current?.view).toBe('terminals');
  expect(store.hostTabs('')).toHaveLength(2);
  expect(store.panes[0]).toBe(ordinary);
  expect(ordinary.elevated).toBe(false);
  expect(store.panes[1]?.elevated).toBe(true);
  expect(store.focused).toBe(store.panes[1]?.key);
});

it.each([null, '', 'a'])(
  'opens or reuses the local terminal from the fixed rail in context "%s"',
  async (hostId) => {
    const workspace = useWorkspaceStore();
    if (hostId !== null) workspace.navigate('terminals', hostId);
    await flush();
    const section = document.querySelector('.host-tree-section')!;
    const local = document.querySelector<HTMLButtonElement>(
      '.sidebar-work-actions > [aria-label="本地终端"]',
    )!;
    expect(local.closest('.sidebar-work-actions')).not.toBeNull();
    expect(local.closest('.activity-rail')).not.toBeNull();
    expect(document.querySelector('.activity-rail')?.contains(section)).toBe(false);
    expect(
      local
        .closest('.sidebar-work-actions')
        ?.nextElementSibling?.classList.contains('sidebar-app-actions'),
    ).toBe(true);
    expect(local.querySelector('svg')).not.toBeNull();
    expect(local.getAttribute('aria-label')).toBe('本地终端');
    expect(section.querySelector('.sidebar-local-device')).toBeNull();
    const hosts = useHostsStore();
    hosts.search = 'no matching host';
    await flush();
    expect(document.querySelectorAll('.tree-host')).toHaveLength(0);
    local.click();
    await flush();
    expect(workspace.current?.hostId).toBe('');
    if (hostId === '') {
      expect(useTerminalsStore().panes).toHaveLength(0);
      await newSession();
    }
    expect(useTerminalsStore().panes.at(-1)?.host).toBeNull();
    expect(local.getAttribute('aria-current')).toBe('page');
    local.click();
    await flush();
    expect(useTerminalsStore().hostTabs('')).toHaveLength(1);
    if (hostId) {
      await workspace.close(`host:${hostId}`);
      await flush();
    }
    expect(document.querySelector('.workspace-tab[data-host-id=""]')).toBeNull();
    expect(document.querySelector('.local-session-sidebar .terminal-tab')).not.toBeNull();
    await workspace.close('host:');
    await flush();
    expect(document.querySelector('.workspace-group-tab')).toBeNull();
    expect(document.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
  },
);

it('keeps welcome and avoids opening connections when settings are opened from the sidebar', async () => {
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  const open = vi.spyOn(terminals, 'open');
  document.querySelector<HTMLButtonElement>('.sidebar-app-actions [aria-label="设置"]')!.click();
  await flush();
  expect(workspace.settingsView).toBe('settings');
  expect(workspace.tabs).toEqual([]);
  expect(document.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
  await workspace.closeSettings();
  await flush();
  expect(open).not.toHaveBeenCalled();
});

it('keeps host and plugin function tabs in one row while settings preserve the active terminal', async () => {
  document
    .querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  const pane = terminals.panes[0]!;
  Object.assign(pane, {
    state: 'connected',
    sessionId: 'existing-session',
    connectRequested: false,
  });
  const open = vi.spyOn(terminals, 'open'),
    close = vi.spyOn(terminalApi, 'close');
  void workspace.openPlugin('cn.hiboot.plugins.assistant', 'assistant', '');
  await flush();
  document
    .querySelector<HTMLButtonElement>('.workspace-tab[data-host-id="a"] [role="tab"]')!
    .click();
  await flush();
  const terminalElement = document.querySelector('.terminal-tab');
  await openNavigation('通用');
  await openNavigation('关于');
  await workspace.closeSettings();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: 'a' });
  expect(document.querySelector('.terminal-tab')).toBe(terminalElement);
  expect(document.querySelectorAll('.workspace-tabs')).toHaveLength(1);
  expect(document.querySelectorAll('.workspace-tabs .workspace-tab')).toHaveLength(2);
  expect(document.querySelector('.workspace-group-tab')).toBeNull();
  expect(pane).toMatchObject({
    sessionId: 'existing-session',
    state: 'connected',
    connectRequested: false,
  });
  expect(open).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it('switches full file pages from the toolbar without closing file or terminal sessions', async () => {
  const files = useFilesStore(),
    workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  files.local = { path: 'D:/test', parent: null, entries: [] };
  for (const host of useHostsStore().catalog!.hosts) {
    files.connections[host.id] = {
      host,
      id: `sftp-${host.id}`,
      state: 'connected',
      error: null,
      trust: null,
      path: `/srv/${host.id}`,
      listing: { path: `/srv/${host.id}`, parent: '/srv', entries: [] },
      loading: false,
    };
  }
  const closeFiles = vi.spyOn(filesApi, 'close'),
    closeTerminal = vi.spyOn(terminalApi, 'close');
  document
    .querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  const pane = terminals.panes[0]!;
  pane.state = 'connected';
  pane.sessionId = 'ssh-a';
  const tool = async (label: string) => {
    document.querySelector<HTMLButtonElement>(`.workspace-header [aria-label="${label}"]`)!.click();
    await flush();
  };
  expect(document.querySelector('.sidebar [aria-label="当前主机工具"]')).toBeNull();
  expect(document.querySelector('[aria-controls="workspace-file-panel"]')).toBeNull();
  await tool('SFTP 文件');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'a' });
  expect(document.querySelectorAll('.files-view')).toHaveLength(1);
  expect(document.querySelector('[aria-label="本地路径"]')).not.toBeNull();
  expect(document.querySelector<HTMLInputElement>('[aria-label="远程路径"]')?.value).toBe('/srv/a');
  expect(document.querySelector('.workspace-header [aria-current="page"]')?.textContent).toContain(
    'SFTP 文件',
  );
  const plugin = { ...systemPluginFixtures()[0]!, enabled: true };
  usePluginsStore().installed = [plugin];
  await flush();
  root
    .querySelector<HTMLButtonElement>(`.host-tools [data-plugin-id="${plugin.manifest.id}"]`)!
    .click();
  await flush();
  expect(workspace.current).toMatchObject({
    view: 'extension',
    hostId: 'a',
    pluginId: plugin.manifest.id,
  });
  expect(
    document.querySelector('.host-tools [aria-current="page"]')?.getAttribute('data-plugin-id'),
  ).toBe(plugin.manifest.id);
  expect(document.querySelector('.workspace-header [aria-haspopup="menu"]')).toBeNull();
  expect(document.querySelector('[aria-label="插件设置"]')).not.toBeNull();
  expect(document.querySelector('.operations-view, .monitor-view')).toBeNull();
  await tool('SSH 终端');
  expect(document.querySelector('.files-view, .workspace-file-panel')).toBeNull();
  expect(terminals.focused).toBe(pane.key);
  expect(pane.sessionId).toBe('ssh-a');
  document
    .querySelector<HTMLButtonElement>('.tree-host[data-host-id="b"]')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  await tool('SFTP 文件');
  expect(files.active).toBe('b');
  expect(document.querySelector<HTMLInputElement>('[aria-label="远程路径"]')?.value).toBe('/srv/b');
  document
    .querySelector<HTMLButtonElement>('.workspace-tab[data-host-id="a"] [role="tab"]')!
    .click();
  await flush();
  await tool('SFTP 文件');
  expect(files.active).toBe('a');
  expect(document.querySelector<HTMLInputElement>('[aria-label="远程路径"]')?.value).toBe('/srv/a');
  expect(files.connections.a?.id).toBe('sftp-a');
  expect(files.connections.b?.id).toBe('sftp-b');
  expect(closeFiles).not.toHaveBeenCalled();
  expect(closeTerminal).not.toHaveBeenCalled();
  workspace.navigate('settings');
  await flush();
  expect(document.querySelector('.workspace-header .host-tools')).not.toBeNull();
  await workspace.closeSettings();
  workspace.navigate('terminals', '');
  await flush();
  expect(document.querySelector('.workspace-header .host-tools')).toBeNull();
  expect(document.querySelector('[aria-controls="workspace-file-panel"]')).toBeNull();
});

it.each(['a', 'b'])(
  'opens context actions without changing the active session (%s)',
  async (id) => {
    const hosts = useHostsStore(),
      terminals = useTerminalsStore(),
      workspace = useWorkspaceStore();
    document
      .querySelector<HTMLButtonElement>('.tree-host')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    const active = workspace.active,
      focused = terminals.focused,
      selected = hosts.selectedId;
    const panes = terminals.panes.map((pane) => pane.key);
    const update = vi.spyOn(hostsApi, 'update'),
      copy = vi.spyOn(hostsApi, 'copy'),
      remove = vi.spyOn(hostsApi, 'remove');
    const host = document.querySelector('.tree-host[data-host-id="' + id + '"]')!;
    for (const target of [host, ...host.querySelectorAll('span')]) {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      await nextTick();
      expect(event.defaultPrevented).toBe(true);
      expect(document.querySelector('[aria-label="主机树操作"]')).not.toBeNull();
      document.querySelector<HTMLButtonElement>('[aria-label="关闭主机树菜单"]')!.click();
      await nextTick();
      expect(document.querySelector('[aria-label="主机树操作"]')).toBeNull();
    }
    expect(document.querySelector('.tree-host-more, [aria-label^="主机操作 "]')).toBeNull();
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

it('opens SSH on a double sidebar host click and reuses the existing terminal', async () => {
  const selector = '.tree-host';
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  const host = document.querySelector<HTMLButtonElement>(selector)!;
  const before = workspace.active;
  host.click();
  await flush();
  expect(workspace.active).toBe(before);
  expect(terminals.panes).toHaveLength(0);
  host.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: 'a' });
  expect(terminals.panes).toHaveLength(1);
  expect(terminals.panes[0]).toMatchObject({ host: { id: 'a' }, connectRequested: true });
  const key = terminals.active;
  workspace.navigate('settings');
  await nextTick();
  document.querySelector<HTMLButtonElement>(selector)!.click();
  root
    .querySelector<HTMLButtonElement>('.tree-host')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  expect(workspace.current?.view).toBe('terminals');
  expect(terminals.tabs).toHaveLength(1);
  expect(terminals.active).toBe(key);
  document
    .querySelectorAll<HTMLButtonElement>('.tree-host')[1]!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  expect(workspace.current?.hostId).toBe('b');
  expect(terminals.tabs).toHaveLength(2);
  document
    .querySelector<HTMLButtonElement>('.tree-host')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  expect(terminals.active).toBe(key);
  expect(terminals.tabs).toHaveLength(2);
});

it.each([false, true])(
  'connects only the selected idle pane on a host double-click (existing workspace=%s)',
  async (existing) => {
    const terminals = useTerminalsStore(),
      workspace = useWorkspaceStore();
    const hosts = useHostsStore().catalog!.hosts;
    terminals.open(hosts[0]!);
    terminals.split(terminals.focused, 'rows');
    terminals.open(hosts[1]!);
    for (const pane of terminals.panes)
      terminals.update(pane.key, { state: 'idle', connectRequested: false });
    if (existing) workspace.navigate('terminals', 'a');
    await flush();
    expect(terminals.panes.every((pane) => pane.state === 'idle' && !pane.connectRequested)).toBe(
      true,
    );
    const keys = terminals.panes.map((pane) => pane.key);
    const click = () =>
      document
        .querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
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
  document
    .querySelector<HTMLButtonElement>('.workspace-tab[data-host-id="a"] [role="tab"]')!
    .click();
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
    document
      .querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
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
  await workspace.closeSettings();
  await flush();
  expect(terminals.panes).toHaveLength(1);
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: 'a' });
  document
    .querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  expect(terminals.panes).toHaveLength(2);
  expect(terminals.panes.find((pane) => pane.key === terminals.focused)).toMatchObject({
    host: { id: 'a' },
    connectRequested: true,
  });
});

it('middle-click closes host sessions while closing global pages leaves them running', async () => {
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  void workspace.openPlugin('cn.hiboot.plugins.assistant', 'assistant', '');
  terminals.open(useHostsStore().catalog!.hosts[0]!);
  workspace.navigate('terminals', 'a');
  await flush();
  const inactive = document.querySelector('.workspace-tab:not(.active) button')!;
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
  expect(document.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
  expect(terminals.tabs).toHaveLength(0);
});

it.each(['button', 'middle', 'menu'])(
  'closes local sessions and splits through the session %s action and restarts numbering at one',
  async (action) => {
    const terminals = useTerminalsStore(),
      workspace = useWorkspaceStore();
    const close = vi.spyOn(terminalApi, 'close').mockResolvedValue();
    const host = useHostsStore().catalog!.hosts[0]!;
    terminals.open(host);
    const other = terminals.tabs[0]!;
    terminals.update(terminals.focused, { sessionId: 'other-session' });
    workspace.navigate('terminals', host.id);
    for (let i = 0; i < 3; i++) terminals.open(null);
    terminals.split(terminals.focused, 'columns');
    const localPanes = terminals.panes.filter((pane) => !pane.host);
    for (const pane of localPanes)
      terminals.update(pane.key, { sessionId: pane.key, state: 'connected' });
    workspace.navigate('terminals', '');
    await flush();
    const tabs = [...document.querySelectorAll('.local-session-sidebar .terminal-tab')];
    if (action === 'menu') {
      tabs[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await nextTick();
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((button) => button.textContent?.trim() === '关闭所有')!
        .click();
    } else {
      for (const tab of tabs) {
        if (action === 'button')
          tab.querySelector<HTMLButtonElement>('[aria-label^="关闭标签 "]')!.click();
        else tab.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
        await flush();
      }
    }
    await flush();
    expect(terminals.hostTabs('')).toHaveLength(0);
    expect(workspace.area).toBe('local');
    expect(document.querySelector('.local-session-empty')?.textContent).toContain('没有打开的终端');
    expect(close.mock.calls.map(([id]) => id).sort()).toEqual(
      localPanes.map((pane) => pane.key).sort(),
    );
    expect(terminals.hostTabs(host.id)).toEqual([other]);
    document.querySelector<HTMLButtonElement>('[aria-label="本地终端"]')!.click();
    await flush();
    expect(terminals.hostTabs('')).toHaveLength(0);
    await newSession();
    expect(terminals.hostTabs('')[0]?.sessionNumber).toBe(1);
    expect(document.querySelector('.terminal-tab [role="tab"]')?.textContent).toContain('会话 1');
  },
);

it('keeps an empty local session list after the last close and opens a replacement only on explicit creation', async () => {
  const terminals = useTerminalsStore(),
    workspace = useWorkspaceStore();
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="本地终端"]')!.click();
  await flush();
  document
    .querySelector<HTMLButtonElement>('.terminal-tab [aria-label="关闭标签 会话 1"]')!
    .click();
  await flush();
  expect(terminals.panes).toHaveLength(0);
  expect(workspace.area).toBe('local');
  expect(document.querySelector('.local-session-empty')?.textContent).toContain('没有打开的终端');
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="本地终端"]')!.click();
  await flush();
  expect(terminals.panes).toHaveLength(0);
  await newSession();
  expect(terminals.panes).toHaveLength(1);
  expect(terminals.panes[0]!.host).toBeNull();
  expect(terminals.hostTabs('')[0]?.sessionNumber).toBe(1);
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
  const inactive = document.querySelector('.terminal-tab button')!;
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
  expect(document.querySelector('.terminal-tab')).toBeNull();
});

it('lets the user dismiss exit review and disables its controls during confirmed exit', async () => {
  let finishExit: (() => void) | undefined;
  const exit = vi.spyOn(filesApi, 'exit').mockImplementation(
    () =>
      new Promise((resolve) => {
        finishExit = resolve;
      }),
  );
  const files = useFilesStore();
  const openReview = async () => {
    files.exitReview = true;
    await nextTick();
    return document.querySelector<HTMLDialogElement>('dialog[aria-label="确认退出 ServerDeck"]')!;
  };
  const dismiss = (dialog: HTMLDialogElement) =>
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  let review = await openReview();
  expect(review.querySelector('h2[autofocus]')?.getAttribute('tabindex')).toBe('-1');
  expect([...review.querySelectorAll('li strong')].map((item) => item.textContent)).toEqual([
    '连接与会话',
    '未完成的任务',
    '未保存的修改',
  ]);
  expect(
    [...review.querySelectorAll('footer button')].map((button) => button.textContent?.trim()),
  ).toEqual(['确认']);
  review.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  await nextTick();
  expect(files.exitReview).toBe(false);
  review = await openReview();
  dismiss(review);
  await nextTick();
  expect(files.exitReview).toBe(false);
  expect(exit).not.toHaveBeenCalled();
  review = await openReview();
  review.querySelector<HTMLButtonElement>('button.danger')!.click();
  await nextTick();
  expect(exit).toHaveBeenCalledExactlyOnceWith(true);
  expect([...review.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
  dismiss(review);
  expect(files.exitReview).toBe(true);
  finishExit?.();
  await nextTick();
});

it('opens settings with its global shortcut without changing the workspace', async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
  useWorkspaceStore().navigate('settings');
  await flush();
  expect(useWorkspaceStore().settingsView).toBe('settings');
  expect(document.querySelector('.topbar')).toBeNull();
});

it('opens a fresh local terminal from welcome after the remote workspace and its sessions close', async () => {
  expect(document.querySelector('[aria-label="打开本地工作区"]')).toBeNull();
  document
    .querySelector<HTMLButtonElement>('.tree-host')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  expect(document.querySelector('[aria-label="打开本地工作区"]')).toBeNull();
  useWorkspaceStore().close(useWorkspaceStore().active, 'all');
  await flush();
  document
    .querySelector<HTMLButtonElement>('[aria-label="欢迎页面"] .welcome-card .button')!
    .click();
  await flush();
  expect(useWorkspaceStore().current).toMatchObject({ view: 'terminals', hostId: '' });
  const terminals = useTerminalsStore();
  expect(terminals.panes.find((p) => p.key === terminals.focused)?.host).toBeNull();
  expect(terminals.panes.some((p) => p.host?.id === 'a')).toBe(false);
  expect(document.querySelector('.workspace-tab[data-host-id=""]')).toBeNull();
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="本地终端"]')!.click();
  await flush();
  expect(terminals.panes.filter((p) => p.host === null)).toHaveLength(1);
});

it('places session controls below the host toolbar and retains names within the current run', async () => {
  const terminals = useTerminalsStore();
  const host = useHostsStore().catalog!.hosts[0]!;
  terminals.open(host);
  useWorkspaceStore().navigate('terminals', host.id);
  await flush();
  expect(terminals.panes[0]).toMatchObject({ state: 'opening', connectRequested: true });
  expect(root.textContent).not.toContain('已恢复布局');
  expect(document.querySelector('.workspace-header .host-tools')).not.toBeNull();
  expect(document.querySelector('.sidebar [aria-label="当前主机工具"]')).toBeNull();
  expect(document.querySelector('.workspace-header .workspace-context')).toBeNull();
  expect(
    [...document.querySelectorAll('.workspace-header .host-tools button')].map((button) =>
      button.textContent?.trim(),
    ),
  ).toEqual(['SSH 终端', 'SFTP 文件', 'AI 运维助手', 'Docker 管理']);
  expect(document.querySelector('.terminal-session-header .terminal-tabs')).not.toBeNull();
  expect(document.querySelector('.split-toolbar, [aria-label="会话操作"]')).toBeNull();
  expect(document.querySelector('#terminal-session-tools .terminal-session-header')).not.toBeNull();
  expect(document.querySelectorAll('.terminal-session-header button')).toHaveLength(3);
  expect(document.querySelector('.terminal-tabs + [aria-label="新建终端会话"]')).not.toBeNull();
  await newSession();
  expect(terminals.tabs).toHaveLength(2);
  const current = terminals.active;
  terminals.open(host);
  await flush();
  await closeSession(2);
  await closeSession(0);
  expect(terminals.tabs).toHaveLength(1);
  expect(terminals.tabs[0]!.key).toBe(current);
  document.querySelector('.terminal-tab [role="tab"]')!.dispatchEvent(new MouseEvent('dblclick'));
  await flush();
  const dialog = document.querySelector('dialog[aria-label="重命名标签"]')!;
  const input = dialog.querySelector<HTMLInputElement>('input')!;
  input.value = '新会话';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  expect(terminals.tabs[0]!.title).toBe('新会话');
  expect(document.querySelector('dialog[aria-label="重命名标签"]')).toBeNull();
  expect(document.querySelector('.terminal-tab [role="tab"]')?.textContent).toContain('新会话');
});

it.each(['remote', 'local'])(
  'keeps %s session numbers stable after closing, reordering and reopening tabs',
  async (kind) => {
    const terminals = useTerminalsStore();
    const host = kind === 'remote' ? useHostsStore().catalog!.hosts[0]! : null;
    for (let index = 0; index < 3; index++) terminals.open(host);
    useWorkspaceStore().navigate('terminals', host?.id ?? '');
    await flush();
    const names = () =>
      [...document.querySelectorAll('.terminal-tab [role="tab"]')].map((button) =>
        button.querySelector('.terminal-session-title')?.textContent?.trim(),
      );
    expect(names()).toEqual(['会话 1', '会话 2', '会话 3']);
    document.querySelector<HTMLButtonElement>('[aria-label="关闭标签 会话 2"]')!.click();
    await flush();
    expect(names()).toEqual(['会话 1', '会话 3']);
    await newSession();
    expect(names()).toEqual(['会话 1', '会话 3', '会话 4']);
    terminals.reorder(terminals.tabs[2]!.key, terminals.tabs[0]!.key);
    await flush();
    expect(names()).toEqual(['会话 4', '会话 1', '会话 3']);
    terminals.rename(terminals.tabs[0]!.key, '部署');
    await flush();
    expect(names()).toEqual(['部署', '会话 1', '会话 3']);
    await newSession();
    expect(names()).toEqual(['部署', '会话 1', '会话 3', '会话 5']);
    for (let count = names().length; count > 0; count--) await closeSession(0);
    root
      .querySelector<HTMLButtonElement>(
        host ? `.tree-host[data-host-id="${host.id}"]` : '[aria-label="本地终端"]',
      )!
      .dispatchEvent(new MouseEvent(host ? 'dblclick' : 'click', { bubbles: true }));
    await flush();
    if (!host) await newSession();
    expect(names()).toEqual(['会话 1']);
  },
);

it.each(['remote', 'local'])(
  'opens a session menu without selecting its target and creates a fresh single-pane %s session from plus',
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
    const menu = document.querySelector('[role="menu"][aria-label="终端会话操作"]')!;
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(
      ['复制', '重命名', '重新连接', '断开连接', '关闭所有', '关闭'],
    );
    expect(JSON.stringify(terminals.tabs)).toBe(original);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    await newSession();
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
    expect(document.querySelector('[role="menu"]')).toBeNull();
  },
);

it.each(['remote', 'local'])(
  'closes %s session tabs through their close buttons without affecting other hosts',
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
    const targetPaneIds = target!.panes.map((pane) => pane.key).sort();
    terminals.select(selected!.key);
    for (const pane of terminals.panes.slice(1))
      terminals.update(pane.key, { sessionId: pane.key });
    useWorkspaceStore().navigate('terminals', host?.id ?? '');
    await flush();
    await closeSession(1);
    expect(terminals.tabs.map((tab) => tab.key)).toEqual([other.key, first!.key, selected!.key]);
    expect(terminals.active).toBe(selected!.key);
    expect(terminals.focused).toBe(selected!.panes[0]!.key);
    expect(close.mock.calls.flat().sort()).toEqual(targetPaneIds);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    terminals.open(host);
    const added = terminals.tabs[3]!;
    terminals.update(added.panes[0]!.key, { sessionId: added.panes[0]!.key });
    await flush();
    expect(terminals.active).toBe(added.key);
    for (let count = 0; count < 3; count++) await closeSession(0);
    expect(terminals.tabs.map((tab) => tab.key)).toEqual([other.key]);
    expect(terminals.active).toBe('');
    expect(terminals.focused).toBe('');
    expect(close).toHaveBeenCalledTimes(5);
    expect(close).not.toHaveBeenCalledWith('other-host-session');
    expect(document.querySelector('.workspace-empty')?.textContent).toContain('没有打开的终端');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  },
);

it('reports the terminal limit from the plus button and keeps the existing sessions selected', async () => {
  const terminals = useTerminalsStore();
  const host = useHostsStore().catalog!.hosts[0]!;
  for (let index = 0; index < 32; index++) terminals.open(host);
  const original = JSON.stringify(terminals.tabs),
    active = terminals.active,
    focused = terminals.focused;
  useWorkspaceStore().navigate('terminals', host.id);
  await flush();
  await newSession();
  expect(terminals.tabs).toHaveLength(32);
  expect(JSON.stringify(terminals.tabs)).toBe(original);
  expect(terminals.active).toBe(active);
  expect(terminals.focused).toBe(focused);
  expect(document.querySelector('.toast[role="alert"]')?.textContent).toContain(
    '最多打开 32 个终端窗格',
  );
  expect(root.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[role="menu"]')).toBeNull();
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
  document
    .querySelector<HTMLButtonElement>('.tree-host')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  await newSession();
  const lastSession = terminals.active;
  const selectHost = async (id: string) => {
    const name = id ? `Host ${id}` : '本地终端';
    [...document.querySelectorAll<HTMLButtonElement>('.workspace-tabs [role="tab"]')]
      .find((button) => button.textContent?.trim() === name)!
      .click();
    await flush();
  };
  document
    .querySelectorAll<HTMLButtonElement>('.tree-host')[1]!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  await selectHost('b');
  expect(document.querySelectorAll('.terminal-tab')).toHaveLength(1);
  expect(workspace.tabs).toHaveLength(2);
  document.querySelector<HTMLButtonElement>('.host-tools [aria-label="SFTP 文件"]')!.click();
  await flush();
  expect(files.current?.id).toBe('files-b');
  expect(document.querySelector('[aria-label="文件管理主机"]')).toBeNull();
  expect(document.querySelector('.files-host-tabs')).toBeNull();
  await selectHost('a');
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: 'a' });
  expect(terminals.active).toBe(lastSession);
  expect(document.querySelectorAll('.terminal-tab')).toHaveLength(2);
  document.querySelector<HTMLButtonElement>('.host-tools [aria-label="SFTP 文件"]')!.click();
  await flush();
  expect(files.current).toMatchObject({ id: 'files-a', path: '/a' });
  expect(files.connections.b?.id).toBe('files-b');
  await selectHost('b');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'b' });
  expect(files.current).toMatchObject({ id: 'files-b', path: '/b' });
  await openNavigation('通用');
  await flush();
  expect(workspace.hostId).toBe('b');
  expect((document.querySelector('.sidebar') as HTMLElement).style.display).not.toBe('none');
  expect((document.querySelector('.host-tree-section') as HTMLElement).style.display).toBe('none');
  expect(document.querySelector('.workspace-header .host-tools')).not.toBeNull();
  await workspace.closeSettings();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'b' });
  await selectHost('a');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'a' });
  expect(document.querySelector('[aria-label="当前工作区主机"]')).toBeNull();
  expect(
    [...document.querySelectorAll('.workspace-tabs [role="tab"]')].map((t) =>
      t.textContent?.trim(),
    ),
  ).toEqual(['首页', 'Host a', 'Host b']);
  workspace.close(workspace.active, 'all');
  await flush();
  document
    .querySelector<HTMLButtonElement>('[aria-label="欢迎页面"] .welcome-card .button')!
    .click();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: '' });
  expect(document.querySelector('.workspace-header .host-tools')).toBeNull();
  expect(files.connections.a).toBeUndefined();
  expect(files.connections.b).toBeUndefined();
  expect(filesApi.close).toHaveBeenCalledWith('files-a', false);
  expect(filesApi.close).toHaveBeenCalledWith('files-b', false);
});

it.each([
  [
    '主机',
    '关闭',
    ['host:', 'extension:cn.hiboot.plugins.assistant:assistant:'],
    'extension:cn.hiboot.plugins.assistant:assistant:',
  ],
  ['主机', '关闭右侧', ['host:', 'host:a'], 'host:a'],
  ['主机', '关闭其它', ['host:', 'host:a'], 'host:a'],
  ['主机', '关闭所有', ['host:'], ''],
])(
  'workspace tab menu (%s / %s) closes sessions only for the removed host workspaces',
  async (_target, label, keys, active) => {
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
    const close = vi.spyOn(terminalApi, 'close').mockResolvedValue();
    terminals.open(null);
    const local = terminals.panes.find((pane) => !pane.host)!;
    terminals.update(local.key, { sessionId: 'local-session', state: 'connected' });
    workspace.navigate('terminals', '');
    workspace.navigate('files', 'a');
    void workspace.openPlugin('cn.hiboot.plugins.assistant', 'assistant', '');
    const beforeMenu = 'extension:cn.hiboot.plugins.assistant:assistant:';
    workspace.activate(beforeMenu);
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
    const selector = '.workspace-tab[data-host-id="a"]';
    document.querySelector(selector)!.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 300,
        clientY: 90,
      }),
    );
    await nextTick();
    expect(workspace.active).toBe(beforeMenu);
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
    expect(workspace.area).toBe('home');
    expect(terminals.hostTabs('')[0]?.panes).toContain(local);
    expect(local.sessionId).toBe('local-session');
    expect(close).not.toHaveBeenCalledWith('local-session');
    expect(document.querySelector('[aria-label="工作区标签操作"]')).toBeNull();
    if (keys.includes('host:a')) {
      expect(terminals.panes).toHaveLength(2);
      expect(terminals.panes[0]).toMatchObject({
        key: pane.key,
        sessionId: 'existing-session',
        state: 'connected',
      });
      expect(close).not.toHaveBeenCalled();
    } else {
      expect(terminals.panes).toEqual([local]);
      expect(close).toHaveBeenCalledExactlyOnceWith('existing-session');
    }
    if (keys.includes('host:a')) {
      expect(files.connections.a).toMatchObject({ id: 'existing-files', state: 'connected' });
      expect(filesApi.close).not.toHaveBeenCalled();
      expect(filesApi.clearTransfers).not.toHaveBeenCalled();
    } else {
      expect(files.connections.a).toBeUndefined();
      expect(filesApi.close).toHaveBeenCalledExactlyOnceWith('existing-files', false);
      expect(filesApi.clearTransfers).toHaveBeenCalledExactlyOnceWith('a');
    }
    if (!workspace.homeTabs.length)
      expect(document.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
  },
);

it('disables empty workspace close ranges and dismisses the menu outside', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  workspace.navigate('terminals', '');
  workspace.showHome();
  await flush();
  const tab = document.querySelector('.workspace-tab')!;
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
  expect(workspace.homeTabs).toHaveLength(1);
  expect(workspace.tabs).toHaveLength(2);
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
  workspace.navigate('files', 'b');
  await flush();
  const tab = document.querySelector<HTMLButtonElement>(
    '.workspace-tab[data-host-id="a"] [role="tab"]',
  )!;
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
  expect(workspace.active).toBe('host:b');
});

it('activating an empty host workspace does not silently create a replacement Shell', async () => {
  const terminals = useTerminalsStore(),
    workspace = useWorkspaceStore();
  terminals.open(null);
  workspace.navigate('terminals', '');
  document
    .querySelector<HTMLButtonElement>('.tree-host')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  const local = terminals.hostTabs('')[0]!;
  await terminals.close(local.key);
  workspace.selectHost('');
  await flush();
  expect(root.textContent).toContain('没有打开的终端');
  expect(terminals.hostTabs('')).toHaveLength(0);
  const heading = document.querySelector<HTMLElement>('.host-list-title')!;
  heading.click();
  heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  expect(terminals.hostTabs('')).toHaveLength(0);
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="本地终端"]')!.click();
  await flush();
  expect(terminals.hostTabs('')).toHaveLength(0);
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: '' });
  expect(terminals.hostTabs('a')).toHaveLength(1);
});

it('keeps single-host plugin drafts in their host workspace through host, core-tool and settings switches', async () => {
  const workspace = useWorkspaceStore(),
    plugins = usePluginsStore();
  const plugin = { ...systemPluginFixtures()[0]!, source: 'user' as const, enabled: true };
  plugin.manifest = {
    ...plugin.manifest,
    id: 'dev.host-draft',
    name: '主机草稿工具',
    permissions: ['ui.contribute'],
    entry: { backend: 'backend.wasm', ui: 'ui.json' },
    contributions: [
      { id: 'draft', kind: 'workspace', label: '主机草稿工具' },
      { id: 'settings', kind: 'settings', label: '草稿工具配置' },
    ],
  };
  plugins.installed.push(plugin);
  plugins.grants[plugin.manifest.id] = {
    version: 1,
    pluginId: plugin.manifest.id,
    pluginVersion: plugin.manifest.version,
    publisher: null,
    packageDigest: plugin.packageDigest,
    revision: plugin.revision,
    permissions: ['ui.contribute'],
    operations: ['ui.contribute'],
    readRoots: [],
    writeRoots: [],
  };
  plugins.schemas[plugin.manifest.id] = {
    revision: plugin.revision,
    ui: {
      uiVersion: 4,
      frontend: { script: 'frontend.js', style: 'frontend.css' },
      title: '主机草稿工具',
      pages: [
        {
          id: 'settings',
          surface: { kind: 'frontend' },
          title: '草稿工具配置',
          initialAction: null,
          fields: [],
          actions: [],
          log: null,
        },
        {
          id: 'draft',
          surface: { kind: 'frontend' },
          title: '草稿',
          initialAction: null,
          fields: [
            {
              id: 'content',
              label: '内容',
              kind: 'textarea',
              default: '',
              readonly: false,
              documentField: null,
            },
          ],
          actions: [],
          log: null,
        },
      ],
    },
  };
  vi.spyOn(pluginsApi, 'list').mockResolvedValue(plugins.installed);
  const show = async (id: string) => {
    document
      .querySelector<HTMLButtonElement>(`.tree-host[data-host-id="${id}"]`)!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    document
      .querySelector<HTMLButtonElement>('.host-tools [data-plugin-id="dev.host-draft"]')!
      .click();
    await flush();
  };
  await show('a');
  const editorA = document.querySelector<HTMLTextAreaElement>(
    '.plugin-workspace[data-host-id="a"] textarea',
  )!;
  editorA.value = 'draft for a';
  editorA.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  expect(workspace.active).toBe('host:a');
  expect(document.querySelector('[aria-label="插件目标主机"]')).toBeNull();
  await show('b');
  const editorB = document.querySelector<HTMLTextAreaElement>(
    '.plugin-workspace[data-host-id="b"] textarea',
  )!;
  editorB.value = 'draft for b';
  editorB.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  document
    .querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await flush();
  expect(workspace.current).toMatchObject({
    view: 'extension',
    hostId: 'a',
    pluginId: 'dev.host-draft',
  });
  expect(editorA.value).toBe('draft for a');
  expect(editorB.value).toBe('draft for b');
  expect(document.querySelector('.plugin-workspace[data-host-id="a"] textarea')).toBe(editorA);
  const settingsButton = root.querySelector<HTMLButtonElement>(
    '.plugin-workspace[data-host-id="a"] [aria-label="插件设置"]',
  )!;
  const frameA = editorA.closest('[data-plugin-frame]')!;
  expect(frameA.getAttribute('data-active')).toBe('true');
  vi.mocked(pluginsApi.reset).mockClear();
  settingsButton.focus();
  settingsButton.click();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'extension', hostId: 'a' });
  expect(workspace.settingsView).toBe('plugins');
  expect(workspace.area).toBe('settings');
  expect(document.querySelector('.settings-navigation')).not.toBeNull();
  expect(frameA.getAttribute('data-active')).toBe('false');
  const configuration = document.querySelector('[aria-label="主机草稿工具 · 配置"]')!;
  expect(configuration.querySelector('.plugin-settings-workspace')).not.toBeNull();
  expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
  configuration.querySelector<HTMLButtonElement>('[aria-label="返回插件列表"]')!.click();
  await flush();
  expect(document.querySelector('[aria-label="主机草稿工具 · 配置"]')).toBeNull();
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="首页"]')!.click();
  await flush();
  expect(document.querySelector('.plugin-workspace[data-host-id="a"] textarea')).toBe(editorA);
  expect(editorA.closest('[data-plugin-frame]')).toBe(frameA);
  expect(frameA.getAttribute('data-active')).toBe('true');
  expect(pluginsApi.reset).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('.host-tools [aria-label="SSH 终端"]')!.click();
  await flush();
  expect(workspace.current?.view).toBe('terminals');
  await show('a');
  expect(editorA.value).toBe('draft for a');
  expect(workspace.tabs.filter((tab) => tab.hostId === 'a')).toHaveLength(1);
  expect(editorA.value).toBe('draft for a');
  expect(editorB.value).toBe('draft for b');
});

it('protects plugin settings on the page while saving and routes cancel and model actions', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('terminals', 'a');
  const current = workspace.current;
  const open = async () => {
    workspace.openPluginSettings('cn.hiboot.plugins.assistant');
    await flush();
    return document.querySelector<HTMLElement>('.plugin-configuration')!;
  };
  const panel = await open();
  expect(panel).not.toBeNull();
  expect(panel.querySelector('[data-plugin-frame]')).not.toBeNull();
  expect(panel.querySelector('[aria-label="返回插件列表"]')).not.toBeNull();
  expect(workspace.settingsView).toBe('plugins');
  expect(document.querySelector('dialog[aria-label="设置"]')).toBeNull();
  panel.querySelector<HTMLButtonElement>('[data-save]')!.click();
  await flush();
  expect(
    [...document.querySelectorAll<HTMLButtonElement>('.activity-rail button')].every(
      (button) => button.disabled,
    ),
  ).toBe(true);
  workspace.showHome();
  expect(workspace.area).toBe('settings');
  expect(workspace.pluginConfiguration).toBeDefined();
  panel.querySelector<HTMLButtonElement>('[data-save-failed]')!.click();
  await flush();
  expect(
    document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="首页"]')!.disabled,
  ).toBe(false);
  panel.querySelector<HTMLButtonElement>('[data-cancel]')!.click();
  await flush();
  expect(panel.isConnected).toBe(false);
  expect(workspace.pluginConfiguration).toBeUndefined();
  expect(workspace.settingsView).toBe('plugins');
  const reopened = await open();
  reopened.querySelector<HTMLButtonElement>('[data-models]')!.click();
  await flush();
  expect(reopened.isConnected).toBe(false);
  expect(workspace.pluginConfiguration).toBeUndefined();
  expect(workspace.settingsView).toBe('models');
  expect(document.querySelector('.settings-page .models-view')).not.toBeNull();
  expect(workspace.current).toBe(current);
  expect(workspace.tabs).toEqual([current]);
});

it('opens disabled, ungranted and UI-less plugins in the shared settings page without creating tabs', async () => {
  const workspace = useWorkspaceStore(),
    plugins = usePluginsStore();
  plugins.installed = systemPluginFixtures();
  plugins.installed[1] = {
    ...plugins.installed[0]!,
    source: 'user',
    enabled: true,
    manifest: { ...plugins.installed[0]!.manifest, id: 'dev.ungranted', name: '未授权插件' },
  };
  plugins.installed.push({
    ...plugins.installed[0]!,
    source: 'user',
    manifest: {
      ...plugins.installed[0]!.manifest,
      id: 'dev.configuration-only',
      name: '仅配置插件',
      contributions: [],
    },
  });
  plugins.grants = {};
  vi.spyOn(pluginsApi, 'list').mockResolvedValue(plugins.installed);
  workspace.navigate('settings');
  await flush();
  const schema = vi.mocked(pluginsApi.ui);
  schema.mockClear();
  const activate = vi.mocked(pluginsApi.activate);
  activate.mockClear();
  for (const plugin of plugins.installed) {
    const modal = await openPluginModal(plugin.manifest.name);
    expect(workspace.current).toBeUndefined();
    expect(workspace.settingsView).toBe('plugins');
    expect(workspace.pluginConfiguration).toEqual({
      pluginId: plugin.manifest.id,
      contributionId: null,
    });
    expect(
      document.querySelector('.activity-rail [aria-current="page"]')?.getAttribute('aria-label'),
    ).toBe('设置');
    expect(document.querySelector('[aria-label="选择使用工具的主机"]')).toBeNull();
    expect(modal.querySelector('[aria-label="插件设置"]')).not.toBeNull();
    expect(workspace.tabs.every((tab) => !tab.pluginId)).toBe(true);
    modal.querySelector<HTMLButtonElement>('[aria-label="返回插件列表"]')!.click();
    await flush();
    expect(workspace.pluginConfiguration).toBeUndefined();
  }
  expect(schema).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  expect(workspace.pluginPages).toHaveLength(0);
  expect(document.querySelector('.sidebar-app-actions [aria-label="插件管理"]')).toBeNull();
  expect(document.querySelector('[aria-label="运维工具导航"]')).toBeNull();
});
