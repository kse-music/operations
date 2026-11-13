<script setup lang="ts">
import { locale } from '@serverdeck/plugin-sdk/i18n';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';
import { tr } from '../i18n/messages';

import { clipboardApi } from '../services/clipboard';
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import {
  ArrowUp,
  ArrowRight,
  AppWindow,
  Copy,
  Eye,
  EyeOff,
  FilePenLine,
  FolderOpen,
  FolderPlus,
  FileUp,
  FolderUp,
  Info,
  RefreshCw,
  Upload,
  Download,
  Trash2,
  CircleX,
  SquareTerminal,
  TextCursorInput,
  UserRoundCog,
} from '@lucide/vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { isTauri } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import FilePane from '../components/FilePane.vue';
import FileLocationPicker from '../components/FileLocationPicker.vue';
import TransferPanel from '../components/TransferPanel.vue';
import Modal from '../components/Modal.vue';
import { useFilesStore } from '../stores/files';
import { useApplicationStore } from '../stores/application';
import { useHostsStore } from '../stores/hosts';
import { useNotificationsStore } from '../stores/notifications';
import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
import {
  bytes,
  remoteJoin,
  remoteDirectoryLocations,
  unfinished,
  type FileEntry,
  type LocalDrive,
  type ConflictPolicy,
  type Direction,
  type TransferInfo,
  type FileTerminalAction,
} from '../types/files';
import { hostDisplayName, type Host } from '../types/hosts';
const props = defineProps<{ hostId?: string }>();
const application = useApplicationStore();
const emit = defineEmits<{
  terminal: [host: Host, action: FileTerminalAction];
}>();
const store = useFilesStore(),
  hosts = useHostsStore(),
  notifications = useNotificationsStore();
const chosen = computed(() => props.hostId ?? hosts.selectedId ?? ''),
  localPath = ref(''),
  remotePath = ref(''),
  localSelection = ref<string[]>([]),
  remoteSelection = ref<string[]>([]),
  showRemoteHidden = ref(false),
  busy = ref(false),
  over = ref(false),
  overLocal = ref(false),
  transferProgress = ref(false),
  cancellingTransfers = ref(false),
  transferCancelError = ref<string | null>(null),
  transferHistory = ref(false),
  localArea = ref<HTMLElement>(),
  remoteArea = ref<HTMLElement>();
const userForm = ref<{
  id: string;
  hostId: string;
  username: string;
  serverPath: string;
  password: string;
  original: boolean;
} | null>(null);
const switchingUser = ref(false);
function closeUserForm(): void {
  if (switchingUser.value) return;
  if (userForm.value) userForm.value.password = '';
  userForm.value = null;
}
function showUserForm(): void {
  const connection = store.current;
  if (!connection?.id || connection.state !== 'connected') return;
  menu.value = null;
  transfer.value = null;
  operation.value = null;
  userForm.value = {
    id: connection.id,
    hostId: connection.host.id,
    username: 'root',
    serverPath: '',
    password: '',
    original: false,
  };
}
async function submitUser(): Promise<void> {
  const form = userForm.value;
  if (!form || switchingUser.value) return;
  if (store.current?.id !== form.id || store.active !== form.hostId) {
    closeUserForm();
    return;
  }
  const user = form.original
    ? null
    : {
        username: form.username.trim(),
        serverPath: form.serverPath.trim(),
        password: form.password || null,
      };
  form.password = '';
  switchingUser.value = true;
  try {
    const changed = await store.switchUser(user);
    if (changed) {
      remoteSelection.value = [];
      userForm.value = null;
    }
  } finally {
    if (user) user.password = null;
    switchingUser.value = false;
  }
}
const hasTransferHistory = computed(() =>
  store.tasks.some((task) => !task.dragExport && task.hostId === chosen.value && !unfinished(task)),
);
const activeTransfers = computed(() =>
  store.tasks.filter((task) => task.hostId === chosen.value && unfinished(task)),
);
const transferCancellationPending = computed(
  () =>
    cancellingTransfers.value ||
    (activeTransfers.value.length > 0 &&
      activeTransfers.value.every((task) => task.state === 'cancelling')),
);
async function cancelTransfers(): Promise<void> {
  if (transferCancellationPending.value) return;
  const ids = activeTransfers.value.map((task) => task.id);
  if (!ids.length) return;
  cancellingTransfers.value = true;
  transferCancelError.value = null;
  try {
    const results = await Promise.allSettled(ids.map((id) => filesApi.cancel(id)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') transferCancelError.value = errorMessage(failure.reason);
    await store.poll();
  } catch (cause) {
    transferCancelError.value = errorMessage(cause);
  } finally {
    cancellingTransfers.value = false;
  }
}
watch(
  () => activeTransfers.value.map((task) => task.id),
  (ids, previous = []) => {
    if (!ids.length) transferProgress.value = false;
    else if (ids.some((id) => !previous.includes(id))) {
      transferHistory.value = false;
      transferCancelError.value = null;
      transferProgress.value = true;
    }
  },
  { immediate: true },
);
const menu = ref<{ side: 'local' | 'remote'; entry: FileEntry; x: number; y: number } | null>(null),
  operation = ref<{
    kind: 'mkdir' | 'rename' | 'delete';
    side: 'local' | 'remote';
    hostId: string;
    id: string;
    host: string;
    parent: string;
    paths: string[];
    name: string;
    hasDirectory: boolean;
  } | null>(null),
  properties = ref<(FileEntry & { side: 'local' | 'remote' }) | null>(null),
  terminalAction = ref<FileTerminalAction | null>(null);
const menuElement = ref<HTMLElement>();
const transfer = ref<{
  id: string;
  host: string;
  direction: Direction;
  sources: string[];
  destination: string;
  conflict: ConflictPolicy;
  confirmed: boolean;
  retry?: string;
} | null>(null);

const transferDestination = computed({
  get: () =>
    transfer.value?.direction === 'download'
      ? displayLocalPath(transfer.value.destination)
      : (transfer.value?.destination ?? ''),
  set: (value: string) => {
    if (transfer.value && value !== transferDestination.value) transfer.value.destination = value;
  },
});

const localDrives = ref<LocalDrive[]>([]),
  localDrivesLoading = ref(false),
  localDrivesFailed = ref(false);
// These captions are generated by files_local_drives, not user volume labels.
const displayedDrives = computed(() =>
  localDrives.value.map((drive) => ({
    ...drive,
    name:
      drive.path === '/'
        ? tr('/ 文件系统')
        : drive.name.replace(/^([A-Z]): (.+)$/, (_match, letter: string, kind: string) =>
            tr('{0}: ' + kind, letter),
          ),
  })),
);
const selectedDrive = computed(() => {
  const path = displayLocalPath(store.localPendingPath ?? store.local?.path ?? '')
    .replaceAll('\\', '/')
    .toLowerCase();
  return (
    localDrives.value.find((drive) =>
      path.startsWith(drive.path.replaceAll('\\', '/').toLowerCase()),
    )?.path ?? ''
  );
});
async function loadLocalDrives(): Promise<void> {
  if (localDrivesLoading.value) return;
  localDrivesLoading.value = true;
  localDrivesFailed.value = false;
  try {
    const drives = await filesApi.localDrives();
    if (!disposed) localDrives.value = drives;
  } catch (cause) {
    if (!disposed) {
      localDrivesFailed.value = true;
      store.error = errorMessage(cause);
    }
  } finally {
    localDrivesLoading.value = false;
  }
}
async function selectLocalDrive(path: string): Promise<void> {
  if (localDrives.value.some((drive) => drive.path === path)) await store.localLoad(path);
}
const remoteFolders = computed(() => {
  const current = store.current;
  if (!current?.listing) return [];
  const pending = remoteDirectoryLocations(current.pendingPath ?? '');
  return pending.length ? pending : remoteDirectoryLocations(current.listing.path);
});
async function selectRemoteFolder(path: string): Promise<void> {
  if (store.current?.state !== 'connected' || store.closingHosts.includes(chosen.value)) return;
  if (remoteFolders.value.some((folder) => folder.path === path)) await store.navigate(path);
}

watch(
  () => store.localPendingPath ?? store.local?.path,
  (value) => {
    localPath.value = displayLocalPath(value ?? '');
    localSelection.value = [];
  },
  { immediate: true },
);
watch(
  () => store.current?.pendingPath ?? store.current?.path,
  (value) => {
    remotePath.value = value ?? '';
    remoteSelection.value = [];
  },
  { immediate: true },
);
watch(
  () => store.active,
  () => {
    localSelection.value = [];
    remoteSelection.value = [];
    transferHistory.value = false;
    closeUserForm();
  },
);
async function connect(): Promise<void> {
  const host = hosts.catalog?.hosts.find((h) => h.id === chosen.value);
  if (host) await store.open(host);
}
async function copy(path: string): Promise<void> {
  try {
    await clipboardApi.writeText(path);
    notifications.push(tr('绝对路径已复制。'));
  } catch {
    store.error = tr('无法写入剪贴板。');
  }
}
async function navigateLocal(): Promise<void> {
  const input = localPath.value;
  const previous = store.local;
  await store.localLoad(
    previous && input === displayLocalPath(previous.path) ? previous.path : input,
  );
  if (store.local && store.local !== previous && localPath.value === input) {
    localPath.value = displayLocalPath(store.local.path);
  }
}
function navigateWithMouse(side: 'local' | 'remote', event: MouseEvent): void {
  if (event.button !== 3 && event.button !== 4) return;
  // Side buttons can also navigate WebView history on mouseup.
  event.preventDefault();
  if (store.closingHosts.includes(chosen.value)) return;
  if (store.stepHistory(side, event.button === 3 ? 'back' : 'forward')) {
    menu.value = null;
  }
}
async function picked(folder = false): Promise<void> {
  const session = store.current?.id;
  try {
    const paths = await filesApi.pick(folder ? 'folder' : 'files');
    if (!session || store.current?.id !== session || store.current.switchingUser) return;
    if (paths.length) prepareTransfer('upload', paths);
  } catch (cause) {
    store.error = errorMessage(cause);
  }
}
function prepareTransfer(direction: Direction, sources: string[], destination?: string): void {
  menu.value = null;
  const current = store.current;
  if (!current?.id || current.state !== 'connected' || current.switchingUser) {
    store.error = tr('请先连接远程主机。');
    return;
  }
  if (!sources.length) {
    store.error = tr('请先选择文件或目录。');
    return;
  }
  transfer.value = {
    id: current.id,
    host: hostDisplayName(current.host),
    direction,
    sources,
    destination:
      destination ??
      (direction === 'upload'
        ? current.path
        : application.state?.config.product?.downloadDirectory || store.local?.path || ''),
    conflict: 'fail',
    confirmed: false,
  };
}
let downloadDrag:
  | {
      pointerId: number;
      x: number;
      y: number;
      source: HTMLElement;
      sessionId: string;
      sources: string[];
      started: boolean;
    }
  | undefined;
let suppressRemoteClick = false;
const windowsFileDrag = isTauri() && navigator.platform.startsWith('Win');

function beginDownloadDrag(entry: FileEntry, event: PointerEvent): void {
  const current = store.current;
  if (
    event.button !== 0 ||
    event.pointerType !== 'mouse' ||
    busy.value ||
    !current?.id ||
    current.state !== 'connected' ||
    (!store.local && !windowsFileDrag)
  )
    return;
  endDownloadDrag();
  downloadDrag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    source: event.currentTarget as HTMLElement,
    sessionId: current.id,
    sources: remoteSelection.value.includes(entry.path) ? [...remoteSelection.value] : [entry.path],
    started: false,
  };
  window.addEventListener('pointermove', moveDownloadDrag);
  window.addEventListener('pointerup', dropDownload);
  window.addEventListener('pointercancel', endDownloadDrag);
  window.addEventListener('blur', endDownloadDrag);
  window.addEventListener('keydown', cancelDownloadDrag);
}
function overLocalPane(event: PointerEvent): boolean {
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  return !!localArea.value?.contains(hit);
}
function moveDownloadDrag(event: PointerEvent): void {
  const drag = downloadDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (event.buttons !== 1 || !drag.source.isConnected) {
    endDownloadDrag();
    return;
  }
  if (!drag.started) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
    drag.started = true;
    suppressRemoteClick = true;
    drag.source.setPointerCapture(event.pointerId);
  }
  event.preventDefault();
  if (
    windowsFileDrag &&
    (event.clientX < 0 ||
      event.clientY < 0 ||
      event.clientX >= window.innerWidth ||
      event.clientY >= window.innerHeight)
  ) {
    endDownloadDrag();
    void exportDownloadDrag(drag.sessionId, drag.sources);
    return;
  }
  overLocal.value = !store.localLoading && overLocalPane(event);
}
async function exportDownloadDrag(sessionId: string, sources: string[]): Promise<void> {
  const connection = store.current;
  if (connection?.id !== sessionId || connection.state !== 'connected') return;
  const supported = new Set(
    connection.listing?.entries
      .filter((entry) => entry.kind === 'file' || entry.kind === 'symlink')
      .map((entry) => entry.path),
  );
  if (!sources.every((path) => supported.has(path))) {
    store.error = tr('拖到 Windows 桌面或文件夹的项目须为文件或文件链接。');
    return;
  }
  try {
    await filesApi.dragDownload(sessionId, sources);
  } catch (cause) {
    store.error = errorMessage(cause);
  }
}
function dropDownload(event: PointerEvent): void {
  const drag = downloadDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const destination =
    drag.started && !store.localLoading && overLocalPane(event) ? store.local?.path : undefined;
  endDownloadDrag();
  if (destination && store.current?.id === drag.sessionId)
    prepareTransfer('download', drag.sources, destination);
}
function endDownloadDrag(): void {
  const drag = downloadDrag;
  downloadDrag = undefined;
  overLocal.value = false;
  window.removeEventListener('pointermove', moveDownloadDrag);
  window.removeEventListener('pointerup', dropDownload);
  window.removeEventListener('pointercancel', endDownloadDrag);
  window.removeEventListener('blur', endDownloadDrag);
  window.removeEventListener('keydown', cancelDownloadDrag);
  if (drag?.source.hasPointerCapture(drag.pointerId))
    drag.source.releasePointerCapture(drag.pointerId);
}
function cancelDownloadDrag(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !downloadDrag?.started) return;
  event.preventDefault();
  endDownloadDrag();
}
function ignoreDownloadClick(event: MouseEvent): void {
  if (!suppressRemoteClick || !event.detail) return;
  event.preventDefault();
  event.stopPropagation();
}
async function chooseDestination(): Promise<void> {
  if (!transfer.value) return;
  try {
    const paths = await filesApi.pick('folder');
    if (paths[0]) transfer.value.destination = paths[0];
  } catch (cause) {
    store.error = errorMessage(cause);
  }
}
async function startTransfer(): Promise<void> {
  const input = transfer.value;
  if (!input || store.closingHosts.includes(chosen.value)) return;
  busy.value = true;
  store.error = null;
  try {
    if (input.retry) await filesApi.retry(input.retry, input.id, input.conflict, input.confirmed);
    else
      await filesApi.start({
        sessionId: input.id,
        direction: input.direction,
        sources: input.sources,
        destination: input.destination,
        conflict: input.conflict,
        confirmOverwrite: input.confirmed,
      });
    transfer.value = null;
    await store.poll();
  } catch (cause) {
    store.error = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function retry(task: TransferInfo): Promise<void> {
  transferHistory.value = false;
  const host = hosts.catalog?.hosts.find((h) => h.id === task.hostId);
  if (!host) return;
  if (store.active !== host.id || store.current?.state !== 'connected') {
    await store.open(host);
    if (store.current?.state !== 'connected') {
      store.error = tr('请在主机连接就绪后再次点击重试。');
      return;
    }
  }
  transfer.value = {
    id: store.current!.id!,
    host: hostDisplayName(host),
    direction: task.direction,
    sources: task.sources,
    destination: task.destination,
    conflict: 'skip',
    confirmed: false,
    retry: task.id,
  };
}
function closeMenu(): void {
  menu.value = null;
}
function outsideMenu(event: PointerEvent): void {
  if (menu.value && !menuElement.value?.contains(event.target as Node)) closeMenu();
}
async function context(
  side: 'local' | 'remote',
  entry: FileEntry,
  event: MouseEvent,
): Promise<void> {
  menu.value = {
    side,
    entry,
    x: event.clientX,
    y: event.clientY,
  };
  await nextTick();
  if (!menu.value || !menuElement.value) return;
  const bounds = menuElement.value.getBoundingClientRect();
  menu.value.x = Math.max(8, Math.min(menu.value.x, window.innerWidth - bounds.width - 8));
  menu.value.y = Math.max(8, Math.min(menu.value.y, window.innerHeight - bounds.height - 8));
}
function mutate(kind: 'mkdir' | 'rename' | 'delete', side: 'local' | 'remote' = 'remote'): void {
  const current = store.current;
  const listing = side === 'local' ? store.local : current?.listing;
  if (
    busy.value ||
    operation.value ||
    document.querySelector('dialog[open]') ||
    store.active !== chosen.value ||
    store.closingHosts.includes(chosen.value) ||
    downloadDrag?.started ||
    !listing ||
    (side === 'local'
      ? store.localLoading
      : !current?.id || current.state !== 'connected' || current.loading || current.switchingUser)
  )
    return;
  const paths =
    kind === 'mkdir'
      ? []
      : kind === 'rename' && menu.value
        ? [menu.value.entry.path]
        : [...(side === 'local' ? localSelection.value : remoteSelection.value)];
  if (kind !== 'mkdir' && !paths.length) return;
  if (paths.some((path) => !listing.entries.some((entry) => entry.path === path))) {
    store.error = tr('部分选中项目已不在当前目录，请刷新后重试。');
    return;
  }
  operation.value = {
    kind,
    side,
    hostId: chosen.value,
    id: current?.id ?? '',
    host: hostDisplayName(current?.host),
    parent: listing.path,
    paths,
    name: kind === 'rename' ? (menu.value?.entry.name ?? '') : '',
    hasDirectory:
      kind === 'delete' &&
      listing.entries.some((entry) => entry.kind === 'directory' && paths.includes(entry.path)),
  };
  menu.value = null;
}
async function submitOperation(): Promise<void> {
  const op = operation.value;
  if (!op || busy.value) return;
  if (
    store.active !== op.hostId ||
    chosen.value !== op.hostId ||
    store.closingHosts.includes(op.hostId) ||
    (op.side === 'local'
      ? store.localLoading || store.local?.path !== op.parent
      : store.current?.id !== op.id ||
        store.current.state !== 'connected' ||
        store.current.loading ||
        store.current.switchingUser ||
        store.current.path !== op.parent)
  ) {
    operation.value = null;
    store.error = tr('文件操作目标已变化，请重新选择。');
    return;
  }
  busy.value = true;
  store.error = null;
  try {
    if (op.side === 'local')
      await filesApi.localRecycle({ parent: op.parent, paths: op.paths, confirmed: true });
    else if (op.kind === 'mkdir')
      await filesApi.action(op.id, { kind: 'mkdir', path: remoteJoin(op.parent, op.name) });
    else if (op.kind === 'rename')
      await filesApi.action(op.id, {
        kind: 'rename',
        path: op.paths[0]!,
        destination: remoteJoin(op.parent, op.name),
      });
    else
      await filesApi.action(op.id, {
        kind: 'remove',
        paths: op.paths,
        recursive: op.hasDirectory,
        confirmed: true,
      });
    operation.value = null;
    if (store.active === op.hostId) {
      if (op.side === 'local') localSelection.value = [];
      else remoteSelection.value = [];
    }
    if (op.side === 'local') await store.localLoad(op.parent, undefined, op.hostId);
    else if (store.active === op.hostId) await store.refresh();
    else if (store.connections[op.hostId]?.id === op.id)
      await store.navigate(op.parent, store.connections[op.hostId]);
  } catch (cause) {
    store.error = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function showProperties(): Promise<void> {
  const item = menu.value;
  if (!item) return;
  menu.value = null;
  try {
    const entry =
      item.side === 'local'
        ? item.entry
        : await filesApi.properties(store.current!.id!, item.entry.path);
    properties.value = { ...entry, side: item.side };
  } catch (cause) {
    store.error = errorMessage(cause);
  }
}
function requestTerminal(kind: 'directory' | 'view'): void {
  const entry = menu.value?.entry;
  if (!entry) return;
  terminalAction.value = { kind, path: entry.path };
  menu.value = null;
}
async function openEntry(side: 'local' | 'remote', entry: FileEntry): Promise<void> {
  if (entry.kind === 'directory' || entry.kind === 'symlink') {
    if (side === 'local') await store.localLoad(entry.path);
    else await store.navigate(entry.path);
  } else if (entry.kind === 'file') {
    if (side === 'remote') await store.edit(entry.path, entry.size);
    else await store.openLocal(entry.path);
  } else store.error = tr('特殊文件不能直接打开。');
}
let unlisten: UnlistenFn | undefined,
  disposed = false;
onMounted(async () => {
  window.addEventListener('contextmenu', closeMenu, true);
  window.addEventListener('pointerdown', outsideMenu, true);
  void loadLocalDrives();
  if (props.hostId && store.current?.host.id !== props.hostId) await connect();
  if (!disposed && !store.local && !store.localLoading) await store.localLoad();
  try {
    const listener = await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'leave') {
        over.value = false;
        return;
      }
      const box = remoteArea.value?.getBoundingClientRect();
      if (!box) return;
      const x = payload.position.x / window.devicePixelRatio,
        y = payload.position.y / window.devicePixelRatio;
      const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      over.value = inside && payload.type !== 'drop';
      if (payload.type === 'drop' && inside) prepareTransfer('upload', payload.paths);
    });
    if (disposed) listener();
    else unlisten = listener;
  } catch (cause) {
    store.error = tr('拖放入口不可用：{0}', errorMessage(cause));
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('contextmenu', closeMenu, true);
  window.removeEventListener('pointerdown', outsideMenu, true);
  if (userForm.value) userForm.value.password = '';
  disposed = true;
  endDownloadDrag();
  unlisten?.();
});
</script>
<template>
  <section
    class="files-view page-view"
    :inert="store.closingHosts.includes(chosen) || store.current?.switchingUser"
    :aria-busy="store.closingHosts.includes(chosen) || store.current?.switchingUser"
  >
    <div class="section-heading">
      <div>
        <p class="eyebrow">SFTP WORKSPACE</p>
        <h1>{{ tr('文件管理') }}</h1>
      </div>
      <div class="toolbar">
        <button v-if="activeTransfers.length" class="button" @click="transferProgress = true">
          {{ tr('传输任务（{0}）', activeTransfers.length) }}
        </button>
        <button v-if="hasTransferHistory" class="button" @click="transferHistory = true">
          {{ tr(' 传输记录 ') }}
        </button>
        <button
          class="button primary"
          :disabled="
            !chosen ||
            ['opening', 'connecting', 'authenticating', 'awaiting_trust', 'connected'].includes(
              store.current?.state ?? '',
            )
          "
          @click="connect"
        >
          {{ store.current?.state === 'connected' ? tr('SFTP 已连接') : tr('连接 SFTP') }}
        </button>
      </div>
    </div>

    <p v-if="store.editorBusy" class="banner" role="status">
      {{ tr('正在打开 ') }}{{ store.openingPath }}…
    </p>
    <p v-if="store.localOpening" class="banner" role="status">{{ tr('正在显示系统打开方式…') }}</p>
    <p v-if="!chosen" class="banner" role="status">
      {{ tr(' 请在主机管理中打开远程主机后使用 SFTP 文件管理。 ') }}
    </p>
    <div class="file-columns">
      <section
        ref="localArea"
        :class="['file-side', { dropping: overLocal }]"
        @mouseup="navigateWithMouse('local', $event)"
      >
        <h2>
          {{ tr('本地文件 ') }}<span v-if="overLocal">{{ tr('松开后下载到当前目录') }}</span>
        </h2>
        <form class="path-bar" @submit.prevent="navigateLocal">
          <button
            class="tool-button"
            :aria-label="tr('本地上级')"
            :title="tr('本地上级')"
            type="button"
            :disabled="!store.local?.parent"
            @click="store.local?.parent && store.localLoad(store.local.parent)"
          >
            <ArrowUp :size="15" aria-hidden="true" />
          </button>
          <FileLocationPicker
            :items="displayedDrives"
            :value="selectedDrive"
            :label="tr('选择本地磁盘')"
            :list-label="tr('本地磁盘')"
            icon="drive"
            :loading="localDrivesLoading"
            :empty-text="
              localDrivesLoading
                ? tr('加载磁盘…')
                : localDrivesFailed
                  ? tr('磁盘加载失败')
                  : tr('无可用磁盘')
            "
            :disabled="store.closingHosts.includes(chosen) || store.current?.switchingUser"
            @refresh="loadLocalDrives"
            @select="selectLocalDrive"
          />
          <input v-model="localPath" :aria-label="tr('本地路径')" required /><button
            class="tool-button"
            :aria-label="tr('前往')"
            :title="tr('前往本地路径')"
          >
            <ArrowRight :size="15" aria-hidden="true" />
          </button>
        </form>
        <div class="toolbar">
          <button
            class="tool-button"
            :aria-label="tr('刷新本地')"
            :title="tr('刷新本地')"
            @click="store.localLoad(store.local?.path ?? null)"
          >
            <RefreshCw :size="14" aria-hidden="true" /></button
          ><button
            class="tool-button"
            :aria-label="tr('复制本地路径')"
            :title="tr('复制本地路径')"
            :disabled="!store.local"
            @click="store.local && copy(displayLocalPath(store.local.path))"
          >
            <Copy :size="14" aria-hidden="true" /></button
          ><button
            class="tool-button"
            :aria-label="tr('上传选中')"
            :title="tr('上传选中')"
            :disabled="store.current?.state !== 'connected' || !localSelection.length"
            @click="prepareTransfer('upload', localSelection)"
          >
            <Upload :size="14" aria-hidden="true" />
          </button>
          <button
            class="tool-button"
            :aria-label="tr('选择上传文件…')"
            :title="tr('选择上传文件')"
            :disabled="store.current?.state !== 'connected'"
            @click="picked()"
          >
            <FileUp :size="15" aria-hidden="true" />
          </button>
          <button
            class="tool-button"
            :aria-label="tr('选择上传文件夹…')"
            :title="tr('选择上传文件夹')"
            :disabled="store.current?.state !== 'connected'"
            @click="picked(true)"
          >
            <FolderUp :size="15" aria-hidden="true" />
          </button>
        </div>
        <FilePane
          side="local"
          :listing="store.local"
          :loading="store.localLoading"
          :selected="localSelection"
          @select="localSelection = $event"
          @open="openEntry('local', $event)"
          @menu="(entry, event) => context('local', entry, event)"
          @remove="mutate('delete', 'local')"
        />
      </section>
      <section
        ref="remoteArea"
        :class="['file-side', { dropping: over }]"
        @pointerdown.capture="suppressRemoteClick = false"
        @click.capture="ignoreDownloadClick"
        @dblclick.capture="ignoreDownloadClick"
        @mouseup="navigateWithMouse('remote', $event)"
      >
        <h2>
          {{ tr(' 远程文件 ')
          }}<span v-if="store.current?.state === 'connected'"
            >（{{ store.current.username ?? store.current.host.username }}）</span
          ><span v-if="over">{{ tr('松开后选择上传策略') }}</span>
        </h2>
        <form class="path-bar" @submit.prevent="store.navigate(remotePath)">
          <button
            class="tool-button"
            :aria-label="tr('远程上级')"
            :title="tr('远程上级')"
            type="button"
            :disabled="!store.current?.listing?.parent"
            @click="store.current?.listing?.parent && store.navigate(store.current.listing.parent)"
          >
            <ArrowUp :size="15" aria-hidden="true" />
          </button>
          <FileLocationPicker
            :key="`remote-${store.current?.id ?? chosen}`"
            :items="remoteFolders"
            :value="remoteFolders.at(-1)?.path ?? ''"
            :label="tr('选择远程目录')"
            :list-label="tr('远程目录层级')"
            icon="folder"
            :loading="store.current?.loading ?? false"
            :empty-text="store.current?.state === 'connected' ? tr('加载目录…') : tr('未连接')"
            :disabled="
              store.current?.state !== 'connected' ||
              !store.current?.listing ||
              store.current?.switchingUser ||
              store.closingHosts.includes(chosen)
            "
            @select="selectRemoteFolder"
          />
          <input
            v-model="remotePath"
            :aria-label="tr('远程路径')"
            :disabled="store.current?.state !== 'connected'"
            required
          /><button
            class="tool-button"
            :aria-label="tr('前往')"
            :title="tr('前往远程路径')"
            :disabled="store.current?.state !== 'connected'"
          >
            <ArrowRight :size="15" aria-hidden="true" />
          </button>
        </form>
        <div class="toolbar">
          <button
            class="tool-button"
            :aria-label="tr('切换用户')"
            :title="tr('切换用户')"
            :disabled="store.current?.state !== 'connected'"
            @click="showUserForm"
          >
            <UserRoundCog :size="14" aria-hidden="true" />
          </button>
          <button
            class="tool-button"
            :aria-label="tr('新建文件夹')"
            :title="tr('新建文件夹')"
            :disabled="store.current?.state !== 'connected'"
            @click="mutate('mkdir')"
          >
            <FolderPlus :size="15" aria-hidden="true" /></button
          ><button
            class="tool-button"
            :aria-label="tr('刷新远程')"
            :title="tr('刷新远程')"
            :disabled="!store.current?.id"
            @click="store.navigate(store.current.path)"
          >
            <RefreshCw :size="14" aria-hidden="true" /></button
          ><button
            class="tool-button"
            :aria-label="tr('复制远程路径')"
            :title="tr('复制远程路径')"
            :disabled="!store.current?.listing"
            @click="store.current && copy(store.current.path)"
          >
            <Copy :size="14" aria-hidden="true" /></button
          ><button
            class="tool-button"
            :aria-label="tr('下载选中')"
            :title="tr('下载选中')"
            :disabled="!remoteSelection.length"
            @click="prepareTransfer('download', remoteSelection)"
          >
            <Download :size="14" aria-hidden="true" /></button
          ><button
            class="tool-button danger"
            :aria-label="tr('删除选中')"
            :title="tr('删除选中')"
            :disabled="!remoteSelection.length"
            @click="mutate('delete')"
          >
            <Trash2 :size="14" aria-hidden="true" /></button
          ><button
            class="tool-button"
            type="button"
            :aria-label="tr('显示隐藏项')"
            :title="tr('显示隐藏项')"
            :aria-pressed="showRemoteHidden"
            @click="
              showRemoteHidden = !showRemoteHidden;
              menu = null;
            "
          >
            <component :is="showRemoteHidden ? Eye : EyeOff" :size="14" aria-hidden="true" />
          </button>
        </div>
        <FilePane
          side="remote"
          :listing="store.current?.listing ?? null"
          :loading="store.current?.loading ?? false"
          :selected="remoteSelection"
          :hide-dotfiles="!showRemoteHidden"
          @select="remoteSelection = $event"
          @open="openEntry('remote', $event)"
          @menu="(entry, event) => context('remote', entry, event)"
          @drag="beginDownloadDrag"
          @remove="mutate('delete')"
        />
      </section>
    </div>
  </section>
  <Modal
    v-if="transferProgress && activeTransfers.length && !transfer"
    :title="tr('传输任务（{0}）', activeTransfers.length)"
    panel-class="file-transfer-dialog"
    :busy="transferCancellationPending"
    :close-label="tr('取消此主机的全部传输')"
    focus-heading
    @close="cancelTransfers"
  >
    <TransferPanel :host-id="chosen" hide-heading />
    <p v-if="transferCancelError" class="error-text" role="alert">{{ transferCancelError }}</p>
    <footer class="dialog-actions">
      <span v-if="transferCancellationPending" class="subtle" role="status">{{
        tr('正在取消并清理…')
      }}</span>
      <button class="button" type="button" @click="transferProgress = false">
        {{ tr('后台传输') }}
      </button>
    </footer>
  </Modal>
  <Modal v-if="userForm" :title="tr('切换 SFTP 用户')" :busy="switchingUser" @close="closeUserForm">
    <form class="editor-form" @submit.prevent="submitUser">
      <p class="subtle">
        {{ tr(' 当前用户：') }}{{ store.current?.username ?? store.current?.host.username
        }}{{ tr('。切换只影响文件管理；请先结束传输并保存、关闭编辑文档。 ') }}
      </p>
      <label v-if="store.current?.elevated" class="checkbox-label">
        <input
          v-model="userForm.original"
          type="checkbox"
          :disabled="switchingUser"
          @change="userForm.password = ''"
        />{{ tr('切回原登录用户 ') }}{{ store.current.host.username }}
      </label>
      <template v-if="!userForm.original">
        <label
          >{{ tr('目标用户')
          }}<input
            v-model="userForm.username"
            :aria-label="tr('目标用户')"
            required
            maxlength="64"
            :disabled="switchingUser"
            autocomplete="off"
        /></label>
        <label
          >{{ tr('sudo 密码')
          }}<input
            v-model="userForm.password"
            :aria-label="tr('sudo 密码')"
            type="password"
            autocomplete="off"
            :disabled="switchingUser"
            :placeholder="tr('免密 sudo 时留空')"
        /></label>
        <p class="subtle">
          {{
            tr(
              ' 通常填写当前 SSH 登录用户的密码。本次文件连接期间临时使用，断开后释放，不保存到主机配置。 ',
            )
          }}
        </p>
        <label
          >{{ tr('SFTP 服务程序')
          }}<input
            v-model="userForm.serverPath"
            :aria-label="tr('SFTP 服务程序')"
            :disabled="switchingUser"
            :placeholder="tr('留空自动查找 sftp-server')"
        /></label>
        <p class="subtle">
          {{
            tr(
              ' 服务器须允许通过 sudo 运行 Shell 和 sftp-server。仅支持 internal-sftp 或要求交互终端的服务器无法使用此方式。 ',
            )
          }}
        </p>
      </template>
      <p v-if="switchingUser" role="status">{{ tr('正在验证新的文件连接…') }}</p>
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="switchingUser" @click="closeUserForm">
          {{ tr(' 取消 ') }}
        </button>
        <button class="button primary" :disabled="switchingUser">{{ tr('确认切换') }}</button>
      </footer>
    </form>
  </Modal>
  <Modal
    v-if="transferHistory && hasTransferHistory"
    :title="tr('传输记录')"
    @close="transferHistory = false"
  >
    <TransferPanel :host-id="chosen" history @retry="retry" />
  </Modal>
  <template v-if="menu">
    <div
      ref="menuElement"
      class="context-menu file-context-menu"
      role="menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @contextmenu.prevent
    >
      <button
        role="menuitem"
        @click="
          openEntry(menu.side, menu.entry);
          menu = null;
        "
      >
        <component
          :is="
            menu.entry.kind === 'directory'
              ? FolderOpen
              : menu.side === 'local'
                ? AppWindow
                : FilePenLine
          "
          :class="
            menu.entry.kind === 'directory'
              ? 'file-menu-folder'
              : menu.side === 'local'
                ? 'file-menu-open'
                : 'file-menu-edit'
          "
          aria-hidden="true"
        />
        {{
          menu.entry.kind === 'directory'
            ? tr('进入目录')
            : menu.side === 'local'
              ? tr('选择应用打开…')
              : tr('打开文本')
        }}</button
      ><button
        v-if="menu.side === 'remote' && menu.entry.kind === 'file'"
        role="menuitem"
        @click="
          store.offerExternal(menu.entry.path);
          menu = null;
        "
      >
        <AppWindow class="file-menu-open" aria-hidden="true" />
        {{ tr(' 使用系统应用编辑…') }}</button
      ><button
        role="menuitem"
        @click="
          prepareTransfer(
            menu.side === 'local' ? 'upload' : 'download',
            menu.side === 'local' ? localSelection : remoteSelection,
          )
        "
      >
        <component
          :is="menu.side === 'local' ? Upload : Download"
          class="file-menu-transfer"
          aria-hidden="true"
        />
        {{ menu.side === 'local' ? tr('上传选中') : tr('下载选中') }}</button
      ><button
        role="menuitem"
        @click="
          copy(menu.side === 'local' ? displayLocalPath(menu.entry.path) : menu.entry.path);
          menu = null;
        "
      >
        <Copy class="file-menu-copy" aria-hidden="true" />
        {{ tr(' 复制绝对路径') }}</button
      ><button role="menuitem" @click="showProperties">
        <Info class="file-menu-properties" aria-hidden="true" />{{ tr('查看属性') }}</button
      ><button v-if="menu.side === 'local'" role="menuitem" @click="mutate('delete', 'local')">
        <Trash2 class="file-menu-delete" aria-hidden="true" />{{ tr('删除') }}</button
      ><template v-if="menu.side === 'remote'"
        ><button role="menuitem" @click="mutate('rename')">
          <TextCursorInput class="file-menu-rename" aria-hidden="true" />{{ tr('重命名') }}</button
        ><button role="menuitem" @click="mutate('delete')">
          <Trash2 class="file-menu-delete" aria-hidden="true" />{{ tr('删除选中') }}</button
        ><button
          role="menuitem"
          @click="requestTerminal(menu!.entry.kind === 'directory' ? 'directory' : 'view')"
        >
          <SquareTerminal class="file-menu-terminal" aria-hidden="true" />
          {{ tr(' 在新终端中打开 ') }}
        </button></template
      >
    </div></template
  >
  <Modal
    v-if="operation?.kind === 'delete'"
    :title="operation.side === 'local' ? tr('确认移入回收站') : tr('确认删除远程项目')"
    :busy="busy"
    @close="operation = null"
  >
    <form class="file-delete-confirm" @submit.prevent="submitOperation">
      <div class="file-delete-message">
        <CircleX :size="32" aria-hidden="true" />
        <p class="file-delete-question">
          {{
            operation.side === 'local'
              ? operation.paths.length === 1
                ? tr(
                    '确定要将「{0}」移入回收站吗？',
                    displayLocalPath(operation.paths[0] ?? '')
                      .split(/[\\/]/)
                      .at(-1),
                  )
                : tr('确定要将这 {0} 个本地项目移入回收站吗？', operation.paths.length)
              : operation.paths.length === 1
                ? tr('确定要永久删除「{0}」吗？', operation.paths[0]?.split('/').at(-1))
                : tr('确定要永久删除这 {0} 个远程项目吗？', operation.paths.length)
          }}
        </p>
      </div>
      <pre v-if="operation.paths.length > 1" class="file-path-preview">{{
        (operation.side === 'local' ? operation.paths.map(displayLocalPath) : operation.paths).join(
          '\n',
        )
      }}</pre>
      <footer class="dialog-actions">
        <button class="button" type="button" autofocus :disabled="busy" @click="operation = null">
          {{ tr(' 取消 ') }}
        </button>
        <button class="button danger" type="submit" :disabled="busy">{{ tr('确认') }}</button>
      </footer>
    </form>
  </Modal>
  <Modal
    v-else-if="operation"
    :title="operation.kind === 'mkdir' ? tr('创建远程文件夹') : tr('重命名远程项目')"
    :busy="busy"
    @close="operation = null"
    ><p>{{ operation.host }} · {{ operation.parent }}</p>

    <form class="editor-form" @submit.prevent="submitOperation">
      <label
        >{{ operation.kind === 'mkdir' ? tr('文件夹名称') : tr('新名称')
        }}<input v-model="operation.name" :aria-label="tr('远程项目名称')" required maxlength="255"
      /></label>
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="busy" @click="operation = null">
          {{ tr('取消') }}</button
        ><button class="button danger" :disabled="busy">
          {{ operation.kind === 'mkdir' ? tr('创建文件夹') : tr('确认重命名') }}
        </button>
      </footer>
    </form></Modal
  >
  <Modal
    v-if="transfer"
    :title="transfer.retry ? tr('重试传输') : tr('确认文件传输')"
    :busy="busy"
    @close="transfer = null"
    ><p>
      {{ transfer.host }} ·
      {{ transfer.direction === 'upload' ? tr('上传到远端') : tr('下载到本地') }} ·
      {{ transfer.sources.length }}{{ tr(' 个源项目 ') }}
    </p>

    <pre class="file-path-preview">{{
      (transfer.direction === 'upload'
        ? transfer.sources.map(displayLocalPath)
        : transfer.sources
      ).join('\n')
    }}</pre>
    <form class="editor-form" @submit.prevent="startTransfer">
      <label
        >{{ tr('目标目录')
        }}<input
          v-model="transferDestination"
          :aria-label="tr('传输目标目录')"
          :readonly="!!transfer.retry"
          required /></label
      ><button
        v-if="transfer.direction === 'download' && !transfer.retry"
        class="button"
        type="button"
        @click="chooseDestination"
      >
        {{ tr(' 选择下载目录') }}</button
      ><label
        >{{ tr('同名文件')
        }}<select v-model="transfer.conflict" :aria-label="tr('冲突处理')">
          <option value="fail">{{ tr('停止并提示冲突') }}</option>
          <option value="skip">{{ tr('跳过') }}</option>
          <option value="overwrite">{{ tr('覆盖') }}</option>
        </select></label
      ><label v-if="transfer.conflict === 'overwrite'" class="checkbox-label"
        ><input v-model="transfer.confirmed" type="checkbox" required />{{
          tr(
            '确认替换已有普通文件；目录合并，不覆盖链接。原子替换改变 inode，ACL、扩展属性或硬链接关系不保证保留。',
          )
        }}</label
      >
      <p class="subtle">
        {{
          transfer.direction === 'download'
            ? tr('直接选中的文件链接会下载目标内容。目录链接和递归扫描遇到的链接不跟随。')
            : tr('上传不跟随链接。')
        }}{{
          tr(' 目录将合并；不支持断点续传，重试从头开始。任务在后台继续，取消保留已完成文件。 ')
        }}
      </p>
      <footer class="dialog-actions">
        <button class="button" type="button" @click="transfer = null">{{ tr('取消') }}</button
        ><button class="button primary" :disabled="busy">
          {{ transfer.retry ? tr('确认重试') : tr('加入传输队列') }}
        </button>
      </footer>
    </form></Modal
  >
  <Modal v-if="properties" :title="tr('文件属性')" @close="properties = null"
    ><dl class="file-properties">
      <dt>{{ tr('路径') }}</dt>
      <dd>
        {{ properties.side === 'local' ? displayLocalPath(properties.path) : properties.path }}
      </dd>
      <dt>{{ tr('类型') }}</dt>
      <dd>{{ properties.kind }}</dd>
      <dt>{{ tr('大小') }}</dt>
      <dd>{{ bytes(properties.size) }}</dd>
      <dt>{{ tr('修改时间') }}</dt>
      <dd>
        {{
          properties.modified === null
            ? tr('未提供')
            : new Date(properties.modified * 1000).toLocaleString(locale)
        }}
      </dd>
      <dt>{{ tr('权限（八进制）') }}</dt>
      <dd>
        {{
          properties.permissions === null
            ? tr('未提供')
            : properties.permissions.toString(8).padStart(4, '0')
        }}
      </dd>
      <dt>UID / GID</dt>
      <dd>{{ properties.uid ?? '—' }} / {{ properties.gid ?? '—' }}</dd>
    </dl></Modal
  >
  <Modal v-if="store.current?.trust" :title="tr('确认 SFTP 主机指纹')" @close="store.trust(false)"
    ><p>
      {{ store.current.trust.hostname }}:{{ store.current.trust.port }} ·
      {{ store.current.trust.algorithm }}
    </p>
    <p>{{ tr('请从服务器控制台或其他可信渠道核对后再继续；不会在确认前发送认证信息。') }}</p>
    <code class="fingerprint">{{ store.current.trust.fingerprint }}</code>
    <footer class="dialog-actions">
      <button class="button" @click="store.trust(false)">{{ tr('拒绝连接') }}</button
      ><button class="button primary" @click="store.trust(true)">
        {{ tr('已核对，信任并连接') }}
      </button>
    </footer></Modal
  >
  <Modal v-if="terminalAction" :title="tr('确认打开文件终端')" @close="terminalAction = null"
    ><p>
      {{ hostDisplayName(store.current?.host) }} ·
      {{ terminalAction.kind === 'view' ? tr('运行 less') : tr('进入目录并打开交互式 Shell') }}
    </p>
    <pre class="file-path-preview">{{ terminalAction.path }}</pre>
    <p>
      {{
        tr('将新建独立 PTY，路径通过后端固定命令和 POSIX 单引号转义处理，不向已有 Shell 注入输入。')
      }}
    </p>
    <footer class="dialog-actions">
      <button class="button" @click="terminalAction = null">{{ tr('取消') }}</button
      ><button
        class="button primary"
        @click="
          emit('terminal', store.current!.host, terminalAction!);
          terminalAction = null;
        "
      >
        {{ tr(' 确认打开新终端 ') }}
      </button>
    </footer></Modal
  >
</template>
