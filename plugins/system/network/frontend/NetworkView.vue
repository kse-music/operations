<script setup lang="ts">
import { clipboardApi } from '@serverdeck/plugin-sdk/services/clipboard';
import { useErrorNotifications } from '@serverdeck/plugin-sdk/composables/error-notifications';
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useHostsStore } from '@serverdeck/plugin-sdk/stores/hosts';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import TaskConnections from '@serverdeck/plugin-sdk/ui/TaskConnections.vue';
import { downloadResult } from '@serverdeck/plugin-sdk/services/tasks';
import { useTasksApi } from '@serverdeck/plugin-sdk/services/plugin-tool-services';
const tasksApi = useTasksApi();
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import { type Diagnostic, type Tool, taskLabels, active } from '@serverdeck/plugin-sdk/types/tasks';
import { hostDisplayName } from '@serverdeck/plugin-sdk/types/hosts';
const props = defineProps<{ hostId?: string; requestId?: number }>();
const hosts = useHostsStore(),
  ops = useOpsStore(),
  host = ref(props.hostId ?? ''),
  source = ref('local');
const contextHost = hosts.catalog?.hosts.find((h) => h.id === props.hostId);
const tool = ref<Tool>(contextHost ? 'tcp' : 'ping'),
  target = ref(contextHost?.hostname ?? ''),
  port = ref(contextHost?.port ?? 22),
  count = ref(5),
  timeout = ref(30),
  error = ref(''),
  busy = ref(false);
const tasks = shallowRef<Diagnostic[]>([]),
  selected = ref('');
// Only an explicit "diagnose this host" action seeds this independent tool.
watch(
  () => [props.hostId, props.requestId] as const,
  ([id]) => {
    host.value = id ?? '';
    if (!id) {
      source.value = 'local';
      target.value = '';
      port.value = 22;
      return;
    }
    const endpoint = hosts.catalog?.hosts.find((h) => h.id === id);
    target.value = endpoint?.hostname ?? '';
    port.value = endpoint?.port ?? 22;
  },
);

const current = computed(() => tasks.value.find((t) => t.id === selected.value));
const tools: Record<Tool, string> = {
  ping: 'Ping',
  tcp: 'TCP 端口',
  dns: 'DNS 解析',
  traceroute: 'Traceroute',
  mtr: 'MTR',
  interfaces: '网络接口',
  connections: '网络连接',
  ssh_latency: 'SSH 延迟',
};
const loading = ref(true);
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
async function poll() {
  try {
    const data = await tasksApi.diagnostics(
      Object.fromEntries(tasks.value.map((t) => [t.id, t.revision])),
    );
    if (!disposed) {
      tasks.value = [...tasks.value.filter((t) => !data.some((n) => n.id === t.id)), ...data]
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(-16);
      if (!tasks.value.some((t) => t.id === selected.value) && tasks.value.length)
        selected.value = tasks.value.at(-1)!.id;
    }
  } catch (e) {
    if (!disposed) error.value = errorMessage(e);
  } finally {
    if (!disposed) loading.value = false;
    if (!disposed) timer = setTimeout(() => void poll(), 750);
  }
}
onMounted(() => void poll());
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
async function start() {
  busy.value = true;
  error.value = '';
  try {
    const c = ops.connections[host.value];
    if (source.value === 'remote' && c?.state !== 'connected')
      throw new Error('请先连接并核对远程目标');
    const t = await tasksApi.start({
      tool: tool.value,
      origin:
        source.value === 'local'
          ? { kind: 'local' }
          : { kind: 'remote', hostId: host.value, sessionId: c!.session!.id },
      target: target.value,
      port: port.value,
      count: count.value,
      timeoutSecs: timeout.value,
    });
    selected.value = t.id;
    tasks.value = [...tasks.value, t];
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function stop(id: string) {
  try {
    await tasksApi.stop(id);
  } catch (e) {
    error.value = errorMessage(e);
  }
}
function origin(t: Diagnostic) {
  if (t.input.origin.kind === 'local') return '本机';
  const id = t.input.origin.hostId;
  const c = ops.connections[id];
  const h = c?.session?.id === t.input.origin.sessionId ? c.host : undefined;
  return h
    ? `远程 ${hostDisplayName(h)} (${h.username}@${h.hostname}:${h.port}) · HostId=${id}`
    : `远程 HostId=${id} · SessionId=${t.input.origin.sessionId}（连接已结束，仅保留原会话标识）`;
}
function result(t: Diagnostic) {
  return JSON.stringify(
    {
      ...t,
      sourceLabel: origin(t),
      notice:
        'ICMP 不可达不能直接证明服务器宕机；SSH 延迟为已认证 exec 往返，包含 Channel 和 Shell 调度。',
    },
    null,
    2,
  );
}
async function copy() {
  if (!current.value) return;
  try {
    await clipboardApi.writeText(result(current.value));
  } catch (e) {
    error.value = errorMessage(e);
  }
}
useErrorNotifications(() => [error.value, ...tasks.value.map((task) => task.message)]);
</script>
<template>
  <section class="operations-view tasks-view network-view page-view">
    <header>
      <p class="eyebrow">NETWORK</p>
      <h1>网络诊断</h1>
      <p class="subtle">
        ICMP 可能被过滤，Ping 无响应不等于服务器宕机。任务独立取消，输出最多保留 256
        KiB；离页后任务继续到完成或超时。
      </p>
    </header>
    <div class="page-tabs" role="tablist" aria-label="诊断工具">
      <button
        v-for="(label, key) in tools"
        :key="key"
        class="button"
        role="tab"
        :aria-selected="tool === key"
        @click="tool = key"
      >
        {{ label }}
      </button>
    </div>
    <form class="work-section" @submit.prevent="start">
      <div class="form-row">
        <label
          >执行来源
          <select v-model="source" aria-label="诊断来源">
            <option value="local">本机</option>
            <option value="remote">远程服务器</option>
          </select></label
        >
        <label v-if="source === 'remote'"
          >远程主机
          <select v-model="host" aria-label="诊断主机" required>
            <option value="" disabled>选择执行诊断的主机</option>
            <option v-for="item in hosts.catalog?.hosts" :key="item.id" :value="item.id">
              {{ hostDisplayName(item) }} · {{ item.username }}@{{ item.hostname }}:{{ item.port }}
            </option>
          </select>
        </label>
      </div>
      <TaskConnections v-if="source === 'remote' && host" :ids="[host]" />
      <div class="form-row">
        <label v-if="!['interfaces', 'connections', 'ssh_latency'].includes(tool)"
          >目标
          <input
            v-model="target"
            required
            maxlength="253"
            aria-label="诊断目标"
            placeholder="IP 或域名"
        /></label>
        <label v-if="tool === 'tcp'"
          >端口
          <input v-model.number="port" type="number" min="1" max="65535" aria-label="诊断端口"
        /></label>
        <label
          >次数
          <input
            v-model.number="count"
            type="number"
            min="1"
            max="100"
            aria-label="诊断次数" /></label
        ><label
          >总超时（秒）
          <input v-model.number="timeout" type="number" min="1" max="300" aria-label="诊断超时"
        /></label>
        <button class="button primary" :disabled="busy">开始诊断</button>
      </div>
      <p class="subtle">
        工具缺失或权限不足会显示失败；不自动安装或提权。MTR 为逐跳原始实时探测输出，Windows
        本机未提供受管 MTR，可选择远端。SSH 延迟使用已有可信连接，不重新发送登录凭据。
      </p>
    </form>

    <div class="ops-log-tabs" role="tablist" aria-label="诊断任务">
      <button
        v-for="t in tasks"
        :key="t.id"
        class="button"
        role="tab"
        :aria-selected="selected === t.id"
        @click="selected = t.id"
      >
        {{ tools[t.input.tool] }} · {{ t.input.origin.kind === 'local' ? '本机' : '远程' }} ·
        {{ taskLabels[t.state] }}
      </button>
    </div>
    <section v-if="current" class="work-section result-section">
      <h2>{{ tools[current.input.tool] }} · {{ taskLabels[current.state] }}</h2>
      <p>
        {{ origin(current) }} · {{ new Date(current.startedAt).toLocaleString() }} · TaskId={{
          current.id
        }}
      </p>
      <div class="ops-toolbar">
        <button class="button" :disabled="!active(current.state)" @click="stop(current.id)">
          停止此诊断</button
        ><button class="button" @click="copy">复制诊断结果</button
        ><button
          class="button"
          @click="downloadResult(`serverdeck-network-${current.id}.json`, result(current))"
        >
          导出诊断结果
        </button>
      </div>

      <p>退出码：{{ current.exitCode ?? '未取得' }} · 已裁剪 {{ current.droppedBytes }} 字节</p>
      <pre class="ops-log-output" aria-label="诊断实时结果">{{
        current.output || '等待输出…'
      }}</pre>
    </section>
    <p v-else class="subtle">
      {{ loading ? '正在读取诊断任务…' : '暂无诊断任务。选择工具和执行来源后开始。' }}
    </p>
  </section>
</template>
