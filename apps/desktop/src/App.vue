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
import WorkspaceView from './views/WorkspaceView.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import HostSidebar from './components/HostSidebar.vue';
import AppNavigation from './components/AppNavigation.vue';
import HostTools from './components/HostTools.vue';
import { Monitor, PanelLeftOpen, Server, X } from '@lucide/vue';
import CredentialsView from './views/CredentialsView.vue';
import HostDialog from './components/HostDialog.vue';
import GroupManager from './components/GroupManager.vue';
import ImportDialog from './components/ImportDialog.vue';
import Modal from './components/Modal.vue';
import { useHostsStore } from './stores/hosts';
import { hostsApi } from './services/hosts';
import { hostDisplayName, type Host } from './types/hosts';
const TerminalsView = defineAsyncComponent(() => import('./views/TerminalsView.vue'));
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useFilesStore } from './stores/files';
import { filesApi } from './services/files';
import { errorMessage } from './services/ipc';
import { useAutomationStore } from './stores/automation';
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
  type WorkspaceView as View,
} from './types/product';
import type { WorkspaceCloseScope, WorkspaceTab } from './stores/workspace';
import GlobalSearch from './components/GlobalSearch.vue';
import BackgroundTasks from './components/BackgroundTasks.vue';
const BackupView = defineAsyncComponent(() => import('./views/BackupView.vue'));
const workspace = useWorkspaceStore(),
  notifications = useNotificationsStore(),
  background = useBackgroundStore(),
  operations = useOpsStore();
const searching = ref(false),
  aboutOpen = ref(false),
  taskPanel = ref(false),
  entryIntent = ref(''),
  automationHost = ref(''),
  networkHost = ref(''),
  networkRequest = ref(0);
async function closeAbout(): Promise<void> {
  aboutOpen.value = false;
  await nextTick();
  document.querySelector<HTMLButtonElement>('.activity-rail [aria-label="关于"]')?.focus();
}
const currentHostId = computed(() => workspace.hostId);
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
          : module === 'monitor'
            ? 'monitor'
            : module === 'operations'
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
const isHostWorkspace = computed(() => view.value !== null && hostViews.has(view.value));
const showSidebar = computed(
  () => sidebarOpen.value && (isHostWorkspace.value || view.value === null),
);
const cachedTools = computed(() =>
  (['automation', 'network', 'batch'] as const)
    .filter((tool) => workspace.tabs.some((tab) => tab.view === tool))
    .map((tool) => `${tool[0]!.toUpperCase()}${tool.slice(1)}View`),
);
function navigate(
  value: View,
  hostId = currentHostId.value,
  section?: WorkspaceTab['section'],
): void {
  if (value !== 'automation') entryIntent.value = '';
  const host = knownHost(hostId);
  if (value === 'terminals' && (host || !hostId)) {
    terminals.activateHost(host?.id ?? '');
    if (!terminals.active) terminals.open(host ?? null);
    const pane = terminals.panes.find((p) => p.key === terminals.focused);
    if (pane?.state === 'idle') pane.connectRequested = true;
  }
  if (value === 'files') files.active = hostId;
  if (value === 'operations') operations.active = hostId;
  workspace.navigate(value, hostId, section);
  if (hostViews.has(value)) store.selectedId = host?.id ?? null;
}
function fromSearch(value: View, hostId = currentHostId.value, entryId = '') {
  entryIntent.value = entryId;
  if (value === 'automation' && entryId) automationHost.value = hostId;
  navigate(value, hostId);
}
function setContext(hostId: string, connectShell = false) {
  const existing = workspace.tabs.some((tab) => hostViews.has(tab.view) && tab.hostId === hostId);
  workspace.selectHost(hostId);
  const tab = workspace.current;
  if (tab && (!existing || (connectShell && tab.view === 'terminals')))
    navigate(tab.view, tab.hostId, tab.section);
}
function tabName(tab: WorkspaceTab) {
  return hostViews.has(tab.view)
    ? tab.hostId
      ? hostDisplayName(knownHost(tab.hostId)) || '已删除主机'
      : '本地设备'
    : messages['zh-CN'][tab.view];
}
function activate(tab: WorkspaceTab) {
  if (tab.view !== 'automation') entryIntent.value = '';
  if (tab.view === 'terminals' && tab.hostId) navigate(tab.view, tab.hostId, tab.section);
  else workspace.activate(tab.key);
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
function closeFromTabMenu(scope: WorkspaceCloseScope) {
  if (!tabMenu.value) return;
  workspace.close(tabMenu.value.key, scope);
  dismissTabMenu();
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
  ).find(([, v]) => v === key)?.[0];
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  if (action === 'search') searching.value = true;
  else if (action === 'settings') navigate('settings');
  else taskPanel.value = true;
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
        ? '.host-sidebar-title [aria-label="收起主机栏"]'
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

const automation = useAutomationStore();
const AutomationView = defineAsyncComponent(() => import('./views/AutomationView.vue'));
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
function openAutomation(host: Host): void {
  if (!currentConfiguration(host)) return;
  automationHost.value = host.id;
  navigate('automation');
}
const NetworkView = defineAsyncComponent(() => import('./views/NetworkView.vue'));
const BatchView = defineAsyncComponent(() => import('./views/BatchView.vue'));
function openNetwork(host: Host): void {
  if (!currentConfiguration(host)) return;
  networkHost.value = host.id;
  networkRequest.value++;
  navigate('network');
}
const OperationsView = defineAsyncComponent(() => import('./views/OperationsView.vue'));
function openOperations(host: Host): void {
  if (!currentConfiguration(host)) return;
  navigate('operations', host.id);
}
function containerTerminal(host: Host, shell: import('./types/ops').ContainerShell): void {
  if (!currentConfiguration(host)) return;
  terminals.open(host, undefined, shell);
  navigate('terminals', host.id);
}
const MonitorView = defineAsyncComponent(() => import('./views/MonitorView.vue'));
function openMonitor(host: Host): void {
  if (!currentConfiguration(host)) return;
  navigate('monitor', host.id);
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
const groups = ref(false);
const importing = ref(false);
const exportText = ref<string | null>(null);
function openHost(): void {
  store.error = null;
  hostDialog.value = true;
}
function revealHost(host: Host): void {
  if (!store.visible.some((item) => item.id === host.id)) {
    store.search = '';
    store.tag = '';
    store.favorites = false;
  }
  store.selectedId = host.id;
  sidebarOpen.value = true;
  void nextTick(() =>
    document.querySelector('.tree-host.selected')?.scrollIntoView({ block: 'nearest' }),
  );
}
async function exportHosts(): Promise<void> {
  const result = await store.run(hostsApi.export);
  if (result.ok) exportText.value = result.value;
}
function download(): void {
  if (!exportText.value) return;
  const url = URL.createObjectURL(
    new Blob([exportText.value], { type: 'application/json;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'serverdeck-hosts.json';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    automation.start();
    background.start();
    window.addEventListener('keydown', globalShortcut, true);
    window.addEventListener('resize', revealActiveTab);
    await terminals.restore(store.catalog?.hosts ?? []);
    navigate('terminals', '');
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
  if (files.dirty) {
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
  automation.stop();
  background.stop();
  window.removeEventListener('keydown', globalShortcut, true);
  window.removeEventListener('resize', revealActiveTab);
  window.removeEventListener('beforeunload', protectDraft);
  releaseExit?.();
});
watch(
  () => terminals.panes.length,
  (count) => {
    if (!count)
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
    if (hostViews.has(t.view)) store.selectedId = currentHostId.value || null;
    if (t.view === 'files') files.active = t.hostId;
    if (t.view === 'operations') operations.active = t.hostId;
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
    <AppNavigation
      :active="view"
      :tasks="(automation.status?.active ?? 0) + (automation.status?.awaiting ?? 0)"
      @navigate="navigate($event)"
      @workspace="setContext(currentHostId)"
      @about="aboutOpen = true"
    />
    <aside v-show="showSidebar" id="host-sidebar" class="sidebar" aria-label="主机管理侧栏">
      <HostSidebar
        @collapse="toggleSidebar"
        @create="openHost()"
        @groups="groups = true"
        @import="importing = true"
        @export="exportHosts"
        @select="setContext($event.id, true)"
        @saved="revealHost"
      />
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
          v-if="!sidebarOpen && (isHostWorkspace || view === null)"
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
          :data-host-id="hostViews.has(tab.view) ? tab.hostId : undefined"
          :data-view="tab.view"
          class="workspace-tab"
          :class="{
            active: workspace.active === tab.key,
            'global-workspace-tab': !hostViews.has(tab.view),
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
            <Server v-if="hostViews.has(tab.view) && tab.hostId" :size="14" aria-hidden="true" />
            <Monitor v-else-if="hostViews.has(tab.view)" :size="14" aria-hidden="true" />
            {{ tabName(tab) }}</button
          ><button
            class="tab-close"
            :aria-label="`关闭工作区标签 ${tabName(tab)}`"
            title="仅关闭导航标签；后台任务和独立终端保留"
            @click="workspace.close(tab.key)"
          >
            <X :size="14" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div v-if="isHostWorkspace && view" class="workspace-header">
        <HostTools :active="view" :local="!currentHostId" @navigate="navigate($event)" />
      </div>
      <p v-if="isHostWorkspace && connectionChanged" class="banner" role="status">
        当前仍操作建立时的连接：{{ currentHost?.username }}@{{ currentHost?.hostname }}:{{
          currentHost?.port
        }}。主机配置已更新，请先停止此模块连接，再重新连接以应用新地址或账号。
      </p>
      <div v-if="automation.status?.awaiting" class="banner" role="status">
        自动化：{{ automation.status.awaiting }} 个待确认任务。
        <button class="text-button" @click="view = 'automation'">查看自动化任务</button>
      </div>

      <div v-show="view !== 'terminals'" class="content-scroll">
        <section v-if="view === null" class="workspace-empty" aria-label="欢迎页面">
          <h1>欢迎使用 ServerDeck</h1>
          <p>打开本地终端，或从左侧主机列表连接服务器。</p>
          <div class="action-row">
            <button class="button primary" @click="navigate('terminals', '')">打开本地终端</button>
            <button class="button" @click="openHost()">新建主机</button>
          </div>
        </section>
        <KeepAlive :include="cachedTools">
          <AutomationView
            v-if="view === 'automation'"
            :host-id="automationHost"
            :entry-id="entryIntent"
            @intent-consumed="entryIntent = ''"
          />
          <NetworkView
            v-else-if="view === 'network'"
            :host-id="networkHost"
            :request-id="networkRequest"
          />
          <BatchView v-else-if="view === 'batch'" />
        </KeepAlive>
        <OperationsView
          v-if="view === 'operations'"
          :key="`operations:${currentHostId}`"
          :host-id="currentHostId"
          :initial-tab="workspace.current?.section"
          @section="
            (s) => {
              if (workspace.current?.view === 'operations') workspace.current.section = s;
            }
          "
          @shell="containerTerminal"
        />
        <MonitorView
          v-else-if="view === 'monitor'"
          :key="`monitor:${currentHostId}`"
          :host-id="currentHostId"
          @processes="(id) => navigate('operations', id, 'processes')"
        />
        <FilesView
          v-else-if="view === 'files'"
          :key="`files:${currentHostId}`"
          :host-id="currentHostId"
          @terminal="fileTerminal"
        />
        <BackupView v-else-if="view === 'backup'" />
        <CredentialsView v-else-if="view === 'credentials'" />
        <WorkspaceView v-else-if="view === 'overview'" @settings="view = 'settings'" />
        <SettingsPanel v-else-if="view === 'settings'" />
      </div>
      <div v-show="view === 'terminals'" class="terminal-workspace">
        <TerminalsView
          v-if="view === 'terminals' || terminals.tabs.length"
          :visible="view === 'terminals'"
          :host-id="currentHostId"
          @files="openFiles"
          @monitor="openMonitor"
          @operations="openOperations"
          @automation="openAutomation"
          @network="openNetwork"
        />
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
      ><button class="text-button" @click="taskPanel = true">
        {{ files.pending }} 个未完成传输</button
      ><button class="text-button" @click="taskPanel = true">
        后台任务 {{ background.pending + (automation.status?.active ?? 0) }}</button
      ><span class="statusbar-right"
        >Rust + Tauri 2<span class="status-separator">|</span>Local First · Agentless</span
      >
    </footer>
  </div>
  <NotificationToasts />
  <Modal v-if="aboutOpen" title="关于 ServerDeck" @close="closeAbout">
    <h3>ServerDeck</h3>
    <p>本地优先的服务器运维工作台，集成 SSH 终端、SFTP 文件管理和服务器监控。</p>
    <dl class="system-details">
      <div>
        <dt>应用版本</dt>
        <dd v-if="application.state">v{{ application.state.appVersion }}</dd>
        <dd v-else>{{ application.loading ? '读取中…' : '暂不可用（本地后端未就绪）' }}</dd>
      </div>
      <div>
        <dt>技术栈</dt>
        <dd>Rust · Tauri 2 · Vue 3</dd>
      </div>
    </dl>
    <footer class="dialog-actions">
      <button class="button" @click="closeAbout">关闭</button>
    </footer>
  </Modal>
  <GlobalSearch
    v-if="searching"
    @close="searching = false"
    @navigate="fromSearch"
    @select-host="setContext"
  />
  <BackgroundTasks v-if="taskPanel" @close="taskPanel = false" @navigate="navigate" />
  <RemoteEditor v-if="files.document" />
  <Modal
    v-if="files.exitReview"
    title="确认退出 ServerDeck"
    :busy="exitBusy"
    @close="files.exitReview = false"
    ><p>
      退出将关闭所有 SSH
      会话及模块连接，并停止本地调度。若有未完成的传输、诊断、批量或自动化任务，将请求取消；未保存文本修改将放弃。已完成文件保留，远端命令是否停止仍需核对。
    </p>

    <footer class="dialog-actions">
      <button class="button" :disabled="exitBusy" @click="files.exitReview = false">继续使用</button
      ><button class="button danger" :disabled="exitBusy" @click="confirmExit">
        取消任务并退出
      </button>
    </footer></Modal
  >
  <HostDialog v-if="hostDialog" @saved="revealHost" @close="hostDialog = false" />
  <GroupManager v-if="groups" @close="groups = false" />
  <ImportDialog v-if="importing" @close="importing = false" />
  <Modal v-if="exportText !== null" title="导出非敏感主机配置" @close="exportText = null"
    ><p class="subtle">
      JSON
      格式，仅包含主机、分组、标签及备注。排除凭据、凭据引用、私钥路径、密码和私钥口令。请确认备注中没有自行填写的秘密。
    </p>
    <textarea class="export-text" :value="exportText" readonly aria-label="导出内容"></textarea>
    <footer class="dialog-actions">
      <button class="button" @click="exportText = null">关闭</button
      ><button class="button primary" @click="download">下载 JSON</button>
    </footer></Modal
  >
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
