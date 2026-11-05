<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ResourceView from '@serverdeck/plugin-sdk/ui/ResourceView.vue';
import ServerTabs from '@serverdeck/plugin-sdk/ui/ServerTabs.vue';
import ProcessDetails from './ProcessDetails.vue';
import type { ServerSection } from '@serverdeck/plugin-sdk/types/server';
const props = defineProps<{
  hostId?: string;
  initialSection?: ServerSection;
  initialTab?: ServerSection;
}>();
const emit = defineEmits<{ section: [section: ServerSection] }>();
const section = ref<ServerSection>(
  (props.initialSection ?? props.initialTab) === 'ports' ? 'ports' : 'processes',
);
watch(
  () => props.initialSection ?? props.initialTab,
  (value) => {
    if (value === 'ports' || value === 'processes') section.value = value;
  },
);
watch(section, (value) => emit('section', value));
const columns = computed(() =>
  section.value === 'processes'
    ? [
        { key: 'pid', label: 'PID' },
        { key: 'user', label: '用户' },
        { key: 'cpu', label: 'CPU %' },
        { key: 'memory', label: '内存 %' },
        { key: 'elapsed', label: '运行秒数' },
        { key: 'command', label: '命令名称' },
      ]
    : [
        { key: 'protocol', label: '协议' },
        { key: 'state', label: '状态' },
        { key: 'local', label: '监听地址' },
        { key: 'peer', label: '对端' },
        { key: 'process', label: '进程（权限允许时）' },
      ],
);
</script>
<template>
  <div class="plugin-server-surface">
    <ServerTabs v-model="section" :sections="['processes', 'ports']" />
    <KeepAlive
      ><ResourceView
        :key="section"
        :host-id="hostId"
        :list-request="{ kind: section === 'ports' ? 'ports' : 'processes' }"
        :columns="columns"
        :row-key="section === 'ports' ? 'local' : 'pid'"
        :sort="section === 'processes' ? 'cpu' : undefined"
        :hint="
          section === 'processes'
            ? 'CPU 为 ps 进程生命周期均值；点击 CPU / 内存标题排序。默认不读取命令参数或环境。'
            : '未获权限的关联进程显示不可用。'
        "
      >
        <template #actions="{ row, busy, inspect }"
          ><button
            v-if="section === 'processes'"
            class="text-button"
            :disabled="busy"
            @click="inspect({ kind: 'process_details', pid: Number(row.pid) }, '进程详情')"
          >
            进程详情 / 信号
          </button></template
        >
        <template #detail="{ detail, ask, query }"
          ><ProcessDetails v-if="detail.pid" :detail="detail" :ask="ask" :query="query"
        /></template> </ResourceView
    ></KeepAlive>
  </div>
</template>
