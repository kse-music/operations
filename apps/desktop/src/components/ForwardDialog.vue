<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Modal from './Modal.vue';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import type { ForwardInfo, ForwardInput } from '../types/connection';
const props = defineProps<{ sessionId: string; hostName: string }>();
const emit = defineEmits<{ close: [] }>();
const items = ref<ForwardInfo[]>([]),
  error = ref<string | null>(null),
  busy = ref(false),
  loading = ref(true);
const draft = ref<ForwardInput>({
  kind: 'local',
  bindAddress: '127.0.0.1',
  listenPort: 0,
  targetHost: '127.0.0.1',
  targetPort: 8080,
  confirmPublic: false,
});
const exposing = computed(
  () => draft.value.bindAddress !== '127.0.0.1' && draft.value.bindAddress !== '::1',
);
const states: Record<string, string> = {
  starting: '启动中',
  running: '运行中',
  stopped: '已停止',
  failed: '失败',
};
let timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false,
  refreshing = false;
async function refresh(): Promise<void> {
  if (disposed || refreshing) return;
  refreshing = true;
  clearTimeout(timer);
  try {
    items.value = await terminalApi.forwardList(props.sessionId);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    refreshing = false;
    loading.value = false;
    if (!disposed) timer = setTimeout(() => void refresh(), 1000);
  }
}
async function start(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const input = { ...draft.value };
    if (input.kind === 'dynamic') {
      input.targetHost = null;
      input.targetPort = null;
    }
    await terminalApi.forwardStart(props.sessionId, input);
    clearTimeout(timer);
    await refresh();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function stop(id: string): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await terminalApi.forwardStop(id);
    clearTimeout(timer);
    await refresh();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
watch(
  () => draft.value.kind,
  (kind) => {
    draft.value.confirmPublic = false;
    if (kind === 'remote' && draft.value.listenPort === 0) draft.value.listenPort = 8080;
  },
);
onMounted(() => void refresh());
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
useErrorNotifications(() => [error.value, ...items.value.map((item) => item.message)]);
</script>
<template>
  <Modal title="端口转发" wide :busy="busy" @close="emit('close')"
    ><p>{{ hostName }} · 转发归属于此终端，关闭终端将停止相关监听和流量。</p>

    <form class="editor-form" @submit.prevent="start">
      <fieldset :disabled="busy" class="form-grid">
        <label
          >转发类型<select v-model="draft.kind" aria-label="转发类型">
            <option value="local">Local Forward</option>
            <option value="remote">Remote Forward</option>
            <option value="dynamic">Dynamic SOCKS5</option>
          </select></label
        ><label
          >监听地址<input
            v-model="draft.bindAddress"
            aria-label="监听地址"
            required
            maxlength="64" /></label
        ><label
          >监听端口<input
            v-model.number="draft.listenPort"
            aria-label="监听端口"
            type="number"
            :min="draft.kind === 'remote' ? 1 : 0"
            max="65535"
            required
        /></label>
        <p class="subtle full-width">
          {{
            draft.kind === 'remote'
              ? '远程服务器监听；请确认服务器 GatewayPorts 策略不会扩大绑定范围。'
              : '本机监听；端口 0 自动分配空闲端口。'
          }}
        </p>
        <template v-if="draft.kind !== 'dynamic'"
          ><label
            >{{ draft.kind === 'remote' ? '本机目标地址' : '远端目标地址'
            }}<input
              v-model="draft.targetHost"
              aria-label="转发目标地址"
              required
              maxlength="253" /></label
          ><label
            >目标端口<input
              v-model.number="draft.targetPort"
              aria-label="转发目标端口"
              type="number"
              min="1"
              max="65535"
              required /></label
        ></template>
        <p v-else class="subtle full-width">
          SOCKS5 CONNECT，通过 SSH 服务器解析目标；不支持
          UDP/BIND。动态代理不提供密码验证，请限制可访问的网络。
        </p>
        <label v-if="exposing" class="checkbox-label full-width"
          ><input
            v-model="draft.confirmPublic"
            type="checkbox"
            required
          />我确认允许非回环监听，可达用户可能通过此转发访问目标网络</label
        >
      </fieldset>
      <footer class="dialog-actions">
        <button class="button primary" :disabled="busy">{{ busy ? '处理中…' : '启动转发' }}</button>
      </footer>
    </form>
    <p v-if="loading">正在读取转发状态…</p>
    <p v-else-if="!items.length" class="subtle">此终端没有转发。</p>
    <div v-for="item in items" :key="item.id" class="forward-row">
      <div>
        <strong
          >{{ item.input.kind }} · {{ item.input.bindAddress }}:{{ item.input.listenPort }}</strong
        >
        <p>
          {{ states[item.state] ?? item.state }} · {{ item.activeConnections }} 条活动连接
          <span v-if="item.input.targetHost"
            >→ {{ item.input.targetHost }}:{{ item.input.targetPort }}</span
          >
        </p>
      </div>
      <button
        class="button"
        :disabled="busy || !['starting', 'running'].includes(item.state)"
        @click="stop(item.id)"
      >
        停止转发
      </button>
    </div>
    <footer class="dialog-actions">
      <button class="button" :disabled="busy" @click="emit('close')">关闭面板</button>
    </footer>
  </Modal>
</template>
