<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, provide, ref, watch } from 'vue';
import MonitorView from '../../../system/resources/frontend/MonitorView.vue';
import OperationsView from './OperationsView.vue';
import {
  pluginServerServices,
  type PluginServerServices,
} from '@serverdeck/plugin-sdk/services/plugin-server-surface';
import { pluginServerRequest } from '@serverdeck/plugin-sdk/services/plugin-server';
import { useApplicationStore } from '@serverdeck/plugin-sdk/stores/application';
import {
  serverSections,
  type ServerSection,
  type MonitorSection,
  type OperationsSection,
} from '@serverdeck/plugin-sdk/types/server';
import type { PluginCapability, PluginUiPage } from '@serverdeck/plugin-sdk/types/plugins';
import type { ContainerShell, LogEvent, LogInput } from '@serverdeck/plugin-sdk/types/ops';
import type { Host } from '@serverdeck/plugin-sdk/types/hosts';
import type { MonitorSnapshot } from '@serverdeck/plugin-sdk/types/monitor';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
const props = defineProps<{
  pluginId: string;
  hostId: string;
  page: PluginUiPage;
  initialSection?: ServerSection;
  logIntent?: { input: LogInput; title: string; sequence: number };
}>();
const emit = defineEmits<{
  navigate: [section: ServerSection, intent?: { input: LogInput; title: string; sequence: number }];
  shell: [host: Host, shell: ContainerShell];
  section: [section: ServerSection];
}>();
const available = computed(() =>
  serverSections.filter(
    (entry) =>
      (props.page.surface?.kind === 'monitor' || props.page.surface?.kind === 'operations') &&
      props.page.surface.sections.includes(entry.key),
  ),
);
const section = ref<ServerSection>(
  props.initialSection && available.value.some((s) => s.key === props.initialSection)
    ? props.initialSection
    : available.value[0]!.key,
);
const monitorSection = computed(() => section.value as MonitorSection);
const operationsSection = computed(() => section.value as OperationsSection);
const tabs = ref<HTMLElement>();
async function tabKey(event: KeyboardEvent) {
  const index = available.value.findIndex((entry) => entry.key === section.value);
  const target =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? available.value.length - 1
        : event.key === 'ArrowRight'
          ? (index + 1) % available.value.length
          : event.key === 'ArrowLeft'
            ? (index + available.value.length - 1) % available.value.length
            : -1;
  if (target < 0) return;
  event.preventDefault();
  section.value = available.value[target]!.key;
  await nextTick();
  tabs.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
}
function select(value: ServerSection) {
  if (available.value.some((entry) => entry.key === value)) section.value = value;
  else emit('navigate', value);
}
watch(
  () => props.initialSection,
  (value) => {
    if (value && available.value.some((s) => s.key === value)) section.value = value;
  },
);
watch(section, (value) => emit('section', value));
const rpc = <T,>(operation: PluginCapability) =>
  pluginServerRequest<T>(props.pluginId, operation, props.page);
let monitor = '',
  disposed = false,
  logSequence = 0;
const logs = new Map<string, { stopped: boolean }>();
const api: PluginServerServices = {
  monitor: {
    async open() {
      const value = await rpc<{ id: string }>({
        kind: 'metrics_open',
        intervalSecs: useApplicationStore().state?.config.monitorIntervalSecs ?? 3,
      });
      monitor = value.id;
      return value;
    },
    async snapshot(_host, after) {
      return monitor
        ? rpc<MonitorSnapshot | null>({
            kind: 'metrics_snapshot',
            monitorId: monitor,
            afterRevision: after ?? null,
          })
        : null;
    },
    async visible(_host, visible) {
      if (monitor) await rpc({ kind: 'metrics_visible', monitorId: monitor, visible });
    },
    async stop() {
      if (monitor) {
        await rpc({ kind: 'metrics_close', monitorId: monitor });
        monitor = '';
      }
    },
  },
  operations: {
    query: (_session, request) => {
      if (request.kind === 'diagnostic')
        return Promise.reject(new Error('标准服务器视图不支持此诊断请求'));
      return rpc({ kind: 'system_query', request });
    },
    feedback: () => rpc({ kind: 'system_feedback' }),
    async logOpen(_session, input, receive) {
      const result = await rpc<{ id: string }>({ kind: 'system_log_start', ...input });
      const control = { stopped: false };
      logs.set(result.id, control);
      void (async () => {
        try {
          while (!disposed && !control.stopped) {
            const resultEvents = await rpc<{
              events: (
                | { type: 'state'; state: string; code: string | null; message: string | null }
                | { type: 'data'; sequence: number; stream: string; dataBase64: string; at: number }
              )[];
            }>({ kind: 'system_log_poll', logId: result.id });
            if (disposed || control.stopped) return;
            for (const event of resultEvents.events) {
              const converted: LogEvent =
                event.type === 'data'
                  ? {
                      ...event,
                      data: [...Uint8Array.from(atob(event.dataBase64), (c) => c.charCodeAt(0))],
                    }
                  : event;
              receive(converted);
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        } catch (cause) {
          if (!disposed && !control.stopped)
            receive({
              type: 'state',
              state: 'failed',
              code: 'PLUGIN_LOG',
              message: errorMessage(cause),
            });
        }
      })();
      return { id: result.id, hostId: props.hostId, sessionId: 'plugin-owned' };
    },
    async logPause(logId, paused) {
      await rpc({ kind: 'system_log_pause', logId, paused });
    },
    async logAck() {
      /* The standard host acknowledges each bounded poll delivery. */
    },
    async logClose(logId) {
      const control = logs.get(logId);
      if (control) control.stopped = true;
      logs.delete(logId);
      await rpc({ kind: 'system_log_stop', logId });
    },
  },
};
provide(pluginServerServices, api);
onBeforeUnmount(() => {
  disposed = true;
  for (const control of logs.values()) control.stopped = true;
});
function openLog(input: LogInput, title: string) {
  emit('navigate', 'logs', { input, title, sequence: ++logSequence });
}
function shell(host: Host, value: ContainerShell) {
  emit('shell', host, { ...value, pluginId: props.pluginId });
}
</script>
<template>
  <div class="plugin-server-surface">
    <div ref="tabs" class="server-tabs" role="tablist" aria-label="插件功能分类" @keydown="tabKey">
      <button
        v-for="entry in available"
        :id="`server-tab-${entry.key}`"
        :key="entry.key"
        role="tab"
        :aria-selected="section === entry.key"
        :tabindex="section === entry.key ? 0 : -1"
        aria-controls="plugin-server-panel"
        @click="section = entry.key"
      >
        {{ entry.label }}
      </button>
    </div>
    <div
      id="plugin-server-panel"
      class="server-panel"
      role="tabpanel"
      :aria-labelledby="`server-tab-${section}`"
    >
      <MonitorView
        v-if="page.surface?.kind === 'monitor'"
        :host-id="hostId"
        :section="monitorSection"
        @processes="emit('navigate', 'processes')"
      />
      <OperationsView
        v-else
        :host-id="hostId"
        :initial-tab="operationsSection"
        :log-intent="logIntent"
        @section="select"
        @log="openLog"
        @shell="shell"
      />
    </div>
  </div>
</template>
