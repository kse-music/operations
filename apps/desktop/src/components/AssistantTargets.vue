<script setup lang="ts">
import { ref } from 'vue';
import { Server, ShieldCheck } from '@lucide/vue';
import { useOpsStore } from '../stores/ops';
import { hostDisplayName, type Host } from '../types/hosts';
import { stateLabels } from '../types/terminal';
import { errorMessage } from '../services/ipc';
defineProps<{ hosts: Host[]; total: number; busy: boolean; loading?: boolean }>();
const ops = useOpsStore(),
  error = ref(''),
  trusting = ref(false);
async function trust(id: string, accept: boolean) {
  trusting.value = true;
  error.value = '';
  try {
    await ops.trust(accept, id);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    trusting.value = false;
  }
}
</script>
<template>
  <section class="ai-auto-targets" aria-label="自动关联主机">
    <div class="ai-assets-summary">
      <Server :size="16" aria-hidden="true" /><strong>{{
        loading ? '正在读取资产列表…' : `已关联全部 ${total} 台资产`
      }}</strong>
    </div>
    <p>根据问题自动匹配并连接相关主机。</p>
    <div v-for="host in hosts" :key="host.id" class="ai-target-row">
      <div>
        <strong>{{ hostDisplayName(host) }}</strong
        ><span>{{ stateLabels[ops.connections[host.id]?.state ?? 'idle'] ?? '连接中' }}</span>
      </div>
      <p>{{ host.hostname }}:{{ host.port }}</p>
      <div v-if="ops.connections[host.id]?.trust" class="ai-trust-review">
        <p><ShieldCheck :size="13" aria-hidden="true" />首次 SSH 主机密钥需要核验</p>
        <p>
          {{ ops.connections[host.id]?.trust?.hostname }}:{{
            ops.connections[host.id]?.trust?.port
          }}
          · {{ ops.connections[host.id]?.trust?.algorithm }}
        </p>
        <code>{{ ops.connections[host.id]?.trust?.fingerprint }}</code>
        <p>通过可信渠道核对后，才能继续连接。</p>
        <div>
          <button class="button" :disabled="busy || trusting" @click="trust(host.id, true)">
            已核对，信任此指纹</button
          ><button class="button" :disabled="busy || trusting" @click="trust(host.id, false)">
            拒绝
          </button>
        </div>
      </div>
    </div>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  </section>
</template>
