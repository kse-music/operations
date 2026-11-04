<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ResourceView from '@serverdeck/plugin-sdk/ui/ResourceView.vue';
import ServerTabs from '@serverdeck/plugin-sdk/ui/ServerTabs.vue';
import type { ContainerAction, LogInput, ContainerShell } from '@serverdeck/plugin-sdk/types/ops';
import type { Host } from '@serverdeck/plugin-sdk/types/hosts';
import type { ServerSection } from '@serverdeck/plugin-sdk/types/server';
const props = defineProps<{ hostId?: string; initialSection?: ServerSection }>();
const emit = defineEmits<{
  section: [section: ServerSection];
  log: [input: LogInput, title: string];
  shell: [host: Host, shell: ContainerShell];
}>();
const section = ref<ServerSection>(props.initialSection === 'images' ? 'images' : 'containers');
watch(
  () => props.initialSection,
  (value) => {
    if (value === 'images' || value === 'containers') section.value = value;
  },
);
watch(section, (value) => emit('section', value));
const columns = computed(() =>
  section.value === 'containers'
    ? [
        { key: 'ID', label: 'ID' },
        { key: 'Names', label: '名称' },
        { key: 'Image', label: '镜像' },
        { key: 'State', label: '状态' },
        { key: 'Status', label: '运行状态' },
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
</script>
<template>
  <div class="plugin-server-surface">
    <ServerTabs v-model="section" :sections="['containers', 'images']" />
    <ResourceView
      :key="section"
      :host-id="hostId"
      :list-request="{ kind: section === 'images' ? 'images' : 'containers' }"
      :columns="columns"
      row-key="ID"
      @log="(input, title) => emit('log', input, title)"
      @shell="(host, shell) => emit('shell', host, shell)"
    >
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
      <template #actions="{ row, busy, inspect, ask, openLog }">
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
            class="text-button"
            :disabled="busy"
            @click="inspect({ kind: 'container_stats', id: String(row.ID) }, '容器资源使用')"
          >
            资源
          </button>
          <button
            v-for="action in ['start', 'stop', 'restart', 'remove'] as ContainerAction[]"
            :key="action"
            class="text-button"
            :disabled="busy"
            @click="
              ask(`容器 ${action}`, String(row.ID), {
                kind: 'container_action',
                id: String(row.ID),
                action,
                confirmed: true,
              })
            "
          >
            {{ { start: '启动', stop: '停止', restart: '重启', remove: '删除' }[action] }}
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
          <button
            class="text-button"
            @click="
              ask('进入容器 Shell', String(row.ID), undefined, {
                id: String(row.ID),
                bash: false,
                confirmed: true,
              })
            "
          >
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
          删除镜像
        </button>
      </template>
      <template #detail="{ detail, ask }">
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
              {
                kind: 'container_details',
                id: String(detail.id),
                revealEnv: true,
                confirmed: true,
              },
              undefined,
              true,
            )
          "
        >
          显示环境变量值…
        </button>
      </template>
    </ResourceView>
  </div>
</template>
