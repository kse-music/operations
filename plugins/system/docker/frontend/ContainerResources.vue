<script setup lang="ts">
import { tr } from './i18n/messages';

import { onMounted, ref } from 'vue';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type { OpsRequest, OpsResponse } from './types';

const props = defineProps<{
  containerId: string;
  query: (request: OpsRequest) => Promise<OpsResponse>;
}>();
const metrics = [
  {
    key: 'CPUPerc',
    get label() {
      return tr('CPU 使用率');
    },
  },
  {
    key: 'MemUsage',
    get label() {
      return tr('内存用量 / 上限');
    },
  },
  {
    key: 'MemPerc',
    get label() {
      return tr('内存使用率');
    },
  },
  {
    key: 'NetIO',
    get label() {
      return tr('网络 I/O');
    },
  },
  {
    key: 'BlockIO',
    get label() {
      return tr('磁盘 I/O');
    },
  },
  {
    key: 'PIDs',
    get label() {
      return tr('进程数');
    },
  },
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
  <section class="docker-resources" :aria-label="tr('资源使用')" :aria-busy="loading">
    <p v-if="loading" class="host-empty" role="status">{{ tr('正在读取资源使用…') }}</p>
    <p v-else-if="error" class="banner error" role="alert">{{ error }}</p>
    <dl v-else-if="stats" class="ops-detail-fields">
      <div v-for="{ key, label } in metrics" :key="key">
        <dt>{{ label }}</dt>
        <dd>{{ stats[key] ?? tr('不可用') }}</dd>
      </div>
    </dl>
    <p v-else class="host-empty">{{ tr('暂无资源使用数据。') }}</p>
  </section>
</template>
