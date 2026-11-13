<script setup lang="ts">
import { tr } from './i18n/messages';

import { computed, ref, watch } from 'vue';
import ResourceView from './ResourceView.vue';
import ServerTabs from './ServerTabs.vue';
import OpsDetails from './OpsDetails.vue';
import { Container, Layers, CircleCheck, Boxes } from '@lucide/vue';
import { usePlatformContext } from '@serverdeck/plugin-sdk/context';
import { useDockerSummary } from './docker-summary';
import ContainerDetails from './ContainerDetails.vue';
import ComposeDetails from './ComposeDetails.vue';
import './docker.css';
import type { ServerSection } from './types';
import type { PluginUiPage } from '@serverdeck/plugin-sdk/types/plugins';
const props = defineProps<{
  hostId?: string;
  initialSection?: ServerSection;
  page?: PluginUiPage;
}>();
const sections = computed<ServerSection[]>(() => ['containers', 'images', 'compose']);
const emit = defineEmits<{
  section: [section: ServerSection];
}>();
const section = ref<ServerSection>(
  props.initialSection && sections.value.includes(props.initialSection)
    ? props.initialSection
    : sections.value[0]!,
);
const platform = usePlatformContext();
const summary = useDockerSummary(computed(() => props.hostId ?? platform.hostId));
const dataRevision = ref(0);
function refreshSummary() {
  dataRevision.value++;
  void summary.refresh();
}
const summaryItems = computed(() => [
  { label: tr('Docker 版本'), icon: Container, metric: summary.metrics.version },
  { label: tr('本地镜像'), icon: Layers, metric: summary.metrics.images },
  { label: tr('运行容器'), icon: CircleCheck, metric: summary.metrics.containers },
  { label: tr('Compose 配置'), icon: Boxes, metric: summary.metrics.compose },
]);
watch(
  () => props.initialSection,
  (value) => {
    if (value && sections.value.includes(value)) section.value = value;
  },
);
watch(section, (value) => emit('section', value));
const columns = computed(() =>
  section.value === 'containers'
    ? [
        { key: 'Names', label: tr('容器') },
        { key: 'Image', label: tr('镜像') },
        { key: 'State', label: tr('状态') },
        { key: 'Ports', label: tr('端口映射') },
      ]
    : section.value === 'compose'
      ? [
          { key: 'Name', label: tr('项目') },
          { key: 'Status', label: tr('状态') },
          { key: 'ConfigFiles', label: tr('配置文件') },
        ]
      : [
          { key: 'Repository', label: tr('仓库') },
          { key: 'Tag', label: tr('标签') },
          { key: 'ID', label: tr('镜像 ID') },
          { key: 'Size', label: tr('大小') },
          { key: 'CreatedSince', label: tr('创建时间') },
        ],
);
const activeStates = ['running', 'paused', 'restarting'];
const actionLabels = {
  get start() {
    return tr('启动');
  },
  get stop() {
    return tr('停止');
  },
  get restart() {
    return tr('重启');
  },
  get remove() {
    return tr('删除');
  },
};
</script>
<template>
  <div class="plugin-server-surface docker-workbench">
    <section
      class="docker-summary"
      :aria-label="tr('Docker 全局统计')"
      :aria-busy="summary.loading.value"
    >
      <article
        v-for="item in summaryItems"
        :key="item.label"
        :title="item.metric.error ?? undefined"
      >
        <span class="docker-stat-icon" :class="{ active: item.icon === CircleCheck }">
          <component :is="item.icon" :size="19" aria-hidden="true" />
        </span>
        <div>
          <span>{{ item.label }}</span>
          <strong>{{ item.metric.value ?? (item.metric.loaded ? tr('不可用') : '—') }}</strong>
          <small v-if="item.metric.error" class="docker-stat-error">{{ tr('读取失败') }}</small>
        </div>
      </article>
    </section>
    <ServerTabs v-model="section" :sections="sections" />
    <KeepAlive
      ><ResourceView
        :key="section"
        :host-id="hostId"
        :data-revision="dataRevision"
        :list-request="{
          kind:
            section === 'compose'
              ? 'compose_projects'
              : section === 'images'
                ? 'images'
                : 'containers',
        }"
        :columns="columns"
        :row-key="section === 'compose' ? 'Name' : 'ID'"
        :search-placeholder="
          section === 'compose' ? tr('搜索项目名称、状态或配置文件…') : undefined
        "
        :hint="
          section === 'compose'
            ? tr('管理已有项目；启动不会重新部署，已删除全部容器的项目不在列表中。')
            : undefined
        "
        @refresh="refreshSummary"
      >
        <template #toolbar="{ execute, busy }">
          <template v-if="section === 'containers'">
            <button
              class="button"
              :disabled="busy"
              @click="
                execute({
                  kind: 'container_maintenance',
                  action: 'restart_exited',
                  confirmed: true,
                })
              "
            >
              {{ tr('重启已退出容器') }}
            </button>
          </template>
        </template>
        <template #toolbar-after="{ busy, openImport }">
          <button v-if="section === 'images'" class="button" :disabled="busy" @click="openImport">
            {{ tr('导入镜像') }}
          </button>
        </template>
        <template #cell="{ row, column }">
          <template v-if="column.key === 'Names'"
            ><strong class="resource-cell-main">{{ row.Names }}</strong
            ><span class="resource-cell-sub">{{ String(row.ID).slice(0, 12) }}</span></template
          >
          <template v-else-if="column.key === 'State'"
            ><span
              class="resource-state"
              :class="{ running: String(row.State).toLowerCase() === 'running' }"
              >{{ row.State }}</span
            ><span class="resource-cell-sub">{{ row.Status }}</span></template
          >
          <span v-else :class="{ 'docker-image': column.key === 'Image' }">{{
            row[column.key] ?? tr('不可用')
          }}</span>
        </template>
        <template
          #actions="{ row, busy, inspect, execute, openLog, openShell, openExport, openTransfer }"
        >
          <template v-if="section === 'compose'">
            <button
              class="text-button"
              :disabled="busy"
              @click="
                inspect(
                  { kind: 'compose_services', project: String(row.Name) },
                  tr('{0} · 服务状态', row.Name),
                )
              "
            >
              {{ tr(' 服务 ') }}
            </button>
            <button
              class="text-button"
              :disabled="busy"
              @click="
                openLog(
                  {
                    source: { kind: 'compose', project: String(row.Name) },
                    lines: 200,
                    follow: true,
                  },
                  tr('{0} · 项目日志', row.Name),
                )
              "
            >
              {{ tr(' 日志 ') }}
            </button>
            <button
              v-for="action in ['start', 'stop', 'restart'] as const"
              :key="action"
              class="text-button"
              :class="{ danger: action !== 'start' }"
              :disabled="busy"
              @click="
                execute({
                  kind: 'compose_action',
                  project: String(row.Name),
                  action,
                  confirmed: true,
                })
              "
            >
              {{ { start: tr('启动'), stop: tr('停止'), restart: tr('重启') }[action] }}
            </button>
          </template>
          <template v-else-if="section === 'containers'">
            <button
              class="text-button"
              :disabled="busy"
              @click="
                inspect(
                  {
                    kind: 'container_details',
                    id: String(row.ID),
                    revealEnv: false,
                  },
                  tr('容器详情'),
                )
              "
            >
              {{ tr(' 详情 ') }}
            </button>
            <button
              v-for="action in [
                activeStates.includes(String(row.State).toLowerCase()) ? 'stop' : 'start',
                'restart',
                'remove',
              ] as const"
              :key="action"
              class="text-button"
              :class="{ danger: action !== 'start' }"
              :disabled="busy"
              @click="
                execute(
                  {
                    kind: 'container_action',
                    id: String(row.ID),
                    action,
                    confirmed: true,
                  },
                  String(row.Names || row.ID),
                )
              "
            >
              {{ actionLabels[action] }}
            </button>
            <button
              class="text-button"
              @click="
                openLog(
                  { source: { kind: 'container', id: String(row.ID) }, lines: 200, follow: true },
                  String(row.Names),
                )
              "
            >
              {{ tr(' 日志 ') }}
            </button>
            <button
              class="text-button"
              :disabled="busy"
              @click="openShell(String(row.ID), String(row.Names || ''))"
            >
              Shell
            </button>
          </template>
          <template v-else>
            <button
              class="text-button"
              :disabled="busy"
              @click="
                execute(
                  {
                    kind: 'image_remove',
                    id: String(row.ID),
                    confirmed: true,
                  },
                  [row.Repository, row.Tag]
                    .filter((value) => value && value !== '<none>')
                    .join(':') || String(row.ID),
                )
              "
            >
              {{ tr(' 删除 ') }}
            </button>
            <button class="text-button" :disabled="busy" @click="openExport(row)">
              {{ tr('导出') }}
            </button>
            <button class="text-button" :disabled="busy" @click="openTransfer(row)">
              {{ tr('远程传输') }}
            </button>
          </template>
        </template>
        <template #detail-content="{ detail, query }">
          <ComposeDetails
            v-if="typeof detail.composeProject === 'string' && Array.isArray(detail.services)"
            :detail="detail"
          />
          <ContainerDetails
            v-else-if="typeof detail.id === 'string' && Array.isArray(detail.environment)"
            :key="detail.id"
            :container-id="detail.id"
            :detail="detail"
            :query="query"
          />
          <OpsDetails v-else :detail="detail" />
        </template> </ResourceView
    ></KeepAlive>
  </div>
</template>
