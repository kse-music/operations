import { tr } from '../i18n/messages';
import { useErrorNotifications } from '../composables/error-notifications';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { hostDisplayName, type Host } from '../types/hosts';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import type { LayoutNode, SplitAxis } from '../types/workspace';
import { removeLeaf, replaceLeaf, resizeNode } from '../services/layout';
import { usePluginsStore } from './plugins';
import type { SavedTerminalLayout, SavedLocalTerminal, SavedSshTerminal } from '../types/terminal';
import { useNotificationsStore } from './notifications';

export interface TerminalPaneModel {
  key: string;
  host: Host | null;
  shell?: string;
  elevated?: boolean;
  state: string;
  connectRequested: boolean;
  sessionId?: string;
  transportId?: string;
  routeHostIds?: string[];
  cwd?: string;
  cipher?: string;
  screen?: import('../types/terminal').TerminalScreen;
  fileAction?: import('../types/files').FileTerminalAction;
  containerShell?: import('../types/ops').ContainerShell;
  pluginTerminal?: { pluginId: string; owner: string; ticket: string };
  savedSource?: { id: string; pane: number };
}
export interface TerminalTab {
  key: string;
  title: string;
  renamed?: boolean;
  sessionNumber: number;
  panes: TerminalPaneModel[];
  layout: LayoutNode;
  savedId?: string;
}
type ConnectionAction = 'reconnect' | 'disconnect';
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
  const connections = new Map<string, (action: ConnectionAction) => Promise<void>>();
  const closingPanes = new Set<string>();
  const changingConnections = ref<string[]>([]);
  const savedLoading = ref(false),
    savedError = ref<string | null>(null),
    saving = ref('');
  let savedLoaded = false;
  function runningPaneCount(): number {
    return panes.value.filter((pane) => pane.connectRequested || pane.state !== 'idle').length;
  }
  function restoreSavedTab(
    entry: SavedLocalTerminal | SavedSshTerminal,
    host: Host | null = null,
  ): TerminalTab {
    const count = 'panes' in entry ? entry.panes.length : entry.paneCount;
    const restored = Array.from({ length: count }, (_, index) => ({
      ...newPane(host),
      state: 'idle',
      connectRequested: false,
      elevated: 'panes' in entry ? entry.panes[index]!.elevated : undefined,
      savedSource: { id: entry.id, pane: index },
    }));
    const restoreLayout = (layout: SavedTerminalLayout): LayoutNode =>
      layout.kind === 'leaf'
        ? { kind: 'leaf', pane: restored[layout.pane]!.key }
        : {
            ...layout,
            id: crypto.randomUUID(),
            first: restoreLayout(layout.first),
            second: restoreLayout(layout.second),
          };
    return {
      key: crypto.randomUUID(),
      title: entry.title,
      renamed: true,
      savedId: entry.id,
      sessionNumber: nextSessionNumber(host?.id ?? ''),
      panes: restored,
      layout: restoreLayout(entry.layout),
    };
  }
  async function loadSaved(): Promise<void> {
    if (savedLoaded || savedLoading.value) return;
    savedLoading.value = true;
    savedError.value = null;
    try {
      const saved = await terminalApi.savedLocalSessions();
      for (const entry of saved) {
        if (tabs.value.some((tab) => tab.savedId === entry.id)) continue;
        tabs.value.push(restoreSavedTab(entry));
      }
      savedLoaded = true;
    } catch (cause) {
      savedError.value = errorMessage(cause);
      error.value = savedError.value;
    } finally {
      savedLoading.value = false;
    }
  }
  const sshLoaded = new Set<string>();
  const sshLoads = new Map<string, Promise<void>>();
  const sshLoading = ref(new Set<string>());
  const sshErrors = ref<Record<string, string>>({});
  async function loadHostSessions(host: Host): Promise<boolean> {
    const id = host.id;
    if (!sshLoaded.has(id)) {
      let pending = sshLoads.get(id);
      if (!pending) {
        sshLoading.value.add(id);
        delete sshErrors.value[id];
        pending = terminalApi
          .savedSshSessions(id)
          .then((records) => {
            for (const entry of records) {
              if (!hostTabs(id).some((t) => t.savedId === entry.id))
                tabs.value.push(restoreSavedTab(entry, host));
            }
            sshLoaded.add(id);
          })
          .catch((cause: unknown) => {
            sshErrors.value[id] = errorMessage(cause);
          })
          .finally(() => {
            sshLoads.delete(id);
            sshLoading.value.delete(id);
          });
        sshLoads.set(id, pending);
      }
      await pending;
    }
    return sshLoaded.has(id);
  }
  function canSave(key: string): boolean {
    const tab = tabs.value.find((tab) => tab.key === key);
    return (
      !!tab &&
      (!!tab.panes[0]?.host || navigator.platform.startsWith('Win')) &&
      !saving.value &&
      !changingConnections.value.includes(key) &&
      tab.panes.every((pane) => !pane.fileAction && !pane.containerShell && !pane.pluginTerminal) &&
      !tab.panes.some((pane) => closingPanes.has(pane.key)) &&
      (tab.panes.every((pane) => pane.state === 'connected' && !!pane.sessionId) ||
        (!!tab.savedId &&
          tab.panes.every((pane) =>
            ['idle', 'closed', 'failed', 'disconnected'].includes(pane.state),
          )))
    );
  }
  async function saveSession(key: string, title: string, nameOnly = false): Promise<boolean> {
    title = title.trim();
    const tab = tabs.value.find((tab) => tab.key === key);
    if (
      !tab ||
      !validTitle(title) ||
      saving.value ||
      (nameOnly ? !tab.savedId || tab.panes.some((p) => closingPanes.has(p.key)) : !canSave(key))
    )
      return false;
    saving.value = key;
    error.value = null;
    try {
      const indices = new Map(tab.panes.map((pane, index) => [pane.key, index]));
      const saveLayout = (layout: LayoutNode): SavedTerminalLayout =>
        layout.kind === 'leaf'
          ? { kind: 'leaf', pane: indices.get(layout.pane)! }
          : {
              kind: 'split',
              axis: layout.axis,
              ratio: layout.ratio,
              first: saveLayout(layout.first),
              second: saveLayout(layout.second),
            };
      const connected =
        !nameOnly && tab.panes.every((pane) => pane.state === 'connected' && !!pane.sessionId);
      const host = tab.panes[0]?.host;
      const input = {
        id: tab.savedId ?? null,
        title,
        layout: connected ? saveLayout(tab.layout) : null,
        sessionIds: connected ? tab.panes.map((p) => p.sessionId!) : [],
      };
      const saved = host
        ? await terminalApi.saveSshSession(host.id, input)
        : await terminalApi.saveLocalSession(input);
      tab.savedId = saved.id;
      tab.title = saved.title;
      tab.renamed = true;
      if (connected)
        tab.panes.forEach((pane, index) => {
          pane.savedSource = { id: saved.id, pane: index };
        });
      if (!nameOnly)
        useNotificationsStore().push(
          'layoutOnlyPanes' in saved && saved.layoutOnlyPanes
            ? tr('会话已保存。{0} 个窗格的远端 Shell 仅支持恢复布局。', saved.layoutOnlyPanes)
            : tr('会话已保存'),
        );
      return true;
    } catch (cause) {
      error.value = errorMessage(cause);
      return false;
    } finally {
      saving.value = '';
    }
  }
  function registerConnection(
    key: string,
    change: (action: ConnectionAction) => Promise<void>,
  ): () => void {
    connections.set(key, change);
    return () => {
      if (connections.get(key) === change) connections.delete(key);
    };
  }
  function canReconnect(key: string): boolean {
    const tab = tabs.value.find((tab) => tab.key === key);
    return (
      !!tab &&
      saving.value !== key &&
      !changingConnections.value.includes(key) &&
      !tab.panes.some((pane) => closingPanes.has(pane.key)) &&
      tab.panes.every(
        (pane) =>
          !pane.fileAction &&
          !pane.containerShell &&
          !pane.pluginTerminal &&
          ['closed', 'failed', 'disconnected'].includes(pane.state),
      )
    );
  }
  function canDisconnect(key: string): boolean {
    const tab = tabs.value.find((tab) => tab.key === key);
    return (
      !!tab &&
      saving.value !== key &&
      !changingConnections.value.includes(key) &&
      !tab.panes.some((pane) => closingPanes.has(pane.key)) &&
      !tab.panes.some((pane) => ['opening', 'closing'].includes(pane.state)) &&
      tab.panes.some(
        (pane) =>
          !!pane.sessionId && !['idle', 'closed', 'failed', 'disconnected'].includes(pane.state),
      )
    );
  }
  async function changeConnection(key: string, action: ConnectionAction): Promise<void> {
    if (!(action === 'reconnect' ? canReconnect(key) : canDisconnect(key))) return;
    const tab = tabs.value.find((tab) => tab.key === key);
    if (!tab) return;
    const targets = tab.panes.map((pane) => ({ pane, change: connections.get(pane.key) }));
    if (targets.some((target) => !target.change)) return;
    changingConnections.value.push(key);
    try {
      const uploading = targets.filter(({ pane }) => uploads.get(pane.key)?.active());
      if (
        uploading.length &&
        !(await usePluginsStore().ask(
          action === 'reconnect' ? tr('停止上传并重新连接') : tr('停止上传并断开连接'),
          tr(
            '目标会话还有待确认或进行中的拖放上传。继续将停止上传，保留已提交文件；断线时可能保留临时目录。是否继续？',
          ),
        ))
      )
        return;
      for (const { pane } of uploading) await uploads.get(pane.key)?.stop();
      for (const { pane, change } of targets) {
        if (panes.value.includes(pane) && connections.get(pane.key) === change)
          await change?.(action);
      }
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      changingConnections.value = changingConnections.value.filter((id) => id !== key);
    }
  }
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
        tr('停止上传并关闭终端'),
        tr('目标终端还有 ') +
          count +
          tr(
            ' 个待确认或进行中的拖放上传。关闭将停止上传，保留已提交文件；断线时可能保留临时目录。是否继续？',
          ),
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
    if (tab?.key !== active.value) select(tab?.key ?? '', false);
  }
  function activateLocal(): void {
    const available = hostTabs('');
    const opened = available.filter((tab) =>
      tab.panes.some((pane) => pane.state !== 'idle' || pane.connectRequested),
    );
    if (opened.length) {
      const tab =
        opened.find((tab) => tab.key === active.value) ??
        opened.find((tab) => tab.key === lastHostTabs.get('')) ??
        opened[0]!;
      if (tab.key !== active.value) select(tab.key, false);
      return;
    }
    const saved = available.find((tab) => tab.savedId);
    if (saved) select(saved.key);
    else activateHost('');
  }
  watch([active, focused], () => {
    const pane = panes.value.find((p) => p.key === focused.value);
    if (pane) lastHostTabs.set(pane.host?.id ?? '', active.value);
  });
  function hostState(id: string): string {
    const p = panes.value.filter((p) => p.host?.id === id || p.routeHostIds?.includes(id));
    return p.some((p) => p.state === 'connected')
      ? tr('已连接')
      : p.some((p) =>
            ['opening', 'connecting', 'authenticating', 'awaiting_trust'].includes(p.state),
          )
        ? tr('连接中')
        : tr('未连接');
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
    elevated = false,
  ): void {
    if (runningPaneCount() >= 32) {
      error.value = tr('最多打开 32 个终端窗格。');
      return;
    }
    const pane = newPane(host);
    pane.fileAction = fileAction;
    pane.containerShell = containerShell;
    if (!host) pane.elevated = elevated;
    const key = crypto.randomUUID();
    tabs.value.push({
      key,
      title: host ? hostDisplayName(host) : tr('本地设备'),
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
    if (!tab || !pane || saving.value === tab.key || closingPanes.has(key)) return;
    if (tab.panes.length >= 8 || runningPaneCount() >= 32) {
      error.value = tr('每个标签最多 8 个窗格，总计最多 32 个。');
      return;
    }
    const added = newPane(pane.host);
    if (!pane.host) added.elevated = pane.elevated;
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
    if (pane) open(pane.host, undefined, undefined, pane.elevated);
  }
  function resize(tabId: string, id: string, ratio: number): void {
    const tab = tabs.value.find((t) => t.key === tabId);
    if (tab && saving.value !== tabId) tab.layout = resizeNode(tab.layout, id, ratio);
  }
  function validTitle(title: string): boolean {
    if (
      !title ||
      title.length > 128 ||
      Array.from(title).some(
        (c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
      )
    ) {
      error.value = tr('标签名称须为 1–128 个字符且不含控制字符。');
      return false;
    }
    return true;
  }
  async function rename(key: string, title: string): Promise<boolean> {
    if (saving.value === key) return false;
    title = title.trim();
    if (!validTitle(title)) return false;
    const tab = tabs.value.find((t) => t.key === key);
    if (tab?.savedId) return saveSession(key, title, true);
    if (tab) {
      tab.title = title;
      tab.renamed = true;
    }
    return !!tab;
  }
  function reorder(key: string, before: string): void {
    const from = tabs.value.findIndex((t) => t.key === key),
      to = tabs.value.findIndex((t) => t.key === before);
    if (from < 0 || to < 0 || from === to) return;
    const [tab] = tabs.value.splice(from, 1);
    if (tab) tabs.value.splice(to, 0, tab);
  }
  function select(key: string, connect = true): void {
    const tab = tabs.value.find((tab) => tab.key === key);
    if (connect && tab?.panes.some((pane) => closingPanes.has(pane.key))) return;
    const pending = connect
      ? (tab?.panes.filter((pane) => pane.state === 'idle' && !pane.connectRequested) ?? [])
      : [];
    if (runningPaneCount() + pending.length > 32) {
      error.value = tr('最多打开 32 个终端窗格。');
      return;
    }
    for (const pane of pending) pane.connectRequested = true;
    active.value = key;
    focused.value = tab?.panes[0]?.key ?? '';
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
      select(hostTabs(hostId)[Math.min(position, available.length - 2)]?.key ?? '', false);
  }
  async function closePane(key: string, approved = false, keepSaved = false): Promise<void> {
    const tab = tabs.value.find((t) => t.panes.some((p) => p.key === key));
    const pane = tab?.panes.find((p) => p.key === key);
    if (
      !tab ||
      !pane ||
      closingPanes.has(key) ||
      changingConnections.value.includes(tab.key) ||
      saving.value === tab.key
    )
      return;
    closingPanes.add(key);
    let previousState = pane.state;
    try {
      const decision = approved || confirmUploadClose([pane]);
      if (decision !== true && !(await decision)) return;
      const upload = uploads.get(pane.key);
      if (upload?.active()) await upload.stop();
      if (pane.sessionId) {
        previousState = pane.state;
        pane.state = 'closing';
        await terminalApi.close(pane.sessionId);
        pane.state = 'closed';
        pane.sessionId = undefined;
        pane.connectRequested = false;
      }
      const layout = removeLeaf(tab.layout, key);
      if (!layout) {
        if (tab.savedId && !keepSaved) {
          if (pane.host) await terminalApi.removeSavedSshSession(pane.host.id, tab.savedId);
          else await terminalApi.removeSavedLocalSession(tab.savedId);
        }
        removeTab(tab.key);
      } else {
        tab.panes = tab.panes.filter((p) => p.key !== key);
        tab.layout = layout;
        if (focused.value === key) focused.value = tab.panes[0]?.key ?? '';
      }
    } catch (cause) {
      if (pane.state === 'closing') pane.state = previousState;
      error.value = errorMessage(cause);
    } finally {
      closingPanes.delete(key);
    }
  }
  async function close(key: string, approved = false, keepSaved = false): Promise<void> {
    const tab = tabs.value.find((t) => t.key === key);
    if (!tab || changingConnections.value.includes(key)) return;
    const decision = approved || confirmUploadClose(tab.panes);
    if (decision !== true && !(await decision)) return;
    for (const pane of [...tab.panes]) await closePane(pane.key, true, keepSaved);
  }
  async function closeAll(key: string, approved = false, keepSaved = false): Promise<void> {
    const tab = tabs.value.find((t) => t.key === key);
    if (!tab) return;
    if (
      hostTabs(tab.panes[0]?.host?.id ?? '').some((tab) =>
        changingConnections.value.includes(tab.key),
      )
    )
      return;
    const decision = approved || confirmHostUploadClose(tab.panes[0]?.host?.id ?? '');
    if (decision !== true && !(await decision)) return;
    const targets = hostTabs(tab.panes[0]?.host?.id ?? '').map((t) => t.key);
    for (const id of targets) await close(id, true, keepSaved);
  }
  async function closeWorkspace(hostId: string): Promise<void> {
    // Wait for the host list before releasing its runtime tabs.
    const loading = sshLoads.get(hostId);
    if (loading) await loading;
    const first = hostTabs(hostId)[0];
    if (first) await closeAll(first.key, true, !!hostId);
    if (!hostTabs(hostId).length) sshLoaded.delete(hostId);
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
    loadHostSessions,
    sshErrors,
    sshLoading,
    closeWorkspace,
    activateHost,
    activateLocal,
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
    registerConnection,
    canReconnect,
    canDisconnect,
    reconnect: (key: string) => changeConnection(key, 'reconnect'),
    disconnect: (key: string) => changeConnection(key, 'disconnect'),
    changingConnections,
    confirmHostUploadClose,
    loadSaved,
    savedLoading,
    savedError,
    saving,
    canSave,
    saveSession,
  };
});
