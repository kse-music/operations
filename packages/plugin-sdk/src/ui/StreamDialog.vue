<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { call } from '../platform';
import { errorMessage } from '../services/ipc';
import { clipboardApi } from '../services/clipboard';
import { LogBuffer } from '../services/log-buffer';
import { usePluginVisibility } from '../visibility';
import Modal from './Modal.vue';
const props = defineProps<{ streamId: string; title: string }>();
const emit = defineEmits<{ close: [] }>();
const visible = usePluginVisibility();
const buffer = new LogBuffer();
const revision = ref(0),
  filter = ref(''),
  error = ref(''),
  state = ref('running'),
  paused = ref(false);
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
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined,
  stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  return (stopping ??= call<void>({ kind: 'stream_stop', streamId: props.streamId }).catch(
    (cause) => {
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        ['NOT_FOUND', 'PLUGIN_CANCELLED', 'PLUGIN_PERMISSION_DENIED'].includes(String(cause.code))
      )
        return;
      throw cause;
    },
  ));
}
async function close() {
  if (disposed) return;
  clearTimeout(timer);
  try {
    await stop();
    if (disposed) return;
    disposed = true;
    emit('close');
  } catch (cause) {
    if (!disposed) {
      error.value = errorMessage(cause);
      stopping = undefined;
    }
  }
}
async function poll() {
  if (disposed || !visible.value) return;
  try {
    const value = await call<{
      events: {
        type: string;
        state?: string;
        message?: string;
        stream?: string;
        dataBase64?: string;
      }[];
    }>({ kind: 'stream_poll', streamId: props.streamId });
    if (disposed || !visible.value) return;
    for (const event of value.events) {
      if (event.type === 'state') {
        state.value = event.state ?? 'failed';
        if (event.message) error.value = event.message;
        continue;
      }
      const stream = event.stream ?? 'stdout';
      let decoder = decoders.get(stream);
      if (!decoder) {
        decoder = new TextDecoder();
        decoders.set(stream, decoder);
      }
      buffer.append(
        decoder.decode(
          Uint8Array.from(atob(event.dataBase64 ?? ''), (char) => char.charCodeAt(0)),
          { stream: true },
        ),
      );
      revision.value++;
    }
    if (['closed', 'failed'].includes(state.value)) return;
    timer = setTimeout(() => void poll(), 200);
  } catch (cause) {
    if (!disposed && visible.value) {
      error.value = errorMessage(cause);
      state.value = 'failed';
    }
  }
}
async function pause() {
  try {
    await call({ kind: 'stream_pause', streamId: props.streamId, paused: !paused.value });
    paused.value = !paused.value;
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
async function copy() {
  try {
    await clipboardApi.writeText(text.value);
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
function download() {
  const url = URL.createObjectURL(new Blob([text.value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'serverdeck-visible-stream.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
onMounted(() => void poll());
watch(visible, (value) => {
  if (!value) void close();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  void stop().catch((cause) => {
    console.error(
      'Plugin stream cleanup failed',
      typeof cause === 'object' && cause && 'code' in cause ? cause.code : 'UNKNOWN',
    );
  });
});
</script>
<template>
  <Modal :title="title" @close="close">
    <div class="dialog-actions">
      <input v-model="filter" aria-label="过滤输出" placeholder="过滤输出" /><button
        class="button"
        @click="pause"
      >
        {{ paused ? '继续' : '暂停' }}</button
      ><button class="button" @click="copy">复制</button
      ><button class="button" @click="download">导出</button>
    </div>
    <p v-if="error" role="alert" class="error-text">{{ error }}</p>
    <p role="status" class="subtle">
      {{
        state === 'failed'
          ? '读取失败'
          : state === 'closed'
            ? '已结束'
            : paused
              ? '已暂停'
              : '实时跟踪'
      }}
    </p>
    <pre class="platform-stream-output">{{ text || '等待输出…' }}</pre>
  </Modal>
</template>
<style scoped>
.platform-stream-output {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: auto;
  min-height: 240px;
  max-height: 55vh;
  font: 12px/1.6 var(--font-mono, monospace);
  background: var(--bg);
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.dialog-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dialog-actions input {
  flex: 1;
  min-width: 100px;
}
</style>
