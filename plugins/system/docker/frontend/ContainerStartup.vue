<script setup lang="ts">
import { tr } from './i18n/messages';

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type { OpsRequest, OpsResponse } from './types';
import { composeYaml } from './compose-yaml';

const props = defineProps<{
  containerId: string;
  query: (request: OpsRequest) => Promise<OpsResponse>;
}>();
const detail = ref<Record<string, unknown> | null>(null);
const loading = ref(true);
const error = ref<string>();
const inspectOnly = ref(false);
let generation = 0;
const yaml = computed(() => (detail.value ? composeYaml(detail.value.configuration) : ''));
const warnings = computed(() =>
  Array.isArray(detail.value?.warnings)
    ? detail.value.warnings.filter((item): item is string => typeof item === 'string')
    : [],
);

async function load(fallback = inspectOnly.value) {
  const token = ++generation;
  loading.value = true;
  detail.value = null;
  error.value = undefined;
  inspectOnly.value = fallback;
  try {
    const response = await props.query({
      kind: 'container_startup',
      id: props.containerId,
      revealEnv: true,
      inspectOnly: fallback,
    });
    if (token !== generation) return;
    const data = response.detail;
    if (
      !response.success ||
      data?.id !== props.containerId ||
      !['compose', 'inspect'].includes(String(data.source)) ||
      !data.configuration ||
      typeof data.configuration !== 'object' ||
      !('services' in data.configuration) ||
      data.environmentRevealed !== true
    )
      throw new Error(tr('未能读取此容器的启动配置。'));
    detail.value = data;
  } catch (cause) {
    if (token === generation) error.value = errorMessage(cause);
  } finally {
    if (token === generation) loading.value = false;
  }
}
onMounted(() => load());
onBeforeUnmount(() => {
  ++generation;
  detail.value = null;
});
</script>

<template>
  <div class="docker-startup">
    <p v-if="loading" class="host-empty" role="status">{{ tr('正在读取启动配置…') }}</p>
    <template v-else-if="error">
      <p class="banner error" role="alert">{{ error }}</p>
      <div class="docker-startup-toolbar">
        <button class="button" type="button" @click="load()">{{ tr('重试') }}</button>
        <button v-if="!inspectOnly" class="button" type="button" @click="load(true)">
          {{ tr(' 使用容器信息转换 ') }}
        </button>
      </div>
    </template>
    <template v-else-if="detail">
      <div class="docker-startup-toolbar">
        <span class="subtle">
          {{
            detail.source === 'compose'
              ? `Compose · ${detail.project} / ${detail.service}`
              : tr('容器信息转换 · Compose 格式')
          }}
        </span>
      </div>
      <p v-for="warning in warnings" :key="warning" class="subtle">{{ tr(warning) }}</p>
      <p class="subtle">{{ tr('环境变量可能包含敏感值，切换标签或关闭详情时会清除。') }}</p>
      <pre
        class="docker-startup-yaml"
        :aria-label="tr('Compose 启动配置')"
      ><code>{{ yaml }}</code></pre>
    </template>
    <p v-else class="host-empty">{{ tr('此容器没有可用的启动配置。') }}</p>
  </div>
</template>
