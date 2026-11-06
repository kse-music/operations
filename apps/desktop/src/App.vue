<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
  nextTick,
} from 'vue';
import { useApplicationStore } from './stores/application';
import { useTheme } from './composables/theme';
import AboutView from './views/AboutView.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import HostSidebar from './components/HostSidebar.vue';
import AppNavigation from './components/AppNavigation.vue';
import AppModules from './components/AppModules.vue';
import type { NavigationModule } from './types/navigation';
import HostTools from './components/HostTools.vue';
import { Monitor, PanelLeftOpen, Server, X } from '@lucide/vue';
import CredentialsView from './views/CredentialsView.vue';
import HostDialog from './components/HostDialog.vue';
import ImportDialog from './components/ImportDialog.vue';
import Modal from './components/Modal.vue';
import { useHostsStore } from './stores/hosts';
import { hostDisplayName, type Host } from './types/hosts';
const TerminalsView = defineAsyncComponent(() => import('./views/TerminalsView.vue'));
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useFilesStore } from './stores/files';
import { filesApi } from './services/files';
import { errorMessage } from './services/ipc';
import { useWorkspaceStore } from './stores/workspace';
import NotificationToasts from './components/NotificationToasts.vue';
import { useNotificationsStore } from './stores/notifications';
import { useBackgroundStore } from './stores/background';
import { useOpsStore } from './stores/ops';
import { sameHostConnection } from './services/product-links';
import {
  messages,
  globalKey,
  defaultProductPreferences,
  hostViews,
  settingsCategories,
  type WorkspaceView as View,
} from './types/product';
import { isHostTab, type WorkspaceCloseScope, type WorkspaceTab } from './stores/workspace';
import { serverPluginFor } from './services/server-plugins';
import GlobalSearch from './components/GlobalSearch.vue';
import { usePluginsStore } from './stores/plugins';
import PluginDialogs from './components/PluginDialogs.vue';
const PluginsView = defineAsyncComponent(() => import('./views/PluginsView.vue'));
const PluginPage = defineAsyncComponent(() => import('./views/PluginPage.vue'));
const PluginView = defineAsyncComponent(() => import('./views/PluginView.vue'));
const plugins = usePluginsStore();
const ModelsView = defineAsyncComponent(() => import('./views/ModelsView.vue'));
const workspace = useWorkspaceStore(),
  notifications = useNotificationsStore(),
  background = useBackgroundStore(),
  operations = useOpsStore();
const searching = ref(false);

const currentHostId = computed(() => workspace.hostId);
const pluginTarget = ref<{ id: string; contribution: string } | null>(null);
function knownHost(id: string) {
  return (
    store.catalog?.hosts.find((h) => h.id === id) ??
    terminals.panes.find((p) => p.host?.id === id)?.host ??
    files.connections[id]?.host ??
    operations.connections[id]?.host
  );
}
const currentHost = computed(() => {
  const id = currentHostId.value,
    configured = knownHost(id);
  if (!configured) return;
  const module = workspace.current?.view,
    kind =
      module === 'terminals'
        ? 'terminal'
        : module === 'files'
          ? 'files'
          : module === 'server'
            ? 'operations'
            : module === 'extension'
              ? 'operations'
              : '';
  const terminal = terminals.panes.find((p) => p.key === terminals.focused && p.host?.id === id);
  const snapshot =
    kind === 'terminal'
      ? terminal?.host
      : kind === 'files'
        ? files.connections[id]?.host
        : kind === 'operations'
          ? operations.connections[id]?.host
          : undefined;
  const session =
    kind === 'terminal'
      ? terminal?.sessionId
      : kind === 'files'
        ? files.connections[id]?.id
        : kind === 'operations'
          ? operations.connections[id]?.session?.id
          : undefined;
  const actual = background.connections?.find(
    (c) => c.hostId === id && c.kind === kind && (session ? c.id === session : true),
  );
  return actual
    ? { ...configured, hostname: actual.hostname, port: actual.port, username: actual.username }
    : (snapshot ?? configured);
});
const connectionChanged = computed(() => {
  const h = currentHost.value,
    c = store.catalog?.hosts.find((h) => h.id === currentHostId.value);
  return h && c && (h.hostname !== c.hostname || h.port !== c.port || h.username !== c.username);
});
const view = computed<View | null>({
  get: () => workspace.current?.view ?? null,
  set: (value) => {
    if (value) navigate(value);
  },
});
const isHostWorkspace = computed(
  () =>
    view.value !== null &&
    (hostViews.has(view.value) || (view.value === 'extension' && !!workspace.current?.hostId)),
);
const settingsCategory = computed(() =>
  settingsCategories.find((item) => item.view === view.value),
);
const settingsOpen = computed(() =>
  workspace.tabs.some((tab) => settingsCategories.some((item) => item.view === tab.view)),
);
const showSidebar = computed(() => sidebarOpen.value);
const showHostTree = computed(() => workspace.module === 'hosts');
const cachedPluginPages = computed(() => workspace.pluginPages);
function navigate(
  value: View,
  hostId = currentHostId.value,
  section?: WorkspaceTab['section'],
): void {
  const host = knownHost(hostId);
  if (value === 'terminals' && (host || !hostId)) {
    terminals.activateHost(host?.id ?? '');
    if (!terminals.active) terminals.open(host ?? null);
    const pane = terminals.panes.find((p) => p.key === terminals.focused);
    if (pane?.state === 'idle') pane.connectRequested = true;
  }
  if (value === 'files') files.active = hostId;
  if (value === 'server') operations.active = hostId;
  workspace.navigate(value, hostId, section);
  if (hostViews.has(value)) store.selectedId = host?.id ?? null;
}
function fromSearch(value: View, hostId = currentHostId.value) {
  navigate(value, hostId);
}
function setContext(hostId: string, connectShell = false) {
  const existing = workspace.tabs.some((tab) => isHostTab(tab) && tab.hostId === hostId);
  workspace.selectHost(hostId);
  const tab = workspace.current;
  if (tab && (!existing || (connectShell && tab.view === 'terminals')))
    navigate(tab.view, tab.hostId, tab.section);
}
function tabName(tab: WorkspaceTab) {
  if (isHostTab(tab))
    return tab.hostId ? hostDisplayName(knownHost(tab.hostId)) || '已删除主机' : '本地设备';
  if (tab.pluginId)
    return `${plugins.installed.find((p) => p.manifest.id === tab.pluginId)?.manifest.name ?? '插件'}${tab.view === 'pluginSettings' ? ' · 设置' : ''}`;
  return hostViews.has(tab.view)
    ? tab.hostId
      ? hostDisplayName(knownHost(tab.hostId)) || '已删除主机'
      : '本地设备'
    : messages['zh-CN'][tab.view];
}
function activate(tab: WorkspaceTab) {
  if (tab.view === 'terminals' && tab.hostId) navigate(tab.view, tab.hostId, tab.section);
  else workspace.activate(tab.key);
}
function selectModule(module: NavigationModule): void {
  workspace.selectModule(module);
}
function revealActiveTab() {
  document
    .querySelector('.workspace-tab.active')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
const tabMenu = ref<{ key: string; x: number; y: number } | null>(null);
const tabMenuElement = ref<HTMLElement>();
let tabMenuTrigger: HTMLButtonElement | null = null;
const tabMenuIndex = computed(() =>
  workspace.tabs.findIndex((tab) => tab.key === tabMenu.value?.key),
);
const tabCloseActions: { scope: WorkspaceCloseScope; label: string }[] = [
  { scope: 'current', label: '关闭' },
  { scope: 'right', label: '关闭右侧' },
  { scope: 'others', label: '关闭其它' },
  { scope: 'all', label: '关闭所有' },
];
function dismissTabMenu(event?: Event) {
  if (event?.target instanceof Node && tabMenuElement.value?.contains(event.target)) return;
  tabMenu.value = null;
}
function restoreTabFocus() {
  if (tabMenuTrigger?.isConnected) tabMenuTrigger.focus({ preventScroll: true });
  else document.querySelector<HTMLButtonElement>('.workspace-tabs [aria-selected=true]')?.focus();
}
async function openTabMenu(tab: WorkspaceTab, event: MouseEvent | KeyboardEvent) {
  const target = event.currentTarget as HTMLElement;
  tabMenuTrigger = target.querySelector<HTMLButtonElement>('[role=tab]');
  const anchor = target.getBoundingClientRect();
  const keyboard = event instanceof KeyboardEvent || (!event.clientX && !event.clientY);
  tabMenu.value = {
    key: tab.key,
    x: keyboard ? anchor.left : event.clientX,
    y: keyboard ? anchor.bottom : event.clientY,
  };
  await nextTick();
  if (!tabMenu.value || !tabMenuElement.value) return;
  const bounds = tabMenuElement.value.getBoundingClientRect();
  tabMenu.value.x = Math.max(8, Math.min(tabMenu.value.x, window.innerWidth - bounds.width - 8));
  tabMenu.value.y = Math.max(8, Math.min(tabMenu.value.y, window.innerHeight - bounds.height - 8));
  tabMenuElement.value
    .querySelector<HTMLButtonElement>('[role=menuitem]')
    ?.focus({ preventScroll: true });
}
function tabContextKeys(tab: WorkspaceTab, event: KeyboardEvent) {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
  event.preventDefault();
  event.stopPropagation();
  void openTabMenu(tab, event);
}
async function closeFromTabMenu(scope: WorkspaceCloseScope) {
  if (!tabMenu.value) return;
  const key = tabMenu.value.key;
  dismissTabMenu();
  await workspace.close(key, scope);
  void nextTick(restoreTabFocus);
}
function tabMenuKeys(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') event.preventDefault();
    event.stopPropagation();
    dismissTabMenu();
    restoreTabFocus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = [
    ...(tabMenuElement.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}
async function workspaceKeys(event: KeyboardEvent) {
  if (
    !(event.target as HTMLElement).matches('[role=tab]') ||
    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
  )
    return;
  event.preventDefault();
  const tabs = workspace.tabs,
    n = tabs.findIndex((t) => t.key === workspace.active),
    i =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (n + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  activate(tabs[i]!);
  await nextTick();
  document.querySelector<HTMLButtonElement>('.workspace-tabs [aria-selected=true]')?.focus();
}

const defaultShortcuts = defaultProductPreferences().shortcuts;
function globalShortcut(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    document.querySelector('dialog[open]') ||
    (event.target instanceof HTMLInputElement && event.target.readOnly)
  )
    return;
  const key = globalKey(event);
  if (!key) return;
  const action = Object.entries(
    application.state?.config.product?.shortcuts ?? defaultShortcuts,
  ).find(([action, v]) => ['search', 'settings'].includes(action) && v === key)?.[0];
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  if (action === 'search') searching.value = true;
  else if (action === 'settings') navigate('settings');
}
const sidebarDraft = ref<number | null>(null);
const sidebarOpen = ref(!window.matchMedia('(max-width: 720px)').matches);
function clampSidebarWidth(width: number): number {
  return Math.max(200, Math.min(400, Math.round(width)));
}
async function toggleSidebar(): Promise<void> {
  sidebarOpen.value = !sidebarOpen.value;
  await nextTick();
  document
    .querySelector<HTMLButtonElement>(
      sidebarOpen.value
        ? '.sidebar-workspace-heading [aria-label="收起主机栏"]'
        : '.workspace-tabs [aria-label="展开主机栏"]',
    )
    ?.focus({ preventScroll: true });
  revealActiveTab();
}
function resizeSidebar(event: PointerEvent) {
  event.preventDefault();
  const start = event.clientX,
    width = application.state?.config.sidebarWidth ?? 248;
  function move(e: PointerEvent) {
    sidebarDraft.value = clampSidebarWidth(width + e.clientX - start);
  }
  function end() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    void saveSidebar(sidebarDraft.value ?? width);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end, { once: true });
  window.addEventListener('pointercancel', end, { once: true });
}
async function saveSidebar(width: number) {
  if (application.state) {
    await application.save({ ...application.state.config, sidebarWidth: clampSidebarWidth(width) });
    sidebarDraft.value = null;
  }
}
function sidebarKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  void saveSidebar(
    (application.state?.config.sidebarWidth ?? 248) + (event.key === 'ArrowRight' ? 8 : -8),
  );
}

function currentConfiguration(host: Host): boolean {
  const configured = store.catalog?.hosts.find((h) => h.id === host.id);
  if (!configured || !sameHostConnection(host, configured)) {
    notifications.push(
      '主机连接配置已变更。当前会话保持原连接；请从主机树确认新配置后打开模块，或先断开并重新连接。',
      true,
    );
    return false;
  }
  return true;
}
const ServerView = defineAsyncComponent(() => import('./views/ServerView.vue'));
function openServer(host: Host): void {
  if (!currentConfiguration(host)) return;
  navigate('server', host.id);
}
const FilesView = defineAsyncComponent(() => import('./views/FilesView.vue'));
const RemoteEditor = defineAsyncComponent(() => import('./components/RemoteEditor.vue'));
import { useTerminalsStore } from './stores/terminals';

const application = useApplicationStore();
const store = useHostsStore();
const terminals = useTerminalsStore();
const files = useFilesStore();
let releaseExit: UnlistenFn | undefined;
const exitBusy = ref(false);
async function confirmExit(): Promise<void> {
  exitBusy.value = true;
  try {
    await filesApi.exit(true);
  } catch (cause) {
    files.error = errorMessage(cause);
    exitBusy.value = false;
  }
}
function openFiles(host: Host, path?: string, pane?: string): void {
  if (!currentConfiguration(host)) return;
  dismissTabMenu();
  navigate('files', host.id);
  void files.open(host, path, pane);
}
function fileTerminal(host: Host, action: import('./types/files').FileTerminalAction): void {
  if (!currentConfiguration(host)) return;
  terminals.open(host, action);
  navigate('terminals', host.id);
}

const hostDialog = ref(false);
const hostFolderId = ref<string | null>(null);
const importingOpenSsh = ref(false);
function openHost(groupId: string | null = null): void {
  store.error = null;
  hostFolderId.value = groupId;
  hostDialog.value = true;
}
function revealHost(host: Host): void {
  if (!store.visible.some((item) => item.id === host.id)) {
    store.search = '';
  }
  store.selectedId = host.id;
  sidebarOpen.value = true;
  void nextTick(() =>
    document.querySelector('.tree-host.selected')?.scrollIntoView({ block: 'nearest' }),
  );
}
const theme = computed(() => application.state?.config.theme);
useTheme(theme);
const layoutStyle = computed(() => ({
  '--sidebar-width': `${sidebarDraft.value ?? application.state?.config.sidebarWidth ?? 248}px`,
}));
function preventNativeContextMenu(event: MouseEvent): void {
  event.preventDefault();
}
onMounted(async () => {
  // Capture also covers teleported dialogs and children that stop propagation (e.g. xterm).
  document.addEventListener('contextmenu', preventNativeContextMenu, true);
  document.addEventListener('pointerdown', dismissTabMenu, true);
  document.addEventListener('contextmenu', dismissTabMenu, true);
  window.addEventListener('resize', dismissTabMenu);
  document.addEventListener('scroll', dismissTabMenu, true);
  await application.initialize();
  if (application.ready) {
    await store.load();
    background.start();
    plugins.start();
    window.addEventListener('keydown', globalShortcut, true);
    window.addEventListener('resize', revealActiveTab);
    void files.poll();
    try {
      releaseExit = await listen<[number, number]>('app-exit-review', (event) => {
        void event;
        files.exitReview = true;
      });
    } catch (cause) {
      files.error = `关闭确认入口注册失败：${errorMessage(cause)}`;
    }
  }
});
function protectDraft(event: BeforeUnloadEvent): void {
  if (files.dirty || plugins.dirtyCount) {
    event.preventDefault();
    event.returnValue = '';
  }
}
window.addEventListener('beforeunload', protectDraft);
onBeforeUnmount(() => {
  document.removeEventListener('contextmenu', preventNativeContextMenu, true);
  document.removeEventListener('pointerdown', dismissTabMenu, true);
  document.removeEventListener('contextmenu', dismissTabMenu, true);
  window.removeEventListener('resize', dismissTabMenu);
  document.removeEventListener('scroll', dismissTabMenu, true);
  background.stop();
  plugins.stop();
  window.removeEventListener('keydown', globalShortcut, true);
  window.removeEventListener('resize', revealActiveTab);
  window.removeEventListener('beforeunload', protectDraft);
  releaseExit?.();
});
function openPlugin(
  id: string,
  contribution: string,
  hostId = workspace.current?.hostId ?? '',
  section?: WorkspaceTab['section'],
): void {
  const installed = plugins.installed.find((p) => p.manifest.id === id);
  const entry = installed?.manifest.contributions.find((entry) => entry.id === contribution);
  if (installed && entry && !hostId && !['tool', 'settings'].includes(entry.kind)) {
    pluginTarget.value = { id, contribution };
    return;
  }
  if (installed)
    void workspace.openPlugin(id, contribution, hostId, section).catch((cause) => {
      plugins.error = errorMessage(cause);
    });
}
async function surfaceNavigate(section: NonNullable<WorkspaceTab['section']>) {
  try {
    const entry = await serverPluginFor(currentHostId.value, section);
    if (entry) openPlugin(entry.pluginId, entry.id, currentHostId.value, section);
    else {
      notifications.push('请先在插件管理中启用并授权提供此功能的插件。', true);
      navigate('plugins');
    }
  } catch (cause) {
    plugins.error = errorMessage(cause);
  }
}
watch(
  () => JSON.stringify([plugins.installed, plugins.grants]),
  (next, previous) => {
    const old = previous ? (JSON.parse(previous)[1] as typeof plugins.grants) : {};
    const invalid = workspace.tabs.filter(
      (tab) => tab.pluginId && !plugins.installed.some((p) => p.manifest.id === tab.pluginId),
    );
    for (const tab of invalid) {
      if (isHostTab(tab)) {
        tab.view = 'terminals';
        delete tab.pluginId;
        delete tab.contributionId;
      } else void workspace.close(tab.key);
    }
    for (const tab of workspace.pluginPages) {
      if (
        tab.pluginId &&
        JSON.stringify(old[tab.pluginId]) !== JSON.stringify(plugins.grants[tab.pluginId])
      ) {
        plugins.forget(tab.key);
        plugins.clearPlugin(tab.pluginId);
      }
    }
    workspace.pluginPages = workspace.pluginPages.filter((page) =>
      plugins.installed.some((plugin) => plugin.manifest.id === page.pluginId),
    );
  },
);
watch(
  () => terminals.panes.length,
  (count) => {
    if (!count && !workspace.closing.length)
      for (const tab of [...workspace.tabs]) if (tab.view === 'terminals') workspace.close(tab.key);
  },
);
watch(
  () => [workspace.active, workspace.hostId, workspace.current?.view],
  () => {
    void nextTick(() => {
      revealActiveTab();
      const content = document.querySelector('.content-scroll');
      if (content) content.scrollTop = 0;
    });
    const t = workspace.current;
    if (!t) return;
    if (isHostTab(t)) store.selectedId = currentHostId.value || null;
    if (t.view === 'files') files.active = t.hostId;
    if (t.view === 'server') operations.active = t.hostId;
    if (t.view === 'terminals') terminals.activateHost(currentHostId.value);
  },
);
watch(
  () => application.state?.config.product?.language,
  (language) => {
    document.documentElement.lang = language ?? 'zh-CN';
  },
  { immediate: true },
);
watch(
  () => application.notice,
  (v) => notifications.push(v),
);
watch(
  () => store.notice,
  (v) => notifications.push(v),
);
watch(
  () => files.notice,
  (v) => notifications.push(v),
);
</script>

<template>
  <div class="app-shell" :class="{ 'hosts-hidden': !showSidebar }" :style="layoutStyle">
    <AppModules :active="workspace.module" @select="selectModule" />
    <aside v-show="showSidebar" id="host-sidebar" class="sidebar" aria-label="主机管理侧栏">
      <AppNavigation
        :active="view"
        :module="workspace.module"
        @navigate="navigate($event)"
        @collapse="toggleSidebar"
      >
        <HostSidebar
          v-show="showHostTree"
          :active="showHostTree && sidebarOpen"
          :local-active="view === 'terminals' && !currentHostId"
          @plugin="openPlugin"
          @local-terminal="navigate('terminals', '')"
          @create="openHost($event)"
          @import-openssh="importingOpenSsh = true"
          @select="setContext($event.id, true)"
          @saved="revealHost"
        />
      </AppNavigation>
    </aside>
    <div
      v-if="showSidebar"
      class="sidebar-resizer"
      role="separator"
      aria-label="调整主机侧栏宽度"
      aria-orientation="vertical"
      tabindex="0"
      :aria-valuenow="sidebarDraft ?? application.state?.config.sidebarWidth ?? 248"
      aria-valuemin="200"
      aria-valuemax="400"
      @pointerdown="resizeSidebar"
      @keydown="sidebarKey"
    />
    <main class="main-content">
      <div
        class="tabbar workspace-tabs"
        role="tablist"
        aria-label="工作区标签"
        @keydown="workspaceKeys"
      >
        <button
          v-if="!sidebarOpen"
          class="workspace-sidebar-button"
          aria-label="展开主机栏"
          title="展开主机栏"
          :aria-expanded="false"
          aria-controls="host-sidebar"
          @click="toggleSidebar"
        >
          <PanelLeftOpen :size="18" aria-hidden="true" />
        </button>
        <div
          v-for="tab in workspace.tabs"
          :key="tab.key"
          :data-host-id="isHostTab(tab) ? tab.hostId : undefined"
          :data-view="tab.view"
          :data-plugin-id="tab.pluginId"
          class="workspace-tab"
          :class="{
            active: workspace.active === tab.key,
            'global-workspace-tab': !isHostTab(tab),
          }"
          @mousedown.middle.prevent
          @auxclick.middle.prevent="workspace.close(tab.key)"
          @contextmenu.prevent.stop="openTabMenu(tab, $event)"
          @keydown="tabContextKeys(tab, $event)"
        >
          <button
            role="tab"
            :aria-selected="workspace.active === tab.key"
            :tabindex="workspace.active === tab.key ? 0 : -1"
            :title="tabName(tab)"
            @click="activate(tab)"
          >
            <Server v-if="isHostTab(tab) && tab.hostId" :size="14" aria-hidden="true" />
            <Monitor v-else-if="isHostTab(tab)" :size="14" aria-hidden="true" />
            {{ tabName(tab) }}</button
          ><button
            class="tab-close"
            :disabled="workspace.closing.includes(tab.key)"
            :aria-label="`关闭工作区标签 ${tabName(tab)}`"
            :title="isHostTab(tab) ? '关闭该设备的连接和临时传输记录' : '关闭此页面'"
            @click="workspace.close(tab.key)"
          >
            <X :size="14" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        v-show="isHostWorkspace"
        class="workspace-header"
        :inert="workspace.closing.includes(workspace.active)"
      >
        <div v-show="view === 'terminals'" id="terminal-session-tools"></div>
        <HostTools
          v-if="isHostWorkspace && view && currentHostId"
          :active="view"
          :active-plugin="workspace.current?.pluginId"
          :local="false"
          @navigate="navigate($event)"
          @plugin="openPlugin"
        />
      </div>
      <p v-if="isHostWorkspace && connectionChanged" class="banner" role="status">
        当前仍操作建立时的连接：{{ currentHost?.username }}@{{ currentHost?.hostname }}:{{
          currentHost?.port
        }}。主机配置已更新，请先停止此模块连接，再重新连接以应用新地址或账号。
      </p>
      <div
        v-show="view !== 'terminals'"
        class="content-scroll"
        :class="{ 'plugin-frame-workspace': view === 'extension' }"
        :inert="workspace.closing.includes(workspace.active)"
        :aria-busy="workspace.closing.includes(workspace.active)"
      >
        <section v-if="view === null" class="workspace-empty" aria-label="欢迎页面">
          <h1>欢迎使用 ServerDeck</h1>
          <p>打开本地终端，或从左侧主机列表连接服务器。</p>
          <div class="action-row">
            <button class="button primary" @click="navigate('terminals', '')">打开本地终端</button>
            <button class="button" @click="openHost()">新建主机</button>
          </div>
        </section>
        <PluginView
          v-for="page in cachedPluginPages"
          v-show="workspace.activePluginKey === page.key"
          :key="page.key"
          :active="
            workspace.activePluginKey === page.key &&
            !workspace.closing.includes(page.hostId ? `host:${page.hostId}` : page.key)
          "
          :plugin-id="page.pluginId!"
          :contribution-id="page.contributionId!"
          :host-id="page.hostId"
          :tab-key="page.key"
          :initial-section="page.section"
          @settings="workspace.openPluginSettings(page.pluginId!)"
          @contribution="(contribution) => openPlugin(page.pluginId!, contribution, page.hostId)"
          @section="
            (section) => {
              page.section = section;
              if (workspace.activePluginKey === page.key && workspace.current)
                workspace.current.section = section;
            }
          "
          @surface-navigate="surfaceNavigate"
        />
        <ServerView
          v-if="view === 'server'"
          :key="`server:${currentHostId}`"
          :host-id="currentHostId"
          :initial-section="workspace.current?.section"
          @plugin="openPlugin"
          @manage="navigate('plugins')"
        />
        <FilesView
          v-else-if="view === 'files'"
          :key="`files:${currentHostId}`"
          :host-id="currentHostId"
          @terminal="fileTerminal"
        />
        <PluginsView v-else-if="view === 'plugins'" @settings="workspace.openPluginSettings" />
        <PluginPage
          v-else-if="view === 'pluginSettings' && workspace.current?.pluginId"
          :key="workspace.current.pluginId"
          :plugin-id="workspace.current.pluginId"
        />
        <ModelsView v-else-if="view === 'models'" />
        <AboutView v-else-if="view === 'about'" />
        <CredentialsView v-else-if="view === 'credentials'" />
        <SettingsPanel
          v-if="settingsOpen"
          v-show="settingsCategory"
          :category="settingsCategory?.id ?? 'general'"
          @category="(id) => navigate(settingsCategories.find((item) => item.id === id)!.view)"
        />
      </div>
      <div
        v-show="view === 'terminals'"
        class="terminal-workspace"
        :inert="workspace.closing.includes(workspace.active)"
      >
        <div class="terminal-primary">
          <TerminalsView
            v-if="view === 'terminals' || terminals.tabs.length"
            :visible="view === 'terminals'"
            :host-id="currentHostId"
            toolbar-target="#terminal-session-tools"
            @files="openFiles"
            @server="openServer"
          />
        </div>
      </div>
    </main>
    <footer class="statusbar">
      <span
        ><span :class="['status-dot', { offline: !application.ready }]"></span
        >{{
          application.ready ? '本地后端已就绪' : application.loading ? '初始化中' : '后端未连接'
        }}</span
      >
      <span
        >{{ store.catalog ? `${store.catalog.hosts.length} 台主机` : '主机列表未加载' }} ·
        {{ store.busy ? '操作中' : `${terminals.connectedCount} 个已连接终端` }}</span
      >
    </footer>
  </div>
  <NotificationToasts />
  <Modal v-if="pluginTarget" title="选择使用工具的主机" @close="pluginTarget = null">
    <p>选择主机后，工具将在该主机工作区打开。</p>
    <div class="action-row">
      <button
        v-for="host in store.catalog?.hosts ?? []"
        :key="host.id"
        class="button"
        @click="
          openPlugin(pluginTarget.id, pluginTarget.contribution, host.id);
          pluginTarget = null;
        "
      >
        {{ hostDisplayName(host) }}
      </button>
      <p v-if="!store.catalog?.hosts.length">暂无主机，请先在主机管理中添加。</p>
    </div>
  </Modal>
  <PluginDialogs />
  <GlobalSearch
    v-if="searching"
    @close="searching = false"
    @navigate="fromSearch"
    @select-host="setContext"
    @plugin="openPlugin"
  />
  <RemoteEditor v-if="files.document" />
  <Modal
    v-if="files.exitReview"
    title="确认退出 ServerDeck"
    :busy="exitBusy"
    @close="files.exitReview = false"
    ><p>
      退出将关闭所有 SSH
      会话及模块连接。若有未完成的传输或诊断任务，将请求取消；未保存文本修改将放弃。已完成文件保留，远端命令是否停止仍需核对。
    </p>

    <footer class="dialog-actions">
      <button class="button" :disabled="exitBusy" @click="files.exitReview = false">继续使用</button
      ><button class="button danger" :disabled="exitBusy" @click="confirmExit">
        取消任务并退出
      </button>
    </footer></Modal
  >
  <HostDialog
    v-if="hostDialog"
    :group-id="hostFolderId"
    @saved="revealHost"
    @close="hostDialog = false"
  />
  <ImportDialog v-if="importingOpenSsh" @close="importingOpenSsh = false" />
  <Teleport to="body">
    <div
      v-if="tabMenu && tabMenuIndex >= 0"
      ref="tabMenuElement"
      class="context-menu workspace-tab-menu"
      role="menu"
      aria-label="工作区标签操作"
      :style="{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }"
      @keydown="tabMenuKeys"
    >
      <button
        v-for="action in tabCloseActions"
        :key="action.scope"
        role="menuitem"
        tabindex="-1"
        :disabled="
          (action.scope === 'right' && tabMenuIndex === workspace.tabs.length - 1) ||
          (action.scope === 'others' && workspace.tabs.length < 2)
        "
        @click="closeFromTabMenu(action.scope)"
      >
        {{ action.label }}
      </button>
    </div>
  </Teleport>
</template>
