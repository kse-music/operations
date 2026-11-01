<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import FilePane from '../components/FilePane.vue';
import TransferPanel from '../components/TransferPanel.vue';
import Modal from '../components/Modal.vue';
import { useFilesStore } from '../stores/files';
import { useApplicationStore } from '../stores/application';
import { useHostsStore } from '../stores/hosts';
import { useTerminalsStore } from '../stores/terminals';
import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
import {
  bytes,
  remoteJoin,
  type FileEntry,
  type ConflictPolicy,
  type Direction,
  type TransferInfo,
  type FileTerminalAction,
} from '../types/files';
import type { Host } from '../types/hosts';
import { stateLabels } from '../types/terminal';
const props = defineProps<{ hostId?: string }>();
const application = useApplicationStore();
const emit = defineEmits<{
  context: [hostId: string];
  terminal: [host: Host, action: FileTerminalAction];
}>();
const store = useFilesStore(),
  hosts = useHostsStore(),
  terminals = useTerminalsStore();
const chosen = ref(props.hostId || store.active || hosts.selectedId || ''),
  localPath = ref(''),
  remotePath = ref(''),
  localSelection = ref<string[]>([]),
  remoteSelection = ref<string[]>([]),
  busy = ref(false),
  over = ref(false),
  following = ref(false),
  remoteArea = ref<HTMLElement>();
const menu = ref<{ side: 'local' | 'remote'; entry: FileEntry; x: number; y: number } | null>(null),
  operation = ref<{
    kind: 'mkdir' | 'rename' | 'delete';
    id: string;
    parent: string;
    paths: string[];
    name: string;
    recursive: boolean;
  } | null>(null),
  properties = ref<FileEntry | null>(null),
  disconnecting = ref(false),
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
watch(
  () => store.local?.path,
  (value) => {
    if (value) {
      localPath.value = value;
      localSelection.value = [];
    }
  },
  { immediate: true },
);
watch(
  () => store.current?.path,
  (value) => {
    remotePath.value = value ?? '';
    remoteSelection.value = [];
  },
  { immediate: true },
);
watch(
  () => store.active,
  (value) => {
    chosen.value = value;
    remoteSelection.value = [];
    following.value = false;
  },
);
const cwd = computed(() => terminals.panes.find((p) => p.key === store.current?.followPane)?.cwd);
watch(cwd, (value) => {
  if (
    value &&
    following.value &&
    store.current?.state === 'connected' &&
    value !== store.current.path
  )
    void store.navigate(value);
});
async function connect(): Promise<void> {
  const host = hosts.catalog?.hosts.find((h) => h.id === chosen.value);
  if (host) await store.open(host);
}
async function copy(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    store.notice = '绝对路径已复制。';
  } catch {
    store.error = '无法写入剪贴板。';
  }
}
async function browseLocal(): Promise<void> {
  try {
    const paths = await filesApi.pick('folder');
    if (paths[0]) await store.localLoad(paths[0]);
  } catch (cause) {
    store.error = errorMessage(cause);
  }
}
async function picked(folder = false): Promise<void> {
  try {
    const paths = await filesApi.pick(folder ? 'folder' : 'files');
    if (paths.length) prepareTransfer('upload', paths);
  } catch (cause) {
    store.error = errorMessage(cause);
  }
}
function prepareTransfer(direction: Direction, sources: string[]): void {
  menu.value = null;
  const current = store.current;
  if (!current?.id || current.state !== 'connected') {
    store.error = '请先连接远程主机。';
    return;
  }
  if (!sources.length) {
    store.error = '请先选择文件或目录。';
    return;
  }
  transfer.value = {
    id: current.id,
    host: current.host.name,
    direction,
    sources,
    destination:
      direction === 'upload'
        ? current.path
        : application.state?.config.product?.downloadDirectory || store.local?.path || '',
    conflict: 'fail',
    confirmed: false,
  };
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
  if (!input) return;
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
    host: host.name,
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
    parent: current.path,
    paths,
    name: kind === 'rename' ? (menu.value?.entry.name ?? '') : '',
    recursive: false,
  };
  menu.value = null;
}
async function submitOperation(): Promise<void> {
  const op = operation.value;
  if (!op) return;
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
        recursive: op.recursive,
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
function requestTerminal(kind: 'directory' | 'view' | 'tail'): void {
  const entry = menu.value?.entry;
  if (!entry) return;
  terminalAction.value = { kind, path: entry.path };
  menu.value = null;
}
async function disconnect(): Promise<void> {
  if (!store.current?.id) return;
  busy.value = true;
  try {
    await filesApi.close(store.current.id, true);
    store.current.state = 'closed';
    store.current.id = undefined;
    store.current.listing = null;
    disconnecting.value = false;
    await store.poll();
  } catch (cause) {
    store.error = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function openEntry(side: 'local' | 'remote', entry: FileEntry): Promise<void> {
  if (entry.kind === 'directory' || entry.kind === 'symlink') {
    if (side === 'local') await store.localLoad(entry.path);
    else {
      following.value = false;
      await store.navigate(entry.path);
    }
  } else if (side === 'remote') await store.edit(entry.path);
}
let unlisten: UnlistenFn | undefined,
  disposed = false;
onMounted(async () => {
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
  disposed = true;
  unlisten?.();
});
</script>
<template>
  <section class="files-view">
    <div class="section-heading">
      <div>
        <p class="eyebrow">SFTP WORKSPACE</p>
        <h1>文件管理</h1>
      </div>
      <div class="toolbar">
        <select v-model="chosen" aria-label="文件管理主机" @change="emit('context', chosen)">
          <option value="" disabled>选择主机</option>
          <option v-for="host in hosts.catalog?.hosts ?? []" :key="host.id" :value="host.id">
            {{ host.name }}
          </option></select
        ><button class="button primary" :disabled="!chosen" @click="connect">连接 SFTP</button>
      </div>
    </div>
    <p v-if="store.error" class="banner error" role="alert">
      {{ store.error }} <button class="text-button" @click="store.error = null">关闭提示</button>
    </p>
    <p v-if="store.notice" class="banner success" role="status">{{ store.notice }}</p>
    <div v-if="Object.keys(store.connections).length" class="files-host-tabs">
      <button
        v-for="connection in store.connections"
        :key="connection.host.id"
        :class="['button', { primary: store.active === connection.host.id }]"
        @click="store.active = connection.host.id"
      >
        {{ connection.host.name }} · {{ stateLabels[connection.state] ?? connection.state }}
      </button>
    </div>
    <div v-if="store.current" class="files-status">
      <strong>{{ store.current.host.name }}</strong
      ><span>{{ stateLabels[store.current.state] ?? store.current.state }}</span
      ><button class="text-button" @click="disconnecting = true">断开文件连接</button
      ><label class="checkbox-label"
        ><input
          v-model="following"
          type="checkbox"
          :disabled="!cwd"
          @change="following && cwd && store.navigate(cwd)"
        />跟随来源终端的 OSC 7 目录</label
      ><span class="subtle">{{ cwd ?? '来源终端未报告目录；不从屏幕文本猜测 pwd' }}</span>
    </div>
    <p v-if="store.current?.error" class="banner error" role="alert">{{ store.current.error }}</p>
    <div class="file-columns">
      <section class="file-side">
        <h2>本地文件</h2>
        <form class="path-bar" @submit.prevent="store.localLoad(localPath)">
          <button
            class="button"
            type="button"
            :disabled="!store.local?.parent"
            @click="store.local?.parent && store.localLoad(store.local.parent)"
          >
            本地上级</button
          ><input v-model="localPath" aria-label="本地路径" required /><button class="button">
            前往
          </button>
        </form>
        <div class="toolbar">
          <button class="button" @click="browseLocal">选择本地目录</button
          ><button class="button" @click="store.localLoad(store.local?.path ?? null)">
            刷新本地</button
          ><button
            class="button"
            :disabled="!store.local"
            @click="store.local && copy(store.local.path)"
          >
            复制本地路径</button
          ><button
            class="button"
            :disabled="store.current?.state !== 'connected'"
            @click="prepareTransfer('upload', localSelection)"
          >
            上传选中
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
      <section ref="remoteArea" :class="['file-side', { dropping: over }]">
        <h2>远程文件 <span v-if="over">松开后选择上传策略</span></h2>
        <form
          class="path-bar"
          @submit.prevent="
            following = false;
            store.navigate(remotePath);
          "
        >
          <button
            class="button"
            type="button"
            :disabled="!store.current?.listing?.parent"
            @click="
              following = false;
              store.current?.listing?.parent && store.navigate(store.current.listing.parent);
            "
          >
            远程上级</button
          ><input
            v-model="remotePath"
            aria-label="远程路径"
            :disabled="store.current?.state !== 'connected'"
            required
          /><button class="button" :disabled="store.current?.state !== 'connected'">前往</button>
        </form>
        <div class="toolbar">
          <button
            class="button"
            :disabled="store.current?.state !== 'connected'"
            @click="mutate('mkdir')"
          >
            新建文件夹</button
          ><button
            class="button"
            :disabled="!store.current?.id"
            @click="store.navigate(store.current.path)"
          >
            刷新远程</button
          ><button
            class="button"
            :disabled="!store.current?.listing"
            @click="store.current && copy(store.current.path)"
          >
            复制远程路径</button
          ><button
            class="button"
            :disabled="!remoteSelection.length"
            @click="prepareTransfer('download', remoteSelection)"
          >
            下载选中</button
          ><button class="button" :disabled="!remoteSelection.length" @click="mutate('delete')">
            删除选中
          </button>
        </div>
        <div class="toolbar">
          <button
            class="text-button"
            :disabled="store.current?.state !== 'connected'"
            @click="picked()"
          >
            选择上传文件…</button
          ><button
            class="text-button"
            :disabled="store.current?.state !== 'connected'"
            @click="picked(true)"
          >
            选择上传文件夹…</button
          ><span class="subtle">可将本地文件或目录拖到此栏；传输不跟随符号链接</span>
        </div>
        <FilePane
          side="remote"
          :listing="store.current?.listing ?? null"
          :loading="store.current?.loading ?? false"
          :selected="remoteSelection"
          @select="remoteSelection = $event"
          @open="openEntry('remote', $event)"
          @menu="(entry, event) => context('remote', entry, event)"
        />
      </section>
    </div>
    <TransferPanel @retry="retry" />
  </section>
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
        {{ menu.entry.kind === 'directory' ? '进入目录' : '打开文本' }}</button
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
          copy(menu.entry.path);
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
          在新终端中打开</button
        ><button v-if="menu.entry.kind === 'file'" role="menuitem" @click="requestTerminal('tail')">
          在新终端执行 tail -f
        </button></template
      >
    </div></template
  >
  <Modal
    v-if="operation"
    :title="
      operation.kind === 'delete'
        ? '确认删除远程项目'
        : operation.kind === 'mkdir'
          ? '创建远程文件夹'
          : '重命名远程项目'
    "
    :busy="busy"
    @close="operation = null"
    ><p>{{ store.current?.host.name }} · {{ operation.parent }}</p>
    <p v-if="store.error" class="banner error" role="alert">{{ store.error }}</p>
    <form class="editor-form" @submit.prevent="submitOperation">
      <label v-if="operation.kind !== 'delete'"
        >{{ operation.kind === 'mkdir' ? '文件夹名称' : '新名称'
        }}<input
          v-model="operation.name"
          aria-label="远程项目名称"
          required
          maxlength="255" /></label
      ><template v-else
        ><p class="error-text">将永久删除 {{ operation.paths.length }} 项，无法撤销。</p>
        <pre class="file-path-preview">{{ operation.paths.join('\n') }}</pre>
        <label class="checkbox-label"
          ><input
            v-model="operation.recursive"
            type="checkbox"
          />递归删除所选目录及全部内容；不跟随链接。未选中时只删除文件或空目录。</label
        ></template
      >
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="busy" @click="operation = null">取消</button
        ><button class="button danger" :disabled="busy">
          {{
            operation.kind === 'delete'
              ? '确认删除'
              : operation.kind === 'mkdir'
                ? '创建文件夹'
                : '确认重命名'
          }}
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
    <p v-if="store.error" class="banner error" role="alert">{{ store.error }}</p>
    <pre class="file-path-preview">{{ transfer.sources.join('\n') }}</pre>
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
          <option value="rename">自动重命名</option>
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
        不跟随链接；目录将合并；不支持断点续传，重试从头开始。任务在后台继续，取消保留已完成文件。
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
  <Modal v-if="disconnecting" title="断开 SFTP 连接" :busy="busy" @close="disconnecting = false"
    ><p>此主机的未完成传输将被取消，已完成文件保留。仅离开文件页面可继续后台任务。</p>
    <p v-if="store.error" class="banner error" role="alert">{{ store.error }}</p>
    <footer class="dialog-actions">
      <button class="button" @click="disconnecting = false">继续后台传输</button
      ><button class="button danger" :disabled="busy" @click="disconnect">取消传输并断开</button>
    </footer></Modal
  >
  <Modal v-if="terminalAction" title="确认打开文件终端" @close="terminalAction = null"
    ><p>
      {{ store.current?.host.name }} ·
      {{
        terminalAction.kind === 'tail'
          ? '运行 tail -f'
          : terminalAction.kind === 'view'
            ? '运行 less'
            : '进入目录并打开交互式 Shell'
      }}
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
