import { useErrorNotifications } from '../composables/error-notifications';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { hostDisplayName, type Host } from '../types/hosts';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import type { LayoutNode, SplitAxis } from '../types/workspace';
import { removeLeaf, replaceLeaf, resizeNode } from '../services/layout';
import { usePluginsStore } from './plugins';

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
  pluginTerminal?: { pluginId: string; owner: string; ticket: string };
}
export interface TerminalTab {
  key: string;
  title: string;
  sessionNumber: number;
  panes: TerminalPaneModel[];
  layout: LayoutNode;
}
export const useTerminalsStore = defineStore('terminals', () => {
  const tabs = ref<TerminalTab[]>([]),
    active = ref(''),
    focused = ref(''),
    error = ref<string | null>(null);
  const panes = computed(() => tabs.value.flatMap((t) => t.panes));
  const connectedCount = computed(() => panes.value.filter((p) => p.state === 'connected').length);
  const lastHostTabs = new Map<string, string>();
  const sessionNumbers = new Map<string, number>();
  const uploads = new Map<string, { active: () => boolean; stop: () => Promise<void> }>();
  function registerUpload(
    key: string,
    active: () => boolean,
    stop: () => Promise<void>,
  ): () => void {
    const entry = { active, stop };
    uploads.set(key, entry);
    return () => {
      if (uploads.get(key) === entry) uploads.delete(key);
    };
  }
  function confirmUploadClose(targets: TerminalPaneModel[]): boolean | Promise<boolean> {
    const count = targets.filter((pane) => uploads.get(pane.key)?.active()).length;
    return (
      !count ||
      usePluginsStore().ask(
        '停止上传并关闭终端',
        '目标终端还有 ' +
          count +
          ' 个待确认或进行中的拖放上传。关闭将停止上传，保留已提交文件；断线时可能保留临时目录。是否继续？',
      )
    );
  }
  function confirmHostUploadClose(id: string): boolean | Promise<boolean> {
    return confirmUploadClose(hostTabs(id).flatMap((tab) => tab.panes));
  }
  function nextSessionNumber(hostId: string): number {
    const number = (sessionNumbers.get(hostId) ?? 0) + 1;
    sessionNumbers.set(hostId, number);
    return number;
  }
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
  function newPane(host: Host | null): TerminalPaneModel {
    return {
      key: crypto.randomUUID(),
      host: host ? { ...host } : null,
      state: 'opening',
      connectRequested: true,
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
      sessionNumber: nextSessionNumber(host?.id ?? ''),
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
  function duplicate(key: string): void {
    const pane = tabs.value.find((tab) => tab.key === key)?.panes[0];
    if (pane) open(pane.host);
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
    if (!hostTabs(hostId).length) {
      sessionNumbers.delete(hostId);
      lastHostTabs.delete(hostId);
    }
    if (active.value === key)
      select(hostTabs(hostId)[Math.min(position, available.length - 2)]?.key ?? '');
  }
  async function closePane(key: string, approved = false): Promise<void> {
    const tab = tabs.value.find((t) => t.panes.some((p) => p.key === key));
    const pane = tab?.panes.find((p) => p.key === key);
    if (!tab || !pane) return;
    try {
      const decision = approved || confirmUploadClose([pane]);
      if (decision !== true && !(await decision)) return;
      const upload = uploads.get(pane.key);
      if (upload?.active()) await upload.stop();
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
  async function close(key: string, approved = false): Promise<void> {
    const tab = tabs.value.find((t) => t.key === key);
    if (!tab) return;
    const decision = approved || confirmUploadClose(tab.panes);
    if (decision !== true && !(await decision)) return;
    for (const pane of [...tab.panes]) await closePane(pane.key, true);
  }
  async function closeAll(key: string, approved = false): Promise<void> {
    const tab = tabs.value.find((t) => t.key === key);
    if (!tab) return;
    const decision = approved || confirmHostUploadClose(tab.panes[0]?.host?.id ?? '');
    if (decision !== true && !(await decision)) return;
    const targets = hostTabs(tab.panes[0]?.host?.id ?? '').map((t) => t.key);
    for (const id of targets) await close(id, true);
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
  useErrorNotifications(error);
  return {
    tabs,
    panes,
    active,
    focused,
    error,
    connectedCount,
    hostState,
    hostTabs,
    activateHost,
    update,
    open,
    duplicate,
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
    registerUpload,
    confirmHostUploadClose,
  };
});
