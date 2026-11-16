<script setup lang="ts">
import { tr } from './i18n/messages';
import { locale } from '@serverdeck/plugin-sdk/i18n';

import { computed, reactive } from 'vue';
import { ChevronRight } from '@lucide/vue';
import OpsDetails from './OpsDetails.vue';
import type { OpsRequest, OpsResponse } from './types';
import ContainerEnvironment from './ContainerEnvironment.vue';
import ContainerStartup from './ContainerStartup.vue';
import { containerExitText, containerStateText } from './container-status';

const props = defineProps<{
  containerId: string;
  detail: Record<string, unknown>;
  query: (request: OpsRequest) => Promise<OpsResponse>;
}>();
const sections = [
  {
    key: 'overview',
    get label() {
      return tr('概览');
    },
  },
  {
    key: 'startup',
    get label() {
      return tr('启动配置');
    },
  },
  {
    key: 'environment',
    get label() {
      return tr('环境变量');
    },
  },
] as const;
type Section = (typeof sections)[number]['key'];
const expanded = reactive<Record<Section, boolean>>({
  overview: true,
  startup: false,
  environment: false,
});
const visited = reactive(new Set<Section>(['overview']));

function toggleSection(section: Section, event: Event) {
  expanded[section] = (event.currentTarget as HTMLDetailsElement).open;
  if (expanded[section]) visited.add(section);
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function fieldText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function dateTime(value: unknown): string {
  const raw = fieldText(value);
  if (!raw || raw.startsWith('0001-01-01')) return '—';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString(locale.value, { hour12: false });
}

const healthLabels = new Map([
  ['starting', '检查中'],
  ['healthy', '健康'],
  ['unhealthy', '不健康'],
]);
const policyLabels = new Map([
  ['', '不自动重启'],
  ['no', '不自动重启'],
  ['on-failure', '异常退出时重启'],
  ['always', '总是重启'],
  ['unless-stopped', '除非手动停止，否则重启'],
]);
const overview = computed(() => {
  const detail = props.detail;
  const state = fields(detail.state);
  const policy = fields(detail.restartPolicy);
  const status = fieldText(state.Status) || (state.Running === true ? 'running' : '');
  const health = fieldText(fields(state.Health).Status);
  const restart = fieldText(policy.Name);
  const retries = fieldText(policy.MaximumRetryCount);
  return {
    [tr('名称')]: fieldText(detail.name).replace(/^\//, ''),
    [tr('镜像')]: fieldText(detail.image),
    [tr('容器 ID')]: props.containerId,
    [tr('运行状态')]: containerStateText(status),
    [tr('健康检查')]: health
      ? healthLabels.has(health)
        ? tr(healthLabels.get(health)!)
        : health
      : tr('未报告'),
    [tr('主进程 PID（主机）')]: typeof state.Pid === 'number' && state.Pid > 0 ? state.Pid : '—',
    [tr('创建时间')]: dateTime(detail.created),
    [tr('最近启动')]: dateTime(state.StartedAt),
    [tr('最近退出')]: dateTime(state.FinishedAt),
    [tr('退出结果')]: containerExitText(status, state.ExitCode),
    [tr('重启策略')]:
      typeof policy.Name === 'string'
        ? policyLabels.has(restart)
          ? tr(policyLabels.get(restart)!)
          : restart
        : '',
    ...(restart === 'on-failure' && retries
      ? { [tr('最大重试次数')]: retries === '0' ? tr('不限') : retries }
      : {}),
    ...(state.OOMKilled === true ? { [tr('退出原因')]: tr('因内存不足被终止') } : {}),
    ...(fieldText(state.Error) ? { [tr('状态错误')]: fieldText(state.Error) } : {}),
  };
});
</script>

<template>
  <div class="docker-container-details">
    <div class="docker-detail-panel">
      <details
        v-for="section in sections"
        :key="section.key"
        class="docker-detail-section"
        :open="expanded[section.key]"
        @toggle.self="toggleSection(section.key, $event)"
      >
        <summary>
          <ChevronRight :size="16" aria-hidden="true" />
          <span>{{ section.label }}</span>
        </summary>
        <div v-if="visited.has(section.key)" class="docker-detail-section-content">
          <OpsDetails v-if="section.key === 'overview'" :detail="overview" />
          <ContainerStartup
            v-else-if="section.key === 'startup'"
            :container-id="containerId"
            :query="query"
          />
          <ContainerEnvironment v-else :container-id="containerId" :query="query" />
        </div>
      </details>
    </div>
  </div>
</template>
