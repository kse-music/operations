<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import OpsLogPanel from './OpsLogPanel.vue';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import { hostDisplayName } from '@serverdeck/plugin-sdk/types/hosts';
import type { LogInput } from '@serverdeck/plugin-sdk/types/ops';
const props = defineProps<{
  hostId: string;
  logIntent?: { input: LogInput; title: string; sequence: number };
}>();
const ops = useOpsStore(),
  logs = ref<InstanceType<typeof OpsLogPanel>>();
const connection = computed(() => ops.connections[props.hostId]);
watch(
  [() => props.logIntent, () => connection.value?.state],
  async ([intent, state]) => {
    if (intent && typeof intent !== 'string' && state === 'connected') {
      await nextTick();
      await logs.value?.open(intent.input, intent.title);
    }
  },
  { immediate: true, flush: 'post' },
);
</script>
<template>
  <section class="operations-view">
    <OpsLogPanel
      v-if="connection?.state === 'connected' && connection.session"
      :key="connection.session.id"
      ref="logs"
      :session-id="connection.session.id"
      :host-name="hostDisplayName(connection.host)"
    />
    <p v-else class="host-empty">请选择主机并建立运维连接后读取日志。</p>
  </section>
</template>
