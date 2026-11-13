<script setup lang="ts">
import { tr } from './i18n/messages';

import {
  computed,
  defineAsyncComponent,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
  nextTick,
  type Component,
} from 'vue';
import { useApplicationStore } from './stores/application';
import { useUpdatesStore } from './stores/updates';
import { useTheme } from './composables/theme';
import { interfaceFontSizes } from './types/preferences';
import SettingsView from './views/SettingsView.vue';
import SettingsNavigation from './components/SettingsNavigation.vue';
import TerminalStatus from './components/TerminalStatus.vue';
import HostSidebar from './components/HostSidebar.vue';
import AppNavigation from './components/AppNavigation.vue';
import AppHeader from './components/AppHeader.vue';
import WelcomeView from './views/WelcomeView.vue';
import HostTools from './components/HostTools.vue';
import {
  CopyX,
  FileWarning,
  Info,
  ListTodo,
  ListX,
  PanelRightClose,
  Puzzle,
  Server,
  Unplug,
  X,
} from '@lucide/vue';
import HostDialog from './components/HostDialog.vue';
import ImportDialog from './components/ImportDialog.vue';
import Modal from './components/Modal.vue';
import FileOpenDialogs from './components/FileOpenDialogs.vue';
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
  viewLabels,
  globalKey,
  defaultProductPreferences,
  hostViews,
  type WorkspaceView as View,
} from './types/product';
import { isHostTab, type WorkspaceCloseScope, type WorkspaceTab } from './stores/workspace';
import { serverPluginFor } from './services/server-plugins';
import GlobalSearch from './components/GlobalSearch.vue';
import { usePluginsStore } from './stores/plugins';
import PluginDialogs from './components/PluginDialogs.vue';
const PluginView = defineAsyncComponent(() => import('./views/PluginView.vue'));
const plugins = usePluginsStore();
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
const isHostWorkspace = computed(() => {
  const tab = workspace.current;
  return !!tab && isHostTab(tab);
});
const settingsOpen = computed(() => workspace.area === 'settings');
const statusPane = computed(() => {
  if (settingsOpen.value || view.value !== 'terminals') return;
  const tab = terminals.tabs.find((tab) => tab.key === terminals.active);
  if (!tab || (tab.panes[0]?.host?.id ?? '') !== currentHostId.value) return;
  return tab.panes.find((pane) => pane.key === terminals.focused) ?? tab.panes[0];
});
const cachedPluginPages = computed(() => workspace.pluginPages);
function navigate(
  value: View,
  hostId = currentHostId.value,
  section?: WorkspaceTab['section'],
): void {
  if (workspace.navigationBlocked) return;
  const host = knownHost(hostId);
  if (value === 'terminals' && (host || !hostId)) {
    if (host) terminals.activateHost(host.id);
    else terminals.activateLocal();
    if (
      !terminals.active &&
      (hostId || !workspace.tabs.some((tab) => isHostTab(tab) && !tab.hostId))
    )
      terminals.open(host ?? null);
    const pane = terminals.panes.find((p) => p.key === terminals.focused);
    if (pane?.state === 'idle' && !pane.savedSource) pane.connectRequested = true;
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
    return tab.hostId ? hostDisplayName(knownHost(tab.hostId)) || tr('已删除主机') : tr('本地终端');
  if (tab.pluginId) {
    const plugin = plugins.installed.find((p) => p.manifest.id === tab.pluginId);
    return plugin ? plugins.metadata(plugin, plugin.manifest.name) : tr('插件');
  }
  return hostViews.has(tab.view)
    ? tab.hostId
      ? hostDisplayName(knownHost(tab.hostId)) || tr('已删除主机')
      : tr('本地设备')
    : viewLabels[tab.view];
}
function activate(tab: WorkspaceTab) {
  if (tab.view === 'terminals' && tab.hostId) navigate(tab.view, tab.hostId, tab.section);
  else workspace.activate(tab.key);
}
function revealActiveTab() {
  for (const tab of document.querySelectorAll('.workspace-tab.active'))
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
const tabMenu = ref<{ key: string; x: number; y: number } | null>(null);
const tabMenuElement = ref<HTMLElement>();
let tabMenuTrigger: HTMLButtonElement | null = null;
const tabMenuIndex = computed(() =>
  workspace.homeTabs.findIndex((tab) => tab.key === tabMenu.value?.key),
);
const hasTabsToRight = computed(
  () => tabMenuIndex.value >= 0 && tabMenuIndex.value < workspace.homeTabs.length - 1,
);
const hasOtherTabs = computed(() => workspace.homeTabs.length > 1);
const tabCloseActions: {
  scope: WorkspaceCloseScope;
  label: string;
  icon: Component;
  iconClass: string;
}[] = [
  {
    scope: 'current',
    icon: X,
    iconClass: 'menu-icon-muted',
    get label() {
      return tr('关闭');
    },
  },
  {
    scope: 'right',
    icon: PanelRightClose,
    iconClass: 'menu-icon-gold',
    get label() {
      return tr('关闭右侧');
    },
  },
  {
    scope: 'others',
    icon: CopyX,
    iconClass: 'menu-icon-purple',
    get label() {
      return tr('关闭其它');
    },
  },
  {
    scope: 'all',
    icon: ListX,
    iconClass: 'menu-icon-red',
    get label() {
      return tr('关闭所有');
    },
  },
];
function dismissTabMenu(event?: Event) {
  if (event?.target instanceof Node && tabMenuElement.value?.contains(event.target)) return;
  tabMenu.value = null;
}
function restoreTabFocus() {
  if (tabMenuTrigger?.isConnected) tabMenuTrigger.focus({ preventScroll: true });
  else document.querySelector<HTMLButtonElement>('.workspace-tab.active [role=tab]')?.focus();
}
async function openTabMenu(key: string, event: MouseEvent | KeyboardEvent) {
  const target = event.currentTarget as HTMLElement;
  tabMenuTrigger =
    target instanceof HTMLButtonElement
      ? target
      : target.querySelector<HTMLButtonElement>('[role=tab]');
  const anchor = target.getBoundingClientRect();
  const keyboard = event instanceof KeyboardEvent || (!event.clientX && !event.clientY);
  tabMenu.value = {
    key,
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
function tabContextKeys(key: string, event: KeyboardEvent) {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
  event.preventDefault();
  event.stopPropagation();
  void openTabMenu(key, event);
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
function workspaceKeys(event: KeyboardEvent) {
  const target = event.target as HTMLButtonElement;
  if (
    !target.matches('[role=tab]') ||
    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
  )
    return;
  event.preventDefault();
  const tabs = [
      ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role=tab]'),
    ],
    n = tabs.indexOf(target),
    i =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (n + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[i]?.click();
  tabs[i]?.focus();
}

const defaultShortcuts = defaultProductPreferences().shortcuts;
function globalShortcut(event: KeyboardEvent) {
  if (
    workspace.area === 'local' &&
    view.value === 'terminals' &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 's'
  )
    return;
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
function clampSidebarWidth(width: number): number {
  return Math.max(200, Math.min(400, Math.round(width)));
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
      tr(
        '主机连接配置已变更。当前会话保持原连接；请从主机树确认新配置后打开模块，或先断开并重新连接。',
      ),
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
import { useTerminalsStore } from './stores/terminals';

const application = useApplicationStore();
const updates = useUpdatesStore();
const store = useHostsStore();
const terminals = useTerminalsStore();
const files = useFilesStore();
let releaseExit: UnlistenFn | undefined;
let releaseEditor: UnlistenFn | undefined;
let releaseEditorSaved: UnlistenFn | undefined;
const exitBusy = ref(false);
const exitError = ref<string | null>(null);
watch(
  () => updates.installRequested,
  (requested) => {
    if (requested) {
      exitError.value = null;
      files.exitReview = true;
    }
  },
);
function cancelExit(): void {
  files.exitReview = false;
  updates.installRequested = false;
  exitError.value = null;
}
async function confirmExit(): Promise<void> {
  if (workspace.settingsCloseGuard && !(await workspace.settingsCloseGuard())) return;
  exitBusy.value = true;
  exitError.value = null;
  try {
    if (updates.installRequested) await updates.install();
    else await filesApi.exit(true);
  } catch (cause) {
    exitError.value = errorMessage(cause);
    exitBusy.value = false;
  }
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
  workspace.showHome();
  void nextTick(() =>
    document.querySelector('.tree-host.selected')?.scrollIntoView({ block: 'nearest' }),
  );
}
const theme = computed(() => application.state?.config.theme);
useTheme(theme);
watch(
  () => application.interfaceFontSizePreview ?? application.state?.config.interfaceFontSize,
  (value) => {
    const scale = interfaceFontSizes.find((size) => size.value === value)?.scale ?? 1;
    document.documentElement.style.setProperty('--interface-font-scale', String(scale));
  },
  { immediate: true },
);
onBeforeUnmount(() => document.documentElement.style.removeProperty('--interface-font-scale'));
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
    await terminals.loadSaved();
    void updates.initialize();
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
      releaseEditor = await listen<import('./services/editor').EditorStatus>(
        'remote-editor-state',
        (event) => files.editorState(event.payload),
      );
      releaseEditorSaved = await listen('remote-editor-saved', () => void files.refresh());
      await files.syncEditorState();
    } catch (cause) {
      files.error = tr('关闭确认入口注册失败：{0}', errorMessage(cause));
    }
  }
});
function protectDraft(event: BeforeUnloadEvent): void {
  if (files.dirty || plugins.dirty || workspace.settingsDirty) {
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
  releaseEditor?.();
  releaseEditorSaved?.();
});
function openPlugin(
  id: string,
  contribution: string,
  hostId = workspace.current?.hostId ?? '',
  section?: WorkspaceTab['section'],
): void {
  const installed = plugins.installed.find((p) => p.manifest.id === id);
  const entry = installed?.manifest.contributions.find((entry) => entry.id === contribution);
  if (installed && entry && !hostId && ['server', 'host_menu'].includes(entry.kind)) {
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
      notifications.push(tr('请先在“设置 → 插件”中启用并授权提供此功能的插件。'), true);
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
      for (const tab of [...workspace.tabs])
        if (tab.view === 'terminals' && tab.hostId) workspace.close(tab.key);
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
</script>

<template>
  <div class="app-shell" :style="layoutStyle">
    <AppHeader
      :search-shortcut="
        application.state?.config.product?.shortcuts.search ?? defaultShortcuts.search!
      "
      @search="searching = true"
    />
    <AppNavigation
      :area="workspace.area"
      :disabled="workspace.navigationBlocked"
      :update-available="updates.available"
      @home="workspace.showHome()"
      @local="navigate('terminals', '')"
      @settings="updates.available ? workspace.navigate('about') : workspace.showSettings()"
    />
    <aside id="host-sidebar" class="sidebar" :aria-label="tr('侧栏菜单')">
      <HostSidebar
        v-show="workspace.area === 'home'"
        id="host-tree-panel"
        :active="workspace.area === 'home'"
        @plugin="openPlugin"
        @create="openHost($event)"
        @import-openssh="importingOpenSsh = true"
        @select="setContext($event.id, true)"
        @saved="revealHost"
      />
      <section
        v-show="workspace.area === 'local'"
        class="local-session-sidebar"
        :aria-label="tr('本地终端会话')"
      >
        <h2>{{ tr('本地终端') }}</h2>
        <div id="local-terminal-session-list"></div>
      </section>
      <SettingsNavigation v-show="settingsOpen" />
    </aside>
    <div
      class="sidebar-resizer"
      role="separator"
      :aria-label="tr('调整主机侧栏宽度')"
      aria-orientation="vertical"
      tabindex="0"
      :aria-valuenow="sidebarDraft ?? application.state?.config.sidebarWidth ?? 248"
      aria-valuemin="200"
      aria-valuemax="400"
      @pointerdown="resizeSidebar"
      @keydown="sidebarKey"
    />
    <main class="main-content">
      <SettingsView v-if="workspace.settingsView" v-show="settingsOpen" :active="settingsOpen" />
      <div v-show="workspace.area === 'home'" class="workspace-navigation">
        <div
          class="tabbar workspace-tabs"
          role="tablist"
          :aria-label="tr('工作区')"
          @keydown="workspaceKeys"
        >
          <button
            class="workspace-start-tab"
            role="tab"
            :aria-selected="!workspace.active"
            :tabindex="!workspace.active ? 0 : -1"
            @click="workspace.showHome(true)"
          >
            {{ tr('首页') }}
          </button>
          <div
            v-for="tab in workspace.homeTabs"
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
            @contextmenu.prevent.stop="openTabMenu(tab.key, $event)"
            @keydown="tabContextKeys(tab.key, $event)"
          >
            <button
              role="tab"
              :aria-selected="workspace.active === tab.key"
              :tabindex="workspace.active === tab.key ? 0 : -1"
              :title="tabName(tab)"
              @click="activate(tab)"
            >
              <Server v-if="isHostTab(tab) && tab.hostId" :size="14" aria-hidden="true" />
              <Puzzle v-else-if="tab.view === 'plugins'" :size="14" aria-hidden="true" />
              {{ tabName(tab) }}</button
            ><button
              class="tab-close"
              :disabled="workspace.closing.includes(tab.key)"
              :aria-label="tr('关闭工作区标签 {0}', tabName(tab))"
              :title="isHostTab(tab) ? tr('关闭该设备的连接和临时传输记录') : tr('关闭此页面')"
              @click="workspace.close(tab.key)"
            >
              <X :size="14" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      <div
        v-show="!settingsOpen && isHostWorkspace"
        class="workspace-header"
        :inert="workspace.closing.includes(workspace.active)"
      >
        <HostTools
          v-if="isHostWorkspace && view && currentHostId"
          :active="view"
          :active-plugin="workspace.current?.pluginId"
          :local="false"
          @navigate="navigate($event)"
          @plugin="openPlugin"
        />
        <strong v-if="isHostWorkspace && !currentHost" class="workspace-local-label">{{
          tr('本地终端')
        }}</strong>
      </div>
      <div
        v-show="!settingsOpen && view === 'terminals' && workspace.area === 'home'"
        id="terminal-session-tools"
      ></div>
      <p v-if="!settingsOpen && isHostWorkspace && connectionChanged" class="banner" role="status">
        {{ tr(' 当前仍操作建立时的连接：') }}{{ currentHost?.username }}@{{
          currentHost?.hostname
        }}:{{ currentHost?.port
        }}{{ tr('。主机配置已更新，请先停止此模块连接，再重新连接以应用新地址或账号。 ') }}
      </p>
      <div
        v-show="!settingsOpen && view !== 'terminals'"
        class="content-scroll"
        :class="{ 'plugin-frame-workspace': view === 'extension' }"
        :inert="workspace.closing.includes(workspace.active)"
        :aria-busy="workspace.closing.includes(workspace.active)"
      >
        <WelcomeView
          v-if="view === null"
          :search-shortcut="
            application.state?.config.product?.shortcuts.search ?? defaultShortcuts.search!
          "
          @local-terminal="navigate('terminals', '')"
          @create-host="openHost()"
          @import-openssh="importingOpenSsh = true"
        />
        <PluginView
          v-for="page in cachedPluginPages"
          v-show="workspace.activePluginKey === page.key"
          :key="page.key"
          :active="
            workspace.activePluginKey === page.key &&
            !settingsOpen &&
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
          @settings="workspace.openPluginSettings"
          @manage="navigate('plugins')"
        />
        <FilesView
          v-else-if="view === 'files'"
          :key="`files:${currentHostId}`"
          :host-id="currentHostId"
          @terminal="fileTerminal"
        />
      </div>
      <div
        class="terminal-workspace"
        :class="{ 'terminal-hidden': settingsOpen || view !== 'terminals' }"
        :inert="
          settingsOpen ||
          view !== 'terminals' ||
          workspace.closing.includes(workspace.active) ||
          undefined
        "
        :aria-hidden="settingsOpen || view !== 'terminals' || undefined"
      >
        <div class="terminal-primary">
          <TerminalsView
            v-if="view === 'terminals' || terminals.tabs.length"
            :visible="!settingsOpen && view === 'terminals'"
            :host-id="currentHostId"
            toolbar-target="#terminal-session-tools"
            local-session-target="#local-terminal-session-list"
            @server="openServer"
          />
        </div>
      </div>
    </main>
    <footer class="statusbar">
      <span
        ><span :class="['status-dot', { offline: !application.ready }]"></span
        >{{
          application.ready
            ? tr('本地后端已就绪')
            : application.loading
              ? tr('初始化中')
              : tr('后端未连接')
        }}</span
      >
      <span
        >{{ store.catalog ? tr('{0} 台主机', store.catalog.hosts.length) : tr('主机列表未加载') }} ·
        {{ store.busy ? tr('操作中') : tr('{0} 个已连接终端', terminals.connectedCount) }}</span
      >
      <TerminalStatus v-if="statusPane" :pane="statusPane" />
    </footer>
  </div>
  <NotificationToasts />
  <Modal v-if="pluginTarget" :title="tr('选择使用工具的主机')" @close="pluginTarget = null">
    <p>{{ tr('选择主机后，工具将在该主机工作区打开。') }}</p>
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
      <p v-if="!store.catalog?.hosts.length">{{ tr('暂无主机，请先在主机管理中添加。') }}</p>
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
  <FileOpenDialogs />
  <Modal
    v-if="files.exitReview"
    :title="updates.installRequested ? tr('确认安装更新并重启') : tr('确认退出 ServerDeck')"
    :busy="exitBusy"
    focus-heading
    @close="cancelExit"
  >
    <div class="exit-review-body">
      <ul class="exit-review-effects" :aria-label="tr('退出影响')">
        <li>
          <Unplug :size="16" aria-hidden="true" />
          <div>
            <strong>{{ tr('连接与会话') }}</strong>
            <p>{{ tr('断开所有模块连接，结束 SSH 和本地终端会话。') }}</p>
          </div>
        </li>
        <li>
          <ListTodo :size="16" aria-hidden="true" />
          <div>
            <strong>{{ tr('未完成的任务') }}</strong>
            <p>{{ tr('请求取消未完成的传输和诊断。') }}</p>
          </div>
        </li>
        <li>
          <FileWarning :size="16" aria-hidden="true" />
          <div>
            <strong>{{ tr('未保存的修改') }}</strong>
            <p>{{ tr('关闭独立编辑器，放弃未保存的文本编辑。') }}</p>
          </div>
        </li>
      </ul>
      <p class="exit-review-note">
        <Info :size="14" aria-hidden="true" />
        <span>{{ tr('已完成的文件会保留。远端命令是否停止仍需核对。') }}</span>
      </p>
    </div>
    <p v-if="exitError" class="error-text" role="alert">{{ exitError }}</p>
    <footer class="dialog-actions exit-review-actions">
      <button class="button danger" type="button" :disabled="exitBusy" @click="confirmExit">
        {{ tr(' 确认 ') }}
      </button>
    </footer>
  </Modal>
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
      :aria-label="tr('工作区标签操作')"
      :style="{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }"
      @keydown="tabMenuKeys"
    >
      <button
        v-for="action in tabCloseActions"
        :key="action.scope"
        role="menuitem"
        tabindex="-1"
        :disabled="
          (action.scope === 'right' && !hasTabsToRight) ||
          (action.scope === 'others' && !hasOtherTabs)
        "
        @click="closeFromTabMenu(action.scope)"
      >
        <component :is="action.icon" :class="action.iconClass" aria-hidden="true" />{{
          action.label
        }}
      </button>
    </div>
  </Teleport>
</template>
