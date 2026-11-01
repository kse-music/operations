import { computed, onScopeDispose, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Host } from '../types/hosts';
import type { DirectoryListing, TextDocument, TransferInfo } from '../types/files';
import { unfinished } from '../types/files';
import type { TerminalEvent } from '../types/terminal';
import { filesApi } from '../services/files';
import { useTerminalsStore } from './terminals';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import { useNotificationsStore } from './notifications';
export interface FileConnection {
  host: Host;
  id?: string;
  routeHostIds?: string[];
  state: string;
  error: string | null;
  trust: Extract<TerminalEvent, { type: 'trust' }> | null;
  path: string;
  listing: DirectoryListing | null;
  loading: boolean;
  followPane?: string;
}
export const useFilesStore = defineStore('files', () => {
  const connections = ref<Record<string, FileConnection>>({}),
    active = ref(''),
    local = ref<DirectoryListing | null>(null),
    localLoading = ref(false),
    error = ref<string | null>(null),
    notice = ref<string | null>(null),
    tasks = ref<TransferInfo[]>([]),
    document = ref<TextDocument | null>(null),
    dirty = ref(false),
    editorBusy = ref(false),
    exitReview = ref(false);
  const current = computed(() => connections.value[active.value]);
  const pending = computed(() => tasks.value.filter(unfinished).length);
  let localGeneration = 0;
  const generations = new Map<string, number>();
  async function localLoad(path: string | null = null): Promise<void> {
    const generation = ++localGeneration;
    localLoading.value = true;
    try {
      const value = await filesApi.local(path);
      if (generation === localGeneration) local.value = value;
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      if (generation === localGeneration) localLoading.value = false;
    }
  }
  async function navigate(path: string, connection = current.value): Promise<void> {
    if (!connection?.id) return;
    const generation = (generations.get(connection.host.id) ?? 0) + 1;
    generations.set(connection.host.id, generation);
    connection.loading = true;
    connection.error = null;
    try {
      const value = await filesApi.list(connection.id, path);
      if (generation === generations.get(connection.host.id)) {
        connection.listing = value;
        connection.path = value.path;
      }
    } catch (cause) {
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
      if (generation === generations.get(connection.host.id)) connection.loading = false;
    }
  }
  async function open(host: Host, path?: string, pane?: string): Promise<void> {
    active.value = host.id;
    let connection = connections.value[host.id];
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
      const value = await filesApi.open(host.id, (event) => {
        if (event.type === 'state') {
          connection.state = event.state;
          if (event.message) connection.error = event.message;
          if (event.state !== 'awaiting_trust') connection.trust = null;
          if (event.state === 'connected' && connection.id)
            void navigate(connection.path, connection);
        } else if (event.type === 'trust') connection.trust = event;
      });
      connection.id = value.id;
      connection.routeHostIds = value.routeHostIds;
      if (connection.state === 'connected') await navigate(connection.path, connection);
    } catch (cause) {
      connection.state = 'failed';
      connection.error = errorMessage(cause);
    }
    if (!local.value) await localLoad();
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
    if (current.value?.id && current.value.state === 'connected')
      await navigate(current.value.path);
    if (local.value) await localLoad(local.value.path);
  }
  async function edit(path: string): Promise<void> {
    if (!current.value?.id || editorBusy.value) return;
    if (document.value) {
      error.value = '请先保存或关闭当前编辑文档。';
      return;
    }
    editorBusy.value = true;
    try {
      document.value = await filesApi.read(current.value.id, path);
      dirty.value = false;
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      editorBusy.value = false;
    }
  }
  let polling = false,
    disposed = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  async function poll(): Promise<void> {
    if (polling || disposed) return;
    polling = true;
    clearTimeout(timer);
    try {
      const [value, live] = await Promise.all([filesApi.tasks(), filesApi.connections()]);
      for (const connection of Object.values(connections.value)) {
        if (connection.state === 'connected' && !live.some((c) => c.id === connection.id)) {
          connection.state = 'failed';
          connection.error = 'SSH 文件连接已关闭，请重新连接。';
        }
      }
      const before = new Map(tasks.value.map((t) => [t.id, t.state]));
      const finished = value.filter(
        (t) => t.state === 'completed' && before.get(t.id) && before.get(t.id) !== 'completed',
      );
      for (const t of value)
        if (t.state === 'failed' && before.get(t.id) !== 'failed')
          useNotificationsStore().push(
            `文件传输失败：${t.id}，请在后台传输中查看主机、原因和恢复路径。`,
            true,
          );
      tasks.value = value;
      if (finished.length) {
        notice.value = `${finished.length} 个传输任务完成，详见校验和跳过统计。`;
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
    if (state === '已连接' || related.some((c) => c.state === 'connected')) return '已连接';
    if (
      state === '连接中' ||
      related.some((c) =>
        ['opening', 'connecting', 'authenticating', 'awaiting_trust'].includes(c.state),
      )
    )
      return '连接中';
    return '未连接';
  }
  return {
    hostState,
    connections,
    active,
    current,
    local,
    localLoading,
    error,
    notice,
    tasks,
    pending,
    document,
    dirty,
    editorBusy,
    exitReview,
    open,
    navigate,
    localLoad,
    trust,
    refresh,
    edit,
    poll,
  };
});
