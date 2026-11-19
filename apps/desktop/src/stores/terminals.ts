import { tr } from '../i18n/messages';
import { useErrorNotifications } from '../composables/error-notifications';
import { defineStore } from 'pinia';
import { computed, reactive, ref, watch } from 'vue';
import { hostDisplayName, type Host } from '../types/hosts';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import { sameHostConnection } from '../services/product-links';
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
  restoreFromSavedMenu?: boolean;
}
export interface TerminalTab {
  key: string;
  title: string;
  renamed?: boolean;
  generatedTitle?: boolean;
  sessionNumber: number;
  panes: TerminalPaneModel[];
  layout: LayoutNode;
  savedId?: string;
}
type ConnectionAction = 'reconnect' | 'disconnect';
type ChangeConnection = (action: ConnectionAction, explicitRestore: boolean) => Promise<void>;
type SavedSession = SavedLocalTerminal | SavedSshTerminal;
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
  const connections = new Map<string, ChangeConnection>();
  const closingPanes = new Set<string>();
  const changingConnections = ref<string[]>([]);
  const savedLoading = ref(false),
    savedError = ref<string | null>(null),
    saving = ref('');
  const savedRecords = ref(new Map<string, SavedSession[]>());
  const savedCommands = reactive(new WeakMap<SavedSession, string>());
  const deleting = ref<{ hostId: string; id: string } | null>(null);
  let localLoad: Promise<void> | undefined;
  function savedSessions(hostId: string): readonly SavedSession[] {
    return savedRecords.value.get(hostId) ?? [];
  }
  function savedSessionTitle(entry: SavedSession): string {
    const command = savedCommands.get(entry);
    return command ? `${entry.title} · ${command}` : entry.title;
  }
  async function loadSavedTitleCommands(hostId: string): Promise<void> {
    const entries = savedSessions(hostId).filter((entry) => entry.titleCommandPane !== undefined);
    if (!entries.length) return;
    try {
      const commands = await terminalApi.savedTitleCommands(hostId);
      for (const entry of entries) {
        const preview = commands[entry.id];
        if (preview) savedCommands.set(entry, preview);
      }
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }
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
      restoreFromSavedMenu: true,
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
      generatedTitle: entry.titleCommandPane !== undefined,
      savedId: entry.id,
      sessionNumber: nextSessionNumber(host?.id ?? ''),
      panes: restored,
      layout: restoreLayout(entry.layout),
    };
  }
  async function loadSaved(): Promise<void> {
    if (savedRecords.value.has('')) return;
    if (!localLoad) {
      savedLoading.value = true;
      savedError.value = null;
      localLoad = Promise.resolve()
        .then(() => terminalApi.savedLocalSessions())
        .then((records) => {
          savedRecords.value.set('', records);
        })
        .catch((cause: unknown) => {
          savedError.value = errorMessage(cause);
          error.value = savedError.value;
        })
        .finally(() => {
          localLoad = undefined;
          savedLoading.value = false;
        });
    }
    await localLoad;
  }
  const sshLoads = new Map<string, Promise<void>>();
  const sshLoading = ref(new Set<string>());
  const sshErrors = ref<Record<string, string>>({});
  async function loadHostSessions(host: Host): Promise<boolean> {
    const id = host.id;
    if (!savedRecords.value.has(id)) {
      let pending = sshLoads.get(id);
      if (!pending) {
        sshLoading.value.add(id);
        delete sshErrors.value[id];
        pending = terminalApi
          .savedSshSessions(id)
          .then((records) => {
            savedRecords.value.set(id, records);
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
    return savedRecords.value.has(id);
  }
  function isDeletingSaved(hostId: string, id: string | undefined): boolean {
    return deleting.value?.hostId === hostId && deleting.value.id === id;
  }
  function restoreSavedSession(host: Host | null, id: string): void {
    const hostId = host?.id ?? '';
    if (isDeletingSaved(hostId, id)) return;
    const existing = hostTabs(hostId).find((tab) => tab.savedId === id);
    if (existing) {
      select(existing.key);
      if (canReconnect(existing.key)) {
        const snapshot = existing.panes[0]?.host;
        if (host && snapshot && !sameHostConnection(snapshot, host)) {
          error.value = tr('主机连接配置已变更，请从主机树重新打开后再重新连接会话。');
          return;
        }
        void changeConnection(existing.key, 'reconnect', true);
      }
      return;
    }
    const record = savedSessions(hostId).find((entry) => entry.id === id);
    if (!record) return;
    if (runningPaneCount() + ('panes' in record ? record.panes.length : record.paneCount) > 32) {
      error.value = tr('最多打开 32 个终端窗格。');
      return;
    }
    const tab = restoreSavedTab(record, host);
    tabs.value.push(tab);
    select(tab.key);
  }
  function canDeleteSaved(hostId: string, id: string): boolean {
    if (saving.value || deleting.value || !savedSessions(hostId).some((entry) => entry.id === id))
      return false;
    const tab = hostTabs(hostId).find((item) => item.savedId === id);
    return (
      !tab ||
      (!changingConnections.value.includes(tab.key) &&
        tab.panes.every(
          (pane) =>
            !pane.savedSource ||
            (!pane.connectRequested &&
              (['closed', 'failed', 'disconnected'].includes(pane.state) || !!pane.sessionId)),
        ))
    );
  }
  async function deleteSavedSession(hostId: string, id: string): Promise<void> {
    if (!canDeleteSaved(hostId, id)) return;
    deleting.value = { hostId, id };
    error.value = null;
    try {
      if (hostId) await terminalApi.removeSavedSshSession(hostId, id);
      else await terminalApi.removeSavedLocalSession(id);
      savedRecords.value.set(
        hostId,
        savedSessions(hostId).filter((entry) => entry.id !== id),
      );
      const tab = hostTabs(hostId).find((item) => item.savedId === id);
      if (tab) {
        delete tab.savedId;
        for (const pane of tab.panes) delete pane.savedSource;
      }
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      deleting.value = null;
    }
  }
  function canSave(key: string): boolean {
    const tab = tabs.value.find((tab) => tab.key === key);
    return (
      !!tab &&
      (!!tab.panes[0]?.host || navigator.platform.startsWith('Win')) &&
      !saving.value &&
      !deleting.value &&
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
  async function saveSession(
    key: string,
    title: string,
    { nameOnly = false, defaultTitle = false } = {},
  ): Promise<boolean> {
    title = title.trim();
    const tab = tabs.value.find((tab) => tab.key === key);
    if (
      !tab ||
      !validTitle(title) ||
      saving.value ||
      deleting.value ||
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
      if (host) {
        if (!(await loadHostSessions(host))) {
          error.value = sshErrors.value[host.id] ?? null;
          return false;
        }
      } else {
        await loadSaved();
        if (savedError.value) return false;
      }
      const hostId = host?.id ?? '';
      const previous = savedSessions(hostId).find((entry) => entry.id === tab.savedId);
      const previousTitlePane = previous?.titleCommandPane;
      const titleCommandPane =
        !nameOnly && (defaultTitle || tab.generatedTitle || previousTitlePane !== undefined)
          ? connected
            ? Math.max(
                0,
                tab.panes.findIndex((pane) => pane.key === focused.value),
              )
            : previousTitlePane
          : undefined;
      const input = {
        id: tab.savedId ?? null,
        title,
        ...(titleCommandPane === undefined ? {} : { titleCommandPane }),
        layout: connected ? saveLayout(tab.layout) : null,
        sessionIds: connected ? tab.panes.map((p) => p.sessionId!) : [],
      };
      const saved = host
        ? await terminalApi.saveSshSession(host.id, input)
        : await terminalApi.saveLocalSession(input);
      const entries = [...savedSessions(hostId)];
      const index = entries.findIndex((entry) => entry.id === saved.id);
      if (index < 0) entries.push(saved);
      else entries[index] = saved;
      savedRecords.value.set(hostId, entries);
      tab.savedId = saved.id;
      tab.title = saved.title;
      tab.renamed = true;
      tab.generatedTitle = saved.titleCommandPane !== undefined;
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
      if (titleCommandPane !== undefined) void loadSavedTitleCommands(hostId);
      return true;
    } catch (cause) {
      error.value = errorMessage(cause);
      return false;
    } finally {
      saving.value = '';
    }
  }
  function registerConnection(key: string, change: ChangeConnection): () => void {
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
      !isDeletingSaved(tab.panes[0]?.host?.id ?? '', tab.savedId) &&
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
  async function changeConnection(
    key: string,
    action: ConnectionAction,
    explicitRestore = false,
  ): Promise<void> {
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
          await change?.(action, explicitRestore);
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
    if (tab?.savedId) return saveSession(key, title, { nameOnly: true });
    if (tab) {
      tab.title = title;
      tab.renamed = true;
      tab.generatedTitle = false;
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
  async function closePane(key: string, approved = false): Promise<void> {
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
      if (!layout) removeTab(tab.key);
      else {
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
  async function close(key: string, approved = false): Promise<void> {
    const tab = tabs.value.find((t) => t.key === key);
    if (!tab || changingConnections.value.includes(key)) return;
    const decision = approved || confirmUploadClose(tab.panes);
    if (decision !== true && !(await decision)) return;
    for (const pane of [...tab.panes]) await closePane(pane.key, true);
  }
  async function closeAll(key: string, approved = false): Promise<void> {
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
    for (const id of targets) await close(id, true);
  }
  async function closeWorkspace(hostId: string): Promise<void> {
    const first = hostTabs(hostId)[0];
    if (first) await closeAll(first.key, true);
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
    savedSessions,
    savedSessionTitle,
    loadSavedTitleCommands,
    restoreSavedSession,
    canDeleteSaved,
    deleteSavedSession,
  };
});
