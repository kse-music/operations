<script setup lang="ts">
import { clipboardApi } from '@serverdeck/plugin-sdk/services/clipboard';
import { useErrorNotifications } from '@serverdeck/plugin-sdk/composables/error-notifications';
import {
  computed,
  inject,
  onBeforeUnmount,
  ref,
  shallowRef,
  triggerRef,
  nextTick,
  watch,
} from 'vue';
import { opsApi } from '@serverdeck/plugin-sdk/services/ops';
import { pluginServerServices } from '@serverdeck/plugin-sdk/services/plugin-server-surface';
import { usePluginVisibility } from '@serverdeck/plugin-sdk/visibility';
const panelVisible = usePluginVisibility();
const api = inject(pluginServerServices, null)?.operations ?? opsApi;
import { LogBuffer } from '@serverdeck/plugin-sdk/services/log-buffer';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type { LogInput, LogSession } from '@serverdeck/plugin-sdk/types/ops';
interface Tab {
  key: string;
  title: string;
  session?: LogSession;
  state: string;
  message: string | null;
  buffer: LogBuffer;
  filter: string;
  decoder: Record<string, TextDecoder>;
  updatedAt: number;
}
const props = defineProps<{ sessionId: string; hostName: string }>();
const tabs = shallowRef<Tab[]>([]),
  active = ref(''),
  path = ref(''),
  lines = ref(200),
  follow = ref(true),
  error = ref<string | null>(null),
  timestamp = ref(false);
const current = computed(() => tabs.value.find((t) => t.key === active.value));
const visible = computed(() => {
  const tab = tabs.value.find((t) => t.key === active.value);
  if (!tab) return '';
  const text = tab.buffer.value();
  return tab.filter
    ? text
        .split('\n')
        .filter((line) => line.toLowerCase().includes(tab.filter.toLowerCase()))
        .join('\n')
    : text;
});
let disposed = false;
async function open(input: LogInput, title: string): Promise<void> {
  if (!panelVisible.value) return;
  if (tabs.value.length >= 8) {
    error.value = '最多 8 个日志标签。';
    return;
  }
  const tab: Tab = {
    key: crypto.randomUUID(),
    title,
    state: 'opening',
    message: null,
    buffer: new LogBuffer(),
    filter: '',
    decoder: {},
    updatedAt: 0,
  };
  tabs.value = [...tabs.value, tab];
  active.value = tab.key;
  try {
    const opening = api.logOpen(props.sessionId, input, (event) => {
      if (disposed) return;
      if (event.type === 'state') {
        tab.state = event.state;
        tab.message = event.message;
        triggerRef(tabs);
      } else {
        const decoder = (tab.decoder[event.stream] ??= new TextDecoder());
        tab.buffer.append(decoder.decode(new Uint8Array(event.data), { stream: true }));
        tab.updatedAt = event.at;
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (disposed || !tabs.value.includes(tab)) return;
          triggerRef(tabs);
          await nextTick();
          const session = await opening;
          await api.logAck(session.id, event.sequence);
        })().catch((cause) => {
          if (!disposed && tabs.value.includes(tab)) {
            tab.message = errorMessage(cause);
            triggerRef(tabs);
          }
        });
      }
    });
    const result = await opening;
    tab.session = result;
    if (disposed || !panelVisible.value || !tabs.value.includes(tab)) {
      await api.logClose(result.id);
      tab.session = undefined;
      tab.state = 'closed';
    }
    triggerRef(tabs);
  } catch (cause) {
    tab.state = 'failed';
    tab.message = errorMessage(cause);
    triggerRef(tabs);
  }
}
// The backend waits for an ACK after each rendered, bounded chunk.
async function toggle(): Promise<void> {
  const tab = current.value;
  if (!tab?.session) return;
  try {
    await api.logPause(tab.session.id, tab.state !== 'paused');
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
async function close(key: string): Promise<void> {
  const tab = tabs.value.find((t) => t.key === key);
  if (!tab) return;
  try {
    if (tab.session) await api.logClose(tab.session.id);
    tabs.value = tabs.value.filter((t) => t.key !== key);
    if (active.value === key) active.value = tabs.value.at(-1)?.key ?? '';
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
function changed(): void {
  triggerRef(tabs);
}
async function copy(): Promise<void> {
  try {
    await clipboardApi.writeText(visible.value);
  } catch {
    error.value = '无法写入剪贴板。';
  }
}
function download(): void {
  const blob = new Blob([visible.value], { type: 'text/plain;charset=utf-8' }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = 'serverdeck-visible-log.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
watch(panelVisible, async (visible) => {
  if (visible) return;
  for (const tab of tabs.value) {
    const session = tab.session;
    tab.session = undefined;
    tab.state = 'closed';
    tab.message = '日志流已停止，已读内容保留。';
    if (session)
      try {
        await api.logClose(session.id);
      } catch (cause) {
        if (!(
          cause &&
          typeof cause === 'object' &&
          'code' in cause &&
          ['PLUGIN_PERMISSION_DENIED', 'PLUGIN_CANCELLED', 'NOT_FOUND'].includes(String(cause.code))
        ))
          tab.message = errorMessage(cause);
      }
  }
  triggerRef(tabs);
});
onBeforeUnmount(() => {
  disposed = true;
  for (const tab of tabs.value)
    if (tab.session)
      void api.logClose(tab.session.id).catch(() => {
        /* The owner disconnect/exit path also cancels streams. */
      });
  tabs.value = [];
});
defineExpose({ open });
useErrorNotifications(() => [error.value, ...tabs.value.map((tab) => tab.message)]);
</script>
<template>
  <section class="ops-logs">
    <h2>{{ hostName }} · 日志</h2>
    <p class="subtle">
      仅主动打开指定来源；每标签最多 1 MiB / 5000
      行，关闭标签或离开运维页面会停止远端流。导出仅包含当前过滤结果。
    </p>
    <div class="ops-toolbar">
      <input v-model="path" aria-label="远程日志绝对路径" placeholder="/var/log/…" /><input
        v-model.number="lines"
        type="number"
        min="1"
        max="5000"
        aria-label="日志最近行数"
      /><label><input v-model="follow" type="checkbox" />实时跟踪</label
      ><button
        class="button"
        :disabled="!path"
        @click="open({ source: { kind: 'file', path }, lines, follow }, path)"
      >
        打开日志文件
      </button>
    </div>

    <div class="ops-log-tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="button"
        :aria-selected="active === tab.key"
        role="tab"
        @click="active = tab.key"
      >
        {{ tab.title }} <span @click.stop="close(tab.key)">×</span>
      </button>
    </div>
    <template v-if="current"
      ><div class="ops-toolbar">
        <span role="status">{{ current.state }}</span
        ><button
          class="button"
          :disabled="!current.session || ['closed', 'failed'].includes(current.state)"
          @click="toggle"
        >
          {{ current.state === 'paused' ? '继续日志' : '暂停日志' }}</button
        ><input
          v-model="current.filter"
          aria-label="日志关键词"
          placeholder="关键词过滤"
          @input="changed"
        /><button class="button" @click="copy">复制可见日志</button
        ><button class="button" @click="download">导出可见日志</button
        ><button class="button" @click="close(current.key)">关闭日志标签</button
        ><label><input v-model="timestamp" type="checkbox" />显示最近接收时间</label>
      </div>
      <p v-if="timestamp">
        本地最近接收：{{
          current.updatedAt ? new Date(current.updatedAt).toLocaleString() : '等待输出'
        }}（Docker / journal 日志保留源时间戳）
      </p>

      <p v-if="current.buffer.dropped" class="subtle">
        已丢弃 {{ current.buffer.dropped }} 字节旧输出。
      </p>
      <pre class="ops-log-output" tabindex="0" data-testid="operations-log-output">{{
        visible || '等待日志输出…'
      }}</pre>
    </template>
    <p v-else class="host-empty">尚未打开日志来源。</p>
  </section>
</template>
