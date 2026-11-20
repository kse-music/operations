<script setup lang="ts">
import { ChevronRight, FolderOpen, RefreshCw, TriangleAlert } from '@lucide/vue';
import { locale } from '@serverdeck/plugin-sdk/i18n';
import { computed } from 'vue';
import EnvironmentTagBadge from '../components/EnvironmentTagBadge.vue';
import Modal from '../components/Modal.vue';
import { useHostOverview } from '../composables/useHostOverview';
import { tr } from '../i18n/messages';
import { useHostsStore } from '../stores/hosts';
import { bytes } from '../types/files';
import { hostDisplayName, type Host } from '../types/hosts';
import { monitorLabels, percent } from '../types/monitor';
import { stateLabels } from '../types/terminal';

const props = defineProps<{ host?: Host; workspaceHosts: readonly string[] }>();
defineEmits<{ openMount: [host: Host, path: string] }>();
const hosts = useHostsStore();
const {
  sample,
  cpuReading,
  previousSample,
  sessionId,
  connection,
  ended,
  error,
  fingerprint,
  confirming,
  refreshing,
  refresh,
  trust,
} = useHostOverview(
  () => props.host,
  () => props.workspaceHosts,
);
const endpoint = computed(() => {
  const host = props.host;
  if (!host) return '';
  const address = host.hostname.includes(':') ? `[${host.hostname}]` : host.hostname;
  return `${host.username}@${address}:${host.port}`;
});
const connected = computed(() => connection.value === 'connected' && !ended.value);
const sampleTime = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }),
);
const freshness = computed(() =>
  sample.value ? sampleTime.value.format(sample.value.sampledAt) : null,
);
const previousCpuLabel = computed(() => {
  const reading = cpuReading.value;
  return reading && reading.sampledAt !== sample.value?.sampledAt
    ? tr('上次采样于 {0}', sampleTime.value.format(reading.sampledAt))
    : undefined;
});
const uptime = computed(() => {
  const seconds = sample.value?.uptime;
  if (seconds == null) return '';
  if (seconds >= 86400) return tr('已运行 {0} 天', Math.floor(seconds / 86400));
  if (seconds >= 3600) return tr('已运行 {0} 小时', Math.floor(seconds / 3600));
  return tr('已运行 {0} 分钟', Math.floor(seconds / 60));
});
const cpu = computed(() => cpuReading.value?.usage ?? null);
const memory = computed(() => sample.value?.memory);
const disks = computed(() =>
  (sample.value?.disks ?? [])
    .filter(
      (disk) =>
        !disk.pseudo &&
        !disk.image &&
        (disk.mount === '/' || (!disk.container && !disk.duplicateOf)),
    )
    .sort((a, b) => (b.usage ?? -1) - (a.usage ?? -1) || a.mount.localeCompare(b.mount)),
);
const highUsage = 90;
const busiestDisk = computed(() => {
  const disk = disks.value[0];
  return disk && (disk.usage ?? 0) >= highUsage ? disk : undefined;
});
const stale = computed(() => !!sample.value && (ended.value || !!error.value));
const load = computed(() => sample.value?.load?.map((value) => value.toFixed(2)).join(' / '));

function progress(value: number): number {
  return Math.max(0, Math.min(100, value));
}
</script>

<template>
  <section v-if="host" class="host-overview page-view" :aria-label="tr('主机概览')">
    <header class="overview-heading">
      <div>
        <div class="overview-identity">
          <h1>{{ hostDisplayName(host) }}</h1>
          <EnvironmentTagBadge :tag="hosts.environmentTag(host.id)" />
        </div>
        <ul class="overview-details muted">
          <li>
            <code>{{ endpoint }}</code>
          </li>
          <li v-if="sample?.system.distribution">{{ sample.system.distribution }}</li>
          <li v-if="uptime">{{ uptime }}</li>
        </ul>
      </div>
      <div class="overview-controls">
        <span class="overview-connection" :class="{ connected }" role="status">
          {{ connected ? tr('SSH 已连接') : (stateLabels[connection] ?? tr('未连接')) }}
        </span>
        <span v-if="freshness" class="muted overview-timestamp">
          {{
            stale || previousSample ? tr('上次采样于 {0}', freshness) : tr('采样于 {0}', freshness)
          }}
        </span>
        <button
          type="button"
          class="button"
          :disabled="refreshing || (!ended && !error && !(connected && sessionId))"
          @click="refresh"
        >
          <RefreshCw :size="15" aria-hidden="true" />
          {{ refreshing ? tr('正在采集') : tr('刷新') }}
        </button>
      </div>
    </header>

    <p v-if="error || ended" class="overview-feedback overview-error" role="alert">
      {{ error ?? tr('SSH 监控连接已结束')
      }}<template v-if="stale"> {{ tr('以下为上次采样结果。') }}</template>
    </p>
    <p v-else-if="!sample" class="overview-feedback muted" role="status">
      {{ connected ? tr('正在采集主机指标…') : tr('正在连接主机…') }}
    </p>
    <p v-else-if="sample.warnings.length" class="overview-partial muted" role="status">
      {{ monitorLabels.partial }}
    </p>

    <template v-if="sample">
      <p v-if="busiestDisk && !stale" class="overview-feedback overview-warning" role="status">
        <TriangleAlert :size="18" aria-hidden="true" />
        <span v-if="busiestDisk.available !== null">
          {{
            tr(
              '{0} 使用率 {1}，剩余 {2}',
              busiestDisk.mount,
              percent(busiestDisk.usage),
              bytes(busiestDisk.available),
            )
          }}
        </span>
        <span v-else>{{
          tr('{0} 使用率 {1}', busiestDisk.mount, percent(busiestDisk.usage))
        }}</span>
      </p>

      <div class="overview-metrics">
        <section class="overview-metric">
          <h2>{{ tr('CPU 使用率') }}</h2>
          <div class="metric-values">
            <strong :class="{ 'metric-unavailable': cpu === null }" :title="previousCpuLabel">
              {{ cpu === null ? '—' : percent(cpu) }}
            </strong>
            <span v-if="sample.system.cores !== null" class="muted">{{
              tr('{0} 核', sample.system.cores)
            }}</span>
          </div>
          <progress
            v-if="cpu !== null"
            :value="progress(cpu)"
            max="100"
            :aria-label="tr('CPU 使用率')"
            :aria-description="previousCpuLabel"
          />
        </section>
        <section class="overview-metric">
          <h2>{{ tr('内存使用率') }}</h2>
          <div class="metric-values">
            <strong :class="{ 'metric-unavailable': !memory }">{{
              memory ? percent(memory.usage) : '—'
            }}</strong>
            <span v-if="memory" class="muted"
              >{{ memory.approximate ? '≈ ' : '' }}{{ bytes(memory.used) }} /
              {{ bytes(memory.total) }}</span
            >
          </div>
          <progress
            v-if="memory"
            :value="progress(memory.usage)"
            max="100"
            :aria-label="tr('内存使用率')"
          />
        </section>
        <section class="overview-metric">
          <h2>{{ tr('系统负载') }}</h2>
          <div class="metric-values">
            <strong>{{ load ?? '—' }}</strong>
          </div>
          <span class="muted">{{ tr('1 分钟 / 5 分钟 / 15 分钟') }}</span>
        </section>
      </div>

      <section class="overview-disks" aria-labelledby="overview-disks-heading">
        <h2 id="overview-disks-heading">{{ tr('磁盘与挂载点') }}</h2>
        <p v-if="!disks.length" class="overview-disk-empty muted">
          {{ tr('暂无可用的磁盘数据。') }}
        </p>
        <div v-else class="overview-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{{ tr('挂载点') }}</th>
                <th scope="col">{{ tr('已用 / 总量') }}</th>
                <th scope="col">{{ tr('使用率') }}</th>
                <th scope="col">{{ tr('操作') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="disk in disks"
                :key="`${disk.mount}:${disk.device}:${disk.filesystem}`"
                :class="{
                  'disk-warning': !stale && disk.usage !== null && disk.usage >= highUsage,
                }"
              >
                <th scope="row">
                  <code>{{ disk.mount }}</code>
                </th>
                <td class="disk-capacity">
                  {{ disk.total === null ? '—' : `${bytes(disk.used)} / ${bytes(disk.total)}` }}
                </td>
                <td>
                  <div v-if="disk.usage !== null" class="disk-usage">
                    <span>{{ percent(disk.usage) }}</span>
                    <progress
                      :value="progress(disk.usage)"
                      max="100"
                      :aria-label="tr('{0} 使用率 {1}', disk.mount, percent(disk.usage))"
                    />
                  </div>
                  <span v-else class="muted" :title="disk.error ? tr(disk.error) : undefined">{{
                    tr('不可用')
                  }}</span>
                </td>
                <td>
                  <button
                    type="button"
                    class="text-button overview-open-path"
                    :aria-label="tr('在 SFTP 中打开 {0}', disk.mount)"
                    @click="$emit('openMount', host, disk.mount)"
                  >
                    <FolderOpen :size="15" aria-hidden="true" />{{ tr('在 SFTP 中打开')
                    }}<ChevronRight :size="15" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <Modal
      v-if="fingerprint"
      :title="tr('确认 SSH 主机指纹')"
      :host-ids="[host.id]"
      :busy="confirming || !sessionId"
      @close="trust(false)"
    >
      <p>{{ fingerprint.hostname }}:{{ fingerprint.port }} · {{ fingerprint.algorithm }}</p>
      <p class="overview-fingerprint">
        <code>{{ fingerprint.fingerprint }}</code>
      </p>
      <p class="muted">{{ tr('请通过可信渠道核对指纹后再继续。') }}</p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <div class="modal-actions">
        <button
          type="button"
          class="button"
          :disabled="confirming || !sessionId"
          @click="trust(false)"
        >
          {{ tr('拒绝连接') }}
        </button>
        <button
          type="button"
          class="button primary"
          :disabled="confirming || !sessionId"
          @click="trust(true)"
        >
          {{ tr('信任并连接') }}
        </button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.host-overview {
  --overview-amber: light-dark(#8f5809, #f5bf64);
  --overview-amber-bg: color-mix(in srgb, var(--overview-amber) 12%, var(--panel));
  display: grid;
  align-content: start;
  gap: 16px;
  min-width: 0;
  padding: 20px 24px 28px;
}
.overview-heading,
.overview-identity,
.overview-details,
.overview-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.overview-heading {
  justify-content: space-between;
  margin-bottom: 4px;
}
.overview-identity h1 {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: calc(23px * var(--interface-font-scale, 1));
}
.overview-details {
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
  overflow-wrap: anywhere;
}
.overview-details li + li::before {
  content: '·';
  margin-right: 12px;
}
.overview-controls {
  font-size: var(--font-size-caption);
}
.overview-connection::before {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 7px;
  border-radius: 50%;
  background: var(--muted);
  content: '';
}
.overview-connection.connected::before {
  background: var(--accent);
}
.overview-timestamp {
  border-left: 1px solid var(--border);
  padding-left: 12px;
  font-variant-numeric: tabular-nums;
}
.overview-feedback {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--control-radius);
  background: var(--panel);
  overflow-wrap: anywhere;
}
.overview-error {
  display: block;
  color: var(--error);
  background: var(--error-bg);
}
.overview-warning {
  color: var(--overview-amber);
  border-color: color-mix(in srgb, var(--overview-amber) 48%, var(--border));
  background: var(--overview-amber-bg);
}
.overview-warning svg {
  flex: none;
}
.overview-partial {
  margin: 0;
}
.overview-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.overview-metric,
.overview-disks {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--control-radius);
  background: var(--panel);
}
.overview-metric {
  flex: 1 1 calc(190px * var(--interface-font-scale, 1));
  display: grid;
  align-content: start;
  gap: 8px;
  padding: 12px 14px;
}
.overview-metric h2,
.overview-disks h2 {
  margin: 0;
  font-size: var(--font-size-section);
}
.metric-values {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 10px;
  font-variant-numeric: tabular-nums;
}
.metric-values strong {
  font-size: calc(23px * var(--interface-font-scale, 1));
}
.metric-values .metric-unavailable {
  color: var(--muted);
  font-size: var(--font-size-section);
}
.host-overview progress {
  appearance: none;
  width: 100%;
  height: 7px;
  overflow: hidden;
  border: 0;
  border-radius: 8px;
  background: var(--border-strong);
}
.host-overview progress::-webkit-progress-bar {
  background: var(--border-strong);
}
.host-overview progress::-webkit-progress-value {
  border-radius: 8px;
  background: var(--accent);
}
.host-overview progress::-moz-progress-bar {
  background: var(--accent);
}
.overview-disks h2,
.overview-disk-empty {
  padding: 12px 14px;
}
.overview-disk-empty {
  margin: 0;
}
.overview-table-scroll {
  overflow-x: auto;
}
.overview-disks table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}
.overview-disks :is(th, td) {
  padding: 8px 14px;
  border-top: 1px solid var(--border);
}
.overview-disks thead {
  color: var(--muted);
}
.overview-disks tbody th {
  overflow-wrap: anywhere;
}
.disk-capacity,
.disk-usage {
  font-variant-numeric: tabular-nums;
}
.disk-usage {
  display: flex;
  align-items: center;
  gap: 8px;
}
.disk-usage span {
  min-width: 5ch;
}
.disk-usage progress {
  min-width: 46px;
}
.disk-warning {
  background: var(--overview-amber-bg);
}
.disk-warning progress::-webkit-progress-value {
  background: var(--overview-amber);
}
.disk-warning progress::-moz-progress-bar {
  background: var(--overview-amber);
}
.overview-open-path {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.overview-fingerprint {
  overflow-wrap: anywhere;
}
</style>
