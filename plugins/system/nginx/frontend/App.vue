<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { invoke } from '@serverdeck/plugin-sdk';
import type { NginxAction, ServiceTarget } from './types';
import { call as platformCall } from '@serverdeck/plugin-sdk/platform';
import { setDraftDirty } from '@serverdeck/plugin-sdk/drafts';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import { usePluginVisibility } from '@serverdeck/plugin-sdk/visibility';

import type { OpsResponse } from './types';

import StreamDialog from '@serverdeck/plugin-sdk/ui/StreamDialog.vue';
import Modal from '@serverdeck/plugin-sdk/ui/Modal.vue';
import { configLocation, type ConfigLocation, type ConfigMount } from './config';

const props = defineProps<{ hostId: string }>();
interface Document {
  id: string;
  path: string;
  content: string;
  sha256: string;
  atomicSave: boolean;
}
interface Saved {
  saved: boolean;
  document: { id: string; sha256: string } | null;
  message: string | null;
  recoveryPath: string | null;
}
const visible = usePluginVisibility();

const mode = ref<'host' | 'container'>('host'),
  containerId = ref('');
const containers = ref<Record<string, unknown>[]>([]);
const mainConfig = ref('/etc/nginx/nginx.conf'),
  editPath = ref('/etc/nginx/nginx.conf');
const busy = ref(false),
  error = ref(''),
  notice = ref(''),
  info = ref('');
const document = shallowRef<Document>(),
  location = shallowRef<ConfigLocation>();
const content = ref(''),
  original = ref(''),
  loadedPath = ref('');
const logPath = ref('/var/log/nginx/error.log'),
  log = shallowRef<{ id: string }>();
const pending = shallowRef<() => Promise<void>>();
const dirty = computed(() => !!document.value && content.value !== original.value);
const contentBytes = computed(() => new TextEncoder().encode(content.value).length);
const target = computed<ServiceTarget>(() =>
  mode.value === 'host' ? { kind: 'host' } : { kind: 'container', id: containerId.value },
);
const targetReady = computed(
  () => mode.value === 'host' || /^[a-fA-F0-9]{64}$/.test(containerId.value),
);
let revision = 0;
function expired(cause: unknown) {
  return (
    !!cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    ['NOT_FOUND', 'PLUGIN_CANCELLED', 'PLUGIN_PERMISSION_DENIED'].includes(String(cause.code))
  );
}
async function query(
  action: string,
  input: Record<string, string | boolean> = {},
): Promise<OpsResponse> {
  const value = await invoke<OpsResponse>(action, { hostId: props.hostId, ...input });
  if (!value.success) throw new Error(value.message ?? value.code ?? '远端操作失败');
  return value;
}
async function work(action: () => Promise<void>) {
  if (busy.value || !visible.value) return;
  const ticket = revision;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await action();
  } catch (cause) {
    if (ticket === revision) error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function closeDocument(discard: boolean) {
  if (document.value?.id) {
    try {
      await platformCall({ kind: 'close_file', documentId: document.value.id, discard });
    } catch (cause) {
      if (!expired(cause)) throw cause;
    }
  }
  document.value = undefined;
  content.value = '';
  original.value = '';
  loadedPath.value = '';
  await setDraftDirty(false);
}
function guarded(action: () => Promise<void>) {
  if (dirty.value) pending.value = action;
  else void work(action);
}
async function discardAndContinue() {
  const action = pending.value;
  pending.value = undefined;
  if (action)
    await work(async () => {
      await closeDocument(true);
      await action();
    });
}
function chooseMode(event: Event) {
  const field = event.target as HTMLSelectElement,
    next = field.value as 'host' | 'container';
  field.value = mode.value;
  guarded(async () => {
    await closeDocument(false);
    mode.value = next;
    info.value = '';
    location.value = undefined;
    if (next === 'container') await loadContainers();
  });
}
function chooseContainer(event: Event) {
  const field = event.target as HTMLSelectElement,
    next = field.value;
  field.value = containerId.value;
  guarded(async () => {
    await closeDocument(false);
    containerId.value = next;
    info.value = '';
    location.value = undefined;
  });
}
async function loadContainers() {
  const ticket = revision;
  const result = await query('containers');
  if (ticket !== revision) return;
  containers.value = result.records as Record<string, unknown>[];
}
async function run(action: NginxAction) {
  if (!targetReady.value) return;
  await work(async () => {
    const ticket = revision;
    const result = await invoke<OpsResponse>('nginx', {
      hostId: props.hostId,
      target: target.value,
      configPath: mainConfig.value,
      action,
    });
    if (ticket !== revision) return;
    if (action === 'info')
      info.value = String((result.detail as { output?: string } | null)?.output ?? '');
    notice.value =
      action === 'reload'
        ? '配置校验通过，已发送重载信号。请核对站点响应和日志确认生效。'
        : action === 'test'
          ? (result.message ??
            String((result.detail as { output?: string } | null)?.output ?? '配置校验通过'))
          : 'Nginx 检测完成';
  });
}
async function readConfig() {
  const ticket = revision;
  let mounts: ConfigMount[] | undefined;
  if (mode.value === 'container') {
    const result = await query('mounts', { id: containerId.value });
    mounts = (result.detail as { mounts?: ConfigMount[] } | null)?.mounts ?? [];
  }
  const resolved = configLocation(editPath.value, mounts);
  const value = await platformCall<Document>({
    kind: 'read_file',
    hostId: props.hostId,
    path: resolved.path,
  });
  if (ticket !== revision) return;
  await closeDocument(false);
  document.value = value;
  location.value = resolved;
  loadedPath.value = editPath.value;
  content.value = original.value = value.content;
  notice.value = resolved.message || '配置已读取。保存仅写入文件，重载需要单独确认。';
}
async function openLog() {
  await work(async () => {
    log.value = await invoke<{ id: string }>('logs', {
      hostId: props.hostId,
      target: target.value,
      path: logPath.value,
    });
  });
}
async function save() {
  if (
    !document.value ||
    !location.value?.writable ||
    contentBytes.value > 32768 ||
    loadedPath.value !== editPath.value
  )
    return;
  await work(async () => {
    let current = document.value!;
    if (!current.id) {
      const reopened = await platformCall<Document>({
        kind: 'read_file',
        hostId: props.hostId,
        path: location.value!.path,
      });
      if (
        reopened.path !== current.path ||
        (reopened.sha256 !== current.sha256 && reopened.content !== content.value)
      ) {
        await platformCall({ kind: 'close_file', documentId: reopened.id, discard: true });
        throw new Error('服务器配置已变化，草稿已保留。请复制草稿并重新读取，核对后再保存。');
      }
      document.value = { ...current, id: reopened.id };
      current = document.value;
    }
    const value = content.value;
    const result = await platformCall<Saved>({
      kind: 'save_file',
      documentId: current.id,
      content: value,
    });
    if (!result.saved || !result.document)
      throw new Error(
        [result.message ?? '保存未完成，草稿已保留', result.recoveryPath]
          .filter(Boolean)
          .join('；'),
      );
    document.value = { ...current, sha256: result.document.sha256, content: value };
    original.value = value;
    await setDraftDirty(false);
    notice.value = '配置已保存。请校验后执行重载；保存不会自动重载。';
  });
}
watch(dirty, (value) => {
  if (visible.value)
    void (async () => {
      await setDraftDirty(value);
      if (document.value?.id)
        await platformCall({
          kind: 'file_dirty',
          documentId: document.value.id,
          dirty: value,
        });
    })().catch((cause) => {
      error.value = errorMessage(cause);
    });
});
watch(visible, (value) => {
  revision++;
  log.value = undefined;
  if (!value && document.value) {
    const previous = document.value.id;
    document.value = { ...document.value, id: '' };
    if (previous)
      void platformCall({ kind: 'close_file', documentId: previous, discard: true }).catch(
        (cause) => {
          if (!expired(cause)) error.value = errorMessage(cause);
        },
      );
  }
  if (value)
    void setDraftDirty(dirty.value).catch((cause) => {
      error.value = errorMessage(cause);
    });
});
watch(
  () => props.hostId,
  () => {
    revision++;
    info.value = '';
  },
);
onBeforeUnmount(() => {
  revision++;
});
</script>
<template>
  <section class="nginx-panel" aria-label="Nginx 管理工具">
    <div class="nginx-toolbar">
      <label
        >部署方式<select :value="mode" :disabled="busy" @change="chooseMode">
          <option value="host">服务器直接安装</option>
          <option value="container">Docker 容器</option>
        </select></label
      >
      <template v-if="mode === 'container'">
        <label
          >目标容器<select :value="containerId" :disabled="busy" @change="chooseContainer">
            <option value="">选择运行中的容器</option>
            <option
              v-for="row in containers"
              :key="String(row.ID)"
              :value="String(row.ID)"
              :disabled="row.State !== 'running'"
            >
              {{ row.Names }} · {{ row.State }}
            </option>
          </select></label
        >
        <button class="button" :disabled="busy" @click="work(loadContainers)">刷新容器</button>
      </template>
      <button class="button" :disabled="busy || !targetReady" @click="run('info')">
        检测 Nginx
      </button>
    </div>
    <p v-if="busy" role="status">正在处理，请稍候…</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="banner" role="status">{{ notice }}</p>
    <p v-if="!info && !busy" class="subtle">
      选择部署方式和目标，点击“检测 Nginx”查看真实版本与编译配置。
    </p>
    <details v-if="info" open>
      <summary>版本与编译信息</summary>
      <pre>{{ info }}</pre>
    </details>
    <section class="work-section">
      <h2>配置与重载</h2>
      <div class="nginx-toolbar">
        <label class="grow"
          >主配置路径<input
            v-model="mainConfig"
            :disabled="busy"
            placeholder="/etc/nginx/nginx.conf" /></label
        ><button class="button" :disabled="busy || !targetReady || dirty" @click="run('test')">
          校验配置</button
        ><button class="button" :disabled="busy || !targetReady || dirty" @click="run('reload')">
          重载 Nginx
        </button>
      </div>
      <div class="nginx-toolbar">
        <label class="grow"
          >编辑文件路径<input v-model="editPath" :disabled="busy || dirty" /></label
        ><button class="button" :disabled="busy || !targetReady" @click="guarded(readConfig)">
          读取配置
        </button>
      </div>
      <p class="subtle">
        支持主配置及站点配置文件，单文件最多 32
        KiB。校验和重载始终使用上方主配置。容器配置编辑需要目录 bind mount。
      </p>
      <template v-if="document"
        ><p class="subtle">
          服务器文件：{{ document.path }} <strong v-if="dirty">· 尚未保存</strong>
        </p>
        <textarea
          v-model="content"
          aria-label="Nginx 配置内容"
          spellcheck="false"
          :readonly="!location?.writable || busy"
        />
        <div class="nginx-toolbar">
          <span>{{ contentBytes }} / 32768 字节</span
          ><button
            class="button primary"
            :disabled="
              busy ||
              !dirty ||
              !location?.writable ||
              contentBytes > 32768 ||
              loadedPath !== editPath
            "
            @click="save"
          >
            保存配置
          </button>
        </div></template
      >
      <p v-else class="subtle">尚未读取配置文件。</p>
    </section>
    <section class="work-section">
      <h2>日志</h2>
      <div class="nginx-toolbar">
        <label v-if="mode === 'host'" class="grow"
          >日志路径<input v-model="logPath" :disabled="busy"
        /></label>
        <p v-else class="subtle">显示所选容器的标准输出与错误日志。</p>
        <button class="button" :disabled="busy || !targetReady" @click="openLog">查看日志</button>
      </div>
    </section>
    <StreamDialog
      v-if="log && visible"
      :stream-id="log.id"
      title="Nginx 日志"
      @close="log = undefined"
    />
    <Modal v-if="pending" title="配置尚未保存" @close="pending = undefined"
      ><p>继续操作会放弃当前配置草稿。</p>
      <footer class="dialog-actions">
        <button class="button" @click="pending = undefined">继续编辑</button
        ><button class="button danger" @click="discardAndContinue">放弃草稿并继续</button>
      </footer></Modal
    >
  </section>
</template>
