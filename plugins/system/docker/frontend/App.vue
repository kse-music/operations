<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ResourceView from './ResourceView.vue';
import ServerTabs from './ServerTabs.vue';
import OpsDetails from './OpsDetails.vue';
import { Container, Layers, CircleCheck, Box } from '@lucide/vue';
import ContainerDetails from './ContainerDetails.vue';
import './docker.css';
import type { ServerSection } from './types';
import type { PluginUiPage } from '@serverdeck/plugin-sdk/types/plugins';
const props = defineProps<{
  hostId?: string;
  initialSection?: ServerSection;
  page?: PluginUiPage;
}>();
const sections = computed<ServerSection[]>(() => ['containers', 'images']);
const emit = defineEmits<{
  section: [section: ServerSection];
}>();
const section = ref<ServerSection>(
  props.initialSection && sections.value.includes(props.initialSection)
    ? props.initialSection
    : sections.value[0]!,
);
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
        { key: 'Names', label: '容器' },
        { key: 'Image', label: '镜像' },
        { key: 'State', label: '状态' },
        { key: 'Ports', label: '端口映射' },
      ]
    : [
        { key: 'Repository', label: '仓库' },
        { key: 'Tag', label: '标签' },
        { key: 'ID', label: '镜像 ID' },
        { key: 'Size', label: '大小' },
        { key: 'CreatedSince', label: '创建时间' },
      ],
);
const activeStates = ['running', 'paused', 'restarting'];
const actionLabels = { start: '启动', stop: '停止', remove: '删除' };
</script>
<template>
  <div class="plugin-server-surface docker-workbench">
    <ServerTabs v-model="section" :sections="sections" />
    <KeepAlive
      ><ResourceView
        :key="section"
        :host-id="hostId"
        :list-request="{ kind: section === 'images' ? 'images' : 'containers' }"
        :columns="columns"
        row-key="ID"
      >
        <template #summary="{ rows, loading, error }">
          <div class="docker-summary">
            <article>
              <span class="docker-stat-icon"
                ><component :is="section === 'images' ? Layers : Container" :size="19"
              /></span>
              <div>
                <span>{{ section === 'images' ? '本地镜像' : '全部容器' }}</span
                ><strong>{{ loading || error ? '—' : rows.length }}</strong>
              </div>
            </article>
            <article v-if="section === 'containers'">
              <span class="docker-stat-icon active"><CircleCheck :size="19" /></span>
              <div>
                <span>运行中</span
                ><strong>{{
                  loading || error
                    ? '—'
                    : rows.filter((row) => String(row.State).toLowerCase() === 'running').length
                }}</strong>
              </div>
            </article>
            <article v-if="section === 'containers'">
              <span class="docker-stat-icon"><Box :size="19" /></span>
              <div>
                <span>其他状态</span
                ><strong>{{
                  loading || error
                    ? '—'
                    : rows.filter((row) => String(row.State).toLowerCase() !== 'running').length
                }}</strong>
              </div>
            </article>
          </div>
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
            row[column.key] ?? '不可用'
          }}</span>
        </template>
        <template #capabilities="{ value }"
          ><span
            >Docker：{{
              value.dockerState === 'running'
                ? '可用'
                : value.dockerInstalled
                  ? '已安装，Daemon 不可用或权限不足'
                  : '未安装'
            }}</span
          ></template
        >
        <template #actions="{ row, busy, inspect, ask, openLog, openShell }">
          <template v-if="section === 'containers'">
            <button
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
              详情
            </button>
            <button
              v-for="action in [
                activeStates.includes(String(row.State).toLowerCase()) ? 'stop' : 'start',
                'remove',
              ] as const"
              :key="action"
              class="text-button"
              :class="{ danger: action !== 'start' }"
              :disabled="busy"
              @click="
                ask(`容器${actionLabels[action]}`, String(row.ID), {
                  kind: 'container_action',
                  id: String(row.ID),
                  action,
                  confirmed: true,
                })
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
              日志
            </button>
            <button class="text-button" :disabled="busy" @click="openShell(String(row.ID))">
              Shell
            </button>
          </template>
          <button
            v-else
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
            删除
          </button>
        </template>
        <template #detail-content="{ detail, query }">
          <ContainerDetails
            v-if="typeof detail.id === 'string' && Array.isArray(detail.environment)"
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
