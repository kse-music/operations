<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { createPluginUiBridge } from '../services/plugin-ui-bridge';
import { useHostsStore } from '../stores/hosts';
import { useOpsStore } from '../stores/ops';
import { useFilesStore } from '../stores/files';
import { useModelsStore } from '../stores/models';
import { useApplicationStore } from '../stores/application';
import { useNotificationsStore } from '../stores/notifications';
import { errorMessage } from '../services/ipc';
import type { PluginUiPage, PluginToolIntent } from '../types/plugins';
import type { ServerSection } from '../types/server';
import type { LogInput, ContainerShell } from '../types/ops';
import type { Host } from '../types/hosts';
const props = defineProps<{
  pluginId: string;
  revision: string;
  hostId: string;
  page: PluginUiPage;
  initialSection?: ServerSection;
  logIntent?: { input: LogInput; title: string; sequence: number };
  toolIntent?: PluginToolIntent;
}>();
const emit = defineEmits<{
  navigate: [section: ServerSection, intent?: { input: LogInput; title: string; sequence: number }];
  shell: [host: Host, shell: ContainerShell];
  section: [section: ServerSection];
  intentConsumed: [];
  retry: [];
}>();
const frame = ref<HTMLIFrameElement>(),
  ready = ref(false),
  error = ref('');
const visible = ref(true);
let loadingTimer: ReturnType<typeof setTimeout> | undefined;
const hosts = useHostsStore(),
  ops = useOpsStore(),
  files = useFilesStore(),
  models = useModelsStore();
const application = useApplicationStore(),
  notifications = useNotificationsStore();
const path = computed(() => `/${props.pluginId}/${props.revision}/${props.page.id}/index.html`);
const source = computed(() =>
  isTauri()
    ? `${convertFileSrc('', 'sdplugin').replace(/\/+$/, '')}${path.value}`
    : `http://sdplugin.localhost${path.value}`,
);
let port: MessagePort | undefined,
  disposed = false,
  inFlight = 0,
  lastEvent = 0,
  lastRequest = 0;
let rateAt = Date.now(),
  rateCount = 0;
const bridge = createPluginUiBridge({
  id: props.pluginId,
  revision: props.revision,
  page: props.page,
  hostId: props.hostId,
  stream: (id, event) =>
    port?.postMessage(JSON.parse(JSON.stringify({ kind: 'stream', id, event }))),
});
function context() {
  if (!port || disposed) return;
  try {
    // Vue props may contain reactive proxies; only serialized public DTOs cross
    // the browser context boundary.
    port.postMessage(
      JSON.parse(
        JSON.stringify({
          kind: 'context',
          visible: visible.value,
          state: bridge.snapshot(),
          props: {
            hostId: props.hostId,
            initialSection: props.initialSection,
            initialTab: props.initialSection,
            logIntent: props.logIntent,
            page: props.page,
            entryId: props.toolIntent?.entryId,
            requestId: props.toolIntent?.networkRequest,
            ...(props.toolIntent?.automationHost
              ? { hostId: props.toolIntent.automationHost }
              : {}),
            ...(props.toolIntent?.networkHost ? { hostId: props.toolIntent.networkHost } : {}),
          },
        }),
      ),
    );
  } catch (cause) {
    error.value = errorMessage(cause);
    port.close();
  }
}
function uiEvent(name: string, args: unknown[]) {
  if (Date.now() - lastEvent < 40) return;
  lastEvent = Date.now();
  const sections = [
    'overview',
    'disks',
    'network',
    'containers',
    'images',
    'processes',
    'ports',
    'services',
    'logs',
  ];
  if (name === 'section' && sections.includes(String(args[0])))
    emit('section', args[0] as ServerSection);
  else if (name === 'navigate' && sections.includes(String(args[0])))
    emit('navigate', args[0] as ServerSection);
  else if (name === 'log') {
    const input = args[0] as LogInput;
    if (input && typeof args[1] === 'string')
      emit('navigate', 'logs', { input, title: args[1].slice(0, 1024), sequence: Date.now() });
  } else if (name === 'shell') {
    const host = hosts.catalog?.hosts.find((h) => h.id === props.hostId);
    const shell = args[1] as ContainerShell;
    if (host && shell && typeof shell.id === 'string' && shell.id.length <= 128)
      emit('shell', host, {
        id: shell.id,
        bash: shell.bash === true,
        confirmed: false,
        pluginId: props.pluginId,
      });
  } else if (name === 'intentConsumed') emit('intentConsumed');
}
function connect(event: MessageEvent) {
  if (
    event.source !== frame.value?.contentWindow ||
    event.origin !== 'null' ||
    event.data?.kind !== 'serverdeck-sdk-ready' ||
    event.data.version !== 1 ||
    port ||
    disposed
  )
    return;
  const channel = new MessageChannel();
  port = channel.port1;
  port.onmessage = async ({ data }) => {
    if (disposed) return;
    if (data?.kind === 'connected') {
      ready.value = true;
      clearTimeout(loadingTimer);
      context();
      return;
    }
    if (data?.kind === 'event' && typeof data.name === 'string' && Array.isArray(data.args)) {
      uiEvent(data.name, data.args);
      return;
    }
    if (
      data?.kind !== 'request' ||
      !Number.isSafeInteger(data.id) ||
      data.id < 1 ||
      typeof data.method !== 'string' ||
      !data.args ||
      typeof data.args !== 'object' ||
      Array.isArray(data.args)
    )
      return;
    const id = data.id;
    if (id <= lastRequest) return;
    lastRequest = id;
    if (Date.now() - rateAt >= 1000) {
      rateAt = Date.now();
      rateCount = 0;
    }
    let bytes: number;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(data.args)).length;
    } catch {
      port?.postMessage({
        kind: 'response',
        id,
        error: { code: 'PLUGIN_INVALID', message: '插件请求格式无效' },
      });
      return;
    }
    if (inFlight >= 32 || ++rateCount > 40 || bytes > 1024 * 1024) {
      port?.postMessage({
        kind: 'response',
        id,
        error: { code: 'PLUGIN_LIMIT', message: '插件请求超过限制' },
      });
      return;
    }
    inFlight++;
    try {
      const result = await bridge.call(data.method, data.args);
      if (!disposed) port?.postMessage({ kind: 'response', id, result });
    } catch (cause) {
      if (!disposed)
        port?.postMessage({
          kind: 'response',
          id,
          error: {
            code:
              typeof cause === 'object' && cause && 'code' in cause
                ? String(cause.code)
                : 'PLUGIN_ERROR',
            message: errorMessage(cause),
          },
        });
    } finally {
      inFlight--;
      context();
    }
  };
  port.start();
  frame.value?.contentWindow?.postMessage({ kind: 'serverdeck-sdk-connect' }, '*', [channel.port2]);
}
watch(
  () => [
    hosts.catalog,
    ops.connections,
    files.connections,
    models.models,
    application.state?.config.monitorIntervalSecs,
    props.initialSection,
    props.logIntent,
    props.toolIntent,
  ],
  context,
  { deep: true },
);
let theme: MutationObserver | undefined;
let intersection: IntersectionObserver | undefined;
onMounted(() => {
  window.addEventListener('message', connect);
  theme = new MutationObserver(context);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (typeof IntersectionObserver !== 'undefined') {
    intersection = new IntersectionObserver((entries) => {
      visible.value = entries.some((entry) => entry.isIntersecting);
      context();
    });
    if (frame.value) intersection.observe(frame.value);
  }
  loadingTimer = setTimeout(() => {
    if (!ready.value) error.value = '插件界面加载超时，请重新加载。';
  }, 15000);
  if (props.page.surface?.kind === 'tool' && props.page.surface.tool === 'assistant')
    void models.refresh();
});
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('message', connect);
  theme?.disconnect();
  intersection?.disconnect();
  clearTimeout(loadingTimer);
  port?.close();
  void bridge.dispose().catch((cause) => notifications.push(errorMessage(cause), true));
});
</script>
<template>
  <div
    class="plugin-frame-container"
    :data-plugin-id="pluginId"
    :data-tool="page.surface?.kind === 'tool' ? page.surface.tool : undefined"
  >
    <div v-if="error" class="banner error" role="alert">
      {{ error }}<button class="button" @click="emit('retry')">重新加载界面</button>
    </div>
    <p v-else-if="!ready" role="status">正在加载插件界面…</p>
    <iframe
      ref="frame"
      :src="source"
      :title="typeof page.title === 'string' ? page.title : page.title['zh-CN']"
      sandbox="allow-scripts allow-forms"
      referrerpolicy="no-referrer"
      class="plugin-frame"
    />
  </div>
</template>
