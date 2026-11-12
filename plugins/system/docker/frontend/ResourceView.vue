<script setup lang="ts">
import { tr } from './i18n/messages';

import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import { usePluginVisibility } from '@serverdeck/plugin-sdk/visibility';
const pluginVisible = usePluginVisibility();
const active = ref(true);
const panelVisible = computed(() => pluginVisible.value && active.value);
onActivated(() => {
  active.value = true;
});
onDeactivated(() => {
  active.value = false;
});
import { call } from '@serverdeck/plugin-sdk/platform';
import { usePlatformContext } from '@serverdeck/plugin-sdk/context';
import { invoke } from '@serverdeck/plugin-sdk';
import { openTerminal } from '@serverdeck/plugin-sdk/terminal';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import { useErrorNotifications } from '@serverdeck/plugin-sdk/composables/error-notifications';
const hostDisplayName = (host: { name: string; hostname: string } | undefined) =>
  host?.name || host?.hostname || '';
const stateLabels: Record<string, string> = {
  get connected() {
    return tr('已连接');
  },
  get idle() {
    return tr('未连接');
  },
  get connecting() {
    return tr('连接中');
  },
  get failed() {
    return tr('连接失败');
  },
};
import type { OpsRequest, OpsResponse, LogInput } from './types';
import type { PluginConfirmation } from '@serverdeck/plugin-sdk/types/plugins';
import { mutationConfirmation } from './confirmation';
import Modal from '@serverdeck/plugin-sdk/ui/Modal.vue';
import OpsTable from '@serverdeck/plugin-sdk/ui/OpsTable.vue';
import OpsDetails from './OpsDetails.vue';
import StreamDialog from '@serverdeck/plugin-sdk/ui/StreamDialog.vue';
import ImageArchiveDialog from './ImageArchiveDialog.vue';
import { Search, RefreshCw, ShieldCheck } from '@lucide/vue';

const props = defineProps<{
  hostId?: string;
  listRequest: OpsRequest;
  columns: { key: string; label: string }[];
  rowKey: string;
  sort?: string;
  hint?: string;
  searchPlaceholder?: string;
}>();
const platform = usePlatformContext();
const chosen = computed(() => props.hostId ?? platform.hostId);
const connection = computed(() => {
  const host = platform.hosts.find((h) => h.id === chosen.value);
  const state = platform.connections[chosen.value];
  return host
    ? {
        host,
        state: state?.state ?? 'idle',
        session: state?.state === 'connected' ? { id: host.id } : undefined,
      }
    : undefined;
});
const connected = computed(() => connection.value?.state === 'connected');
const rows = ref<Record<string, unknown>[]>([]),
  filter = ref(''),
  busy = ref(false);
const error = ref<string | null>(null),
  notice = ref<string | null>(null);
const detail = ref<Record<string, unknown> | null>(null),
  detailTitle = ref(''),
  detailOpen = ref(false);
const detailLoading = ref(false),
  detailError = ref<string | null>(null);
const capabilities = ref<Record<string, unknown> | null>(null);
const log = ref<{ id: string; title: string }>();
const archive = ref<{ row?: Record<string, unknown> }>();
function openArchive(row?: Record<string, unknown>) {
  if (!busy.value && !archive.value && connected.value && panelVisible.value)
    archive.value = { row };
}
let generation = 0,
  detailGeneration = 0,
  disposed = false;
function session() {
  if (!connection.value?.session || !connected.value) throw new Error(tr('请先连接主机'));
  return connection.value.session.id;
}
async function query(request: OpsRequest, confirmation?: PluginConfirmation): Promise<OpsResponse> {
  const value = await invoke<OpsResponse>(
    'query',
    { hostId: session(), request },
    confirmation ? { confirmation } : undefined,
  );
  if (!value.success)
    throw new Error(`${value.code ?? tr('操作失败')}：${value.message ?? tr('请刷新核对状态')}`);
  if (value.message) notice.value = value.message;
  return value;
}
function closeDetail() {
  ++detailGeneration;
  detail.value = null;
  detailOpen.value = false;
  detailLoading.value = false;
  detailError.value = null;
}
async function load() {
  if (!connected.value || !panelVisible.value) return;
  const token = ++generation;
  busy.value = true;
  error.value = null;
  notice.value = null;
  rows.value = [];
  try {
    const value = await query(props.listRequest);
    if (!disposed && token === generation) rows.value = value.records;
  } catch (cause) {
    if (!disposed && token === generation) error.value = errorMessage(cause);
  } finally {
    if (!disposed && token === generation) busy.value = false;
  }
}
async function inspect(request: OpsRequest, title: string) {
  if (busy.value || archive.value || !panelVisible.value) return;
  closeDetail();
  const token = ++detailGeneration,
    id = session();
  detailTitle.value = title;
  detailOpen.value = true;
  detailLoading.value = true;
  try {
    const value = await query(request);
    if (!disposed && token === detailGeneration && id === connection.value?.session?.id)
      detail.value = value.detail ?? { resources: value.records };
  } catch (cause) {
    if (!disposed && token === detailGeneration) detailError.value = errorMessage(cause);
  } finally {
    if (!disposed && token === detailGeneration) detailLoading.value = false;
  }
}
async function execute(request: OpsRequest | { kind: 'shell'; id: string }, targetName?: string) {
  if (busy.value || archive.value || !panelVisible.value) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    if (request.kind === 'shell') {
      const ticket = await invoke<{ ticket: string; hostId: string }>('shell', {
        hostId: session(),
        id: request.id,
        bash: false,
      });
      await openTerminal(ticket.ticket, ticket.hostId, {
        title: (targetName || request.id.slice(0, 12)).slice(0, 160),
        description: `${request.id.slice(0, 12)} · /bin/sh`,
      });
    } else {
      const value = await query(request, mutationConfirmation(request, targetName));
      await load();
      if (!error.value) notice.value = value.message || tr('请求完成，请核对刷新后的目标状态。');
    }
  } catch (cause) {
    if (
      !['PLUGIN_USER_CANCELLED', 'USER_CANCELLED'].includes(
        (cause as { code?: string } | null)?.code ?? '',
      )
    )
      error.value =
        errorMessage(cause) +
        (request.kind === 'compose_action' || request.kind === 'container_maintenance'
          ? tr('；操作可能部分完成，请刷新核对实际状态，勿直接重复执行。')
          : '');
    notice.value = null;
  } finally {
    busy.value = false;
  }
}
watch(
  [() => connection.value?.session?.id, () => connection.value?.state],
  async () => {
    closeDetail();
    log.value = undefined;
    ++generation;
    rows.value = [];
    capabilities.value = null;
    if (!connected.value || !panelVisible.value) return;
    const id = session();
    try {
      const value = await query({ kind: 'capabilities' });
      if (id !== connection.value?.session?.id || disposed) return;
      capabilities.value = value.detail;
      await load();
    } catch (cause) {
      if (!disposed) error.value = errorMessage(cause);
    }
  },
  { immediate: true },
);
watch(
  () => JSON.stringify(props.listRequest),
  () => {
    filter.value = '';
    closeDetail();
    log.value = undefined;
    void load();
  },
);
function visibility() {
  ++generation;
  closeDetail();
  log.value = undefined;
  busy.value = false;
  if (panelVisible.value) void load();
}
watch(panelVisible, visibility);
onBeforeUnmount(() => {
  disposed = true;
  ++generation;
  closeDetail();
});
useErrorNotifications(() => [error.value, detailError.value]);
const slotContext = {
  inspect,
  execute,
  query,
  openExport: openArchive,
  openLog: async (input: LogInput, title: string) => {
    if (busy.value || !panelVisible.value) return;
    const token = generation;
    busy.value = true;
    try {
      const stream = await invoke<{ id: string }>('logs', { hostId: session(), ...input });
      if (!disposed && token === generation && panelVisible.value)
        log.value = { id: stream.id, title };
      else {
        try {
          await call({ kind: 'stream_stop', streamId: stream.id });
        } catch (cause) {
          if (
            ['NOT_FOUND', 'PLUGIN_CANCELLED', 'PLUGIN_PERMISSION_DENIED'].includes(
              (cause as { code?: string } | null)?.code ?? '',
            )
          )
            return;
          console.error(
            'Docker late log stream cleanup failed',
            (cause as { code?: string } | null)?.code ?? 'UNKNOWN',
          );
          throw cause;
        }
      }
    } catch (cause) {
      if (
        !disposed &&
        token === generation &&
        !['USER_CANCELLED', 'PLUGIN_USER_CANCELLED'].includes(
          (cause as { code?: string } | null)?.code ?? '',
        )
      )
        error.value = errorMessage(cause);
    } finally {
      if (!disposed && token === generation) busy.value = false;
    }
  },
  openShell: (id: string, name?: string) => {
    if (connected.value && panelVisible.value && connection.value)
      void execute({ kind: 'shell', id }, name);
  },
};
</script>
<template>
  <section class="operations-view" :aria-label="tr('主机运维工作区')">
    <p class="ops-connection-status" role="status">
      {{ hostDisplayName(connection?.host) || tr('当前主机尚未连接') }} ·
      {{ stateLabels[connection?.state ?? 'idle'] ?? connection?.state }}
    </p>
    <p v-if="notice" class="banner success" role="status">{{ notice }}</p>
    <p v-if="error" class="banner error" role="alert">{{ error }}</p>
    <template v-if="connected">
      <slot name="summary" :rows="rows" :loading="busy" :error="error" />
      <div v-if="capabilities" class="ops-capabilities">
        <slot name="capabilities" :value="capabilities" />
        <button
          class="text-button"
          @click="
            closeDetail();
            detail = capabilities;
            detailTitle = tr('Docker信息');
            detailOpen = true;
          "
        >
          {{ tr(' Docker信息 ') }}
        </button>
      </div>
      <div class="ops-toolbar">
        <label class="ops-search"
          ><Search :size="15" aria-hidden="true" /><input
            v-model="filter"
            :aria-label="tr('运维项目搜索')"
            :placeholder="searchPlaceholder ?? tr('搜索名称、镜像、状态或端口…')"
        /></label>
        <slot name="toolbar" :execute="execute" :busy="busy || !!archive" />
        <button class="button" :disabled="busy || !!archive" @click="load">
          <RefreshCw :size="14" aria-hidden="true" />{{ busy ? tr('正在读取…') : tr('刷新') }}
        </button>
        <slot name="toolbar-after" :busy="busy || !!archive" :open-import="() => openArchive()" />
        <span v-if="hint" class="subtle">{{ hint }}</span>
      </div>
      <OpsTable
        :rows="rows"
        :loading="busy"
        :columns="columns"
        :filter="filter"
        :row-key="rowKey"
        :sort="sort"
      >
        <template #cell="context"
          ><slot name="cell" v-bind="context">{{
            context.row[context.column.key] ?? tr('不可用')
          }}</slot></template
        >
        <template #actions="{ row }"
          ><slot name="actions" v-bind="slotContext" :row="row" :busy="busy || !!archive"
        /></template>
      </OpsTable>
      <Modal v-if="detailOpen" :title="detailTitle" wide :busy="busy" @close="closeDetail">
        <div class="ops-detail-content" :aria-busy="detailLoading">
          <p v-if="detailLoading" class="host-empty" role="status">{{ tr('正在读取详情…') }}</p>
          <p v-else-if="detailError" class="banner error" role="alert">{{ detailError }}</p>
          <template v-else-if="detail">
            <slot name="detail-content" v-bind="slotContext" :detail="detail">
              <slot name="detail" v-bind="slotContext" :detail="detail" />
              <OpsDetails :detail="detail" />
            </slot>
          </template>
        </div>
      </Modal>
    </template>
    <p v-else class="host-empty">{{ tr('请选择主机并建立运维连接后查看。') }}</p>
    <footer class="ops-footer">
      <span class="subtle"
        ><ShieldCheck :size="13" aria-hidden="true" />{{
          tr('当前 SSH 账号执行 · 不自动提权')
        }}</span
      >
    </footer>
    <StreamDialog v-if="log" :stream-id="log.id" :title="log.title" @close="log = undefined" />
    <ImageArchiveDialog
      v-if="archive"
      :host-id="chosen"
      :host-label="`${hostDisplayName(connection?.host)} (${connection?.host.hostname ?? ''})`"
      :row="archive.row"
      :visible="panelVisible && connected"
      @close="archive = undefined"
      @completed="load"
    />
  </section>
</template>
