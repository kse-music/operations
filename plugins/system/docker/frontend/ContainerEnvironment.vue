<script setup lang="ts">
import { tr } from './i18n/messages';

import { onBeforeUnmount, onMounted, ref } from 'vue';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type { OpsRequest, OpsResponse } from './types';

const props = defineProps<{
  containerId: string;
  query: (request: OpsRequest) => Promise<OpsResponse>;
}>();
const variables = ref<{ name: string; value: string | null }[]>([]);
const loading = ref(true);
const error = ref<string>();
let disposed = false;

async function load() {
  loading.value = true;
  error.value = undefined;
  try {
    const { detail } = await props.query({
      kind: 'container_details',
      id: props.containerId,
      revealEnv: true,
    });
    if (disposed) return;
    if (
      detail?.id !== props.containerId ||
      detail.environmentRevealed !== true ||
      !Array.isArray(detail.environment)
    )
      throw new Error(tr('未能读取此容器的环境变量。'));
    variables.value = detail.environment
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => {
        const separator = entry.indexOf('=');
        return separator === -1
          ? { name: entry, value: null }
          : { name: entry.slice(0, separator), value: entry.slice(separator + 1) };
      });
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause);
  } finally {
    if (!disposed) loading.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  variables.value = [];
});
</script>

<template>
  <p v-if="loading" class="host-empty" role="status">{{ tr('正在读取环境变量…') }}</p>
  <template v-else-if="error">
    <p class="banner error" role="alert">{{ error }}</p>
    <button type="button" class="button" @click="load">{{ tr('重试') }}</button>
  </template>
  <template v-else-if="variables.length">
    <p class="subtle">{{ tr('环境变量可能包含敏感值，仅在本次详情弹窗内保留，关闭后清除。') }}</p>
    <dl class="docker-env-values">
      <div v-for="({ name, value }, index) in variables" :key="index">
        <dt>{{ name }}</dt>
        <dd>
          <code v-if="value">{{ value }}</code
          ><span v-else>{{ value === '' ? tr('空值') : tr('未设置') }}</span>
        </dd>
      </div>
    </dl>
  </template>
  <p v-else class="host-empty">{{ tr('此容器没有环境变量。') }}</p>
</template>
