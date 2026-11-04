<script setup lang="ts">
import { ref } from 'vue';
import OpsTable from '@serverdeck/plugin-sdk/ui/OpsTable.vue';
import { pidPorts } from '@serverdeck/plugin-sdk/services/product-links';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type { OpsRequest, OpsResponse, ContainerShell } from '@serverdeck/plugin-sdk/types/ops';
const props = defineProps<{
  detail: Record<string, unknown>;
  query: (request: OpsRequest) => Promise<OpsResponse>;
  ask: (
    title: string,
    target: string,
    request?: OpsRequest,
    shell?: ContainerShell,
    asDetail?: boolean,
  ) => void;
}>();
const signal = ref<'TERM' | 'KILL' | 'INT' | 'HUP'>('TERM'),
  ports = ref<Record<string, unknown>[] | null>(null),
  error = ref('');
let sequence = 0;
async function related() {
  const token = ++sequence,
    pid = Number(props.detail.pid),
    identity = props.detail.startTicks;
  try {
    const value = await props.query({ kind: 'ports' });
    if (token === sequence && props.detail.pid === pid && props.detail.startTicks === identity)
      ports.value = pidPorts(value.records, pid);
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
</script>
<template>
  <div class="ops-toolbar">
    <span>PID {{ detail.pid }}</span
    ><button class="button" @click="related">查看关联监听端口</button
    ><select v-model="signal" aria-label="进程信号">
      <option>TERM</option>
      <option>KILL</option>
      <option>INT</option>
      <option>HUP</option></select
    ><button
      class="button danger"
      @click="
        ask(`向 PID ${detail.pid} 发送 ${signal}`, String(detail.pid), {
          kind: 'signal',
          pid: Number(detail.pid),
          startTicks: String(detail.startTicks),
          bootId: String(detail.bootId),
          signal,
          confirmed: true,
        })
      "
    >
      发送信号…
    </button>
  </div>
  <p v-if="error" class="banner error" role="alert">{{ error }}</p>
  <section v-if="ports" aria-label="进程关联端口">
    <p class="subtle">只显示 ss 明确报告此 PID 的监听项；权限不足时可能没有关联信息。</p>
    <OpsTable
      :rows="ports"
      :columns="[
        { key: 'protocol', label: '协议' },
        { key: 'local', label: '地址' },
        { key: 'process', label: '进程' },
      ]"
      row-key="local"
      filter=""
    />
  </section>
</template>
