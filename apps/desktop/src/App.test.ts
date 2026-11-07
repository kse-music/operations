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
import type { NavigationModule } from './types/navigation';
import { pluginsApi } from './services/plugins';
import { usePluginsStore } from './stores/plugins';
import { useNotificationsStore } from './stores/notifications';
import { systemPluginFixtures, toolPluginState } from './services/system-plugins.fixture';
import { aiApi } from './services/ai';
import type { TransferInfo } from './types/files';

// Exercise the shell and both tab bars without xterm's browser canvas or a remote connection.
vi.mock('./components/TerminalPane.vue', () => ({ default: { render: () => null } }));
// This shell unit suite mounts the real plugin views through public SDK test
// adapters. Native iframe isolation and package loading are checked separately.
vi.mock('@serverdeck/plugin-sdk/stores/hosts', async () => import('./stores/hosts'));
vi.mock('@serverdeck/plugin-sdk/stores/ops', async () => import('./stores/ops'));
vi.mock('@serverdeck/plugin-sdk/stores/files', async () => import('./stores/files'));
vi.mock('@serverdeck/plugin-sdk/stores/models', async () => import('./stores/models'));
vi.mock('@serverdeck/plugin-sdk/services/ai', async () => import('./services/ai'));
vi.mock('./components/PluginFrame.vue', () => ({ default: { render: () => null } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
let app: App | undefined, pinia: Pinia, root: HTMLDivElement;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const flush = async () => {
  await vi.dynamicImportSettled();
  await nextTick();
};
async function sidebarMenu(module: NavigationModule, label: string): Promise<void> {
  root.querySelector<HTMLButtonElement>(`.module-navigation [data-module="${module}"]`)!.click();
  await flush();
  root.querySelector<HTMLButtonElement>(`.activity-rail [aria-label="${label}"]`)!.click();
  await flush();
}
async function openPluginModal(name: string): Promise<HTMLDialogElement> {
  await sidebarMenu('plugins', '插件管理');
  [...root.querySelectorAll<HTMLButtonElement>('.plugin-name-button')]
    .find((button) => button.textContent?.trim() === name)!
    .click();
  await flush();
  return document.querySelector<HTMLDialogElement>(`dialog[aria-label="${name} · 配置"]`)!;
}
async function newSession(): Promise<void> {
  root.querySelector<HTMLButtonElement>('[aria-label="新建终端会话"]')!.click();
  await flush();
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
    databaseVersion: 6,
    dataDirectory: '',
    logDirectory: '',
    config: {
      version: 1,
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
  const pluginState = toolPluginState();
  Object.assign(usePluginsStore(), pluginState);
  vi.spyOn(pluginsApi, 'list').mockResolvedValue(pluginState.installed);
  vi.spyOn(pluginsApi, 'permissions').mockImplementation(
    async (id) => pluginState.grants[id] ?? null,
  );
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  vi.spyOn(pluginsApi, 'ui').mockImplementation(async (id) => pluginState.schemas[id]!.ui);
  vi.spyOn(pluginsApi, 'context').mockResolvedValue();
  vi.spyOn(filesApi, 'tasks').mockResolvedValue([]);
  vi.spyOn(filesApi, 'connections').mockResolvedValue([]);
  vi.spyOn(filesApi, 'close').mockResolvedValue();
  vi.spyOn(filesApi, 'clearTransfers').mockResolvedValue();
  vi.spyOn(pluginsApi, 'activate').mockResolvedValue({ state: 'active' } as never);
  vi.spyOn(aiApi, 'models').mockResolvedValue([]);
  vi.spyOn(pluginsApi, 'toolStage').mockImplementation(async (_id, input) => ({
    inputId: crypto.randomUUID(),
    operation: input.operation,
  }));
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

it.each([null, '', 'a'])(
  'starts with no terminal tabs and opens one fresh Shell despite a legacy layout (%s)',
  async (savedHostId) => {
    app!.unmount();
    loadSidebarConfig();
    vi.spyOn(useHostsStore(), 'load').mockResolvedValue();
    vi.spyOn(useBackgroundStore(), 'start').mockImplementation(() => {});
    vi.spyOn(useFilesStore(), 'poll').mockResolvedValue();
    const load = vi.spyOn(terminalApi, 'workspaceLoad').mockResolvedValue(
      savedHostId !== null
        ? {
            version: 1,
            active: 'saved-0',
            tabs: Array.from({ length: 5 }, (_, index) => ({
              key: `saved-${index}`,
              title: '旧会话',
              panes: [{ key: `saved-pane-${index}`, hostId: savedHostId || null }],
              layout: { kind: 'leaf' as const, pane: `saved-pane-${index}` },
            })),
          }
        : null,
    );
    const save = vi.spyOn(terminalApi, 'workspaceSave').mockResolvedValue();
    const terminals = useTerminalsStore();
    const open = vi.spyOn(terminals, 'open');
    app = createApp(AppShell).use(pinia);
    app.mount(root);
    await flush();
    expect(useWorkspaceStore().tabs).toEqual([]);
    expect(root.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
    expect(root.querySelector<HTMLElement>('.terminal-workspace')?.style.display).toBe('none');
    expect(open).not.toHaveBeenCalled();
    expect(terminals.tabs).toEqual([]);
    expect(terminals.panes).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    root
      .querySelector<HTMLButtonElement>(
        savedHostId ? `.tree-host[data-host-id="${savedHostId}"]` : '[aria-label="本地终端"]',
      )!
      .click();
    await flush();
    expect(useWorkspaceStore().current).toMatchObject({
      view: 'terminals',
      hostId: savedHostId ?? '',
    });
    expect(terminals.tabs).toHaveLength(1);
    expect(terminals.panes).toHaveLength(1);
    expect(terminals.panes[0]?.connectRequested).toBe(true);
    expect(terminals.tabs[0]).toMatchObject({ sessionNumber: 1 });
    expect(terminals.tabs[0]!.key).not.toMatch(/^saved-/);
    expect(open).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
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

it('opens About as a single system workspace page and preserves the existing terminal', async () => {
  loadSidebarConfig();
  useApplicationStore().state!.appVersion = '0.2.0';
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  terminals.open(useHostsStore().catalog!.hosts[0]!);
  terminals.update(terminals.focused, { state: 'connected', sessionId: 'live-shell' });
  workspace.navigate('terminals', 'a');
  await flush();
  const original = JSON.stringify(terminals.tabs);
  const close = vi.spyOn(terminalApi, 'close').mockResolvedValue();
  expect(root.querySelector('[aria-label="关于"]')).toBeNull();
  await sidebarMenu('system', '关于');
  const page = root.querySelector('.about-view')!;
  expect(page).not.toBeNull();
  expect(page.querySelector('h1')?.textContent).toBe('关于 ServerDeck');
  expect(page.textContent).toContain('v0.2.0');
  expect(page.textContent).toContain('SSH 终端、SFTP 文件管理和服务器监控');
  expect(page.textContent).toContain('Rust · Tauri 2 · Vue 3');
  expect(page.textContent).toContain('本地环境');
  expect(page.textContent).toContain('schema v6');
  expect(page.querySelector('[data-testid="backend-ready"]')).not.toBeNull();
  expect(root.querySelector('.module-menu [aria-label="本地环境"]')).toBeNull();
  expect(document.querySelector('dialog[aria-label="关于 ServerDeck"]')).toBeNull();
  expect(workspace.current).toMatchObject({ key: 'about:', view: 'about', hostId: '' });
  expect(root.querySelector('.module-menu [aria-current="page"]')?.getAttribute('aria-label')).toBe(
    '关于',
  );
  expect(
    root.querySelector('.module-menu [aria-label="关于"]')?.getAttribute('aria-haspopup'),
  ).toBeNull();
  expect(
    root.querySelector('.workspace-tab[data-view="about"] [role="tab"]')?.textContent?.trim(),
  ).toBe('关于');
  await sidebarMenu('system', '关于');
  expect(workspace.tabs.filter((tab) => tab.view === 'about')).toHaveLength(1);
  root.querySelector<HTMLButtonElement>('.workspace-tab[data-host-id="a"] [role="tab"]')!.click();
  await flush();
  expect(workspace.current?.view).toBe('terminals');
  root.querySelector<HTMLButtonElement>('.workspace-tab[data-view="about"] [role="tab"]')!.click();
  await flush();
  expect(workspace.module).toBe('system');
  expect(root.querySelector('.about-view')).not.toBeNull();
  await workspace.close('about:');
  await flush();
  expect(root.querySelector('.about-view')).toBeNull();
  expect(workspace.current?.view).toBe('terminals');
  expect(JSON.stringify(terminals.tabs)).toBe(original);
  expect(close).not.toHaveBeenCalled();
});

it('opens plugin management under Plugins, keeps language in Settings and preserves the terminal', async () => {
  loadSidebarConfig();
  vi.spyOn(pluginsApi, 'list').mockResolvedValue([]);
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  terminals.open(useHostsStore().catalog!.hosts[0]!);
  terminals.update(terminals.focused, { state: 'connected', sessionId: 'live-shell' });
  workspace.navigate('terminals', 'a');
  await flush();
  const original = JSON.stringify(terminals.tabs);
  const close = vi.spyOn(terminalApi, 'close').mockResolvedValue();
  expect(root.querySelector('[data-module="plugins"]')?.textContent?.trim()).toBe('插件');
  root.querySelector<HTMLButtonElement>('[data-module="system"]')!.click();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: 'a' });
  expect(root.querySelector('.module-menu [aria-label="插件管理"]')).toBeNull();
  expect(root.querySelector('.module-menu [aria-label="通用"]')).not.toBeNull();
  await sidebarMenu('plugins', '插件管理');
  expect(workspace.module).toBe('plugins');
  expect(root.querySelector('.plugin-manager h1')?.textContent).toBe('插件管理');
  expect(root.querySelector('[aria-label="插件界面语言"]')).toBeNull();
  await sidebarMenu('system', '数据与存储');
  expect(root.querySelector('.module-menu [aria-label="插件管理"]')).toBeNull();
  expect(root.querySelector<HTMLSelectElement>('[aria-label="界面语言"]')?.value).toBe('zh-CN');
  root
    .querySelector<HTMLButtonElement>('.workspace-tab[data-view="plugins"] [role="tab"]')!
    .click();
  await flush();
  expect(workspace.module).toBe('plugins');
  expect(root.querySelector('.plugin-manager')).not.toBeNull();
  expect(workspace.tabs.filter((tab) => tab.view === 'plugins')).toHaveLength(1);
  expect(JSON.stringify(terminals.tabs)).toBe(original);
  expect(close).not.toHaveBeenCalled();
});

it('shows the saved development kit path or save error and lets the user retry after cancellation', async () => {
  const save = vi
    .spyOn(pluginsApi, 'saveDevelopmentKit')
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('目录不可写'))
    .mockResolvedValueOnce('D:\\QA\\serverdeck-plugin-development-kit.zip');
  await sidebarMenu('plugins', '插件管理');
  const button = [
    ...root.querySelectorAll<HTMLButtonElement>('.plugin-heading-actions button'),
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
  await sidebarMenu('system', '关于');
  const page = root.querySelector('.about-view')!;
  expect(page).not.toBeNull();
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
  expect(document.querySelector('dialog[aria-label="关于 ServerDeck"]')).toBeNull();
});

it('keeps settings drafts across menus and workspace tabs, and navigates to invalid fields', async () => {
  loadSidebarConfig();
  const save = vi.spyOn(ipc, 'saveConfig').mockImplementation(async (config) => config);
  const workspace = useWorkspaceStore();
  await sidebarMenu('system', '终端');
  const panel = root.querySelector('.settings-panel');
  const lineHeight = root.querySelector<HTMLInputElement>('[aria-label="终端行高"]')!;
  lineHeight.value = '99';
  lineHeight.dispatchEvent(new Event('input', { bubbles: true }));
  await sidebarMenu('system', '通用');
  await sidebarMenu('system', '关于');
  root
    .querySelector<HTMLButtonElement>('.workspace-tab[data-view="settings"] [role="tab"]')!
    .click();
  await flush();
  expect(root.querySelector('.settings-panel')).toBe(panel);
  root
    .querySelector('form.settings-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  expect(workspace.current?.view).toBe('settingsTerminal');
  expect(root.querySelector('.module-menu [aria-current="page"]')?.getAttribute('aria-label')).toBe(
    '终端',
  );
  expect(root.querySelector('#settings-title')?.textContent).toBe('终端');
  expect(document.activeElement).toBe(lineHeight);
  expect(save).not.toHaveBeenCalled();
  lineHeight.value = '120';
  lineHeight.dispatchEvent(new Event('input', { bubbles: true }));
  await sidebarMenu('system', '快捷键');
  root
    .querySelector('form.settings-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  expect(save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ terminal: expect.objectContaining({ lineHeight: 120 }) }),
  );
  await sidebarMenu('system', '终端');
  expect(workspace.tabs.filter((tab) => tab.view === 'settingsTerminal')).toHaveLength(1);
  for (const view of ['settings', 'settingsTerminal', 'settingsShortcuts'])
    await workspace.close(`${view}:`);
  await flush();
  expect(root.querySelector('.settings-panel')).toBeNull();
});

it.each([
  ['通用', 'settings', '[aria-label="侧边栏宽度"]', '300'],
  ['终端', 'settingsTerminal', '[aria-label="终端行高"]', '125'],
  ['快捷键', 'settingsShortcuts', '[aria-label="复制快捷键"]', ''],
  ['数据与存储', 'settingsStorage', '[aria-label="默认下载目录"]', 'D:\\Downloads'],
])('warns before closing the last dirty %s settings tab', async (label, view, selector, value) => {
  loadSidebarConfig();
  const save = vi.spyOn(ipc, 'saveConfig');
  const workspace = useWorkspaceStore();
  await sidebarMenu('system', label);
  const field = root.querySelector<HTMLInputElement>(selector)!;
  if (value) {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    field.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyX', ctrlKey: true, shiftKey: true }),
    );
  }
  await flush();
  root.querySelector<HTMLButtonElement>(`[aria-label="关闭工作区标签 ${label}"]`)!.click();
  await flush();
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="设置尚未保存"]')!;
  expect(dialog).not.toBeNull();
  expect(workspace.tabs.some((tab) => tab.view === view)).toBe(true);
  [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '继续编辑')!
    .click();
  await flush();
  expect(document.querySelector('dialog[aria-label="设置尚未保存"]')).toBeNull();
  expect(root.querySelector<HTMLInputElement>(selector)!.value).toBe(value || 'Ctrl+Shift+X');
  const closing = workspace.close(`${view}:`);
  await flush();
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')]
    .find((button) => button.textContent?.trim() === '放弃更改并关闭')!
    .click();
  await closing;
  await flush();
  expect(workspace.tabs).toHaveLength(0);
  expect(root.querySelector('.settings-panel')).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it('previews interface size across tabs and retains only the last successful save', async () => {
  loadSidebarConfig();
  const save = vi
    .spyOn(ipc, 'saveConfig')
    .mockRejectedValueOnce({ code: 'STORAGE', message: '无法保存设置' })
    .mockImplementation(async (config) => config);
  const application = useApplicationStore();
  const workspace = useWorkspaceStore();
  const scale = () => document.documentElement.style.getPropertyValue('--interface-font-scale');
  await sidebarMenu('system', '通用');
  const slider = root.querySelector<HTMLInputElement>('#interface-font-size')!;
  const choose = async (step: string) => {
    slider.value = step;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
  };
  const submit = async () => {
    root.querySelector('.settings-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
  };

  expect(slider.getAttribute('aria-valuetext')).toBe('标准');
  await choose('4');
  expect(scale()).toBe('1.45');
  expect(save).not.toHaveBeenCalled();
  await sidebarMenu('system', '关于');
  expect(scale()).toBe('1.45');
  await sidebarMenu('system', '通用');
  await submit();
  expect(application.error).toBe('无法保存设置');
  expect(application.state?.config.interfaceFontSize).toBe('standard');
  expect(scale()).toBe('1.45');

  await submit();
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ interfaceFontSize: 'ultraLarge', terminalFontSize: 14 }),
  );
  expect(application.state?.config.interfaceFontSize).toBe('ultraLarge');
  await choose('0');
  expect(scale()).toBe('0.95');
  const closing = workspace.close('settings:');
  await flush();
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')]
    .find((button) => button.textContent?.trim() === '放弃更改并关闭')!
    .click();
  await closing;
  await flush();
  expect(scale()).toBe('1.45');
  await sidebarMenu('system', '通用');
  expect(root.querySelector('#interface-font-size')?.getAttribute('aria-valuetext')).toBe('超大');
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
  const host = root.querySelector<HTMLButtonElement>('.tree-host')!;
  host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  expect(document.querySelector('[aria-label="主机树操作"]')).not.toBeNull();
  expect(useTerminalsStore().panes).toHaveLength(0);
  document.querySelector<HTMLButtonElement>('[aria-label="关闭主机树菜单"]')!.click();
  host.click();
  await flush();
  expect(useTerminalsStore().panes[0]?.host?.id).toBe('a');
  root
    .querySelector('.terminal-tab [role="tab"]')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await closeSession(0);
  expect(useTerminalsStore().panes).toHaveLength(0);
});

it('removes the host management page and keeps creation available in the workspace', async () => {
  expect(root.querySelector('.topbar [aria-label="当前主机上下文"]')).toBeNull();
  expect(root.querySelector('.topbar [aria-label="打开全局搜索"]')).toBeNull();
  expect(root.querySelector('.workspace-group-tab')).toBeNull();
  expect(root.querySelector('[aria-label="主机管理"]')).toBeNull();
  expect(root.querySelector('.activity-rail [aria-label="主机工作区"]')).toBeNull();
  expect(root.querySelector('.hosts-view')).toBeNull();
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
  root.querySelector<HTMLButtonElement>('[aria-label="本地终端"]')!.click();
  await flush();
  const original = JSON.stringify(useTerminalsStore().tabs);
  expect(root.querySelector('[aria-label="任务中心"]')).toBeNull();
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

it('reopens model management in Settings from global search and reuses the existing tab', async () => {
  app!.unmount();
  loadSidebarConfig();
  vi.spyOn(useHostsStore(), 'load').mockResolvedValue();
  vi.spyOn(useBackgroundStore(), 'start').mockImplementation(() => {});
  vi.spyOn(useFilesStore(), 'poll').mockResolvedValue();
  app = createApp(AppShell).use(pinia);
  app.mount(root);
  await flush();
  await sidebarMenu('system', '模型管理');
  await sidebarMenu('system', '关于');
  root.querySelector<HTMLButtonElement>('[data-module="plugins"]')!.click();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
  await flush();
  const search = document.querySelector<HTMLInputElement>('[aria-label="全局搜索内容"]')!;
  search.value = '模型管理';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  const result = document.querySelector<HTMLButtonElement>('[role="option"]')!;
  expect(result.textContent?.trim()).toBe('工作区 · 模型管理');
  result.click();
  await flush();
  expect(useWorkspaceStore().current?.key).toBe('models:');
  expect(useWorkspaceStore().module).toBe('system');
  expect(root.querySelectorAll('.workspace-tab[data-view="models"]')).toHaveLength(1);
  expect(root.querySelector('.module-menu [aria-current="page"]')?.getAttribute('aria-label')).toBe(
    '模型管理',
  );
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
  root.querySelector<HTMLButtonElement>('.workspace-tab[data-host-id="a"] .tab-close')!.click();
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
  root.querySelector<HTMLButtonElement>('.workspace-tab[data-host-id="a"] .tab-close')!.click();
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

it('merges navigation with the host tree and keeps the sidebar available on global pages', async () => {
  expect(root.querySelector('.topbar')).toBeNull();
  const title = root.querySelector('.sidebar-workspace-heading')!;
  const collapse = title.querySelector<HTMLButtonElement>('[aria-label="收起主机栏"]')!;
  const tabList = root.querySelector<HTMLElement>('.workspace-tabs')!;
  expect(collapse).not.toBeNull();
  expect(tabList.style.display).toBe('none');
  expect(root.querySelector('.host-sidebar-heading')).toBeNull();
  expect(title.textContent).toContain('主机管理');
  expect(root.querySelector('.sidebar .activity-rail .host-tree-section')).not.toBeNull();
  expect(collapse.getAttribute('aria-expanded')).toBe('true');
  const hosts = useHostsStore();
  hosts.search = 'Host a';
  await nextTick();
  collapse.click();
  await flush();
  expect(root.querySelector<HTMLElement>('.sidebar')!.style.display).toBe('none');
  const expandSelector = '.workspace-navigation [aria-label="展开主机栏"]';
  const expand = root.querySelector<HTMLButtonElement>(expandSelector)!;
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
  expect(root.querySelector(expandSelector)).toBeNull();
  await useWorkspaceStore().navigate('models');
  await flush();
  expect(root.querySelector<HTMLElement>('.sidebar')!.style.display).not.toBe('none');
  expect(root.querySelector<HTMLElement>('.host-tree-section')!.style.display).toBe('none');
  expect(root.querySelector('.workspace-group-tab')).toBeNull();
  expect(tabList.style.display).not.toBe('none');
  expect(root.querySelector(expandSelector)).toBeNull();
  collapse.click();
  await flush();
  expect(root.querySelector(expandSelector)).not.toBeNull();
});

it('keeps the host count and search without JSON import or export controls', () => {
  const heading = root.querySelector('.host-list-heading')!;
  expect(heading.textContent).toContain('全部主机');
  expect(heading.querySelector('.host-count')?.textContent?.trim()).toBe('2');
  expect([...heading.querySelectorAll('button')].map((button) => button.ariaLabel)).toEqual([
    '本地终端',
  ]);
  expect(root.querySelector('[aria-label="选择 ServerDeck 主机文件"]')).toBeNull();
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
  const dialog = document.querySelector('[aria-label="新建主机"]')!;
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
  await vi.waitFor(() => expect(document.querySelector('[aria-label="新建主机"]')).toBeNull());
  expect(root.querySelector('[data-group-id="child"] [data-host-id="created"]')).not.toBeNull();
  expect(useTerminalsStore().panes).toHaveLength(0);
});

it.each([null, '', 'a'])(
  'opens or reuses the local terminal from the All Hosts heading in context "%s"',
  async (hostId) => {
    const workspace = useWorkspaceStore();
    if (hostId !== null) workspace.navigate('terminals', hostId);
    await flush();
    const section = root.querySelector('.host-tree-section')!;
    const local = section.querySelector<HTMLButtonElement>(
      '.host-list-heading > [aria-label="本地终端"]',
    )!;
    expect(local).toBe(section.querySelector('.host-list-heading')?.lastElementChild);
    expect(local.querySelector('svg')).not.toBeNull();
    expect(local.textContent?.trim()).toBe('');
    expect(section.querySelector('.sidebar-local-device')).toBeNull();
    const hosts = useHostsStore();
    hosts.search = 'no matching host';
    await flush();
    expect(root.querySelectorAll('.tree-host')).toHaveLength(0);
    local.click();
    await flush();
    expect(workspace.current?.hostId).toBe('');
    expect(useTerminalsStore().panes.at(-1)?.host).toBeNull();
    expect(local.getAttribute('aria-current')).toBe('page');
    local.click();
    await flush();
    expect(useTerminalsStore().hostTabs('')).toHaveLength(1);
    if (hostId) {
      await workspace.close(`host:${hostId}`);
      await flush();
    }
    expect(root.querySelector('.workspace-group-tab')?.textContent?.trim()).toBe('全部主机');
    await workspace.close('host:');
    await flush();
    expect(root.querySelector('.workspace-group-tab')).toBeNull();
    expect(root.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
  },
);

it('preserves welcome when switching unused module menus without opening a page or terminal', async () => {
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  const open = vi.spyOn(terminals, 'open');
  for (const module of ['plugins', 'system'] as const) {
    root.querySelector<HTMLButtonElement>(`.module-navigation [data-module="${module}"]`)!.click();
    await flush();
    expect(workspace.module).toBe(module);
    expect(workspace.current).toBeUndefined();
    expect(workspace.tabs).toEqual([]);
    expect(root.querySelector('.module-menu [aria-current="page"]')).toBeNull();
    expect(root.querySelector('.module-menu .active')).toBeNull();
    expect(root.querySelector('[aria-label="模块未选择功能"]')).toBeNull();
    expect(root.querySelector('[aria-label="欢迎页面"]')).not.toBeNull();
    expect(root.textContent).not.toContain('请选择功能');
    expect(root.querySelector<HTMLElement>('.host-tree-section')!.style.display).toBe('none');
  }
  expect(root.querySelector('.module-menu [aria-label="通用"]')).not.toBeNull();
  root.querySelector<HTMLButtonElement>('.module-menu [aria-label="通用"]')!.click();
  await flush();
  expect(workspace.current?.view).toBe('settings');
  expect(workspace.tabs).toHaveLength(1);
  expect(open).not.toHaveBeenCalled();
});

it('keeps the current terminal visible across top module switches and navigates only on explicit page selection', async () => {
  root.querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!.click();
  await flush();
  const terminals = useTerminalsStore(),
    workspace = useWorkspaceStore();
  const pane = terminals.panes[0]!;
  Object.assign(pane, {
    state: 'connected',
    sessionId: 'existing-session',
    connectRequested: false,
  });
  await flush();
  const terminalElement = root.querySelector('.terminal-tab')!;
  const allHosts = root.querySelector<HTMLButtonElement>('.workspace-group-tab')!;
  const hostTabRow = root.querySelector<HTMLElement>('.workspace-host-tabs')!;
  const open = vi.spyOn(terminals, 'open');
  const close = vi.spyOn(terminalApi, 'close');
  for (const module of ['plugins', 'system', 'hosts'] as const) {
    root.querySelector<HTMLButtonElement>(`.module-navigation [data-module="${module}"]`)!.click();
    await flush();
    expect(workspace.module).toBe(module);
    expect(workspace.current).toMatchObject({ view: 'terminals', hostId: 'a' });
    expect(allHosts.getAttribute('aria-selected')).toBe('true');
    expect(hostTabRow.style.display).not.toBe('none');
    expect(root.querySelector<HTMLElement>('.terminal-workspace')!.style.display).not.toBe('none');
    expect(root.querySelector('.terminal-tab')).toBe(terminalElement);
    expect(pane).toMatchObject({
      sessionId: 'existing-session',
      state: 'connected',
      connectRequested: false,
    });
    expect(root.querySelector('[aria-label="欢迎页面"]')).toBeNull();
    expect(root.textContent).not.toContain('请选择功能');
  }
  const pluginModal = await openPluginModal('AI 运维助手');
  expect(pluginModal.open).toBe(true);
  expect(workspace.current?.view).toBe('plugins');
  expect(workspace.tabs.some((tab) => tab.pluginId === 'cn.hiboot.plugins.assistant')).toBe(false);
  pluginModal.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  await flush();
  expect(workspace.module).toBe('plugins');
  expect([...root.querySelectorAll('.module-menu .nav-label')].map((el) => el.textContent)).toEqual(
    ['插件管理'],
  );
  expect(root.querySelector('.activity-rail [aria-label="通用"]')).toBeNull();
  await sidebarMenu('system', '模型管理');
  expect(workspace.module).toBe('system');
  expect(root.querySelector('.module-menu [aria-current="page"]')?.getAttribute('aria-label')).toBe(
    '模型管理',
  );
  expect(allHosts.getAttribute('aria-selected')).toBe('false');
  expect(allHosts.parentElement).toBe(
    root.querySelector('.workspace-tab[data-view="models"]')?.parentElement,
  );
  expect(hostTabRow.style.display).toBe('none');
  await sidebarMenu('system', '关于');
  root.querySelector<HTMLButtonElement>('.module-navigation [data-module="plugins"]')!.click();
  await flush();
  expect(workspace.current?.view).toBe('about');
  root.querySelector<HTMLButtonElement>('.workspace-tab[data-view="models"] [role="tab"]')!.click();
  await flush();
  expect(workspace.module).toBe('system');
  expect(root.querySelector('.module-menu [aria-current="page"]')?.getAttribute('aria-label')).toBe(
    '模型管理',
  );
  root
    .querySelector<HTMLButtonElement>('.workspace-tab[data-view="plugins"] [role="tab"]')!
    .click();
  await flush();
  expect(root.querySelector('.module-navigation [aria-current="page"]')?.textContent?.trim()).toBe(
    '插件',
  );
  expect(
    root.querySelector('.activity-rail [aria-label="插件管理"][aria-current="page"]'),
  ).not.toBeNull();
  root.querySelector<HTMLButtonElement>('.module-navigation [data-module="hosts"]')!.click();
  await flush();
  expect(workspace.current?.view).toBe('plugins');
  allHosts.click();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: 'a' });
  expect(root.querySelector('.workspace-header .host-tools')).not.toBeNull();
  expect(root.querySelector('.activity-rail [aria-label="AI 运维助手"]')).toBeNull();
  expect(terminals.panes[0]?.key).toBe(pane.key);
  expect(terminals.panes[0]?.connectRequested).toBe(false);
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
  root.querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!.click();
  await flush();
  const pane = terminals.panes[0]!;
  pane.state = 'connected';
  pane.sessionId = 'ssh-a';
  const tool = async (label: string) => {
    root.querySelector<HTMLButtonElement>(`.workspace-header [aria-label="${label}"]`)!.click();
    await flush();
  };
  expect(root.querySelector('.sidebar [aria-label="当前主机工具"]')).toBeNull();
  expect(root.querySelector('[aria-controls="workspace-file-panel"]')).toBeNull();
  await tool('SFTP 文件');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'a' });
  expect(root.querySelectorAll('.files-view')).toHaveLength(1);
  expect(root.querySelector('[aria-label="本地路径"]')).not.toBeNull();
  expect(root.querySelector<HTMLInputElement>('[aria-label="远程路径"]')?.value).toBe('/srv/a');
  expect(root.querySelector('.workspace-header [aria-current="page"]')?.textContent).toContain(
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
    root.querySelector('.host-tools [aria-current="page"]')?.getAttribute('data-plugin-id'),
  ).toBe(plugin.manifest.id);
  expect(root.querySelector('.workspace-header [aria-haspopup="menu"]')).toBeNull();
  expect(root.querySelector('[aria-label="插件设置"]')).not.toBeNull();
  expect(root.querySelector('.operations-view, .monitor-view')).toBeNull();
  await tool('SSH 终端');
  expect(root.querySelector('.files-view, .workspace-file-panel')).toBeNull();
  expect(terminals.focused).toBe(pane.key);
  expect(pane.sessionId).toBe('ssh-a');
  root.querySelector<HTMLButtonElement>('.tree-host[data-host-id="b"]')!.click();
  await flush();
  await tool('SFTP 文件');
  expect(files.active).toBe('b');
  expect(root.querySelector<HTMLInputElement>('[aria-label="远程路径"]')?.value).toBe('/srv/b');
  root.querySelector<HTMLButtonElement>('.workspace-tab[data-host-id="a"] [role="tab"]')!.click();
  await flush();
  await tool('SFTP 文件');
  expect(files.active).toBe('a');
  expect(root.querySelector<HTMLInputElement>('[aria-label="远程路径"]')?.value).toBe('/srv/a');
  expect(files.connections.a?.id).toBe('sftp-a');
  expect(files.connections.b?.id).toBe('sftp-b');
  expect(closeFiles).not.toHaveBeenCalled();
  expect(closeTerminal).not.toHaveBeenCalled();
  workspace.navigate('settings');
  await flush();
  expect(root.querySelector('.workspace-header .host-tools')).toBeNull();
  workspace.navigate('terminals', '');
  await flush();
  expect(root.querySelector('.workspace-header .host-tools')).toBeNull();
  expect(root.querySelector('[aria-controls="workspace-file-panel"]')).toBeNull();
});

it('opens the full file page with the terminal directory and rejects changed connection settings', async () => {
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore(),
    files = useFilesStore();
  root.querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!.click();
  await flush();
  const pane = terminals.panes[0]!;
  pane.state = 'connected';
  pane.sessionId = 'existing';
  const open = vi.spyOn(files, 'open').mockResolvedValue();
  const terminalView = root.querySelector('.terminals-view') as HTMLElement & {
    __vueParentComponent: { emit: (event: string, ...args: unknown[]) => void };
  };
  terminalView.__vueParentComponent.emit('files', pane.host, '/srv/project', pane.key);
  await flush();
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'a' });
  expect(open).toHaveBeenCalledWith(pane.host, '/srv/project', pane.key);
  expect(root.querySelector('.files-view')).not.toBeNull();
  expect(root.querySelector('.workspace-file-panel')).toBeNull();
  root.querySelector<HTMLButtonElement>('.workspace-header [aria-label="SSH 终端"]')!.click();
  await flush();
  open.mockClear();
  useHostsStore().catalog!.hosts[0] = { ...pane.host!, hostname: 'changed.example' };
  terminalView.__vueParentComponent.emit('files', pane.host, '/srv/project', pane.key);
  await flush();
  expect(workspace.current?.view).toBe('terminals');
  expect(open).not.toHaveBeenCalled();
  expect(pane.sessionId).toBe('existing');
  expect(
    [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent).join(' '),
  ).toContain('主机连接配置已变更');
});

it.each(['a', 'b'])(
  'opens context actions without changing the active session (%s)',
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
      expect(document.querySelector('[aria-label="主机树操作"]')).not.toBeNull();
      document.querySelector<HTMLButtonElement>('[aria-label="关闭主机树菜单"]')!.click();
      await nextTick();
      expect(document.querySelector('[aria-label="主机树操作"]')).toBeNull();
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
  'connects only the selected idle pane on a host click (existing workspace=%s)',
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
  root.querySelector<HTMLButtonElement>('.module-navigation [data-module="hosts"]')!.click();
  await flush();
  expect(terminals.panes).toHaveLength(1);
  expect(workspace.current).toMatchObject({ view: 'settings' });
  root.querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!.click();
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
  expect(terminals.tabs).toHaveLength(0);
});

it.each(['button', 'middle', 'menu'])(
  'closes all local sessions and splits through the workspace %s action and restarts numbering at one',
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
    const tab = root.querySelector('.workspace-tab[data-host-id=""]')!;
    if (action === 'button') tab.querySelector<HTMLButtonElement>('.tab-close')!.click();
    else if (action === 'middle')
      tab.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    else {
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await nextTick();
      document
        .querySelector<HTMLButtonElement>('[aria-label="工作区标签操作"] [role="menuitem"]')!
        .click();
    }
    await flush();
    expect(terminals.hostTabs('')).toHaveLength(0);
    expect(workspace.tabs.some((tab) => tab.key === 'host:')).toBe(false);
    expect(close.mock.calls.map(([id]) => id).sort()).toEqual(
      localPanes.map((pane) => pane.key).sort(),
    );
    expect(terminals.hostTabs(host.id)).toEqual([other]);
    root.querySelector<HTMLButtonElement>('[aria-label="本地终端"]')!.click();
    await flush();
    expect(terminals.hostTabs('')[0]?.sessionNumber).toBe(1);
    expect(root.querySelector('.terminal-tab [role="tab"]')?.textContent).toContain('会话 1');
  },
);

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
  ).toEqual(['全部主机', '本地设备']);
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

it('keeps settings in the system module and omits the old topbar exit action', async () => {
  expect(root.querySelector('.topbar [aria-label="退出应用"]')).toBeNull();
  expect(root.querySelector('.topbar [aria-label="打开通用"]')).toBeNull();
  await sidebarMenu('system', '通用');
  expect(useWorkspaceStore().current?.view).toBe('settings');
});

it('opens a fresh local terminal from welcome after the remote workspace and its sessions close', async () => {
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
  expect(terminals.panes.some((p) => p.host?.id === 'a')).toBe(false);
  root.querySelector<HTMLButtonElement>('.workspace-tab.active [role="tab"]')!.click();
  await flush();
  expect(terminals.panes.filter((p) => p.host === null)).toHaveLength(1);
});

it('merges session controls into the host toolbar and retains names within the current run', async () => {
  const terminals = useTerminalsStore();
  const host = useHostsStore().catalog!.hosts[0]!;
  terminals.open(host);
  useWorkspaceStore().navigate('terminals', host.id);
  await flush();
  expect(terminals.panes[0]).toMatchObject({ state: 'opening', connectRequested: true });
  expect(root.textContent).not.toContain('已恢复布局');
  expect(root.querySelector('.workspace-header .host-tools')).not.toBeNull();
  expect(root.querySelector('.sidebar [aria-label="当前主机工具"]')).toBeNull();
  expect(root.querySelector('.workspace-header .workspace-context')).toBeNull();
  expect(
    [...root.querySelectorAll('.workspace-header .host-tools button')].map((button) =>
      button.textContent?.trim(),
    ),
  ).toEqual(['SSH 终端', 'SFTP 文件', 'AI 运维助手', 'Docker 管理']);
  expect(root.querySelector('.terminal-session-header .terminal-tabs')).not.toBeNull();
  expect(root.querySelector('.split-toolbar, [aria-label="会话操作"]')).toBeNull();
  expect(root.querySelector('#terminal-session-tools .terminal-session-header')).not.toBeNull();
  expect(root.querySelectorAll('.terminal-session-header button')).toHaveLength(3);
  expect(root.querySelector('.terminal-tabs + [aria-label="新建终端会话"]')).not.toBeNull();
  await newSession();
  expect(terminals.tabs).toHaveLength(2);
  const current = terminals.active;
  terminals.open(host);
  await flush();
  await closeSession(2);
  await closeSession(0);
  expect(terminals.tabs).toHaveLength(1);
  expect(terminals.tabs[0]!.key).toBe(current);
  root.querySelector('.terminal-tab [role="tab"]')!.dispatchEvent(new MouseEvent('dblclick'));
  await flush();
  const dialog = document.querySelector('dialog[aria-label="重命名标签"]')!;
  const input = dialog.querySelector<HTMLInputElement>('input')!;
  input.value = '新会话';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  expect(terminals.tabs[0]!.title).toBe('新会话');
  expect(document.querySelector('dialog[aria-label="重命名标签"]')).toBeNull();
  expect(root.querySelector('.terminal-tab [role="tab"]')?.textContent).toContain('新会话');
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
      [...root.querySelectorAll('.terminal-tab [role="tab"]')].map((button) =>
        button.firstChild?.textContent?.trim(),
      );
    expect(names()).toEqual(['会话 1', '会话 2', '会话 3']);
    root.querySelector<HTMLButtonElement>('[aria-label="关闭标签 会话 2"]')!.click();
    await flush();
    expect(names()).toEqual(['会话 1', '会话 3']);
    root.querySelector<HTMLButtonElement>('[aria-label="新建终端会话"]')!.click();
    await flush();
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
      .click();
    await flush();
    expect(names()).toEqual(['会话 1']);
  },
);

it.each(['remote', 'local'])(
  'ignores right-click and opens a fresh single-pane %s session from the plus button',
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
    expect(document.querySelector('[role="menu"]')).toBeNull();
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
    expect(root.querySelector('[role="menu"]')).toBeNull();
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
    expect(root.querySelector('[role="menu"]')).toBeNull();
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
    expect(root.querySelector('.workspace-empty')?.textContent).toContain('没有打开的终端');
    expect(root.querySelector('[role="menu"]')).toBeNull();
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
  await newSession();
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
  await sidebarMenu('system', '通用');
  await flush();
  expect(workspace.hostId).toBe('b');
  expect((root.querySelector('.sidebar') as HTMLElement).style.display).not.toBe('none');
  expect((root.querySelector('.host-tree-section') as HTMLElement).style.display).toBe('none');
  expect(root.querySelector('.workspace-header .host-tools')).toBeNull();
  root.querySelector<HTMLButtonElement>('.workspace-group-tab')!.click();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'b' });
  await selectHost('a');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'a' });
  expect(root.querySelector('[aria-label="当前工作区主机"]')).toBeNull();
  expect(
    [...root.querySelectorAll('.workspace-tabs [role="tab"]')].map((t) => t.textContent?.trim()),
  ).toEqual(['全部主机', '通用', 'Host a', 'Host b']);
  workspace.close(workspace.active, 'all');
  await flush();
  root.querySelector<HTMLButtonElement>('[aria-label="欢迎页面"] .primary')!.click();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'terminals', hostId: '' });
  expect(root.querySelector('.workspace-header .host-tools')).toBeNull();
  expect(files.connections.a).toBeUndefined();
  expect(files.connections.b).toBeUndefined();
  expect(filesApi.close).toHaveBeenCalledWith('files-a', false);
  expect(filesApi.close).toHaveBeenCalledWith('files-b', false);
});

it.each([
  [
    '主机',
    '关闭',
    ['host:', 'extension:cn.hiboot.plugins.assistant:assistant:', 'models:'],
    'host:',
  ],
  [
    '主机',
    '关闭右侧',
    ['host:', 'extension:cn.hiboot.plugins.assistant:assistant:', 'models:'],
    'host:',
  ],
  ['主机', '关闭其它', ['host:a'], 'host:a'],
  ['主机', '关闭所有', [], ''],
  [
    '全部主机',
    '关闭',
    ['extension:cn.hiboot.plugins.assistant:assistant:', 'models:'],
    'extension:cn.hiboot.plugins.assistant:assistant:',
  ],
  ['全部主机', '关闭右侧', ['host:', 'host:a'], 'host:a'],
  ['全部主机', '关闭其它', ['host:', 'host:a'], 'host:a'],
  ['全部主机', '关闭所有', [], ''],
])(
  'workspace tab menu (%s / %s) closes sessions only for the removed host workspaces',
  async (target, label, keys, active) => {
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
    workspace.navigate('terminals', '');
    workspace.navigate('files', 'a');
    workspace.navigate('assistant');
    workspace.navigate('models');
    const peerPageActive = target === '全部主机' && ['关闭右侧', '关闭其它'].includes(label);
    if (peerPageActive) workspace.activate('host:a');
    const beforeMenu = peerPageActive ? 'models:' : 'host:';
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
    const hostId = label === '关闭右侧' ? '' : 'a';
    const selector =
      target === '全部主机' ? '.workspace-group-tab' : `.workspace-tab[data-host-id="${hostId}"]`;
    root.querySelector(selector)!.dispatchEvent(
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
    expect(document.querySelector('[aria-label="工作区标签操作"]')).toBeNull();
    if (keys.includes('host:a')) {
      expect(terminals.panes).toHaveLength(1);
      expect(terminals.panes[0]).toMatchObject({
        key: pane.key,
        sessionId: 'existing-session',
        state: 'connected',
      });
      expect(close).not.toHaveBeenCalled();
    } else {
      expect(terminals.panes).toHaveLength(0);
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
  workspace.navigate('files', 'b');
  await flush();
  const tab = root.querySelector<HTMLButtonElement>(
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
  root.querySelector<HTMLButtonElement>('.tree-host')!.click();
  await flush();
  const local = terminals.hostTabs('')[0]!;
  await terminals.close(local.key);
  workspace.selectHost('');
  await flush();
  expect(root.textContent).toContain('没有打开的终端');
  expect(terminals.hostTabs('')).toHaveLength(0);
  const heading = root.querySelector<HTMLElement>('.sidebar-module-title')!;
  heading.click();
  heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  expect(terminals.hostTabs('')).toHaveLength(0);
  root.querySelector<HTMLButtonElement>('.workspace-tab.active [role="tab"]')!.click();
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
    entry: { backend: null, ui: 'ui.json' },
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
      uiVersion: 1,
      title: '主机草稿工具',
      pages: [
        {
          id: 'settings',
          title: '草稿工具配置',
          initialAction: null,
          fields: [],
          actions: [],
          log: null,
        },
        {
          id: 'draft',
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
    root.querySelector<HTMLButtonElement>(`.tree-host[data-host-id="${id}"]`)!.click();
    await flush();
    root.querySelector<HTMLButtonElement>('.host-tools [data-plugin-id="dev.host-draft"]')!.click();
    await flush();
  };
  await show('a');
  const editorA = root.querySelector<HTMLTextAreaElement>(
    '.plugin-workspace[data-host-id="a"] textarea',
  )!;
  editorA.value = 'draft for a';
  editorA.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  expect(workspace.active).toBe('host:a');
  expect(workspace.module).toBe('hosts');
  expect(root.querySelector('[aria-label="插件目标主机"]')).toBeNull();
  await show('b');
  const editorB = root.querySelector<HTMLTextAreaElement>(
    '.plugin-workspace[data-host-id="b"] textarea',
  )!;
  editorB.value = 'draft for b';
  editorB.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  root.querySelector<HTMLButtonElement>('.tree-host[data-host-id="a"]')!.click();
  await flush();
  expect(workspace.current).toMatchObject({
    view: 'extension',
    hostId: 'a',
    pluginId: 'dev.host-draft',
  });
  expect(editorA.value).toBe('draft for a');
  expect(editorB.value).toBe('draft for b');
  expect(root.querySelector('.plugin-workspace[data-host-id="a"] textarea')).toBe(editorA);
  root
    .querySelector<HTMLButtonElement>(
      '.plugin-workspace[data-host-id="a"] [aria-label="插件设置"]',
    )!
    .click();
  await flush();
  expect(workspace.current).toMatchObject({ view: 'extension', hostId: 'a' });
  expect(workspace.module).toBe('hosts');
  const configuration = document.querySelector('[aria-label="主机草稿工具 · 配置"]')!;
  expect(configuration.querySelector('.plugin-settings-workspace')).not.toBeNull();
  configuration.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
  await flush();
  expect(document.querySelector('[aria-label="主机草稿工具 · 配置"]')).toBeNull();
  expect(root.querySelector('.plugin-workspace[data-host-id="a"] textarea')).toBe(editorA);
  root.querySelector<HTMLButtonElement>('.host-tools [aria-label="SSH 终端"]')!.click();
  await flush();
  expect(workspace.current?.view).toBe('terminals');
  await show('a');
  expect(editorA.value).toBe('draft for a');
  expect(workspace.tabs.filter((tab) => tab.hostId === 'a')).toHaveLength(1);
  expect(plugins.drafts['extension:dev.host-draft:draft:a']?.values.content).toBe('draft for a');
  expect(plugins.drafts['extension:dev.host-draft:draft:b']?.values.content).toBe('draft for b');
});

it('opens disabled, ungranted and UI-less plugins in a modal without creating individual tabs', async () => {
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
    expect(workspace.current?.view).toBe('plugins');
    expect(workspace.pluginConfiguration).toEqual({
      pluginId: plugin.manifest.id,
      contributionId: null,
    });
    expect(workspace.module).toBe('plugins');
    expect(root.querySelector('.activity-rail [aria-current="page"]')?.textContent).toContain(
      '插件管理',
    );
    expect(document.querySelector('[aria-label="选择使用工具的主机"]')).toBeNull();
    expect(modal.querySelector('[aria-label="插件设置"]')).not.toBeNull();
    expect(workspace.tabs.every((tab) => !tab.pluginId)).toBe(true);
    modal.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click();
    await flush();
    expect(workspace.pluginConfiguration).toBeUndefined();
  }
  expect(schema).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  expect(workspace.pluginPages).toHaveLength(0);
  expect(root.querySelector('[data-module="plugins"]')?.textContent?.trim()).toBe('插件');
  expect(root.querySelector('[aria-label="运维工具导航"]')).toBeNull();
});
