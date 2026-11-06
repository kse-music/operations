<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import OpsDetails from '@serverdeck/plugin-sdk/ui/OpsDetails.vue';
import type { OpsRequest, OpsResponse } from '@serverdeck/plugin-sdk/types/ops';
import ContainerResources from './ContainerResources.vue';
import ContainerEnvironment from './ContainerEnvironment.vue';

const props = defineProps<{
  containerId: string;
  detail: Record<string, unknown>;
  query: (request: OpsRequest) => Promise<OpsResponse>;
}>();
const tabs = [
  { key: 'overview', label: '概览' },
  { key: 'resources', label: '资源使用' },
  { key: 'ports', label: '端口映射' },
  { key: 'mounts', label: '挂载' },
  { key: 'environment', label: '环境变量' },
] as const;
type Tab = (typeof tabs)[number]['key'];
const activeTab = ref<Tab>('overview');
const focusedTab = ref<Tab>('overview');
const panelId = useId();

function moveTabFocus(event: KeyboardEvent) {
  const buttons = Array.from(
    (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  const index = tabs.findIndex((tab) => tab.key === focusedTab.value);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : event.key === 'ArrowRight'
          ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (index + tabs.length - 1) % tabs.length
            : -1;
  if (next < 0) return;
  event.preventDefault();
  buttons[next]?.focus();
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
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString('zh-CN', { hour12: false });
}

const stateLabels = new Map([
  ['created', '已创建'],
  ['running', '运行中'],
  ['paused', '已暂停'],
  ['restarting', '重启中'],
  ['exited', '已退出'],
  ['removing', '删除中'],
  ['dead', '已失效'],
]);
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
    名称: fieldText(detail.name).replace(/^\//, ''),
    镜像: fieldText(detail.image),
    '容器 ID': props.containerId,
    运行状态: stateLabels.get(status) ?? status,
    健康检查: health ? (healthLabels.get(health) ?? health) : '未报告',
    '主进程 PID（主机）': typeof state.Pid === 'number' && state.Pid > 0 ? state.Pid : '—',
    创建时间: dateTime(detail.created),
    最近启动: dateTime(state.StartedAt),
    最近退出: dateTime(state.FinishedAt),
    退出码: state.Running === false ? fieldText(state.ExitCode) : '—',
    重启策略: typeof policy.Name === 'string' ? (policyLabels.get(restart) ?? restart) : '',
    ...(restart === 'on-failure' && retries
      ? { 最大重试次数: retries === '0' ? '不限' : retries }
      : {}),
    ...(state.OOMKilled === true ? { 退出原因: '因内存不足被终止' } : {}),
    ...(fieldText(state.Error) ? { 状态错误: fieldText(state.Error) } : {}),
  };
});

const ports = computed(() =>
  Object.entries(fields(props.detail.ports)).flatMap(([container, bindings]) =>
    Array.isArray(bindings) && bindings.length
      ? bindings.map((binding: unknown) => ({
          container,
          address: fieldText(fields(binding).HostIp) || '所有接口',
          port: fieldText(fields(binding).HostPort),
        }))
      : [{ container, address: '未发布到主机', port: '—' }],
  ),
);
const mountTypes = new Map([
  ['bind', '绑定挂载'],
  ['volume', '数据卷'],
  ['tmpfs', '内存文件系统'],
  ['npipe', '命名管道'],
]);
const mounts = computed(() =>
  (Array.isArray(props.detail.mounts) ? props.detail.mounts : []).map((value: unknown) => {
    const mount = fields(value);
    const type = fieldText(mount.Type);
    return {
      type: mountTypes.get(type) ?? type,
      source: fieldText(mount.Source),
      name: fieldText(mount.Name),
      target: fieldText(mount.Destination),
      access: mount.RW === true ? '读写' : mount.RW === false ? '只读' : '不可用',
    };
  }),
);
</script>

<template>
  <div class="docker-container-details">
    <div
      class="server-tabs docker-detail-tabs"
      role="tablist"
      aria-label="容器详情分类"
      @keydown="moveTabFocus"
    >
      <button
        v-for="tab in tabs"
        :id="`${panelId}-${tab.key}`"
        :key="tab.key"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.key"
        :aria-controls="panelId"
        :tabindex="focusedTab === tab.key ? 0 : -1"
        @focus="focusedTab = tab.key"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>
    <section
      :id="panelId"
      class="docker-detail-panel"
      role="tabpanel"
      :aria-labelledby="`${panelId}-${activeTab}`"
      tabindex="0"
    >
      <OpsDetails v-if="activeTab === 'overview'" :detail="overview" />
      <ContainerResources
        v-else-if="activeTab === 'resources'"
        :container-id="containerId"
        :query="query"
      />
      <template v-else-if="activeTab === 'ports'">
        <p v-if="!ports.length" class="host-empty">此容器没有端口映射。</p>
        <dl v-for="(port, index) in ports" :key="index" class="docker-detail-row">
          <div>
            <dt>容器端口 / 协议</dt>
            <dd>{{ port.container }}</dd>
          </div>
          <div>
            <dt>主机监听地址</dt>
            <dd>{{ port.address }}</dd>
          </div>
          <div>
            <dt>主机端口</dt>
            <dd>{{ port.port || '不可用' }}</dd>
          </div>
        </dl>
      </template>
      <template v-else-if="activeTab === 'mounts'">
        <p v-if="!mounts.length" class="host-empty">此容器没有挂载。</p>
        <dl v-for="(mount, index) in mounts" :key="index" class="docker-detail-row">
          <div>
            <dt>挂载类型</dt>
            <dd>{{ mount.type || '不可用' }}</dd>
          </div>
          <div>
            <dt>主机路径</dt>
            <dd>{{ mount.source || '—' }}</dd>
          </div>
          <div v-if="mount.name">
            <dt>卷名称</dt>
            <dd>{{ mount.name }}</dd>
          </div>
          <div>
            <dt>容器内路径</dt>
            <dd>{{ mount.target || '不可用' }}</dd>
          </div>
          <div>
            <dt>访问模式</dt>
            <dd>{{ mount.access }}</dd>
          </div>
        </dl>
      </template>
      <ContainerEnvironment v-else :container-id="containerId" :query="query" />
    </section>
  </div>
</template>
