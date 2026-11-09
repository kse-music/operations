<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type { OpsRequest, OpsResponse } from './types';

const props = defineProps<{
  containerId: string;
  query: (request: OpsRequest) => Promise<OpsResponse>;
}>();
const metrics = [
  { key: 'CPUPerc', label: 'CPU 使用率' },
  { key: 'MemUsage', label: '内存用量 / 上限' },
  { key: 'MemPerc', label: '内存使用率' },
  { key: 'NetIO', label: '网络 I/O' },
  { key: 'BlockIO', label: '磁盘 I/O' },
  { key: 'PIDs', label: '进程数' },
];
const stats = ref<Record<string, unknown>>();
const loading = ref(true);
const error = ref<string>();

onMounted(async () => {
  try {
    const { records } = await props.query({ kind: 'container_stats', id: props.containerId });
    stats.value = records[0];
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="docker-resources" aria-label="资源使用" :aria-busy="loading">
    <p v-if="loading" class="host-empty" role="status">正在读取资源使用…</p>
    <p v-else-if="error" class="banner error" role="alert">{{ error }}</p>
    <dl v-else-if="stats" class="ops-detail-fields">
      <div v-for="{ key, label } in metrics" :key="key">
        <dt>{{ label }}</dt>
        <dd>{{ stats[key] ?? '不可用' }}</dd>
      </div>
    </dl>
    <p v-else class="host-empty">暂无资源使用数据。</p>
  </section>
</template>
