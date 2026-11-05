<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePluginVisibility } from '../visibility';
const panelVisible = usePluginVisibility();
import { useOpsStore } from '../stores/ops';
import { useHostsStore } from '../stores/hosts';
import { opsApi } from '../services/ops';
import { errorMessage } from '../services/ipc';
import { useErrorNotifications } from '../composables/error-notifications';
import { hostDisplayName } from '../types/hosts';
import { stateLabels } from '../types/terminal';
import type { OpsRequest, OpsResponse, ContainerShell, Feedback, LogInput } from '../types/ops';
import type { Host } from '../types/hosts';
import Modal from './Modal.vue';
import OpsTable from './OpsTable.vue';
import OpsDetails from './OpsDetails.vue';
import ResourceLogDialog from './ResourceLogDialog.vue';
import { Search, RefreshCw, ShieldCheck } from '@lucide/vue';

const props = defineProps<{
  hostId?: string;
  listRequest: OpsRequest;
  columns: { key: string; label: string }[];
  rowKey: string;
  sort?: string;
  hint?: string;
}>();
const emit = defineEmits<{
  shell: [host: Host, value: ContainerShell];
}>();
const ops = useOpsStore(),
  hosts = useHostsStore();
const chosen = computed(() => props.hostId ?? hosts.selectedId);
const connection = computed(() => ops.connections[chosen.value]);
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
const history = ref<Feedback[]>([]),
  historyOpen = ref(false);
const pending = ref<{
  title: string;
  target: string;
  request?: OpsRequest;
  shell?: ContainerShell;
  inspect: boolean;
  sessionId: string;
} | null>(null);
const confirmedTarget = ref('');
const log = ref<{ input: LogInput; title: string; sessionId: string }>();
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
  const value = await opsApi.query(session(), request);
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
  pending.value = { title, target, request, shell, inspect: asDetail, sessionId: session() };
  confirmedTarget.value = '';
}
async function apply() {
  const action = pending.value;
  if (!action || confirmedTarget.value !== action.target) return;
  if (action.sessionId !== connection.value?.session?.id) {
    error.value = '主机上下文已变化，请重新选择目标';
    pending.value = null;
    return;
  }
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    if (action.shell && connection.value) emit('shell', connection.value.host, action.shell);
    else if (action.request && action.inspect) await inspect(action.request, action.title);
    else if (action.request) {
      await query(action.request);
      notice.value = '请求完成，请核对刷新后的目标状态。';
      await load();
    }
    pending.value = null;
  } catch (cause) {
    error.value = errorMessage(cause);
    notice.value = null;
  } finally {
    try {
      history.value = await opsApi.feedback();
    } catch (cause) {
      if (!error.value) error.value = errorMessage(cause);
    }
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
onMounted(async () => {
  try {
    history.value = await opsApi.feedback();
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause);
  }
});
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
  openLog: (input: LogInput, title: string) => {
    log.value = { input, title, sessionId: session() };
  },
  openShell: (id: string) => {
    if (connected.value && panelVisible.value && connection.value)
      emit('shell', connection.value.host, { id, bash: false, confirmed: false });
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
            placeholder="搜索名称、PID、端口…"
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
            <slot name="detail" v-bind="slotContext" :detail="detail" />
            <OpsDetails :detail="detail" />
          </template>
        </div>
      </Modal>
    </template>
    <p v-else class="host-empty">请选择主机并建立运维连接后查看。</p>
    <footer class="ops-footer">
      <span class="subtle"
        ><ShieldCheck :size="13" aria-hidden="true" />当前 SSH 账号执行 · 不自动提权</span
      ><button class="text-button" @click="historyOpen = true">操作反馈</button>
    </footer>
    <ResourceLogDialog
      v-if="log"
      :session-id="log.sessionId"
      :input="log.input"
      :title="log.title"
      @close="log = undefined"
    />
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
    <Modal v-if="historyOpen" title="本次操作反馈" wide @close="historyOpen = false">
      <p class="subtle">仅记录目标与结果，不记录输出。</p>
      <p
        v-for="(entry, index) in history.filter((e) => e.hostId === connection?.host.id)"
        :key="index"
      >
        {{ new Date(entry.at).toLocaleTimeString() }} · {{ entry.operation }} · {{ entry.target }} ·
        {{ entry.outcome }}
      </p>
      <p v-if="!history.some((e) => e.hostId === connection?.host.id)" class="host-empty">
        当前主机暂无操作记录。
      </p>
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
