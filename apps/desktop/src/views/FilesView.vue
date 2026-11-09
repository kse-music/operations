<script setup lang="ts">
import { clipboardApi } from '../services/clipboard';
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import {
  ArrowUp,
  ArrowRight,
  Copy,
  Eye,
  EyeOff,
  HardDrive,
  FolderPlus,
  FileUp,
  FolderUp,
  RefreshCw,
  Upload,
  Download,
  Trash2,
  CircleX,
  UserRoundCog,
} from '@lucide/vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { isTauri } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import FilePane from '../components/FilePane.vue';
import TransferPanel from '../components/TransferPanel.vue';
import Modal from '../components/Modal.vue';
import { useFilesStore } from '../stores/files';
import { useApplicationStore } from '../stores/application';
import { useHostsStore } from '../stores/hosts';
import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
import {
  bytes,
  remoteJoin,
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
  hosts = useHostsStore();
const chosen = computed(() => props.hostId ?? hosts.selectedId ?? ''),
  localPath = ref(''),
  remotePath = ref(''),
  localSelection = ref<string[]>([]),
  remoteSelection = ref<string[]>([]),
  showRemoteHidden = ref(false),
  busy = ref(false),
  over = ref(false),
  overLocal = ref(false),
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
  store.tasks.some((task) => task.hostId === chosen.value && !unfinished(task)),
);
const menu = ref<{ side: 'local' | 'remote'; entry: FileEntry; x: number; y: number } | null>(null),
  operation = ref<{
    kind: 'mkdir' | 'rename' | 'delete';
    id: string;
    host: string;
    parent: string;
    paths: string[];
    name: string;
    hasDirectory: boolean;
  } | null>(null),
  properties = ref<FileEntry | null>(null),
  terminalAction = ref<FileTerminalAction | null>(null);
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

function displayLocalPath(path: string): string {
  // Keep other Windows namespaces intact. Only drive and UNC paths have this display form.
  if (/^\\\\\?\\[a-z]:\\/i.test(path)) return path.slice(4);
  if (/^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?:\\|$)/i.test(path)) return '\\\\' + path.slice(8);
  return path;
}

const localDrives = ref<LocalDrive[]>([]),
  localDrivesLoading = ref(false),
  localDrivesFailed = ref(false);
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
async function selectLocalDrive(event: Event): Promise<void> {
  const path = (event.target as HTMLSelectElement).value;
  if (localDrives.value.some((drive) => drive.path === path)) await store.localLoad(path);
}

watch(
  () => store.localPendingPath ?? store.local?.path,
  (value) => {
    if (value) {
      localPath.value = displayLocalPath(value);
      localSelection.value = [];
    }
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
    store.notice = '绝对路径已复制。';
  } catch {
    store.error = '无法写入剪贴板。';
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
    store.error = '请先连接远程主机。';
    return;
  }
  if (!sources.length) {
    store.error = '请先选择文件或目录。';
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
    store.error = '拖到 Windows 桌面或文件夹的项目须为文件或文件链接。';
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
    store.notice = '任务已交给 Rust 后台队列，离开此页面后继续。';
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
      store.error = '请在主机连接就绪后再次点击重试。';
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
function context(side: 'local' | 'remote', entry: FileEntry, event: MouseEvent): void {
  menu.value = {
    side,
    entry,
    x: Math.min(event.clientX, window.innerWidth - 220),
    y: Math.min(event.clientY, window.innerHeight - 330),
  };
}
function mutate(kind: 'mkdir' | 'rename' | 'delete'): void {
  const current = store.current;
  if (!current?.id || current.state !== 'connected') return;
  const paths =
    kind === 'mkdir'
      ? []
      : kind === 'rename' && menu.value
        ? [menu.value.entry.path]
        : [...remoteSelection.value];
  if (kind !== 'mkdir' && !paths.length) return;
  operation.value = {
    kind,
    id: current.id,
    host: hostDisplayName(current.host),
    parent: current.path,
    paths,
    name: kind === 'rename' ? (menu.value?.entry.name ?? '') : '',
    hasDirectory:
      kind === 'delete' &&
      !!current.listing?.entries.some(
        (entry) => entry.kind === 'directory' && paths.includes(entry.path),
      ),
  };
  menu.value = null;
}
async function submitOperation(): Promise<void> {
  const op = operation.value;
  if (!op || busy.value) return;
  busy.value = true;
  store.error = null;
  try {
    if (op.kind === 'mkdir')
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
    remoteSelection.value = [];
    await store.refresh();
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
    properties.value =
      item.side === 'local'
        ? item.entry
        : await filesApi.properties(store.current!.id!, item.entry.path);
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
  } else store.error = '特殊文件不能直接打开。';
}
let unlisten: UnlistenFn | undefined,
  disposed = false;
onMounted(async () => {
  void loadLocalDrives();
  if (props.hostId && store.current?.host.id !== props.hostId) await connect();
  if (!store.local) await store.localLoad();
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
    store.error = `拖放入口不可用：${errorMessage(cause)}`;
  }
});
onBeforeUnmount(() => {
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
        <h1>文件管理</h1>
      </div>
      <div class="toolbar">
        <button v-if="hasTransferHistory" class="button" @click="transferHistory = true">
          传输记录
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
          {{ store.current?.state === 'connected' ? 'SFTP 已连接' : '连接 SFTP' }}
        </button>
      </div>
    </div>

    <p v-if="store.notice" class="banner success" role="status">{{ store.notice }}</p>
    <p v-if="store.editorBusy" class="banner" role="status">正在打开 {{ store.openingPath }}…</p>
    <p v-if="store.localOpening" class="banner" role="status">正在显示系统打开方式…</p>
    <p v-if="!chosen" class="banner" role="status">
      请在主机管理中打开远程主机后使用 SFTP 文件管理。
    </p>
    <div class="file-columns">
      <section
        ref="localArea"
        :class="['file-side', { dropping: overLocal }]"
        @mouseup="navigateWithMouse('local', $event)"
      >
        <h2>本地文件 <span v-if="overLocal">松开后下载到当前目录</span></h2>
        <form class="path-bar" @submit.prevent="navigateLocal">
          <button
            class="tool-button"
            aria-label="本地上级"
            title="本地上级"
            type="button"
            :disabled="!store.local?.parent"
            @click="store.local?.parent && store.localLoad(store.local.parent)"
          >
            <ArrowUp :size="15" aria-hidden="true" />
          </button>
          <label class="local-drive-picker">
            <HardDrive :size="15" aria-hidden="true" />
            <select
              aria-label="选择本地磁盘"
              title="选择本地磁盘"
              :value="selectedDrive"
              :disabled="localDrivesLoading && !localDrives.length"
              :aria-busy="localDrivesLoading"
              @focus="loadLocalDrives"
              @pointerdown="loadLocalDrives"
              @change="selectLocalDrive"
            >
              <option v-if="!localDrives.length" value="" disabled>
                {{
                  localDrivesLoading
                    ? '加载磁盘…'
                    : localDrivesFailed
                      ? '磁盘加载失败'
                      : '无可用磁盘'
                }}
              </option>
              <option v-for="drive in localDrives" :key="drive.path" :value="drive.path">
                {{ drive.name }}
              </option>
            </select>
          </label>
          <input v-model="localPath" aria-label="本地路径" required /><button
            class="tool-button"
            aria-label="前往"
            title="前往本地路径"
          >
            <ArrowRight :size="15" aria-hidden="true" />
          </button>
        </form>
        <div class="toolbar">
          <button
            class="tool-button"
            aria-label="刷新本地"
            title="刷新本地"
            @click="store.localLoad(store.local?.path ?? null)"
          >
            <RefreshCw :size="14" aria-hidden="true" /></button
          ><button
            class="tool-button"
            aria-label="复制本地路径"
            title="复制本地路径"
            :disabled="!store.local"
            @click="store.local && copy(displayLocalPath(store.local.path))"
          >
            <Copy :size="14" aria-hidden="true" /></button
          ><button
            class="button"
            :disabled="store.current?.state !== 'connected' || !localSelection.length"
            @click="prepareTransfer('upload', localSelection)"
          >
            <Upload :size="14" aria-hidden="true" />上传选中
          </button>
          <button
            class="tool-button"
            aria-label="选择上传文件…"
            title="选择上传文件"
            :disabled="store.current?.state !== 'connected'"
            @click="picked()"
          >
            <FileUp :size="15" aria-hidden="true" />
          </button>
          <button
            class="tool-button"
            aria-label="选择上传文件夹…"
            title="选择上传文件夹"
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
          远程文件
          <span v-if="store.current?.state === 'connected'"
            >（{{ store.current.username ?? store.current.host.username }}）</span
          ><span v-if="over">松开后选择上传策略</span>
        </h2>
        <form class="path-bar" @submit.prevent="store.navigate(remotePath)">
          <button
            class="tool-button"
            aria-label="远程上级"
            title="远程上级"
            type="button"
            :disabled="!store.current?.listing?.parent"
            @click="store.current?.listing?.parent && store.navigate(store.current.listing.parent)"
          >
            <ArrowUp :size="15" aria-hidden="true" /></button
          ><input
            v-model="remotePath"
            aria-label="远程路径"
            :disabled="store.current?.state !== 'connected'"
            required
          /><button
            class="tool-button"
            aria-label="前往"
            title="前往远程路径"
            :disabled="store.current?.state !== 'connected'"
          >
            <ArrowRight :size="15" aria-hidden="true" />
          </button>
        </form>
        <div class="toolbar">
          <button
            class="button"
            :disabled="store.current?.state !== 'connected'"
            @click="showUserForm"
          >
            <UserRoundCog :size="14" aria-hidden="true" />切换用户
          </button>
          <button
            class="tool-button"
            aria-label="新建文件夹"
            title="新建文件夹"
            :disabled="store.current?.state !== 'connected'"
            @click="mutate('mkdir')"
          >
            <FolderPlus :size="15" aria-hidden="true" /></button
          ><button
            class="tool-button"
            aria-label="刷新远程"
            title="刷新远程"
            :disabled="!store.current?.id"
            @click="store.navigate(store.current.path)"
          >
            <RefreshCw :size="14" aria-hidden="true" /></button
          ><button
            class="tool-button"
            aria-label="复制远程路径"
            title="复制远程路径"
            :disabled="!store.current?.listing"
            @click="store.current && copy(store.current.path)"
          >
            <Copy :size="14" aria-hidden="true" /></button
          ><button
            class="button"
            :disabled="!remoteSelection.length"
            @click="prepareTransfer('download', remoteSelection)"
          >
            <Download :size="14" aria-hidden="true" />下载选中</button
          ><button
            class="tool-button danger"
            aria-label="删除选中"
            title="删除选中"
            :disabled="!remoteSelection.length"
            @click="mutate('delete')"
          >
            <Trash2 :size="14" aria-hidden="true" /></button
          ><button
            class="tool-button"
            type="button"
            aria-label="显示隐藏项"
            title="显示隐藏项"
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
        />
      </section>
    </div>
    <TransferPanel :host-id="chosen" />
  </section>
  <Modal v-if="userForm" title="切换 SFTP 用户" :busy="switchingUser" @close="closeUserForm">
    <form class="editor-form" @submit.prevent="submitUser">
      <p class="subtle">
        当前用户：{{
          store.current?.username ?? store.current?.host.username
        }}。切换只影响文件管理；请先结束传输并保存、关闭编辑文档。
      </p>
      <label v-if="store.current?.elevated" class="checkbox-label">
        <input
          v-model="userForm.original"
          type="checkbox"
          :disabled="switchingUser"
          @change="userForm.password = ''"
        />切回原登录用户 {{ store.current.host.username }}
      </label>
      <template v-if="!userForm.original">
        <label
          >目标用户<input
            v-model="userForm.username"
            aria-label="目标用户"
            required
            maxlength="64"
            :disabled="switchingUser"
            autocomplete="off"
        /></label>
        <label
          >sudo 密码<input
            v-model="userForm.password"
            aria-label="sudo 密码"
            type="password"
            autocomplete="off"
            :disabled="switchingUser"
            placeholder="免密 sudo 时留空"
        /></label>
        <p class="subtle">
          通常填写当前 SSH 登录用户的密码。本次文件连接期间临时使用，断开后释放，不保存到主机配置。
        </p>
        <label
          >SFTP 服务程序<input
            v-model="userForm.serverPath"
            aria-label="SFTP 服务程序"
            :disabled="switchingUser"
            placeholder="留空自动查找 sftp-server"
        /></label>
        <p class="subtle">
          服务器须允许通过 sudo 运行 Shell 和 sftp-server。仅支持 internal-sftp
          或要求交互终端的服务器无法使用此方式。
        </p>
      </template>
      <p v-if="switchingUser" role="status">正在验证新的文件连接…</p>
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="switchingUser" @click="closeUserForm">
          取消
        </button>
        <button class="button primary" :disabled="switchingUser">确认切换</button>
      </footer>
    </form>
  </Modal>
  <Modal
    v-if="transferHistory && hasTransferHistory"
    title="传输记录"
    @close="transferHistory = false"
  >
    <TransferPanel :host-id="chosen" history @retry="retry" />
  </Modal>
  <template v-if="menu"
    ><button class="context-backdrop" aria-label="关闭文件菜单" @click="menu = null"></button>
    <div class="context-menu" role="menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button
        role="menuitem"
        @click="
          openEntry(menu.side, menu.entry);
          menu = null;
        "
      >
        {{
          menu.entry.kind === 'directory'
            ? '进入目录'
            : menu.side === 'local'
              ? '选择应用打开…'
              : '打开文本'
        }}</button
      ><button
        v-if="menu.side === 'remote' && menu.entry.kind === 'file'"
        role="menuitem"
        @click="
          store.offerExternal(menu.entry.path);
          menu = null;
        "
      >
        使用系统应用编辑…</button
      ><button
        role="menuitem"
        @click="
          prepareTransfer(
            menu.side === 'local' ? 'upload' : 'download',
            menu.side === 'local' ? localSelection : remoteSelection,
          )
        "
      >
        {{ menu.side === 'local' ? '上传选中' : '下载选中' }}</button
      ><button
        role="menuitem"
        @click="
          copy(menu.side === 'local' ? displayLocalPath(menu.entry.path) : menu.entry.path);
          menu = null;
        "
      >
        复制绝对路径</button
      ><button role="menuitem" @click="showProperties">查看属性</button
      ><template v-if="menu.side === 'remote'"
        ><button role="menuitem" @click="mutate('rename')">重命名</button
        ><button role="menuitem" @click="mutate('delete')">删除选中</button
        ><button
          role="menuitem"
          @click="requestTerminal(menu!.entry.kind === 'directory' ? 'directory' : 'view')"
        >
          在新终端中打开
        </button></template
      >
    </div></template
  >
  <Modal
    v-if="operation?.kind === 'delete'"
    title="确认删除远程项目"
    :busy="busy"
    @close="operation = null"
  >
    <form class="file-delete-confirm" @submit.prevent="submitOperation">
      <div class="file-delete-message">
        <CircleX :size="32" aria-hidden="true" />
        <p class="file-delete-question">
          {{
            operation.paths.length === 1
              ? `确定要永久删除「${operation.paths[0]?.split('/').at(-1)}」吗？`
              : `确定要永久删除这 ${operation.paths.length} 个远程项目吗？`
          }}
        </p>
      </div>
      <pre v-if="operation.paths.length > 1" class="file-path-preview">{{
        operation.paths.join('\n')
      }}</pre>
      <footer class="dialog-actions">
        <button class="button" type="button" autofocus :disabled="busy" @click="operation = null">
          取消
        </button>
        <button class="button danger" type="submit" :disabled="busy">确认</button>
      </footer>
    </form>
  </Modal>
  <Modal
    v-else-if="operation"
    :title="operation.kind === 'mkdir' ? '创建远程文件夹' : '重命名远程项目'"
    :busy="busy"
    @close="operation = null"
    ><p>{{ operation.host }} · {{ operation.parent }}</p>

    <form class="editor-form" @submit.prevent="submitOperation">
      <label
        >{{ operation.kind === 'mkdir' ? '文件夹名称' : '新名称'
        }}<input v-model="operation.name" aria-label="远程项目名称" required maxlength="255"
      /></label>
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="busy" @click="operation = null">取消</button
        ><button class="button danger" :disabled="busy">
          {{ operation.kind === 'mkdir' ? '创建文件夹' : '确认重命名' }}
        </button>
      </footer>
    </form></Modal
  >
  <Modal
    v-if="transfer"
    :title="transfer.retry ? '重试传输' : '确认文件传输'"
    :busy="busy"
    @close="transfer = null"
    ><p>
      {{ transfer.host }} · {{ transfer.direction === 'upload' ? '上传到远端' : '下载到本地' }} ·
      {{ transfer.sources.length }} 个源项目
    </p>

    <pre class="file-path-preview">{{
      (transfer.direction === 'upload'
        ? transfer.sources.map(displayLocalPath)
        : transfer.sources
      ).join('\n')
    }}</pre>
    <form class="editor-form" @submit.prevent="startTransfer">
      <label
        >目标目录<input
          v-model="transfer.destination"
          aria-label="传输目标目录"
          :readonly="!!transfer.retry"
          required /></label
      ><button
        v-if="transfer.direction === 'download' && !transfer.retry"
        class="button"
        type="button"
        @click="chooseDestination"
      >
        选择下载目录</button
      ><label
        >同名文件<select v-model="transfer.conflict" aria-label="冲突处理">
          <option value="fail">停止并提示冲突</option>
          <option value="skip">跳过</option>
          <option value="overwrite">覆盖</option>
        </select></label
      ><label v-if="transfer.conflict === 'overwrite'" class="checkbox-label"
        ><input
          v-model="transfer.confirmed"
          type="checkbox"
          required
        />确认替换已有普通文件；目录合并，不覆盖链接。原子替换改变
        inode，ACL、扩展属性或硬链接关系不保证保留。</label
      >
      <p class="subtle">
        {{
          transfer.direction === 'download'
            ? '直接选中的文件链接会下载目标内容。目录链接和递归扫描遇到的链接不跟随。'
            : '上传不跟随链接。'
        }}
        目录将合并；不支持断点续传，重试从头开始。任务在后台继续，取消保留已完成文件。
      </p>
      <footer class="dialog-actions">
        <button class="button" type="button" @click="transfer = null">取消</button
        ><button class="button primary" :disabled="busy">
          {{ transfer.retry ? '确认重试' : '加入传输队列' }}
        </button>
      </footer>
    </form></Modal
  >
  <Modal v-if="properties" title="文件属性" @close="properties = null"
    ><dl class="file-properties">
      <dt>路径</dt>
      <dd>{{ properties.path }}</dd>
      <dt>类型</dt>
      <dd>{{ properties.kind }}</dd>
      <dt>大小</dt>
      <dd>{{ bytes(properties.size) }}</dd>
      <dt>修改时间</dt>
      <dd>
        {{
          properties.modified === null
            ? '未提供'
            : new Date(properties.modified * 1000).toLocaleString()
        }}
      </dd>
      <dt>权限（八进制）</dt>
      <dd>
        {{
          properties.permissions === null
            ? '未提供'
            : properties.permissions.toString(8).padStart(4, '0')
        }}
      </dd>
      <dt>UID / GID</dt>
      <dd>{{ properties.uid ?? '—' }} / {{ properties.gid ?? '—' }}</dd>
    </dl></Modal
  >
  <Modal v-if="store.current?.trust" title="确认 SFTP 主机指纹" @close="store.trust(false)"
    ><p>
      {{ store.current.trust.hostname }}:{{ store.current.trust.port }} ·
      {{ store.current.trust.algorithm }}
    </p>
    <p>请从服务器控制台或其他可信渠道核对后再继续；不会在确认前发送认证信息。</p>
    <code class="fingerprint">{{ store.current.trust.fingerprint }}</code>
    <footer class="dialog-actions">
      <button class="button" @click="store.trust(false)">拒绝连接</button
      ><button class="button primary" @click="store.trust(true)">已核对，信任并连接</button>
    </footer></Modal
  >
  <Modal v-if="terminalAction" title="确认打开文件终端" @close="terminalAction = null"
    ><p>
      {{ hostDisplayName(store.current?.host) }} ·
      {{ terminalAction.kind === 'view' ? '运行 less' : '进入目录并打开交互式 Shell' }}
    </p>
    <pre class="file-path-preview">{{ terminalAction.path }}</pre>
    <p>将新建独立 PTY，路径通过后端固定命令和 POSIX 单引号转义处理，不向已有 Shell 注入输入。</p>
    <footer class="dialog-actions">
      <button class="button" @click="terminalAction = null">取消</button
      ><button
        class="button primary"
        @click="
          emit('terminal', store.current!.host, terminalAction!);
          terminalAction = null;
        "
      >
        确认打开新终端
      </button>
    </footer></Modal
  >
</template>
