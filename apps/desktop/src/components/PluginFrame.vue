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
import { usePluginsStore } from '../stores/plugins';
import { useWorkspaceStore } from '../stores/workspace';
import { errorMessage } from '../services/ipc';
import type { PluginUiPage } from '../types/plugins';
import type { ServerSection } from '../types/server';
import type { Host } from '../types/hosts';
import type { TerminalPresentation } from '@serverdeck/plugin-sdk/terminal';
import PluginTerminalDialog from './PluginTerminalDialog.vue';
const props = withDefaults(
  defineProps<{
    pluginId: string;
    revision: string;
    hostId: string;
    page: PluginUiPage;
    initialSection?: ServerSection;
    active?: boolean;
    contextKey?: string;
    retainRequests?: boolean;
    settingsPage?: boolean;
  }>(),
  {
    active: true,
    contextKey: '',
    retainRequests: false,
    settingsPage: false,
    initialSection: undefined,
  },
);
const emit = defineEmits<{
  navigate: [section: ServerSection];
  section: [section: ServerSection];
  retry: [];
  settingsAction: [action: 'close' | 'models'];
  saving: [value: boolean];
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
const plugins = usePluginsStore(),
  workspace = useWorkspaceStore();
const terminal = ref<{ host: Host; ticket: string; presentation?: TerminalPresentation }>();
const active = computed(
  () =>
    props.active &&
    (!props.contextKey ||
      ((workspace.activePluginKey === props.contextKey ||
        (props.settingsPage &&
          workspace.pluginConfiguration?.pluginId === props.pluginId &&
          workspace.pluginConfiguration.contributionId === props.page.id)) &&
        plugins.owns(props.pluginId, props.contextKey))),
);
const path = computed(() => `/${props.pluginId}/${props.revision}/${props.page.id}/index.html`);
const source = computed(() =>
  isTauri()
    ? `${convertFileSrc('', 'sdplugin').replace(/\/+$/, '')}${path.value}`
    : `http://sdplugin.localhost${path.value}`,
);
let port: MessagePort | undefined,
  disposed = false,
  inFlight = 0,
  settingsWrites = 0,
  lastEvent = 0,
  lastRequest = 0;
let rateAt = Date.now(),
  rateCount = 0;
const bridge = createPluginUiBridge({
  id: props.pluginId,
  revision: props.revision,
  page: props.page,
  hostId: props.hostId,
  contextKey: props.contextKey,
  isActive: () => active.value,
  canRetain: () => props.retainRequests,
  settingsAction: props.settingsPage ? (action) => emit('settingsAction', action) : undefined,
  terminal: (ticket, hostId, presentation) => {
    const host = hosts.catalog?.hosts.find((h) => h.id === hostId);
    if (!host) throw new Error('终端目标主机已删除');
    terminal.value = { host, ticket, presentation };
  },
});
watch(
  [
    active,
    () => props.hostId,
    () => props.revision,
    () => ops.connections[props.hostId]?.session?.id,
  ],
  () => {
    terminal.value = undefined;
  },
);
function context() {
  if (!port || disposed) return;
  try {
    // Vue props may contain reactive proxies; only serialized public DTOs cross
    // the browser context boundary.
    port.postMessage(
      JSON.parse(
        JSON.stringify({
          kind: 'context',
          visible: active.value && visible.value,
          state: bridge.snapshot(),
          props: {
            hostId: props.hostId,
            boundHostId: props.hostId,
            initialSection: props.initialSection,
            initialTab: props.initialSection,
            page: props.page,
            settingsDialog: props.settingsPage,
            keepRunning: props.retainRequests,
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
  if (!active.value) return;
  if (Date.now() - lastEvent < 40) return;
  lastEvent = Date.now();
  const sections =
    plugins.installed
      .find((p) => p.manifest.id === props.pluginId)
      ?.manifest.contributions.find((entry) => entry.id === props.page.id)?.routes ?? [];
  if (name === 'section' && sections.includes(String(args[0])))
    emit('section', args[0] as ServerSection);
  else if (name === 'navigate' && sections.includes(String(args[0])))
    emit('navigate', args[0] as ServerSection);
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
    const saving =
      props.settingsPage &&
      (data.method === 'invoke' ||
        (data.method === 'platform.request' && data.args.operation?.kind === 'settings_write'));
    if (saving && ++settingsWrites === 1) emit('saving', true);
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
      if (saving && --settingsWrites === 0 && !disposed) emit('saving', false);
      context();
    }
  };
  port.start();
  frame.value?.contentWindow?.postMessage({ kind: 'serverdeck-sdk-connect' }, '*', [channel.port2]);
}
watch(
  () => active.value,
  (value) => {
    if (!value) bridge.suspend();
    else void bridge.resume().catch((cause) => notifications.push(errorMessage(cause), true));
    context();
  },
  { flush: 'sync' },
);
watch(
  () => [
    hosts.catalog,
    ops.connections,
    files.connections,
    models.models,
    plugins.settingsRevisions[props.pluginId],
    application.state?.config.monitorIntervalSecs,
    props.initialSection,
    props.page,
  ],
  context,
  { deep: true },
);
let theme: MutationObserver | undefined;
let intersection: IntersectionObserver | undefined;
onMounted(() => {
  window.addEventListener('message', connect);
  theme = new MutationObserver(context);
  theme.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style'],
  });
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
  <div class="plugin-frame-container" :data-plugin-id="pluginId">
    <div v-if="error" class="banner error" role="alert">
      {{ error }}<button class="button" @click="emit('retry')">重新加载界面</button>
    </div>
    <p v-else-if="!ready" role="status">正在加载插件界面…</p>
    <iframe
      ref="frame"
      :inert="!active"
      :src="source"
      :title="typeof page.title === 'string' ? page.title : page.title['zh-CN']"
      sandbox="allow-scripts allow-forms"
      referrerpolicy="no-referrer"
      class="plugin-frame"
    />
    <PluginTerminalDialog
      v-if="terminal && active"
      :key="terminal.ticket"
      :host="terminal.host"
      :ticket="terminal.ticket"
      :plugin-id="pluginId"
      :owner="contextKey || 'default'"
      :presentation="terminal.presentation"
      @close="terminal = undefined"
    />
  </div>
</template>
