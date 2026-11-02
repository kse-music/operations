<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useHostsStore } from '../stores/hosts';
import { useApplicationStore } from '../stores/application';
import { monitorApi } from '../services/monitor';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import { monitorLabels, percent, type MonitorSnapshot } from '../types/monitor';
import type { TerminalEvent } from '../types/terminal';
import { bytes } from '../types/files';
import TrendChart from '../components/TrendChart.vue';
import Modal from '../components/Modal.vue';
const props = defineProps<{ hostId?: string }>();
const emit = defineEmits<{ processes: [hostId: string] }>();
const hosts = useHostsStore(),
  application = useApplicationStore();
const chosen = computed(() => props.hostId ?? hosts.selectedId ?? ''),
  snapshot = ref<MonitorSnapshot | null>(null),
  error = ref<string | null>(null),
  connection = ref(''),
  busy = ref(false),
  session = ref(''),
  allMounts = ref(false),
  trust = ref<Extract<TerminalEvent, { type: 'trust' }> | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined,
  alive = true,
  polling = false,
  generation = 0;
let ownedHost = '';
const sample = computed(() => snapshot.value?.sample),
  cpu = computed(() => sample.value?.cpus.find((c) => c.name === 'cpu'));
const disks = computed(
  () =>
    sample.value?.disks.filter(
      (d) => allMounts.value || (!d.pseudo && !d.image && !d.duplicateOf),
    ) ?? [],
);
const stale = computed(() =>
  ['failed', 'error', 'paused', 'connecting'].includes(snapshot.value?.state ?? 'connecting'),
);
const networkPoints = computed(
  () =>
    snapshot.value?.history.map((p) => ({
      ...p,
      receiveRate: p.receiveRate == null ? null : p.receiveRate / 1024,
      sendRate: p.sendRate == null ? null : p.sendRate / 1024,
    })) ?? [],
);
async function poll(): Promise<void> {
  if (!alive || polling || !ownedHost) return;
  polling = true;
  const host = ownedHost,
    token = generation;
  try {
    const value = await monitorApi.snapshot(host, snapshot.value?.revision ?? null);
    if (alive && token === generation && value) {
      snapshot.value = value;
      if (value.error) error.value = value.error;
      else if (['running', 'partial'].includes(value.state)) error.value = null;
    }
  } catch (cause) {
    if (alive && token === generation) error.value = errorMessage(cause);
  } finally {
    polling = false;
    if (alive && ownedHost) timer = setTimeout(() => void poll(), 1000);
  }
}
async function pauseHost(): Promise<void> {
  if (ownedHost) {
    const host = ownedHost;
    ownedHost = '';
    try {
      await monitorApi.visible(host, false);
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }
}
async function start(): Promise<void> {
  if (!chosen.value || busy.value) return;
  busy.value = true;
  error.value = null;
  trust.value = null;
  await pauseHost();
  clearTimeout(timer);
  const token = ++generation;
  const host = chosen.value;
  snapshot.value = null;
  session.value = '';
  connection.value = '连接中';
  try {
    const value = await monitorApi.open(host, (event) => {
      if (!alive || token !== generation) return;
      if (event.type === 'trust') trust.value = event;
      else if (event.type === 'state') {
        connection.value = event.state;
        if (event.message) error.value = event.message;
        if (event.state !== 'awaiting_trust') trust.value = null;
      }
    });
    if (!alive || token !== generation) {
      await monitorApi.visible(host, false);
      return;
    }
    session.value = value.id;
    ownedHost = host;
    await monitorApi.visible(host, !document.hidden);
    void poll();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function stop(): Promise<void> {
  if (!ownedHost) return;
  busy.value = true;
  const host = ownedHost;
  try {
    await monitorApi.stop(host);
    ownedHost = '';
    snapshot.value = null;
    session.value = '';
    trust.value = null;
    error.value = null;
    connection.value = '已停止，采样任务和租约已释放';
    clearTimeout(timer);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function confirmTrust(accept: boolean): Promise<void> {
  try {
    await terminalApi.trust(session.value, accept);
    trust.value = null;
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
async function visibility(): Promise<void> {
  if (ownedHost)
    try {
      await monitorApi.visible(ownedHost, !document.hidden);
    } catch (cause) {
      error.value = errorMessage(cause);
    }
}
function uptime(value: number | null | undefined): string {
  if (value == null) return '不可用';
  const n = Math.floor(value);
  return `${Math.floor(n / 86400)} 天 ${Math.floor((n % 86400) / 3600)} 小时 ${Math.floor((n % 3600) / 60)} 分`;
}
onMounted(async () => {
  document.addEventListener('visibilitychange', visibility);
  if (props.hostId) await start();
  else if (chosen.value) {
    try {
      const current = await monitorApi.snapshot(chosen.value);
      if (current) {
        snapshot.value = current;
        session.value = current.sessionId;
        ownedHost = chosen.value;
        await monitorApi.visible(ownedHost, !document.hidden);
        void poll();
      }
    } catch (cause) {
      if (!(typeof cause === 'object' && cause && 'code' in cause && cause.code === 'NOT_FOUND'))
        error.value = errorMessage(cause);
    }
  }
});
onBeforeUnmount(() => {
  alive = false;
  ++generation;
  clearTimeout(timer);
  document.removeEventListener('visibilitychange', visibility);
  void pauseHost();
});
useErrorNotifications(() => [
  error.value,
  ...(sample.value?.disks.map((disk) => disk.error) ?? []),
]);
</script>
<template>
  <section class="monitor-view page-view" aria-label="Linux 服务器监控">
    <div class="section-heading">
      <div>
        <p class="eyebrow">AGENTLESS MONITOR</p>
        <h1>服务器监控</h1>
        <p class="subtle">固定只读 SSH 采集 · 页面隐藏暂停 · 不安装 Agent</p>
      </div>
      <div class="monitor-actions">
        <button class="button primary" :disabled="!chosen || busy" @click="start">
          {{ busy ? '正在连接…' : snapshot ? '重新连接 / 继续' : '开始监控' }}</button
        ><button class="button" :disabled="!session || busy" @click="stop">停止监控</button
        ><button class="button" :disabled="!chosen" @click="emit('processes', chosen)">
          查看资源占用进程
        </button>
      </div>
    </div>

    <p class="monitor-status" role="status" data-testid="monitor-state">
      {{ snapshot ? (monitorLabels[snapshot.state] ?? snapshot.state) : connection || '尚未采样' }}
      · 间隔
      {{ snapshot?.intervalSecs ?? application.state?.config.monitorIntervalSecs ?? 3 }}
      秒（全局设置）<span v-if="sample">
        · 最后成功 {{ new Date(sample.sampledAt).toLocaleTimeString() }}</span
      >
    </p>
    <p v-if="sample && stale" class="subtle">下方为上次成功样本，禁止视作当前值。</p>
    <div v-if="!sample" class="host-empty">
      {{
        session
          ? '正在建立安全连接或等待首个样本；CPU 和网络需要连续采样。'
          : '请在主机管理中打开远程主机后查看服务器资源使用情况。'
      }}
    </div>
    <div v-if="sample" :class="{ 'monitor-stale': stale }">
      <div class="monitor-cards">
        <article class="panel">
          <h2>CPU</h2>
          <strong data-testid="monitor-cpu">{{
            sample.cpus.length ? percent(cpu?.usage) : '不可用'
          }}</strong>
          <p>{{ sample.system.cores ?? '未知' }} 核 · iowait {{ percent(cpu?.iowait) }}</p>
          <small>{{
            sample.rateStatus === 'initial'
              ? '首次采样，等待差值'
              : sample.rateStatus === 'reset'
                ? '差分基线已重置'
                : '忙碌时间不含 idle / iowait'
          }}</small>
        </article>
        <article class="panel">
          <h2>内存</h2>
          <strong>{{ sample.memory ? percent(sample.memory.usage) : '不可用' }}</strong>
          <p>
            {{
              sample.memory
                ? `${bytes(sample.memory.used)} / ${bytes(sample.memory.total)}`
                : '采集失败'
            }}
          </p>
          <small
            >可用 {{ sample.memory ? bytes(sample.memory.available) : '—' }}
            {{ sample.memory?.approximate ? '（近似）' : '' }}</small
          >
        </article>
        <article class="panel">
          <h2>Swap</h2>
          <strong>{{
            !sample.memory
              ? '不可用'
              : sample.memory.swapTotal === 0
                ? '未启用'
                : percent(sample.memory.swapUsage)
          }}</strong>
          <p>
            {{
              sample.memory
                ? `${bytes(sample.memory.swapUsed)} / ${bytes(sample.memory.swapTotal)}`
                : '—'
            }}
          </p>
        </article>
        <article class="panel">
          <h2>系统负载 1 / 5 / 15 分钟</h2>
          <strong class="load-value">{{
            sample.load?.map((n) => n.toFixed(2)).join(' / ') ?? '不可用'
          }}</strong>
          <p>运行 {{ uptime(sample.uptime) }}</p>
        </article>
      </div>
      <details class="panel">
        <summary>每核心 CPU（新核心和无效差值显示待计算）</summary>
        <div class="core-grid">
          <span v-for="core in sample.cpus.filter((c) => c.name !== 'cpu')" :key="core.name"
            >{{ core.name }} {{ percent(core.usage) }}</span
          >
        </div>
      </details>
      <div class="monitor-charts">
        <TrendChart
          :points="snapshot?.history ?? []"
          field="cpu"
          label="CPU 使用率"
          unit="%"
          :max="100"
        /><TrendChart
          :points="snapshot?.history ?? []"
          field="memory"
          label="内存使用率"
          unit="%"
          :max="100"
        /><TrendChart
          :points="networkPoints"
          field="receiveRate"
          label="接收速率（非 lo 接口合计）"
          unit="KiB/s"
        /><TrendChart
          :points="networkPoints"
          field="sendRate"
          label="发送速率（非 lo 接口合计）"
          unit="KiB/s"
        />
      </div>
      <div class="panel monitor-system">
        <h2>系统信息</h2>
        <dl>
          <dt>主机名</dt>
          <dd>{{ sample.system.hostname ?? '不可用' }}</dd>
          <dt>发行版</dt>
          <dd>{{ sample.system.distribution ?? '不可用' }}</dd>
          <dt>内核 / 架构</dt>
          <dd>{{ sample.system.kernel ?? '—' }} / {{ sample.system.architecture ?? '—' }}</dd>
          <dt>CPU</dt>
          <dd>{{ sample.system.cpuModel ?? '不可用' }}</dd>
          <dt>远程系统时间 / 时区</dt>
          <dd>
            {{ sample.system.systemTime ?? '不可用' }} / {{ sample.system.timezone ?? '不可用' }}
          </dd>
        </dl>
      </div>
      <section class="panel">
        <h2>磁盘与挂载点</h2>
        <label
          ><input v-model="allMounts" type="checkbox" />显示伪文件系统、只读镜像与重复挂载</label
        >
        <div class="monitor-table">
          <table>
            <thead>
              <tr>
                <th>挂载点 / 设备</th>
                <th>类型</th>
                <th>总量</th>
                <th>已用</th>
                <th>可用</th>
                <th>使用率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="disk in disks" :key="`${disk.device}:${disk.mount}`">
                <td>
                  {{ disk.mount
                  }}<small
                    >{{ disk.source }}
                    <span v-if="disk.duplicateOf">· 重复于 {{ disk.duplicateOf }}</span></small
                  >
                </td>
                <td>{{ disk.filesystem }} {{ disk.container ? '（容器）' : '' }}</td>
                <td>{{ disk.total == null ? '—' : bytes(disk.total) }}</td>
                <td>{{ disk.used == null ? '—' : bytes(disk.used) }}</td>
                <td>{{ disk.available == null ? '—' : bytes(disk.available) }}</td>
                <td :class="{ 'error-text': (disk.usage ?? 0) >= 90 }">
                  {{ disk.usage == null ? '不可用' : percent(disk.usage) }}
                  {{ (disk.usage ?? 0) >= 90 ? '高占用' : '' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!disks.length">没有可显示的持久文件系统，请检查采集警告或显示全部挂载。</p>
      </section>
      <section class="panel">
        <h2>网络接口</h2>
        <p class="subtle">
          速率由远端 uptime 间隔计算；虚拟接口可能重复计算同一流量，合计不是物理线路吞吐量。
        </p>
        <div class="monitor-table">
          <table>
            <thead>
              <tr>
                <th>接口 / 地址</th>
                <th>接收速度</th>
                <th>发送速度</th>
                <th>累计接收</th>
                <th>累计发送</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="net in sample.network" :key="net.name">
                <td>
                  {{ net.name
                  }}<small>{{ net.addresses.join(', ') || '无地址或 ip 命令不可用' }}</small>
                </td>
                <td>{{ net.receiveRate == null ? '待计算' : bytes(net.receiveRate) + '/s' }}</td>
                <td>{{ net.sendRate == null ? '待计算' : bytes(net.sendRate) + '/s' }}</td>
                <td>{{ bytes(net.received) }}</td>
                <td>{{ bytes(net.sent) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <details v-if="sample.warnings.length" open class="panel monitor-warnings">
        <summary>采集警告（{{ sample.warnings.length }}）</summary>
        <p v-for="(warning, i) in sample.warnings" :key="i">{{ warning }}</p>
      </details>
    </div>
    <Modal v-if="trust" title="确认监控主机指纹" @close="confirmTrust(false)"
      ><p>请通过可信渠道核对后接受，认证信息将在确认后发送。</p>
      <p>{{ trust.hostname }}:{{ trust.port }} · {{ trust.algorithm }}</p>
      <code>{{ trust.fingerprint }}</code>
      <footer class="dialog-actions">
        <button class="button" @click="confirmTrust(false)">拒绝</button
        ><button class="button primary" @click="confirmTrust(true)">信任并继续监控</button>
      </footer></Modal
    >
  </section>
</template>
