<script setup lang="ts">
import { computed, defineAsyncComponent, provide } from 'vue';
import {
  assistantApiKey,
  tasksApiKey,
  automationApiKey,
  type AssistantApi,
} from '../services/plugin-tool-services';
import type { tasksApi } from '../services/tasks';
import type { automationApi } from '../services/automation';
import { pluginToolRequest } from '../services/plugin-server';
import { pluginsApi } from '../services/plugins';
import type { PluginToolIntent, PluginToolOperation, PluginUiPage } from '../types/plugins';
const AssistantView = defineAsyncComponent(() => import('../views/AssistantView.vue'));
const BatchView = defineAsyncComponent(() => import('../views/BatchView.vue'));
const AutomationView = defineAsyncComponent(() => import('../views/AutomationView.vue'));
const NetworkView = defineAsyncComponent(() => import('../views/NetworkView.vue'));
const props = defineProps<{ pluginId: string; page: PluginUiPage; intent?: PluginToolIntent }>();
const emit = defineEmits<{ intentConsumed: [] }>();
const tool = computed(() => (props.page.surface?.kind === 'tool' ? props.page.surface.tool : null));
const rpc = <T,>(operation: PluginToolOperation, args: Record<string, unknown> = {}) =>
  pluginToolRequest<T>(props.pluginId, operation, args, props.page);
let activeRequest = '';
let activeController: AbortController | null = null;
function aiRequest<T>(operation: PluginToolOperation, args: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  activeController = controller;
  return pluginToolRequest<T>(
    props.pluginId,
    operation,
    args,
    props.page,
    controller.signal,
  ).finally(() => {
    if (activeController === controller) activeController = null;
  });
}
const assistant: AssistantApi = {
  resolveHosts(input) {
    activeRequest = input.requestId;
    return aiRequest('ai_resolve_hosts', { input });
  },
  async prepare(input) {
    const preview = await aiRequest<Awaited<ReturnType<AssistantApi['prepare']>>>('ai_prepare', {
      input,
    });
    activeRequest = preview.id;
    return preview;
  },
  send(id, confirmed) {
    activeRequest = id;
    return aiRequest('ai_send', { id, confirmed });
  },
  execute(proposalId, confirmed, changeConfirmation) {
    return aiRequest('ai_execute', { input: { proposalId, confirmed, changeConfirmation } });
  },
  async cancel(id) {
    if (activeRequest === id) {
      activeRequest = '';
      activeController?.abort();
    }
    try {
      await pluginsApi.toolCancelRequest(props.pluginId, id);
    } catch (error) {
      // Unmount/disable may already have revoked these owned resources.
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['NOT_FOUND', 'PLUGIN_PERMISSION_DENIED', 'PLUGIN_CANCELLED'].includes(String(error.code))
      ))
        throw error;
    }
  },
};
const tasks: typeof tasksApi = {
  start: (input) => rpc('diagnostic_start', { input }),
  diagnostics: (versions = {}) => rpc('diagnostic_list', { versions }),
  stop: (id) => rpc('diagnostic_cancel', { id }),
  batch: (input) => rpc('batch_start', { input }),
  batches: (versions = {}) => rpc('batch_list', { versions }),
  cancel: (id, running = false) => rpc('batch_cancel', { id, running }),
  retryFile: (id, hostId, sessionId, confirmed) =>
    rpc('batch_retry_file', { id, hostId, sessionId, confirmed }),
};
const automation: typeof automationApi = {
  catalog: () => rpc('automation_catalog'),
  prepare: (entryId, revision, hostIds) =>
    rpc('automation_prepare', { entryId, revision, hostIds }),
  save: (id, revision, input) => rpc('automation_entry_save', { id, revision, input }),
  remove: (id, confirmed) => rpc('automation_entry_delete', { id, confirmed }),
  groupSave: (id, name) => rpc('automation_group_save', { id, name }),
  groupRemove: (id, confirmed) => rpc('automation_group_delete', { id, confirmed }),
  start: (input) => rpc('automation_start', { input }),
  run: (id) => rpc('automation_run', { id }),
  history: (query = {}) => rpc('automation_history', { query }),
  cancel: (id, running) => rpc('automation_cancel', { id, running }),
  approve: (id, confirmed, dangerConfirmed) =>
    rpc('automation_approve', { id, confirmed, dangerConfirmed }),
  scheduleSave: (id, revision, input) => rpc('automation_schedule_save', { id, revision, input }),
  scheduleDisable: (id) => rpc('automation_schedule_disable', { id }),
  scheduleRemove: (id, confirmed) => rpc('automation_schedule_delete', { id, confirmed }),
  status: () => rpc('automation_status'),
  runRemove: (id, confirmed) => rpc('automation_run_delete', { id, confirmed }),
};
provide(assistantApiKey, assistant);
provide(tasksApiKey, tasks);
provide(automationApiKey, automation);
</script>
<template>
  <div class="plugin-tool-surface" :data-tool="tool">
    <AssistantView v-if="tool === 'assistant'" />
    <BatchView v-else-if="tool === 'batch'" />
    <AutomationView
      v-else-if="tool === 'automation'"
      :host-id="intent?.automationHost"
      :entry-id="intent?.entryId"
      @intent-consumed="emit('intentConsumed')"
    />
    <NetworkView
      v-else-if="tool === 'network'"
      :host-id="intent?.networkHost"
      :request-id="intent?.networkRequest"
    />
  </div>
</template>
