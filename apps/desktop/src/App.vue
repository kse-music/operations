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
import { PanelLeftClose, PanelLeftOpen, Power, Search, Settings2, X } from '@lucide/vue';
import HostsView from './views/HostsView.vue';
import CredentialsView from './views/CredentialsView.vue';
import HostDialog from './components/HostDialog.vue';
import GroupManager from './components/GroupManager.vue';
import ImportDialog from './components/ImportDialog.vue';
import Modal from './components/Modal.vue';
import { useHostsStore } from './stores/hosts';
import { hostsApi } from './services/hosts';
import { hostInput, type Host } from './types/hosts';
const TerminalsView = defineAsyncComponent(() => import('./views/TerminalsView.vue'));
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useFilesStore } from './stores/files';
import { filesApi } from './services/files';
import { errorMessage } from './services/ipc';
import { useAutomationStore } from './stores/automation';
import { useWorkspaceStore } from './stores/workspace';
import { useNotificationsStore } from './stores/notifications';
import { useBackgroundStore } from './stores/background';
import { useOpsStore } from './stores/ops';
import { sameHostConnection } from './services/product-links';
import {
  messages,
  globalKey,
  defaultProductPreferences,
  type WorkspaceView as View,
} from './types/product';
import type { WorkspaceTab } from './stores/workspace';
import GlobalSearch from './components/GlobalSearch.vue';
import BackgroundTasks from './components/BackgroundTasks.vue';
const BackupView = defineAsyncComponent(() => import('./views/BackupView.vue'));
const workspace = useWorkspaceStore(),
  notifications = useNotificationsStore(),
  background = useBackgroundStore(),
  operations = useOpsStore();
const searching = ref(false),
  taskPanel = ref(false),
  entryIntent = ref(''),
  closingHost = ref<Host | null>(null);
const currentHostId = computed(() => workspace.current.hostId);
function knownHost(id: string) {
  return (
    store.catalog?.hosts.find((h) => h.id === id) ??
    terminals.panes.find((p) => p.host.id === id)?.host ??
    files.connections[id]?.host ??
    operations.connections[id]?.host
  );
}
const currentHost = computed(() => {
  const id = currentHostId.value,
    configured = knownHost(id);
  if (!configured) return;
  const module = workspace.current.view,
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
  const snapshot =
    kind === 'terminal'
      ? terminals.panes.find((p) => p.key === terminals.focused)?.host
      : kind === 'files'
        ? files.connections[id]?.host
        : kind === 'operations'
          ? operations.connections[id]?.host
          : undefined;
  const session =
    kind === 'terminal'
      ? terminals.panes.find((p) => p.key === terminals.focused)?.sessionId
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
const view = computed({
  get: () => workspace.current.view,
  set: (value: View) => navigate(value, store.selectedId ?? currentHostId.value),
});
function navigate(
  value: View,
  hostId = store.selectedId ?? currentHostId.value,
  section?: WorkspaceTab['section'],
): void {
  if (value !== 'automation') entryIntent.value = '';
  const host = knownHost(hostId);
  if (value === 'terminals' && host) {
    const tab =
      terminals.tabs.find(
        (t) => t.key === terminals.active && t.panes.some((p) => p.host.id === host.id),
      ) ?? terminals.tabs.find((t) => t.panes.some((p) => p.host.id === host.id));
    if (tab) {
      terminals.select(tab.key);
      terminals.focused = tab.panes.find((p) => p.host.id === host.id)!.key;
    } else terminals.open(host);
  }
  if (value === 'files') files.active = hostId;
  if (value === 'operations') operations.active = hostId;
  workspace.navigate(value, host ? hostId : '', section);
  if (host) store.selectedId = host.id;
  menu.value = null;
}
function fromSearch(value: View, hostId = '', entryId = '') {
  entryIntent.value = entryId;
  navigate(value, hostId);
}
function setContext(hostId: string) {
  navigate(view.value, hostId);
}
function tabName(tab: WorkspaceTab) {
  const h = store.catalog?.hosts.find((h) => h.id === tab.hostId);
  return `${messages['zh-CN'][tab.view]}${h ? ` · ${h.name}` : ''}`;
}
function activate(tab: WorkspaceTab) {
  navigate(tab.view, tab.hostId, tab.section);
}
function revealActiveTab() {
  document
    .querySelector('.workspace-tab.active')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
function resizeSidebar(event: PointerEvent) {
  event.preventDefault();
  const start = event.clientX,
    width = application.state?.config.sidebarWidth ?? 248;
  function move(e: PointerEvent) {
    sidebarDraft.value = Math.max(200, Math.min(400, width + e.clientX - start));
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
    await application.save({ ...application.state.config, sidebarWidth: width });
    sidebarDraft.value = null;
  }
}
function sidebarKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  void saveSidebar(
    Math.max(
      200,
      Math.min(
        400,
        (application.state?.config.sidebarWidth ?? 248) + (event.key === 'ArrowRight' ? 8 : -8),
      ),
    ),
  );
}

const automation = useAutomationStore();
const AutomationView = defineAsyncComponent(() => import('./views/AutomationView.vue'));
function currentConfiguration(host: Host): boolean {
  const configured = store.catalog?.hosts.find((h) => h.id === host.id);
  if (!configured || !sameHostConnection(host, configured)) {
    notifications.push(
      '主机连接配置已变更。当前会话保持原连接；请从主机管理确认新配置后打开模块，或先断开并重新连接。',
      true,
    );
    return false;
  }
  return true;
}
function openAutomation(host: Host): void {
  if (!currentConfiguration(host)) return;
  navigate('automation', host.id);
}
const NetworkView = defineAsyncComponent(() => import('./views/NetworkView.vue'));
const BatchView = defineAsyncComponent(() => import('./views/BatchView.vue'));
function openNetwork(host: Host): void {
  if (!currentConfiguration(host)) return;
  navigate('network', host.id);
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
async function requestExit(): Promise<void> {
  files.exitReview = true;
}

function openFiles(host: Host, path?: string, pane?: string): void {
  if (!currentConfiguration(host)) return;
  menu.value = null;
  navigate('files', host.id);
  void files.open(host, path, pane);
}
function fileTerminal(host: Host, action: import('./types/files').FileTerminalAction): void {
  if (!currentConfiguration(host)) return;
  terminals.open(host, action);
  navigate('terminals', host.id);
}

function connect(host: Host): void {
  menu.value = null;
  terminals.open(host);
  navigate('terminals', host.id);
}
const hostDialog = ref(false);
const editing = ref<Host>();
const groups = ref(false);
const importing = ref(false);
const deleting = ref<Host | null>(null);
const exportText = ref<string | null>(null);
const menu = ref<{ host: Host; x: number; y: number } | null>(null);
function openHost(host?: Host): void {
  store.error = null;
  editing.value = host;
  hostDialog.value = true;
  menu.value = null;
}
function openMenu(host: Host, event: MouseEvent): void {
  menu.value = {
    host,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - 195)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - 330)),
  };
}
async function copy(host: Host): Promise<void> {
  menu.value = null;
  const result = await store.run(
    () => hostsApi.copy(host.id),
    '主机配置已复制，共享原安全凭据引用。',
  );
  if (result.ok) {
    store.selectedId = result.value.id;
    view.value = 'hosts';
  }
}
async function favorite(host: Host): Promise<void> {
  menu.value = null;
  const input = hostInput(host);
  input.favorite = !input.favorite;
  await store.run(() => hostsApi.update(host.id, input), '收藏状态已保存。');
}
function confirmDelete(host: Host): void {
  menu.value = null;
  store.error = null;
  deleting.value = host;
}
async function remove(): Promise<void> {
  if (!deleting.value) return;
  const id = deleting.value.id;
  const result = await store.run(
    () => hostsApi.remove(id),
    '主机已删除，安全凭据保留供其他主机使用。',
  );
  if (result.ok) deleting.value = null;
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
onMounted(async () => {
  await application.initialize();
  if (application.ready) {
    await store.load();
    automation.start();
    background.start();
    window.addEventListener('keydown', globalShortcut, true);
    window.addEventListener('resize', revealActiveTab);
    await terminals.restore(store.catalog?.hosts ?? []);
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
  automation.stop();
  background.stop();
  window.removeEventListener('keydown', globalShortcut, true);
  window.removeEventListener('resize', revealActiveTab);
  window.removeEventListener('beforeunload', protectDraft);
  releaseExit?.();
});
watch(
  () => terminals.focused,
  () => {
    if (view.value !== 'terminals') return;
    const pane = terminals.panes.find((p) => p.key === terminals.focused);
    if (pane) {
      workspace.navigate('terminals', pane.host.id);
      store.selectedId = pane.host.id;
    }
  },
);
watch(
  () => workspace.active,
  () => {
    void nextTick(() => {
      revealActiveTab();
      const content = document.querySelector('.content-scroll');
      if (content) content.scrollTop = 0;
    });
    const t = workspace.current;
    if (t.hostId) store.selectedId = t.hostId;
    if (t.view === 'files') files.active = t.hostId;
    if (t.view === 'operations') operations.active = t.hostId;
    if (t.view === 'terminals') {
      const tab =
        terminals.tabs.find(
          (tab) => tab.key === terminals.active && tab.panes.some((p) => p.host.id === t.hostId),
        ) ?? terminals.tabs.find((tab) => tab.panes.some((p) => p.host.id === t.hostId));
      if (tab) {
        terminals.select(tab.key);
        terminals.focused = tab.panes.find((p) => p.host.id === t.hostId)!.key;
      }
    }
  },
);
watch(
  () => store.selectedId,
  (id) => {
    if (view.value === 'hosts') workspace.navigate('hosts', id ?? '');
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
  () => application.error,
  (v) => notifications.push(v, true),
);
watch(
  () => application.notice,
  (v) => notifications.push(v),
);
watch(
  () => store.error,
  (v) => notifications.push(v, true),
);
watch(
  () => store.notice,
  (v) => notifications.push(v),
);
watch(
  () => files.error,
  (v) => notifications.push(v, true),
);
watch(
  () => files.notice,
  (v) => notifications.push(v),
);
watch(
  () => terminals.error,
  (v) => notifications.push(v, true),
);
watch(
  () => background.error,
  (v) => notifications.push(v, true),
);
watch(
  () => automation.error,
  (v) => notifications.push(v, true),
);
async function disconnectHost() {
  if (!closingHost.value) return;
  if (files.dirty) {
    notifications.push('请先保存或关闭未保存的远程文档，再关闭主机全部连接。', true);
    return;
  }
  try {
    if (!(await terminals.closeHost(closingHost.value.id))) return;
    await operations.sync();
    await files.poll();
    closingHost.value = null;
  } catch (cause) {
    notifications.push(errorMessage(cause), true);
  }
}
</script>

<template>
  <div class="app-shell" :class="{ 'hosts-hidden': !sidebarOpen }" :style="layoutStyle">
    <header class="topbar">
      <div class="brand">
        <span class="brand-icon" aria-hidden="true">S<span>▸</span></span
        ><strong>ServerDeck</strong><span class="version">v0.1</span>
      </div>
      <button
        class="shell-icon-button"
        :aria-label="sidebarOpen ? '收起主机栏' : '展开主机栏'"
        :title="sidebarOpen ? '收起主机栏' : '展开主机栏'"
        :aria-expanded="sidebarOpen"
        aria-controls="host-sidebar"
        @click="sidebarOpen = !sidebarOpen"
      >
        <PanelLeftClose v-if="sidebarOpen" :size="18" aria-hidden="true" />
        <PanelLeftOpen v-else :size="18" aria-hidden="true" />
      </button>
      <div class="topbar-context" aria-label="当前主机上下文">
        <span v-if="view === 'batch'">多主机任务 · 以目标预览为准</span
        ><template v-else
          ><select
            :value="currentHostId"
            aria-label="当前工作区主机"
            @change="setContext(($event.target as HTMLSelectElement).value)"
          >
            <option value="">本地设备 / 未选择主机</option>
            <option
              v-if="currentHost && !store.catalog?.hosts.some((h) => h.id === currentHost?.id)"
              :value="currentHost.id"
            >
              {{ currentHost.name }}（配置已删除，已有连接）
            </option>
            <option v-for="h in store.catalog?.hosts" :key="h.id" :value="h.id">
              {{ h.name }} · {{ h.username }}@{{ h.hostname }}:{{ h.port }}
            </option>
          </select></template
        >
      </div>
      <button
        class="button global-search-button"
        aria-label="打开全局搜索"
        @click="searching = true"
      >
        <Search :size="15" aria-hidden="true" /><span>搜索</span>
        <kbd>{{ application.state?.config.product?.shortcuts.search ?? 'Ctrl+K' }}</kbd>
      </button>
      <button class="shell-icon-button" aria-label="退出应用" title="退出应用" @click="requestExit">
        <Power :size="17" aria-hidden="true" />
      </button>
      <button
        class="shell-icon-button"
        aria-label="打开全局设置"
        title="全局设置"
        @click="view = 'settings'"
      >
        <Settings2 :size="18" aria-hidden="true" />
      </button>
    </header>
    <AppNavigation
      :active="view"
      :terminals="terminals.tabs.length"
      :transfers="files.pending"
      :tasks="(automation.status?.active ?? 0) + (automation.status?.awaiting ?? 0)"
      @navigate="navigate($event)"
    />
    <aside v-show="sidebarOpen" id="host-sidebar" class="sidebar" aria-label="主机管理栏">
      <HostSidebar
        @create="openHost()"
        @groups="groups = true"
        @select="navigate(view, store.selectedId ?? '')"
        @menu="openMenu"
        @connect="connect"
      />
    </aside>
    <div
      v-if="sidebarOpen"
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
        aria-label="主机工作区标签"
        @keydown="workspaceKeys"
      >
        <div
          v-for="tab in workspace.tabs"
          :key="tab.key"
          class="workspace-tab"
          :class="{ active: workspace.active === tab.key }"
        >
          <button
            role="tab"
            :aria-selected="workspace.active === tab.key"
            :tabindex="workspace.active === tab.key ? 0 : -1"
            :title="tabName(tab)"
            @click="activate(tab)"
          >
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
      <div v-if="currentHost" class="workspace-context">
        <strong>{{ currentHost.name }}</strong
        ><span>{{ currentHost.username }}@{{ currentHost.hostname }}:{{ currentHost.port }}</span
        ><span>{{
          background.connections
            ? background.hostState(currentHost.id)
            : files.hostState(currentHost.id)
        }}</span
        ><button class="text-button" @click="navigate('operations', currentHost.id, 'containers')">
          Docker</button
        ><button class="text-button" @click="navigate('operations', currentHost.id, 'logs')">
          Logs</button
        ><button class="text-button" @click="navigate('operations', currentHost.id, 'processes')">
          Processes</button
        ><button class="text-button" @click="navigate('operations', currentHost.id, 'services')">
          Services</button
        ><button class="text-button" @click="openNetwork(currentHost)">诊断连接</button>
      </div>
      <p v-if="connectionChanged" class="banner" role="status">
        当前仍操作建立时的连接：{{ currentHost?.username }}@{{ currentHost?.hostname }}:{{
          currentHost?.port
        }}。主机配置已更新，请先停止此模块连接，再重新连接以应用新地址或账号。
      </p>
      <div
        v-if="
          automation.status?.schedulerError ||
          automation.status?.awaiting ||
          (automation.status?.latestFailure?.id !== automation.dismissed &&
            automation.status?.latestFailure)
        "
        class="banner"
        role="status"
      >
        自动化：{{ automation.status?.awaiting || 0 }} 个待确认任务。{{
          automation.status?.schedulerError
            ? `最近调度/保存错误：${automation.status.schedulerError}`
            : ''
        }}
        <span v-if="automation.status?.latestFailure?.id !== automation.dismissed">{{
          automation.status?.latestFailure
            ? `最近失败/未知：${automation.status.latestFailure.entryName}`
            : ''
        }}</span>
        <button class="text-button" @click="view = 'automation'">查看自动化任务</button>
        <button
          v-if="automation.status?.latestFailure"
          class="text-button"
          @click="automation.dismissed = automation.status!.latestFailure!.id"
        >
          已阅失败提示
        </button>
      </div>

      <div v-show="view !== 'terminals'" class="content-scroll">
        <div v-if="application.error" class="banner error" role="alert">
          {{ application.error }}
        </div>

        <div v-if="store.error" class="banner error" role="alert">{{ store.error }}</div>

        <HostsView
          v-if="view === 'hosts'"
          @create="openHost()"
          @edit="openHost"
          @remove="confirmDelete"
          @copy="copy"
          @favorite="favorite"
          @menu="openMenu"
          @import="importing = true"
          @export="exportHosts"
          @connect="connect"
          @files="openFiles"
          @monitor="openMonitor"
          @operations="openOperations"
          @automation="openAutomation"
        />
        <AutomationView
          v-else-if="view === 'automation'"
          :key="`automation:${currentHostId}`"
          :host-id="currentHostId"
          :entry-id="entryIntent"
          @intent-consumed="entryIntent = ''"
        />
        <NetworkView
          v-else-if="view === 'network'"
          :host-id="currentHostId"
          @context="setContext"
        />
        <BatchView v-else-if="view === 'batch'" />
        <OperationsView
          v-else-if="view === 'operations'"
          :key="`operations:${currentHostId}`"
          :host-id="currentHostId"
          :initial-tab="workspace.current.section"
          @context="setContext"
          @section="(s) => (workspace.current.section = s)"
          @shell="containerTerminal"
        />
        <MonitorView
          v-else-if="view === 'monitor'"
          :key="`monitor:${currentHostId}`"
          :host-id="currentHostId"
          @context="setContext"
          @processes="(id) => navigate('operations', id, 'processes')"
        />
        <FilesView
          v-else-if="view === 'files'"
          :key="`files:${currentHostId}`"
          :host-id="currentHostId"
          @context="setContext"
          @terminal="fileTerminal"
        />
        <BackupView v-else-if="view === 'backup'" />
        <CredentialsView v-else-if="view === 'credentials'" />
        <WorkspaceView v-else-if="view === 'overview'" @settings="view = 'settings'" />
        <SettingsPanel v-else />
      </div>
      <div v-show="view === 'terminals'" class="terminal-workspace">
        <TerminalsView
          v-if="view === 'terminals' || terminals.tabs.length"
          :visible="view === 'terminals'"
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
      ><button class="text-button" @click="view = 'files'">{{ files.pending }} 个未完成传输</button
      ><button class="text-button" @click="taskPanel = true">
        后台任务 {{ background.pending + (automation.status?.active ?? 0) }}</button
      ><span class="statusbar-right"
        >Rust + Tauri 2<span class="status-separator">|</span>Local First · Agentless</span
      >
    </footer>
  </div>
  <div class="toast-stack" aria-label="全局通知">
    <div
      v-for="t in notifications.items"
      :key="t.id"
      :class="['toast', { error: t.error }]"
      :role="t.error ? 'alert' : 'status'"
    >
      <span>{{ t.text }}</span
      ><button class="text-button" aria-label="关闭通知" @click="notifications.dismiss(t.id)">
        ×
      </button>
    </div>
  </div>
  <GlobalSearch v-if="searching" @close="searching = false" @navigate="fromSearch" />
  <BackgroundTasks v-if="taskPanel" @close="taskPanel = false" @navigate="navigate" />
  <Modal v-if="closingHost" title="关闭主机全部连接" @close="closingHost = null"
    ><p>
      {{ closingHost.name }} · {{ closingHost.username }}@{{ closingHost.hostname }}:{{
        closingHost.port
      }}
    </p>
    <p>
      将关闭此主机及使用此跳板的终端、文件、运维和监控连接，并中断相关任务。传输可能留下待恢复临时文件；远端命令是否停止仍需核对。未保存文本须先处理。
    </p>
    <button class="button" @click="closingHost = null">继续使用</button
    ><button class="button danger" @click="disconnectHost">确认关闭全部连接</button></Modal
  >
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
    <p v-if="files.error" class="banner error" role="alert">{{ files.error }}</p>
    <footer class="dialog-actions">
      <button class="button" :disabled="exitBusy" @click="files.exitReview = false">继续使用</button
      ><button class="button danger" :disabled="exitBusy" @click="confirmExit">
        取消任务并退出
      </button>
    </footer></Modal
  >
  <HostDialog v-if="hostDialog" :host="editing" @close="hostDialog = false" />
  <GroupManager v-if="groups" @close="groups = false" />
  <ImportDialog v-if="importing" @close="importing = false" />
  <Modal v-if="deleting" title="确认删除主机" :busy="store.busy" @close="deleting = null"
    ><p>删除“{{ deleting.name }}”（{{ deleting.hostname }}）？此操作无法撤销。</p>
    <p class="subtle">只删除此主机配置，不删除关联凭据、私钥文件或其他主机。</p>
    <p v-if="store.error" class="banner error" role="alert">{{ store.error }}</p>
    <footer class="dialog-actions">
      <button class="button" :disabled="store.busy" @click="deleting = null">取消</button
      ><button class="button danger" :disabled="store.busy" @click="remove">确认删除主机</button>
    </footer></Modal
  >
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
  <template v-if="menu"
    ><button class="context-backdrop" aria-label="关闭操作菜单" @click="menu = null"></button>
    <div
      class="context-menu"
      role="menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @keydown.esc="menu = null"
    >
      <button role="menuitem" @click="openAutomation(menu.host)">打开运维自动化</button>
      <button role="menuitem" @click="openNetwork(menu.host)">打开网络诊断</button>
      <button role="menuitem" @click="openOperations(menu.host)">打开 Linux 运维</button>
      <button role="menuitem" @click="openMonitor(menu.host)">打开服务器监控</button>
      <button role="menuitem" @click="openFiles(menu.host)">打开 SFTP 文件</button>
      <button role="menuitem" @click="connect(menu.host)">连接 / 新建终端</button
      ><button
        role="menuitem"
        @click="
          closingHost = menu.host;
          menu = null;
        "
      >
        关闭此主机全部连接</button
      ><button role="menuitem" :disabled="store.busy" @click="openHost(menu.host)">编辑主机</button
      ><button role="menuitem" :disabled="store.busy" @click="copy(menu.host)">复制配置</button
      ><button role="menuitem" :disabled="store.busy" @click="favorite(menu.host)">
        {{ menu.host.favorite ? '取消收藏' : '收藏主机' }}</button
      ><button
        role="menuitem"
        class="danger"
        :disabled="store.busy"
        @click="confirmDelete(menu.host)"
      >
        删除主机…
      </button>
    </div></template
  >
</template>
