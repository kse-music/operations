<script setup lang="ts">
import { useErrorNotifications } from '@serverdeck/plugin-sdk/composables/error-notifications';
import { usePluginVisibility } from '@serverdeck/plugin-sdk/visibility';
import { computed, inject, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useHostsStore } from '@serverdeck/plugin-sdk/stores/hosts';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import { opsApi } from '@serverdeck/plugin-sdk/services/ops';
import { pluginServerServices } from '@serverdeck/plugin-sdk/services/plugin-server-surface';
const surface = inject(pluginServerServices, null);
const api = surface?.operations ?? opsApi;
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type {
  OpsRequest,
  OpsResponse,
  Scope,
  ContainerAction,
  ServiceAction,
  ProcessSignal,
  LogInput,
  ContainerShell,
  Feedback,
} from '@serverdeck/plugin-sdk/types/ops';
import { pidPorts } from '@serverdeck/plugin-sdk/services/product-links';
import { hostDisplayName, type Host } from '@serverdeck/plugin-sdk/types/hosts';
import { stateLabels } from '@serverdeck/plugin-sdk/types/terminal';
import Modal from '@serverdeck/plugin-sdk/ui/Modal.vue';
import OpsDetails from '@serverdeck/plugin-sdk/ui/OpsDetails.vue';
import type { OperationsSection } from '@serverdeck/plugin-sdk/types/server';
import OpsTable from '@serverdeck/plugin-sdk/ui/OpsTable.vue';
import ResourceLogDialog from '@serverdeck/plugin-sdk/ui/ResourceLogDialog.vue';
const props = defineProps<{
  hostId?: string;
  initialTab?: OperationsSection;
}>();
const emit = defineEmits<{
  section: [value: NonNullable<typeof props.initialTab>];
  shell: [host: Host, shell: ContainerShell];
}>();
const hosts = useHostsStore(),
  ops = useOpsStore();
const chosen = computed(() => props.hostId ?? hosts.selectedId ?? ''),
  tab = ref<Exclude<OperationsSection, 'logs'>>(
    props.initialTab === 'logs' ? 'services' : (props.initialTab ?? 'containers'),
  ),
  scope = ref<Scope>('system'),
  filter = ref(''),
  rows = ref<Record<string, unknown>[]>([]),
  capabilities = ref<Record<string, unknown> | null>(null),
  error = ref<string | null>(null),
  notice = ref<string | null>(null),
  busy = ref(false),
  detail = ref<Record<string, unknown> | null>(null),
  detailTitle = ref(''),
  history = ref<Feedback[]>([]);
const log = ref<{ input: LogInput; title: string; sessionId: string }>();
watch(usePluginVisibility(), (visible) => {
  if (!visible) log.value = undefined;
});
const pending = ref<{
    title: string;
    target: string;
    request?: OpsRequest;
    shell?: ContainerShell;
    reveal?: string;
    sessionId: string;
  } | null>(null),
  confirmedTarget = ref('');
const processDetail = ref<{ pid: number; startTicks: string; bootId: string } | null>(null),
  signal = ref<ProcessSignal>('TERM');
const probe = ref(false),
  probeTarget = ref('127.0.0.1'),
  probePort = ref(22),
  probeLocation = ref<'local' | 'remote'>('remote');
const detailOpen = ref(false),
  detailLoading = ref(false),
  detailError = ref<string | null>(null),
  historyOpen = ref(false);
let detailGeneration = 0;
function closeDetail() {
  ++detailGeneration;
  detailOpen.value = false;
  detailLoading.value = false;
  detail.value = null;
  processDetail.value = null;
  processPorts.value = null;
  detailError.value = null;
}
const processPorts = ref<Record<string, unknown>[] | null>(null);
watch(
  () => props.initialTab,
  (value) => {
    if (value && value !== 'logs') tab.value = value;
  },
);
watch(tab, (value) => emit('section', value));
const connection = computed(() => ops.connections[chosen.value]),
  connected = computed(() => connection.value?.state === 'connected' && !!connection.value.session);
let generation = 0;
const columns = computed(
  () =>
    ({
      containers: [
        { key: 'Names', label: '名称' },
        { key: 'Image', label: '镜像' },
        { key: 'State', label: '状态' },
        { key: 'Status', label: '运行时间 / 状态' },
        { key: 'Ports', label: '端口' },
      ],
      images: [
        { key: 'Repository', label: '仓库' },
        { key: 'Tag', label: '标签' },
        { key: 'ID', label: '镜像 ID' },
        { key: 'Size', label: '大小' },
        { key: 'CreatedSince', label: '创建时间' },
      ],
      processes: [
        { key: 'pid', label: 'PID' },
        { key: 'user', label: '用户' },
        { key: 'cpu', label: 'CPU %' },
        { key: 'memory', label: '内存 %' },
        { key: 'elapsed', label: '运行秒数' },
        { key: 'command', label: '命令名称' },
      ],
      ports: [
        { key: 'protocol', label: '协议' },
        { key: 'state', label: '状态' },
        { key: 'local', label: '监听地址' },
        { key: 'peer', label: '对端' },
        { key: 'process', label: '进程（权限允许时）' },
      ],
      services: [
        { key: 'unit', label: '服务' },
        { key: 'load', label: '加载' },
        { key: 'active', label: '状态' },
        { key: 'sub', label: '子状态' },
        { key: 'enabled', label: '开机自启' },
        { key: 'description', label: '说明' },
      ],
    })[tab.value],
);
const rowKey = computed(
  () =>
    ({
      containers: 'ID',
      images: 'ID',
      processes: 'pid',
      ports: 'local',
      services: 'unit',
    })[tab.value],
);
function session(): string {
  if (!connection.value?.session) throw new Error('请先连接主机');
  return connection.value.session.id;
}
async function query(request: OpsRequest): Promise<OpsResponse> {
  const result = await api.query(session(), request);
  if (!result.success)
    throw new Error(`${result.code ?? '操作失败'}：${result.message ?? '请刷新核对状态'}`);
  if (result.message) notice.value = result.message;
  return result;
}
async function load(): Promise<void> {
  if (!connected.value) return;
  const token = ++generation;
  busy.value = true;
  error.value = null;
  rows.value = [];
  try {
    const request: OpsRequest =
      tab.value === 'services' ? { kind: 'services', scope: scope.value } : { kind: tab.value };
    const result = await query(request);
    if (token === generation) rows.value = result.records;
  } catch (cause) {
    if (token === generation) error.value = errorMessage(cause);
  } finally {
    if (token === generation) busy.value = false;
  }
}
async function ready(): Promise<void> {
  if (!connected.value) return;
  try {
    const id = session();
    const value = await query({ kind: 'capabilities' });
    if (id !== connection.value?.session?.id) return;
    capabilities.value = value.detail;
    await load();
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
watch(
  () => [connection.value?.session?.id, connection.value?.state],
  () => {
    closeDetail();
    if (connected.value) void ready();
    else {
      ++generation;
      rows.value = [];
      capabilities.value = null;
      detail.value = null;
      processDetail.value = null;
    }
  },
  { immediate: true },
);
watch([tab, scope], () => {
  filter.value = '';
  closeDetail();
  void load();
});
async function connect(): Promise<void> {
  error.value = null;
  const host = hosts.catalog?.hosts.find((h) => h.id === chosen.value);
  if (!host) return;
  try {
    await ops.open(host);
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
async function inspect(request: OpsRequest, title: string): Promise<void> {
  closeDetail();
  const token = ++detailGeneration;
  detailTitle.value = title;
  detailOpen.value = true;
  detailLoading.value = true;
  try {
    const id = session();
    const result = await query(request);
    if (token !== detailGeneration || id !== connection.value?.session?.id) return;
    detail.value = result.detail ?? { resources: result.records };
    if (request.kind === 'process_details')
      processDetail.value = {
        pid: Number(detail.value.pid),
        startTicks: String(detail.value.startTicks),
        bootId: String(detail.value.bootId),
      };
  } catch (cause) {
    if (token === detailGeneration) detailError.value = errorMessage(cause);
  } finally {
    if (token === detailGeneration) detailLoading.value = false;
  }
}
function ask(
  title: string,
  target: string,
  request?: OpsRequest,
  shell?: ContainerShell,
  reveal?: string,
): void {
  pending.value = { title, target, request, shell, reveal, sessionId: session() };
  confirmedTarget.value = '';
}
function container(action: ContainerAction, id: string): void {
  ask(`容器 ${action}`, id, { kind: 'container_action', id, action, confirmed: true });
}
function service(action: ServiceAction, unit: string): void {
  ask(`服务 ${action} · ${scope.value === 'user' ? '当前用户' : '系统'}`, unit, {
    kind: 'service_action',
    scope: scope.value,
    unit,
    action,
    confirmed: true,
  });
}
async function apply(): Promise<void> {
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
    if (action.shell) {
      const host = connection.value?.host;
      if (host) emit('shell', host, action.shell);
    } else if (action.reveal) {
      await inspect(
        { kind: 'container_details', id: action.reveal, revealEnv: true, confirmed: true },
        '容器详情 · 环境变量已显式显示',
      );
    } else if (action.request) {
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
      history.value = await api.feedback();
    } catch (cause) {
      if (!error.value) error.value = errorMessage(cause);
    }
    busy.value = false;
  }
}
async function openLog(input: LogInput, title: string): Promise<void> {
  log.value = { input, title, sessionId: session() };
}
watch([tab, () => connection.value?.session?.id], () => {
  log.value = undefined;
});
async function disconnect(): Promise<void> {
  try {
    await ops.close(chosen.value);
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
async function runProbe(): Promise<void> {
  probe.value = false;
  await inspect(
    {
      kind: 'probe',
      location: probeLocation.value,
      target: probeTarget.value,
      port: probePort.value,
    },
    'TCP 连通性结果',
  );
}
let healthTimer: ReturnType<typeof setInterval> | undefined;
onBeforeUnmount(() => {
  clearInterval(healthTimer);
  ++generation;
  closeDetail();
});
onMounted(async () => {
  healthTimer = setInterval(
    () =>
      void ops.sync().catch((cause) => {
        error.value = errorMessage(cause);
      }),
    2000,
  );
  if (props.hostId && !surface) await connect();
  try {
    history.value = await api.feedback();
  } catch (cause) {
    error.value = errorMessage(cause);
  }
});
async function relatedPorts() {
  if (!processDetail.value) return;
  const id = session(),
    pid = processDetail.value.pid;
  try {
    const result = await query({ kind: 'ports' });
    if (id === connection.value?.session?.id && pid === processDetail.value?.pid)
      processPorts.value = pidPorts(result.records, pid);
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
useErrorNotifications(() => [error.value, detailError.value]);
</script>
<template>
  <section class="operations-view" aria-label="主机运维工作区">
    <div v-if="!surface" class="ops-toolbar">
      <button class="button primary" :disabled="!chosen || busy || connected" @click="connect">
        {{ connected ? '运维已连接' : '连接运维' }}</button
      ><button class="button" :disabled="!connected" @click="disconnect">断开运维连接</button>
    </div>
    <p class="ops-connection-status" role="status">
      {{
        hostDisplayName(connection?.host) ||
        (chosen ? '当前主机尚未连接' : '请在主机管理中打开远程主机')
      }}
      ·
      {{ stateLabels[connection?.state ?? 'idle'] ?? connection?.state }}
    </p>

    <div v-if="notice" role="status" class="banner success">{{ notice }}</div>
    <template v-if="connected"
      ><div v-if="capabilities" class="ops-capabilities">
        <span
          >Docker：{{
            capabilities.dockerState === 'running'
              ? '可用'
              : capabilities.dockerInstalled
                ? '已安装，Daemon 不可用或权限不足'
                : '未安装'
          }}</span
        ><span>systemd：{{ capabilities.systemd ? '可用' : '不支持' }}</span
        ><button
          class="text-button"
          @click="
            closeDetail();
            detail = capabilities;
            detailTitle = '主机能力与 Docker 版本';
            detailOpen = true;
          "
        >
          版本 / 能力详情</button
        ><button class="text-button" @click="probe = !probe">TCP 连通性检测</button>
      </div>
      <div class="ops-toolbar">
        <input
          v-model="filter"
          aria-label="运维项目搜索"
          placeholder="搜索名称、PID、端口…"
        /><select v-if="tab === 'services'" v-model="scope" aria-label="systemd 范围">
          <option value="system">系统服务</option>
          <option value="user">当前用户服务</option></select
        ><button class="button" :disabled="busy" @click="load">
          {{ busy ? '正在读取…' : '刷新运维列表' }}</button
        ><span v-if="tab === 'processes'" class="subtle"
          >CPU 为 ps 进程生命周期均值；点击 CPU / 内存标题排序。默认不读取命令参数或环境。</span
        ><span v-if="tab === 'ports'" class="subtle">未获权限的关联进程显示不可用。</span>
      </div>
      <OpsTable
        :key="tab"
        :rows="rows"
        :loading="busy"
        :columns="columns"
        :filter="filter"
        :row-key="rowKey"
        :sort="tab === 'processes' ? 'cpu' : undefined"
        ><template #actions="{ row }"
          ><template v-if="tab === 'containers'"
            ><button
              class="text-button"
              :disabled="busy"
              @click="
                inspect(
                  {
                    kind: 'container_details',
                    id: String(row.ID),
                    revealEnv: false,
                    confirmed: false,
                  },
                  '容器详情',
                )
              "
            >
              详情</button
            ><button
              class="text-button"
              :disabled="busy"
              @click="inspect({ kind: 'container_stats', id: String(row.ID) }, '容器资源使用')"
            >
              资源</button
            ><button
              v-for="action in ['start', 'stop', 'restart', 'remove'] as const"
              :key="action"
              class="text-button"
              :disabled="busy"
              @click="container(action, String(row.ID))"
            >
              {{ { start: '启动', stop: '停止', restart: '重启', remove: '删除' }[action] }}</button
            ><button
              class="text-button"
              @click="
                openLog(
                  { source: { kind: 'container', id: String(row.ID) }, lines: 200, follow: true },
                  String(row.Names),
                )
              "
            >
              日志</button
            ><button
              class="text-button"
              @click="
                connection &&
                emit('shell', connection.host, {
                  id: String(row.ID),
                  bash: false,
                  confirmed: false,
                })
              "
            >
              Shell
            </button></template
          >
          <button
            v-else-if="tab === 'images'"
            class="text-button"
            :disabled="busy"
            @click="
              ask('删除镜像（不强制、不删除卷）', String(row.ID), {
                kind: 'image_remove',
                id: String(row.ID),
                confirmed: true,
              })
            "
          >
            删除镜像
          </button>
          <button
            v-else-if="tab === 'processes'"
            class="text-button"
            :disabled="busy"
            @click="inspect({ kind: 'process_details', pid: Number(row.pid) }, '进程详情')"
          >
            进程详情 / 信号
          </button>
          <template v-else-if="tab === 'services'"
            ><button
              class="text-button"
              :disabled="busy"
              @click="
                inspect({ kind: 'service_details', scope, unit: String(row.unit) }, '服务详情')
              "
            >
              详情</button
            ><button
              v-for="action in ['start', 'stop', 'restart', 'enable', 'disable'] as const"
              :key="action"
              class="text-button"
              :disabled="busy"
              @click="service(action, String(row.unit))"
            >
              {{
                {
                  start: '启动',
                  stop: '停止',
                  restart: '重启',
                  enable: '启用自启',
                  disable: '禁用自启',
                }[action]
              }}</button
            ><button
              class="text-button"
              @click="
                openLog(
                  {
                    source: { kind: 'service', scope, unit: String(row.unit) },
                    lines: 200,
                    follow: true,
                  },
                  String(row.unit),
                )
              "
            >
              服务日志
            </button></template
          ></template
        ></OpsTable
      >
      <ResourceLogDialog
        v-if="log"
        :session-id="log.sessionId"
        :input="log.input"
        :title="log.title"
        @close="log = undefined"
      />
      <Modal v-if="detailOpen" :title="detailTitle" wide :busy="busy" @close="closeDetail">
        <div class="ops-detail-content" :aria-busy="detailLoading">
          <p v-if="detailLoading" class="host-empty" role="status">正在读取详情…</p>
          <p v-else-if="detailError" class="banner error" role="alert">{{ detailError }}</p>
          <template v-else-if="detail">
            <p v-if="detail.environmentRevealed" class="banner error">
              敏感环境值正在显示，离开详情即清除；不会记录到操作历史。
            </p>
            <button
              v-if="detail.environment && !detail.environmentRevealed"
              class="button"
              @click="
                ask(
                  '显式显示容器环境变量',
                  String(detail.id),
                  undefined,
                  undefined,
                  String(detail.id),
                )
              "
            >
              显示环境变量值…
            </button>
            <div v-if="processDetail" class="ops-toolbar">
              <span>PID {{ processDetail.pid }}</span
              ><button class="button" @click="relatedPorts">查看关联监听端口</button
              ><select v-model="signal" aria-label="进程信号">
                <option>TERM</option>
                <option>KILL</option>
                <option>INT</option>
                <option>HUP</option></select
              ><button
                class="button danger"
                @click="
                  ask(`向 PID ${processDetail.pid} 发送 ${signal}`, String(processDetail.pid), {
                    kind: 'signal',
                    ...processDetail,
                    signal,
                    confirmed: true,
                  })
                "
              >
                发送信号…
              </button>
            </div>
            <section v-if="processPorts" aria-label="进程关联端口">
              <p class="subtle">只显示 ss 明确报告此 PID 的监听项；权限不足时可能没有关联信息。</p>
              <OpsTable
                :rows="processPorts"
                :columns="[
                  { key: 'protocol', label: '协议' },
                  { key: 'local', label: '地址' },
                  { key: 'process', label: '进程' },
                ]"
                row-key="local"
                filter=""
              />
            </section>
            <OpsDetails :detail="detail" />
          </template>
        </div>
      </Modal>
    </template>
    <p v-else class="host-empty">从主机管理连接后，查看真实 Docker、进程、端口、服务和指定日志。</p>
    <footer class="ops-footer">
      <span class="subtle">当前 SSH 账号执行 · 不自动提权</span
      ><button class="text-button" @click="historyOpen = true">操作反馈</button>
    </footer>
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
        /><button class="button" :disabled="busy" @click="runProbe">检测 TCP 端口</button>
      </div>
    </Modal>
    <Modal v-if="historyOpen" title="本次操作反馈" wide @close="historyOpen = false">
      <p class="subtle">仅记录目标与结果，不记录输出。</p>
      <p
        v-for="(event, index) in history.filter((e) => e.hostId === connection?.host.id)"
        :key="index"
      >
        {{ new Date(event.at).toLocaleTimeString() }} · {{ event.operation }} · {{ event.target }} ·
        {{ event.outcome }}
      </p>
      <p v-if="!history.some((e) => e.hostId === connection?.host.id)" class="host-empty">
        当前主机暂无操作记录。
      </p>
    </Modal>
    <Modal v-if="pending" title="确认主机运维操作" :busy="busy" @close="pending = null"
      ><p>{{ pending.title }}</p>
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
          autocomplete="off" /></label
      ><label v-if="pending.shell"
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
      </footer></Modal
    >
    <Modal v-if="connection?.trust" title="确认运维主机指纹" @close="ops.trust(false, chosen)"
      ><p>请通过可信渠道核对指纹后接受。</p>
      <p>
        {{ connection.trust.hostname }}:{{ connection.trust.port }} ·
        {{ connection.trust.algorithm }}
      </p>
      <code>{{ connection.trust.fingerprint }}</code>
      <footer class="dialog-actions">
        <button class="button" @click="ops.trust(false, chosen)">拒绝</button
        ><button class="button primary" @click="ops.trust(true, chosen)">信任并连接运维</button>
      </footer></Modal
    >
  </section>
</template>
