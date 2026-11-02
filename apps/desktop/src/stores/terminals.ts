import { useErrorNotifications } from '../composables/error-notifications';
import { defineStore } from 'pinia';
import { computed, ref, watch, onScopeDispose } from 'vue';
import { hostDisplayName, type Host } from '../types/hosts';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import type { LayoutNode, SplitAxis, WorkspaceLayout } from '../types/workspace';
import { removeLeaf, replaceLeaf, resizeNode } from '../services/layout';

export interface TerminalPaneModel {
  key: string;
  host: Host | null;
  shell?: string;
  state: string;
  connectRequested: boolean;
  sessionId?: string;
  transportId?: string;
  routeHostIds?: string[];
  cwd?: string;
  fileAction?: import('../types/files').FileTerminalAction;
  containerShell?: import('../types/ops').ContainerShell;
}
export interface TerminalTab {
  key: string;
  title: string;
  panes: TerminalPaneModel[];
  layout: LayoutNode;
}
export const useTerminalsStore = defineStore('terminals', () => {
  const tabs = ref<TerminalTab[]>([]),
    active = ref(''),
    focused = ref(''),
    error = ref<string | null>(null),
    initialized = ref(false);
  const panes = computed(() => tabs.value.flatMap((t) => t.panes));
  const connectedCount = computed(() => panes.value.filter((p) => p.state === 'connected').length);
  const lastHostTabs = new Map<string, string>();
  function hostTabs(hostId: string): TerminalTab[] {
    return tabs.value.filter((tab) => tab.panes.every((pane) => (pane.host?.id ?? '') === hostId));
  }
  function activateHost(hostId: string): void {
    const available = hostTabs(hostId);
    const tab =
      available.find((t) => t.key === active.value) ??
      available.find((t) => t.key === lastHostTabs.get(hostId)) ??
      available[0];
    if (tab?.key !== active.value) select(tab?.key ?? '');
  }
  watch([active, focused], () => {
    const pane = panes.value.find((p) => p.key === focused.value);
    if (pane) lastHostTabs.set(pane.host?.id ?? '', active.value);
  });
  function hostState(id: string): string {
    const p = panes.value.filter((p) => p.host?.id === id || p.routeHostIds?.includes(id));
    return p.some((p) => p.state === 'connected')
      ? '已连接'
      : p.some((p) =>
            ['opening', 'connecting', 'authenticating', 'awaiting_trust'].includes(p.state),
          )
        ? '连接中'
        : '未连接';
  }
  function update(key: string, values: Partial<Omit<TerminalPaneModel, 'key' | 'host'>>): void {
    const pane = panes.value.find((p) => p.key === key);
    if (pane) Object.assign(pane, values);
  }
  function newPane(
    host: Host | null,
    connect = true,
    key: string = crypto.randomUUID(),
  ): TerminalPaneModel {
    return {
      key,
      host: host ? { ...host } : null,
      state: connect ? 'opening' : 'idle',
      connectRequested: connect,
    };
  }
  function open(
    host: Host | null,
    fileAction?: import('../types/files').FileTerminalAction,
    containerShell?: import('../types/ops').ContainerShell,
  ): void {
    if (panes.value.length >= 32) {
      error.value = '最多打开 32 个终端窗格。';
      return;
    }
    const pane = newPane(host);
    pane.fileAction = fileAction;
    pane.containerShell = containerShell;
    const key = crypto.randomUUID();
    tabs.value.push({
      key,
      title: host ? hostDisplayName(host) : '本地设备',
      panes: [pane],
      layout: { kind: 'leaf', pane: pane.key },
    });
    active.value = key;
    focused.value = pane.key;
  }
  function split(key: string, axis: SplitAxis): void {
    const tab = tabs.value.find((t) => t.panes.some((p) => p.key === key));
    const pane = tab?.panes.find((p) => p.key === key);
    if (!tab || !pane) return;
    if (tab.panes.length >= 8 || panes.value.length >= 32) {
      error.value = '每个标签最多 8 个窗格，总计最多 32 个。';
      return;
    }
    const added = newPane(pane.host);
    tab.panes.push(added);
    tab.layout = replaceLeaf(tab.layout, key, {
      kind: 'split',
      id: crypto.randomUUID(),
      axis,
      ratio: 50,
      first: { kind: 'leaf', pane: key },
      second: { kind: 'leaf', pane: added.key },
    });
    focused.value = added.key;
  }
  function resize(tabId: string, id: string, ratio: number): void {
    const tab = tabs.value.find((t) => t.key === tabId);
    if (tab) tab.layout = resizeNode(tab.layout, id, ratio);
  }
  function rename(key: string, title: string): boolean {
    title = title.trim();
    if (
      !title ||
      title.length > 128 ||
      Array.from(title).some(
        (c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
      )
    ) {
      error.value = '标签名称须为 1–128 个字符且不含控制字符。';
      return false;
    }
    const tab = tabs.value.find((t) => t.key === key);
    if (tab) tab.title = title;
    return !!tab;
  }
  function reorder(key: string, before: string): void {
    const from = tabs.value.findIndex((t) => t.key === key),
      to = tabs.value.findIndex((t) => t.key === before);
    if (from < 0 || to < 0 || from === to) return;
    const [tab] = tabs.value.splice(from, 1);
    if (tab) tabs.value.splice(to, 0, tab);
  }
  function select(key: string): void {
    active.value = key;
    focused.value = tabs.value.find((t) => t.key === key)?.panes[0]?.key ?? '';
  }
  function cycle(delta: number): void {
    const pane = panes.value.find((p) => p.key === focused.value);
    const available = hostTabs(pane?.host?.id ?? '');
    const index = available.findIndex((t) => t.key === active.value);
    if (available.length)
      select(available[(index + delta + available.length) % available.length]!.key);
  }
  function removeTab(key: string): void {
    const index = tabs.value.findIndex((t) => t.key === key);
    if (index < 0) return;
    const hostId = tabs.value[index]?.panes[0]?.host?.id ?? '';
    const available = hostTabs(hostId),
      position = available.findIndex((t) => t.key === key);
    tabs.value.splice(index, 1);
    if (active.value === key)
      select(hostTabs(hostId)[Math.min(position, available.length - 2)]?.key ?? '');
  }
  async function closePane(key: string): Promise<void> {
    const tab = tabs.value.find((t) => t.panes.some((p) => p.key === key));
    const pane = tab?.panes.find((p) => p.key === key);
    if (!tab || !pane) return;
    try {
      if (pane.sessionId) await terminalApi.close(pane.sessionId);
      const layout = removeLeaf(tab.layout, key);
      if (!layout) removeTab(tab.key);
      else {
        tab.panes = tab.panes.filter((p) => p.key !== key);
        tab.layout = layout;
        if (focused.value === key) focused.value = tab.panes[0]?.key ?? '';
      }
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }
  async function close(key: string): Promise<void> {
    const tab = tabs.value.find((t) => t.key === key);
    if (!tab) return;
    try {
      await Promise.all(
        tab.panes.filter((p) => p.sessionId).map((p) => terminalApi.close(p.sessionId!)),
      );
      removeTab(key);
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }
  async function closeAll(key: string): Promise<void> {
    const tab = tabs.value.find((t) => t.key === key);
    if (!tab) return;
    const targets = hostTabs(tab.panes[0]?.host?.id ?? '').map((t) => t.key);
    for (const id of targets) await close(id);
  }
  async function closeHost(id: string): Promise<boolean> {
    try {
      await terminalApi.closeHost(id);
      return true;
    } catch (cause) {
      error.value = errorMessage(cause);
      return false;
    }
  }
  function snapshot(): WorkspaceLayout {
    return {
      version: 1,
      active: active.value,
      tabs: tabs.value.map((t) => ({
        key: t.key,
        title: t.title,
        panes: t.panes.map((p) => ({ key: p.key, hostId: p.host?.id ?? null })),
        layout: t.layout,
      })),
    };
  }
  async function restore(hosts: Host[]): Promise<void> {
    try {
      const saved = await terminalApi.workspaceLoad();
      if (!saved) return;
      for (const tab of saved.tabs) {
        let layout: LayoutNode | null = tab.layout;
        const restoredPanes: TerminalPaneModel[] = [];
        for (const pane of tab.panes) {
          const host = pane.hostId === null ? null : hosts.find((h) => h.id === pane.hostId);
          if (host !== undefined) restoredPanes.push(newPane(host, false, pane.key));
          else if (layout) layout = removeLeaf(layout, pane.key);
        }
        if (layout && restoredPanes.length)
          tabs.value.push({ ...tab, panes: restoredPanes, layout });
      }
      select(tabs.value.find((t) => t.key === saved.active)?.key ?? tabs.value[0]?.key ?? '');
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      initialized.value = true;
    }
  }
  let saveTimer: ReturnType<typeof setTimeout> | undefined,
    disposed = false;
  async function saveLayout(retry = 0): Promise<void> {
    clearTimeout(saveTimer);
    if (disposed) return;
    try {
      await terminalApi.workspaceSave(snapshot());
    } catch (cause) {
      if (
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        cause.code === 'BUSY' &&
        retry < 5 &&
        !disposed
      )
        saveTimer = setTimeout(() => void saveLayout(retry + 1), 250);
      else if (!disposed) error.value = errorMessage(cause);
    }
  }
  watch(
    () => JSON.stringify(snapshot()),
    () => {
      if (!initialized.value) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void saveLayout(), 300);
    },
  );
  onScopeDispose(() => {
    disposed = true;
    clearTimeout(saveTimer);
  });
  useErrorNotifications(error);
  return {
    tabs,
    panes,
    active,
    focused,
    error,
    initialized,
    connectedCount,
    hostState,
    hostTabs,
    activateHost,
    update,
    open,
    split,
    resize,
    rename,
    reorder,
    select,
    cycle,
    closePane,
    close,
    closeAll,
    closeHost,
    snapshot,
    saveLayout,
    restore,
  };
});
