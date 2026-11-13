import { tr } from '../i18n/messages';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';
import { useErrorNotifications } from '../composables/error-notifications';
import { computed, onScopeDispose, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Host } from '../types/hosts';
import type { DirectoryListing, ExternalDocument, SftpUser, TransferInfo } from '../types/files';
import { unfinished } from '../types/files';
import type { TerminalEvent } from '../types/terminal';
import { filesApi } from '../services/files';
import type { EditorDocument, EditorStatus } from '../services/editor';
import { useTerminalsStore } from './terminals';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import { usePluginsStore } from './plugins';
import { useNotificationsStore } from './notifications';
import type { TerminalSession } from '../types/terminal';
export interface FileConnection {
  host: Host;
  id?: string;
  routeHostIds?: string[];
  state: string;
  error: string | null;
  trust: Extract<TerminalEvent, { type: 'trust' }> | null;
  path: string;
  pendingPath?: string;
  listing: DirectoryListing | null;
  loading: boolean;
  followPane?: string;
  username?: string;
  elevated?: boolean;
  switchingUser?: boolean;
}

type HistoryDirection = 'back' | 'forward';
type DirectoryHistory = Record<HistoryDirection, string[]>;
interface LocalFileBrowser {
  listing: DirectoryListing | null;
  loading: boolean;
  pendingPath: string | null;
  generation: number;
  history: DirectoryHistory;
}
const directoryHistoryLimit = 100;

function recordDirectory(
  history: DirectoryHistory,
  previous: string | undefined,
  next: string,
  direction?: HistoryDirection,
): void {
  if (!previous) return;
  if (direction) {
    history[direction].pop();
    if (previous !== next) history[direction === 'back' ? 'forward' : 'back'].push(previous);
  } else if (previous !== next) {
    history.back.push(previous);
    if (history.back.length > directoryHistoryLimit) history.back.shift();
    history.forward.length = 0;
  }
}

export const useFilesStore = defineStore('files', () => {
  const notifications = useNotificationsStore();
  const connections = ref<Record<string, FileConnection>>({}),
    active = ref(''),
    localBrowsers = ref<Record<string, LocalFileBrowser>>({}),
    error = ref<string | null>(null),
    tasks = ref<TransferInfo[]>([]),
    document = ref<EditorDocument | null>(null),
    dirty = ref(false),
    editorBusy = ref(false),
    openingPath = ref(''),
    openIssue = ref<{ sessionId: string; path: string; message: string } | null>(null),
    externalDocument = ref<ExternalDocument | null>(null),
    externalBusy = ref(false),
    externalSaving = ref(false),
    localOpening = ref(false),
    externalError = ref<string | null>(null),
    exitReview = ref(false),
    closingHosts = ref<string[]>([]);
  const current = computed(() => connections.value[active.value]);
  const localBrowser = computed(() => localBrowsers.value[active.value]);
  const local = computed({
    get: () => localBrowser.value?.listing ?? null,
    set: (value: DirectoryListing | null) => {
      ensureLocalBrowser(active.value).listing = value;
    },
  });
  const localLoading = computed(() => localBrowser.value?.loading ?? false);
  const localPendingPath = computed(() => localBrowser.value?.pendingPath ?? null);
  const pending = computed(() => tasks.value.filter(unfinished).length);
  let editorGeneration = 0;
  let transferGeneration = 0;
  const opening = new Map<string, Promise<TerminalSession>>();
  const generations = new Map<string, number>();
  const remoteHistories = new WeakMap<FileConnection, DirectoryHistory>();
  function ensureLocalBrowser(hostId: string): LocalFileBrowser {
    localBrowsers.value[hostId] ??= {
      listing: null,
      loading: false,
      pendingPath: null,
      generation: 0,
      history: { back: [], forward: [] },
    };
    return localBrowsers.value[hostId];
  }
  async function localLoad(
    path: string | null = null,
    direction?: HistoryDirection,
    hostId = active.value,
  ): Promise<void> {
    const browser = ensureLocalBrowser(hostId);
    const generation = ++browser.generation;
    const isCurrentRequest = () =>
      localBrowsers.value[hostId] === browser && generation === browser.generation;
    browser.pendingPath = path;
    browser.loading = true;
    try {
      const value = await filesApi.local(path);
      if (isCurrentRequest()) {
        recordDirectory(browser.history, browser.listing?.path, value.path, direction);
        browser.listing = value;
      }
    } catch (cause) {
      if (isCurrentRequest()) error.value = errorMessage(cause);
    } finally {
      if (isCurrentRequest()) {
        browser.loading = false;
        browser.pendingPath = null;
      }
    }
  }
  async function navigate(
    path: string,
    connection = current.value,
    direction?: HistoryDirection,
  ): Promise<void> {
    if (!connection?.id || connection.switchingUser) return;
    const { id, host } = connection;
    const generation = (generations.get(host.id) ?? 0) + 1;
    generations.set(host.id, generation);
    const isCurrentRequest = () =>
      generation === generations.get(host.id) &&
      connections.value[host.id] === connection &&
      connection.id === id;
    connection.loading = true;
    connection.pendingPath = path;
    connection.error = null;
    try {
      const value = await filesApi.list(id, path);
      if (!isCurrentRequest()) return;
      const history = remoteHistories.get(connection) ?? { back: [], forward: [] };
      recordDirectory(history, connection.listing?.path, value.path, direction);
      remoteHistories.set(connection, history);
      connection.listing = value;
      connection.path = value.path;
    } catch (cause) {
      if (!isCurrentRequest()) return;
      connection.error = errorMessage(cause);
      if (
        typeof cause === 'object' &&
        cause &&
        'code' in cause &&
        [
          'SFTP_DISCONNECTED',
          'SFTP_NOT_CONNECTED',
          'SFTP_NETWORK',
          'SSH_NETWORK',
          'NOT_FOUND',
        ].includes(String(cause.code))
      )
        connection.state = 'failed';
    } finally {
      if (isCurrentRequest()) {
        connection.loading = false;
        connection.pendingPath = undefined;
      }
    }
  }
  function stepHistory(side: 'local' | 'remote', direction: HistoryDirection): boolean {
    if (side === 'local') {
      const path = localBrowser.value?.history[direction].at(-1);
      if (!path || localLoading.value) return false;
      void localLoad(path, direction);
      return true;
    }
    const connection = current.value;
    if (
      !connection?.id ||
      connection.state !== 'connected' ||
      connection.loading ||
      closingHosts.value.includes(connection.host.id)
    )
      return false;
    const path = remoteHistories.get(connection)?.[direction].at(-1);
    if (!path) return false;
    void navigate(path, connection, direction);
    return true;
  }
  async function open(host: Host, path?: string, pane?: string): Promise<void> {
    if (closingHosts.value.includes(host.id)) return;
    active.value = host.id;
    let connection = connections.value[host.id];
    if (connection?.switchingUser) return;
    if (connection?.id && connection.state === 'connected') {
      connection.followPane = pane;
      await navigate(path ?? connection.path, connection);
      return;
    }
    if (
      connection &&
      ['opening', 'connecting', 'authenticating', 'awaiting_trust'].includes(connection.state)
    )
      return;
    if (connection?.id) {
      try {
        await filesApi.close(connection.id, false);
      } catch (cause) {
        error.value = errorMessage(cause);
        return;
      }
    }
    connections.value[host.id] = {
      host,
      state: 'opening',
      error: null,
      trust: null,
      path: path ?? '.',
      listing: null,
      loading: false,
      followPane: pane,
    };
    connection = connections.value[host.id]!;
    try {
      let eventSession = '';
      const request = filesApi.open(host.id, (event) => {
        if (eventSession && connection.id !== eventSession) return;
        if (event.type === 'state') {
          connection.state = event.state;
          if (event.message) connection.error = event.message;
          if (event.state !== 'awaiting_trust') connection.trust = null;
          if (event.state === 'connected' && connection.id)
            void navigate(connection.path, connection);
        } else if (event.type === 'trust') connection.trust = event;
      });
      opening.set(host.id, request);
      const value = await request;
      eventSession = value.id;
      connection.id = value.id;
      connection.routeHostIds = value.routeHostIds;
      if (connection.state === 'connected') await navigate(connection.path, connection);
    } catch (cause) {
      connection.state = 'failed';
      connection.error = errorMessage(cause);
    } finally {
      opening.delete(host.id);
    }
    if (connections.value[host.id] === connection && !closingHosts.value.includes(host.id)) {
      const browser = ensureLocalBrowser(host.id);
      if (!browser.listing && !browser.loading) await localLoad(null, undefined, host.id);
    }
  }
  const switching = new Map<string, Promise<boolean>>();
  async function switchUser(user: SftpUser | null): Promise<boolean> {
    const connection = current.value;
    if (
      !connection?.id ||
      connection.state !== 'connected' ||
      connection.switchingUser ||
      closingHosts.value.includes(connection.host.id)
    )
      return false;
    const { id, host } = connection;
    if (
      editorBusy.value ||
      document.value?.sessionId === id ||
      externalDocument.value?.sessionId === id
    ) {
      error.value = tr('请先保存并关闭编辑文档，再切换 SFTP 用户。');
      return false;
    }
    connection.switchingUser = true;
    transferGeneration++;
    connection.loading = false;
    connection.pendingPath = undefined;
    generations.set(host.id, (generations.get(host.id) ?? 0) + 1);
    const request = (async () => {
      try {
        const value = await filesApi.switchUser(id, user);
        connection.id = value.session.id;
        connection.routeHostIds = value.session.routeHostIds;
        connection.username = user?.username ?? host.username;
        connection.elevated = user !== null;
        connection.state = 'connected';
        connection.listing = value.listing;
        connection.path = value.listing.path;
        connection.error = null;
        connection.followPane = undefined;
        remoteHistories.delete(connection);
        return true;
      } catch (cause) {
        error.value = errorMessage(cause);
        return false;
      } finally {
        connection.switchingUser = false;
        transferGeneration++;
      }
    })();
    switching.set(host.id, request);
    try {
      return await request;
    } finally {
      switching.delete(host.id);
    }
  }
  async function trust(accept: boolean): Promise<void> {
    if (!current.value?.id) return;
    try {
      await terminalApi.trust(current.value.id, accept);
      current.value.trust = null;
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }
  async function refresh(): Promise<void> {
    const connection = current.value;
    const hostId = active.value;
    if (connection?.id && connection.state === 'connected' && !connection.loading)
      await navigate(connection.path, connection);
    const browser = localBrowsers.value[hostId];
    if (browser?.listing && !browser.loading)
      await localLoad(browser.listing.path, undefined, hostId);
  }
  async function edit(path: string, size: number | null = null): Promise<void> {
    if (!current.value?.id || editorBusy.value || closingHosts.value.includes(active.value)) return;
    if (document.value || externalDocument.value) {
      error.value = tr('请先保存或关闭当前编辑文档。');
      return;
    }
    const sessionId = current.value.id;
    openIssue.value = null;
    openingPath.value = path;
    if (size !== null && size > 2 * 1024 * 1024) {
      openIssue.value = {
        sessionId,
        path,
        message: tr('文件超过内置编辑器的 2 MiB 上限，可使用系统应用编辑。'),
      };
      return;
    }
    editorBusy.value = true;
    const generation = editorGeneration;
    const { host, username } = current.value;
    const connectionCaption = `${username ?? host.username}@${host.hostname}`;
    try {
      const opened = await filesApi.openEditor(sessionId, path, connectionCaption);
      if (generation === editorGeneration) {
        document.value = opened;
        dirty.value = false;
      }
    } catch (cause) {
      openIssue.value = { sessionId, path, message: errorMessage(cause) };
    } finally {
      editorBusy.value = false;
    }
  }
  function editorState(status: EditorStatus): void {
    editorGeneration++;
    document.value = status.document;
    dirty.value = status.dirty;
  }
  async function syncEditorState(): Promise<void> {
    const generation = editorGeneration;
    const status = await filesApi.editorStatus();
    if (generation === editorGeneration) editorState(status);
  }
  function offerExternal(path: string): void {
    if (!current.value?.id) return;
    if (document.value || externalDocument.value || editorBusy.value) {
      error.value = tr('请先保存或关闭当前编辑文档。');
      return;
    }
    openIssue.value = {
      sessionId: current.value.id,
      path,
      message: tr('使用本机应用编辑远程文件，保存后返回此处确认回传。'),
    };
  }
  async function openLocal(path: string): Promise<void> {
    if (localOpening.value) return;
    localOpening.value = true;
    try {
      await filesApi.openLocal(path);
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      localOpening.value = false;
    }
  }
  async function startExternal(): Promise<void> {
    const issue = openIssue.value;
    if (!issue || externalBusy.value || document.value || externalDocument.value) return;
    externalBusy.value = true;
    externalError.value = null;
    try {
      externalDocument.value = await filesApi.externalPrepare(issue.sessionId, issue.path);
      openIssue.value = null;
      void poll();
    } catch (cause) {
      externalError.value = errorMessage(cause);
    } finally {
      externalBusy.value = false;
    }
  }
  async function finishExternalDownload(): Promise<void> {
    const old = externalDocument.value;
    if (!old || old.ready || externalBusy.value || externalError.value) return;
    const task = tasks.value.find((task) => task.id === old.transferId);
    if (!task || unfinished(task)) return;
    if (task.state !== 'completed') {
      externalError.value = task.message ?? tr('外部编辑副本下载未完成，请结束本次编辑后重试。');
      return;
    }
    externalBusy.value = true;
    try {
      const ready = await filesApi.externalReady(old.token);
      externalDocument.value = ready;
      await filesApi.openLocal(ready.localPath);
    } catch (cause) {
      externalError.value = errorMessage(cause);
    } finally {
      externalBusy.value = false;
    }
  }
  async function saveExternal(confirmed: boolean): Promise<void> {
    const external = externalDocument.value;
    if (!external?.ready || externalBusy.value || !confirmed) return;
    externalBusy.value = true;
    externalSaving.value = true;
    externalError.value = null;
    try {
      const result = await filesApi.externalSave(external.token, true);
      if (!result.document) {
        externalError.value = tr(
          '{0}；恢复路径：{1}',
          result.message ?? tr('回传失败'),
          result.recoveryPath ?? tr('无'),
        );
        return;
      }
      notifications.push(tr('外部编辑的文件已回传并校验；继续编辑后需再次确认回传。'));
      void refresh();
    } catch (cause) {
      externalError.value = errorMessage(cause);
    } finally {
      externalBusy.value = false;
      externalSaving.value = false;
    }
  }
  async function cancelExternalSave(): Promise<void> {
    if (
      !externalDocument.value ||
      (!externalSaving.value && (externalDocument.value.ready || !externalBusy.value))
    )
      return;
    try {
      await filesApi.externalCancel(externalDocument.value.token);
    } catch (cause) {
      externalError.value = errorMessage(cause);
    }
  }
  async function closeExternal(): Promise<void> {
    const external = externalDocument.value;
    if (!external || externalBusy.value) return;
    externalBusy.value = true;
    try {
      if (
        !external.ready &&
        tasks.value.some((task) => task.id === external.transferId && unfinished(task))
      ) {
        await filesApi.cancel(external.transferId);
      }
      await filesApi.closeEditor(external.token, true);
      externalDocument.value = null;
      externalError.value = null;
      notifications.push(
        tr('已结束外部编辑，本地副本保留于：{0}', displayLocalPath(external.localPath)),
      );
    } catch (cause) {
      externalError.value = errorMessage(cause);
    } finally {
      externalBusy.value = false;
    }
  }
  async function prepareHostClose(hostId: string): Promise<boolean> {
    try {
      await switching.get(hostId);
      // Wait for an already requested lease so it cannot arrive after the workspace closes.
      await opening.get(hostId)?.catch(() => undefined);
      const [latest, live] = await Promise.all([filesApi.tasks(), filesApi.connections()]);
      tasks.value = latest;
      const connection = connections.value[hostId];
      const ids = new Set(live.filter((session) => session.hostId === hostId).map((s) => s.id));
      if (connection?.id) ids.add(connection.id);
      for (const task of latest)
        if (task.hostId === hostId && unfinished(task)) ids.add(task.sessionId);
      if (
        (document.value && ids.has(document.value.sessionId)) ||
        (externalDocument.value && ids.has(externalDocument.value.sessionId)) ||
        (editorBusy.value && active.value === hostId)
      ) {
        error.value = tr('请先关闭此主机的编辑文档，再关闭主机。');
        return false;
      }
      const count = latest.filter((task) => task.hostId === hostId && unfinished(task)).length;
      if (
        count &&
        !(await usePluginsStore().ask(
          tr('取消传输并关闭主机'),
          tr(
            '此主机还有 {0} 个未完成的传输。确认后取消传输并关闭主机，已完成文件保留，传输记录将清除。提交中的单个文件会等待结果。',
            count,
          ),
        ))
      )
        return false;
      for (const id of ids) {
        const previous = connection?.state;
        if (connection?.id === id) connection.state = 'closing';
        try {
          await filesApi.close(id, count > 0);
        } catch (cause) {
          if (connection?.id === id) connection.state = previous!;
          throw cause;
        }
        if (connection?.id === id) {
          connection.state = 'closed';
          connection.id = undefined;
          connection.trust = null;
        }
        if (document.value?.sessionId === id) {
          document.value = null;
          dirty.value = false;
        }
      }
      // Keep cancellation failures and recovery paths visible before clearing the records.
      tasks.value = await filesApi.tasks();
      return true;
    } catch (cause) {
      error.value = errorMessage(cause);
      return false;
    }
  }
  async function clearHostTransfers(hostId: string): Promise<boolean> {
    try {
      await filesApi.clearTransfers(hostId);
      transferGeneration++;
      tasks.value = tasks.value.filter((task) => task.hostId !== hostId);
      delete connections.value[hostId];
      delete localBrowsers.value[hostId];
      return true;
    } catch (cause) {
      error.value = errorMessage(cause);
      return false;
    }
  }
  let polling = false,
    disposed = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  async function poll(): Promise<void> {
    if (polling || disposed) return;
    polling = true;
    const generation = transferGeneration;
    clearTimeout(timer);
    try {
      const [value, live] = await Promise.all([filesApi.tasks(), filesApi.connections()]);
      if (generation !== transferGeneration) return;
      for (const connection of Object.values(connections.value)) {
        if (
          connection.state === 'connected' &&
          !connection.switchingUser &&
          !live.some((c) => c.id === connection.id)
        ) {
          connection.state = 'failed';
          connection.error = tr('SSH 文件连接已关闭，请重新连接。');
        }
      }
      const before = new Map(tasks.value.map((t) => [t.id, t.state]));
      const finished = value.filter(
        (t) => t.state === 'completed' && before.get(t.id) && before.get(t.id) !== 'completed',
      );
      tasks.value = value;
      void finishExternalDownload();
      if (finished.length) {
        void refresh();
      }
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      polling = false;
      if (!disposed) timer = setTimeout(() => void poll(), 750);
    }
  }
  onScopeDispose(() => {
    disposed = true;
    clearTimeout(timer);
  });
  function hostState(id: string): string {
    const state = useTerminalsStore().hostState(id);
    const related = Object.values(connections.value).filter(
      (c) => c.host.id === id || c.routeHostIds?.includes(id),
    );
    if (state === tr('已连接') || related.some((c) => c.state === 'connected')) return tr('已连接');
    if (
      state === tr('连接中') ||
      related.some((c) =>
        ['opening', 'connecting', 'authenticating', 'awaiting_trust'].includes(c.state),
      )
    )
      return tr('连接中');
    return tr('未连接');
  }
  useErrorNotifications(() => [
    error.value,
    ...Object.values(connections.value).map((connection) => connection.error),
    ...tasks.value
      .filter((task) => task.state === 'failed' || task.recoveryPaths.length > 0)
      .map((task) =>
        task.message || task.recoveryPaths.length
          ? tr(
              '文件传输 {0}（HostId={1}）：{2}',
              task.id,
              task.hostId,
              [
                task.message,
                ...task.recoveryPaths.map((path) =>
                  tr(
                    '待检查临时文件：{0}',
                    task.direction === 'download' ? displayLocalPath(path) : path,
                  ),
                ),
              ]
                .filter(Boolean)
                .join('；'),
            )
          : null,
      ),
  ]);
  return {
    hostState,
    connections,
    active,
    current,
    localBrowsers,
    local,
    localLoading,
    localPendingPath,
    error,
    tasks,
    pending,
    document,
    dirty,
    editorBusy,
    openingPath,
    openIssue,
    externalDocument,
    externalBusy,
    externalSaving,
    localOpening,
    cancelExternalSave,
    externalError,
    editorState,
    syncEditorState,
    offerExternal,
    openLocal,
    startExternal,
    saveExternal,
    closeExternal,
    exitReview,
    closingHosts,
    prepareHostClose,
    clearHostTransfers,
    open,
    switchUser,
    navigate,
    stepHistory,
    localLoad,
    trust,
    refresh,
    edit,
    poll,
  };
});
