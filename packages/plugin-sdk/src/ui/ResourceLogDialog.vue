<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { opsApi } from '../services/ops';
import { usePluginVisibility } from '../visibility';
import { LogBuffer } from '../services/log-buffer';
import { errorMessage } from '../services/ipc';
import { clipboardApi } from '../services/clipboard';
import { useNotificationsStore } from '../stores/notifications';
import type { LogInput, LogSession } from '../types/ops';
import Modal from './Modal.vue';

const props = defineProps<{
  sessionId: string;
  title: string;
  input: LogInput;
  api?: Pick<typeof opsApi, 'logOpen' | 'logAck' | 'logPause' | 'logClose'>;
  copy?: (text: string) => Promise<void>;
  reportError?: (message: string) => void;
}>();
const emit = defineEmits<{ close: [] }>();
const labels: Record<string, string> = {
  opening: '正在打开…',
  running: '实时跟踪',
  paused: '已暂停',
  closed: '已结束',
  failed: '读取失败',
};
const api = props.api ?? opsApi;
const visible = usePluginVisibility();
const buffer = new LogBuffer();
const revision = ref(0),
  filter = ref(''),
  state = ref('opening'),
  error = ref('');
const session = shallowRef<LogSession>();
const output = ref<HTMLElement>();
const notifications = useNotificationsStore();
const text = computed(() => {
  void revision.value;
  const value = buffer.value();
  return filter.value
    ? value
        .split('\n')
        .filter((line) => line.toLowerCase().includes(filter.value.toLowerCase()))
        .join('\n')
    : value;
});
const decoders = new Map<string, TextDecoder>();
let disposed = false;
let opening: Promise<LogSession>;
let stopping: Promise<void> | undefined;
function ownerReleased(cause: unknown): boolean {
  return (
    !visible.value &&
    !!cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    ['PLUGIN_CANCELLED', 'PLUGIN_PERMISSION_DENIED', 'NOT_FOUND'].includes(String(cause.code))
  );
}
function reportCleanupError(cause: unknown): void {
  if (ownerReleased(cause)) return;
  const message = errorMessage(cause);
  if (props.reportError) props.reportError(message);
  else notifications.push(message, true);
}
function stop(): Promise<void> {
  if (stopping) return stopping;
  const value = session.value;
  if (!value) return Promise.resolve();
  stopping = api
    .logClose(value.id)
    .then(() => {
      session.value = undefined;
    })
    .finally(() => {
      stopping = undefined;
    });
  return stopping;
}
async function close() {
  if (disposed) return;
  disposed = true;
  try {
    await stop();
    emit('close');
  } catch (cause) {
    if (ownerReleased(cause)) {
      emit('close');
      return;
    }
    error.value = errorMessage(cause);
    disposed = false;
  }
}
async function pause() {
  if (!session.value) return;
  try {
    await api.logPause(session.value.id, state.value !== 'paused');
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
async function copyText() {
  try {
    await (props.copy ?? clipboardApi.writeText)(text.value);
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
function download() {
  const url = URL.createObjectURL(new Blob([text.value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'serverdeck-visible-log.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
onMounted(async () => {
  try {
    opening = api.logOpen(props.sessionId, props.input, (event) => {
      if (disposed) return;
      if (event.type === 'state') {
        state.value = event.state;
        if (event.message) error.value = event.message;
        return;
      }
      let decoder = decoders.get(event.stream);
      if (!decoder) {
        decoder = new TextDecoder();
        decoders.set(event.stream, decoder);
      }
      buffer.append(decoder.decode(new Uint8Array(event.data), { stream: true }));
      revision.value++;
      void (async () => {
        await nextTick();
        if (disposed) return;
        if (output.value && !filter.value) output.value.scrollTop = output.value.scrollHeight;
        const value = await opening;
        if (!disposed) await api.logAck(value.id, event.sequence);
      })().catch((cause) => {
        if (!disposed) error.value = errorMessage(cause);
      });
    });
    const value = await opening;
    if (disposed || !visible.value) await api.logClose(value.id).catch(reportCleanupError);
    else session.value = value;
  } catch (cause) {
    if (!disposed) {
      state.value = 'failed';
      error.value = errorMessage(cause);
    }
  }
});
watch(visible, (value) => {
  if (!value) void close();
});
onBeforeUnmount(() => {
  disposed = true;
  void stop().catch(reportCleanupError);
});
</script>
<template>
  <Modal :title="`${title} · 日志`" wide @close="close">
    <section class="resource-log-dialog" aria-label="资源日志">
      <div class="ops-toolbar">
        <span role="status">{{ labels[state] ?? state }}</span>
        <input v-model="filter" aria-label="日志关键词" placeholder="过滤当前日志…" />
        <button
          class="button"
          :disabled="!session || !['running', 'paused'].includes(state)"
          @click="pause"
        >
          {{ state === 'paused' ? '继续日志' : '暂停日志' }}
        </button>
        <button class="button" @click="copyText">复制可见日志</button>
        <button class="button" @click="download">导出可见日志</button>
      </div>
      <p v-if="error" class="banner error" role="alert">{{ error }}</p>
      <p v-if="buffer.dropped" class="subtle">已丢弃 {{ buffer.dropped }} 字节旧输出。</p>
      <pre ref="output" class="ops-log-output" tabindex="0" data-testid="operations-log-output">{{
        text ||
        (filter ? '没有匹配的日志。' : state === 'failed' ? '无法读取日志。' : '等待日志输出…')
      }}</pre>
      <p class="subtle">最多保留 1 MiB / 5000 行，关闭弹窗即停止读取。</p>
    </section>
  </Modal>
</template>
<style scoped>
.resource-log-dialog {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.ops-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ops-toolbar > span {
  color: var(--muted);
  font-size: var(--font-size-body);
  margin-right: auto;
}
.ops-toolbar input {
  min-width: 0;
  width: min(100%, 220px);
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel);
  color: var(--text);
}
.ops-log-output {
  margin: 0;
  height: clamp(180px, 48vh, 500px);
  overflow: auto;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--rail);
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
  font:
    var(--font-size-body)/1.8 Consolas,
    monospace;
}
.resource-log-dialog > p {
  margin: 0;
}
</style>
