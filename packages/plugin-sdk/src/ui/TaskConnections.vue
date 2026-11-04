<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { computed, ref } from 'vue';
import { useHostsStore } from '../stores/hosts';
import { useOpsStore } from '../stores/ops';
import { useFilesStore } from '../stores/files';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import { hostDisplayName, type Host } from '../types/hosts';
const props = defineProps<{ ids: string[]; file?: boolean }>();
const hosts = useHostsStore(),
  ops = useOpsStore(),
  files = useFilesStore(),
  error = ref(''),
  busy = ref(false);
const selected = computed(() => hosts.catalog?.hosts.filter((h) => props.ids.includes(h.id)) ?? []);
function connection(h: Host) {
  const c = props.file ? files.connections[h.id] : ops.connections[h.id];
  return c;
}
async function connect(h: Host) {
  try {
    if (props.file) await files.open(h);
    else await ops.open(h);
  } catch (e) {
    error.value = errorMessage(e);
  }
}
async function all() {
  busy.value = true;
  error.value = '';
  try {
    for (const h of selected.value) await connect(h);
  } finally {
    busy.value = false;
  }
}
async function trust(h: Host, accept: boolean) {
  const c = connection(h);
  const id = c && 'session' in c ? c.session?.id : c && 'id' in c ? c.id : undefined;
  if (!id) return;
  try {
    await terminalApi.trust(id, accept);
  } catch (e) {
    error.value = errorMessage(e);
  }
}
useErrorNotifications(error);
</script>
<template>
  <section class="ops-detail task-connections" aria-label="目标连接">
    <p>
      执行前先建立并核对{{
        file ? '文件' : 'SSH 运维'
      }}连接；连接失败的目标会单独标记未执行，不会自动重试命令。
    </p>
    <button type="button" class="button" :disabled="busy || !selected.length" @click="all">
      连接所选目标
    </button>

    <div v-for="host in selected" :key="host.id" class="task-host">
      <strong>{{ hostDisplayName(host) }}</strong> {{ host.hostname }}:{{ host.port }} ·
      {{ host.username }} ·
      {{ connection(host)?.state ?? '未连接' }}
      <span
        v-if="
          connection(host)?.host &&
          (connection(host)!.host.hostname !== host.hostname ||
            connection(host)!.host.port !== host.port ||
            connection(host)!.host.username !== host.username)
        "
        class="error-text"
        >现有会话仍连接 {{ connection(host)!.host.username }}@{{
          connection(host)!.host.hostname
        }}:{{ connection(host)!.host.port }}；应用新配置前须先断开并重新连接。</span
      >
      <button type="button" class="text-button" @click="connect(host)">连接此目标</button>

      <div v-if="connection(host)?.trust" class="banner">
        首次主机密钥：{{ connection(host)?.trust?.hostname }}:{{ connection(host)?.trust?.port }} ·
        {{ connection(host)?.trust?.algorithm }} ·
        <code>{{ connection(host)?.trust?.fingerprint }}</code>
        <p>请通过可信渠道核对该指纹。</p>
        <div class="action-row">
          <button type="button" class="button" @click="trust(host, true)">已核对，信任此指纹</button
          ><button type="button" class="button" @click="trust(host, false)">拒绝</button>
        </div>
      </div>
    </div>
  </section>
</template>
