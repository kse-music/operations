<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { pluginsApi } from '../services/plugins';
import { usePluginsStore } from '../stores/plugins';
import { errorMessage } from '../services/ipc';
const props = defineProps<{ pluginId: string; resource: string }>();
let decoder = new TextDecoder();
const plugins = usePluginsStore();
const text = ref(''),
  query = ref(''),
  paused = ref(false),
  state = ref(''),
  busy = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
const output = computed(() =>
  text.value
    .split('\n')
    .filter((line) => !query.value || line.toLowerCase().includes(query.value.toLowerCase()))
    .join('\n'),
);
async function poll() {
  if (busy.value || !props.resource) return;
  busy.value = true;
  try {
    const reply = await pluginsApi.capability(props.pluginId, {
      apiVersion: 1,
      requestId: crypto.randomUUID(),
      operation: { kind: 'log_poll', logId: props.resource },
    });
    if (reply.error) throw reply.error;
    const data = reply.result as { events?: Record<string, unknown>[] };
    for (const event of data.events ?? []) {
      if (event.type === 'state') {
        state.value = String(event.state);
        if (event.code) throw { message: String(event.message ?? event.code) };
      } else if (typeof event.dataBase64 === 'string') {
        const bytes = Uint8Array.from(atob(event.dataBase64), (c) => c.charCodeAt(0));
        text.value = (text.value + decoder.decode(bytes, { stream: true })).slice(-65536);
      }
    }
  } catch (cause) {
    plugins.error = errorMessage(cause);
    clearInterval(timer);
  } finally {
    busy.value = false;
  }
}
async function control(kind: 'log_pause' | 'log_stop') {
  try {
    const reply = await pluginsApi.capability(props.pluginId, {
      apiVersion: 1,
      requestId: crypto.randomUUID(),
      operation:
        kind === 'log_pause'
          ? { kind, logId: props.resource, paused: !paused.value }
          : { kind, logId: props.resource },
    });
    if (reply.error) throw reply.error;
    if (kind === 'log_pause') paused.value = !paused.value;
    else {
      clearInterval(timer);
      state.value = 'closed';
    }
  } catch (cause) {
    plugins.error = errorMessage(cause);
  }
}
onMounted(() => {
  timer = setInterval(() => void poll(), 500);
  void poll();
});
watch(
  () => props.resource,
  () => {
    text.value = '';
    decoder = new TextDecoder();
  },
);
onBeforeUnmount(() => {
  clearInterval(timer);
});
</script>
<template>
  <section class="plugin-log">
    <div class="action-row">
      <input
        v-model="query"
        :placeholder="plugins.t('搜索日志缓存', 'Search cached log')"
        maxlength="200"
        :aria-label="plugins.t('搜索插件日志', 'Search plugin log')"
      /><button class="button" @click="control('log_pause')">
        {{ paused ? plugins.t('继续', 'Resume') : plugins.t('暂停', 'Pause') }}</button
      ><button class="button" @click="control('log_stop')">
        {{ plugins.t('取消日志', 'Stop log') }}</button
      ><span class="subtle">{{ state }}</span>
    </div>
    <pre class="plugin-output" aria-live="off">{{
      output || plugins.t('等待日志输出…', 'Waiting for log output…')
    }}</pre>
    <small class="subtle">{{
      plugins.t('仅保留最近 64 KiB 字符缓存', 'Keeps at most the latest 64 KiB characters')
    }}</small>
  </section>
</template>
