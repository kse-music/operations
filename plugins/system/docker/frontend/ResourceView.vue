<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { usePluginVisibility } from '@serverdeck/plugin-sdk/visibility';
const panelVisible = usePluginVisibility();
import { usePlatformContext } from '@serverdeck/plugin-sdk/context';
import { invoke } from '@serverdeck/plugin-sdk';
import { openTerminal } from '@serverdeck/plugin-sdk/terminal';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import { useErrorNotifications } from '@serverdeck/plugin-sdk/composables/error-notifications';
const hostDisplayName = (host: { name: string; hostname: string } | undefined) =>
  host?.name || host?.hostname || '';
const stateLabels: Record<string, string> = {
  connected: '已连接',
  idle: '未连接',
  connecting: '连接中',
  failed: '连接失败',
};
import type { OpsRequest, OpsResponse, ContainerShell, LogInput } from './types';
import Modal from '@serverdeck/plugin-sdk/ui/Modal.vue';
import OpsTable from '@serverdeck/plugin-sdk/ui/OpsTable.vue';
import OpsDetails from './OpsDetails.vue';
import StreamDialog from '@serverdeck/plugin-sdk/ui/StreamDialog.vue';
import { Search, RefreshCw, ShieldCheck } from '@lucide/vue';

const props = defineProps<{
  hostId?: string;
  listRequest: OpsRequest;
  columns: { key: string; label: string }[];
  rowKey: string;
  sort?: string;
  hint?: string;
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
const pending = ref<{
  title: string;
  target: string;
  request?: OpsRequest;
  shell?: ContainerShell;
  inspect: boolean;
  sessionId: string;
} | null>(null);
const confirmedTarget = ref('');
const log = ref<{ id: string; title: string }>();
const probe = ref(false),
  probeTarget = ref(''),
  probePort = ref(80),
  probeLocation = ref<'local' | 'remote'>('remote');
let generation = 0,
  detailGeneration = 0,
  disposed = false;
function session() {
  if (!connection.value?.session || !connected.value) throw new Error('请先连接主机');
  return connection.value.session.id;
}
async function query(request: OpsRequest): Promise<OpsResponse> {
  const value = await invoke<OpsResponse>('query', { hostId: session(), request });
  if (!value.success)
    throw new Error(`${value.code ?? '操作失败'}：${value.message ?? '请刷新核对状态'}`);
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
function ask(
  title: string,
  target: string,
  request?: OpsRequest,
  shell?: ContainerShell,
  asDetail = false,
) {
  if (busy.value || !panelVisible.value) return;
  const action = { title, target, request, shell, inspect: asDetail, sessionId: session() };
  if (request?.kind === 'image_remove') {
    void execute(action);
    return;
  }
  pending.value = action;
  confirmedTarget.value = '';
}
async function apply() {
  const action = pending.value;
  if (!action || confirmedTarget.value !== action.target) return;
  await execute(action);
}
async function execute(action: NonNullable<typeof pending.value>) {
  if (action.sessionId !== connection.value?.session?.id) {
    error.value = '主机上下文已变化，请重新选择目标';
    pending.value = null;
    return;
  }
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    if (action.shell && connection.value) {
      const ticket = await invoke<{ ticket: string; hostId: string }>('shell', {
        hostId: session(),
        id: action.shell.id,
        bash: action.shell.bash,
      });
      await openTerminal(ticket.ticket, ticket.hostId);
    } else if (action.request && action.inspect) await inspect(action.request, action.title);
    else if (action.request) {
      await query(action.request);
      notice.value = '请求完成，请核对刷新后的目标状态。';
      await load();
    }
    pending.value = null;
  } catch (cause) {
    if (
      !['PLUGIN_USER_CANCELLED', 'USER_CANCELLED'].includes(
        (cause as { code?: string } | null)?.code ?? '',
      )
    )
      error.value = errorMessage(cause);
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
  pending.value = null;
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
  ask,
  query,
  openLog: async (input: LogInput, title: string) => {
    try {
      const stream = await invoke<{ id: string }>('logs', { hostId: session(), ...input });
      if (panelVisible.value) log.value = { id: stream.id, title };
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  },
  openShell: (id: string) => {
    if (connected.value && panelVisible.value && connection.value)
      ask('打开容器终端', id, undefined, { id, bash: false, confirmed: false });
  },
};
</script>
<template>
  <section class="operations-view" aria-label="主机运维工作区">
    <p class="ops-connection-status" role="status">
      {{ hostDisplayName(connection?.host) || '当前主机尚未连接' }} ·
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
            detailTitle = '主机能力与版本';
            detailOpen = true;
          "
        >
          版本 / 能力详情
        </button>
        <button class="text-button" @click="probe = !probe">TCP 连通性检测</button>
      </div>
      <div class="ops-toolbar">
        <label class="ops-search"
          ><Search :size="15" aria-hidden="true" /><input
            v-model="filter"
            aria-label="运维项目搜索"
            placeholder="搜索名称、镜像、状态或端口…"
        /></label>
        <slot name="toolbar" />
        <button class="button" :disabled="busy" @click="load">
          <RefreshCw :size="14" aria-hidden="true" />{{ busy ? '正在读取…' : '刷新运维列表' }}
        </button>
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
            context.row[context.column.key] ?? '不可用'
          }}</slot></template
        >
        <template #actions="{ row }"
          ><slot name="actions" v-bind="slotContext" :row="row" :busy="busy"
        /></template>
      </OpsTable>
      <Modal v-if="detailOpen" :title="detailTitle" wide :busy="busy" @close="closeDetail">
        <div class="ops-detail-content" :aria-busy="detailLoading">
          <p v-if="detailLoading" class="host-empty" role="status">正在读取详情…</p>
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
    <p v-else class="host-empty">请选择主机并建立运维连接后查看。</p>
    <footer class="ops-footer">
      <span class="subtle"
        ><ShieldCheck :size="13" aria-hidden="true" />当前 SSH 账号执行 · 不自动提权</span
      >
    </footer>
    <StreamDialog v-if="log" :stream-id="log.id" :title="log.title" @close="log = undefined" />
    <Modal v-if="probe" title="TCP 连通性检测" @close="probe = false">
      <div class="ops-toolbar">
        <select v-model="probeLocation" aria-label="检测位置">
          <option value="remote">从远端主机</option>
          <option value="local">从本地设备</option></select
        ><input v-model="probeTarget" aria-label="连通性目标" placeholder="IP / 域名" /><input
          v-model.number="probePort"
          type="number"
          min="1"
          max="65535"
          aria-label="连通性端口"
        /><button
          class="button"
          :disabled="busy"
          @click="
            probe = false;
            inspect(
              { kind: 'probe', location: probeLocation, target: probeTarget, port: probePort },
              'TCP 连通性结果',
            );
          "
        >
          检测 TCP 端口
        </button>
      </div>
    </Modal>
    <Modal v-if="pending" title="确认主机运维操作" :busy="busy" @close="pending = null">
      <p>{{ pending.title }}</p>
      <p>
        主机：{{ hostDisplayName(connection?.host) }} · {{ connection?.host.hostname }} · 账号
        {{ connection?.host.username }}
      </p>
      <code>{{ pending.target }}</code>
      <p>操作可能中断业务。不会自动提权或强制删除；超时后请刷新核对，勿盲目重复。</p>
      <label
        >输入完整目标以确认<input
          v-model="confirmedTarget"
          aria-label="确认运维目标"
          autocomplete="off"
      /></label>
      <label v-if="pending.shell"
        ><input v-model="pending.shell.bash" type="checkbox" />使用 /bin/bash（默认 /bin/sh）</label
      >
      <footer class="dialog-actions">
        <button class="button" :disabled="busy" @click="pending = null">取消</button
        ><button
          class="button danger"
          :disabled="busy || confirmedTarget !== pending.target"
          @click="apply"
        >
          确认执行
        </button>
      </footer>
    </Modal>
  </section>
</template>
