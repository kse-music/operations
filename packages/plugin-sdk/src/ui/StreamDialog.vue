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
const output = ref<HTMLPreElement | null>(null),
  following = ref(true);
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
  stopping: Promise<void> | undefined,
  resizeObserver: ResizeObserver | undefined;
function scrollToBottom() {
  if (!disposed && output.value) output.value.scrollTop = output.value.scrollHeight;
}
function followLatest() {
  following.value = true;
  scrollToBottom();
}
function onScroll() {
  const element = output.value;
  if (element)
    following.value = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
}
watch(
  text,
  () => {
    if (following.value && !paused.value) scrollToBottom();
  },
  { flush: 'post' },
);
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
    if (!paused.value) followLatest();
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
onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    if (following.value && !paused.value) scrollToBottom();
  });
  if (output.value) resizeObserver.observe(output.value);
  void poll();
});
watch(visible, (value) => {
  if (!value) void close();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  resizeObserver?.disconnect();
  void stop().catch((cause) => {
    console.error(
      'Plugin stream cleanup failed',
      typeof cause === 'object' && cause && 'code' in cause ? cause.code : 'UNKNOWN',
    );
  });
});
</script>
<template>
  <Modal :title="title" wide @close="close">
    <section class="platform-stream-dialog">
      <div class="stream-toolbar">
        <input v-model="filter" aria-label="过滤输出" placeholder="过滤输出" /><button
          class="button"
          :disabled="['closed', 'failed'].includes(state)"
          @click="pause"
        >
          {{ paused ? '继续' : '暂停' }}</button
        ><button class="button" @click="copy">复制</button
        ><button class="button" @click="download">导出</button>
        <button class="button" :disabled="following && !paused" @click="followLatest">
          最新日志
        </button>
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
                : following
                  ? '实时跟踪 · 自动滚动到最新'
                  : '查看历史 · 新日志继续接收'
        }}
      </p>
      <pre
        ref="output"
        class="platform-stream-output"
        role="region"
        aria-label="日志输出"
        tabindex="0"
        @scroll="onScroll"
        >{{ text || (filter ? '没有匹配的日志。' : '等待输出…') }}</pre>
    </section>
  </Modal>
</template>
<style scoped>
:global(.modal[open]:has(> .platform-stream-dialog)) {
  display: flex;
  flex-direction: column;
  height: min(720px, calc(100dvh - 60px));
  overflow: hidden;
}
:global(.modal:has(> .platform-stream-dialog) > .modal-heading) {
  flex-shrink: 0;
}
.platform-stream-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.platform-stream-dialog > :not(.platform-stream-output) {
  flex-shrink: 0;
  margin: 0;
}
.error-text {
  max-height: 80px;
  overflow: auto;
}
.platform-stream-output {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: auto;
  flex: 1;
  min-height: 0;
  margin: 0;
  font-family: var(--font-mono, Consolas, monospace);
  font-size: var(--font-size-caption);
  line-height: 1.6;
  user-select: text;
  background: var(--bg);
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.stream-toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.stream-toolbar input {
  flex: 1 1 180px;
  min-width: 0;
}
</style>
