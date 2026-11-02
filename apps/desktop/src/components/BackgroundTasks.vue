<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { computed, ref } from 'vue';
import Modal from './Modal.vue';
import TransferPanel from './TransferPanel.vue';
import { useBackgroundStore } from '../stores/background';
import { useAutomationStore } from '../stores/automation';
import { useHostsStore } from '../stores/hosts';
import { tasksApi } from '../services/tasks';
import { errorMessage } from '../services/ipc';
import { taskLabels } from '../types/tasks';
import type { BackgroundTask, WorkspaceView } from '../types/product';
import { hostDisplayName } from '../types/hosts';
const emit = defineEmits<{ close: []; navigate: [view: WorkspaceView, hostId?: string] }>();
const background = useBackgroundStore(),
  automation = useAutomationStore(),
  hosts = useHostsStore(),
  stopping = ref<BackgroundTask | null>(null),
  error = ref('');
const tasks = computed(() => [...background.tasks].reverse());
function names(ids: string[]) {
  return ids.map((id) => {
    const h = hosts.catalog?.hosts.find((h) => h.id === id);
    return h
      ? `${hostDisplayName(h)} · HostId=${h.id} · 当前配置 ${h.username}@${h.hostname}:${h.port}`
      : id;
  });
}
function open(view: WorkspaceView, hostId = '') {
  emit('navigate', view, hostId);
  emit('close');
}
async function stop() {
  if (!stopping.value) return;
  try {
    const t = stopping.value;
    if (t.kind === 'diagnostic') await tasksApi.stop(t.id);
    else await tasksApi.cancel(t.id, true);
    stopping.value = null;
  } catch (e) {
    error.value = errorMessage(e);
  }
}
useErrorNotifications(error);
</script>
<template>
  <Modal title="后台任务与传输" wide @close="emit('close')"
    ><p class="subtle">
      所有结果归属各自目标。关闭此面板不会停止任务；停止在途远端命令后仍需核对实际状态。
    </p>

    <TransferPanel @retry="(t) => open('files', t.hostId)" />
    <h2>网络与批量任务</h2>
    <p v-if="!tasks.length" class="host-empty">没有网络或批量任务</p>
    <article v-for="t in tasks" :key="t.id" class="ops-detail">
      <strong>{{ t.label }} · {{ taskLabels[t.state] ?? t.state }}</strong>
      <ul v-if="t.hostIds.length">
        <li v-for="name in names(t.hostIds)" :key="name">{{ name }}</li>
      </ul>
      <p v-else>执行来源：本机</p>
      <div class="action-row">
        <button
          class="button"
          @click="open(t.kind === 'batch' ? 'batch' : 'network', t.hostIds[0])"
        >
          查看任务结果</button
        ><button v-if="t.active" class="button" @click="stopping = t">请求停止此任务</button>
      </div>
    </article>
    <h2>自动化任务</h2>
    <p>
      {{ automation.status?.active ?? 0 }} 个活动任务，{{ automation.status?.awaiting ?? 0 }}
      个待确认。
    </p>
    <button class="button" @click="open('automation', hosts.selectedId ?? '')">
      查看自动化历史与全部目标
    </button></Modal
  >
  <Modal v-if="stopping" title="确认停止后台任务" @close="stopping = null"
    ><p>{{ stopping.label }} · {{ stopping.id }}</p>
    <ul>
      <li v-for="name in names(stopping.hostIds)" :key="name">{{ name }}</li>
    </ul>
    <p>将取消排队并请求停止在途操作；远端进程可能仍在运行，已提交文件不会回滚。</p>
    <footer class="dialog-actions">
      <button class="button" @click="stopping = null">继续执行</button
      ><button class="button danger" @click="stop">确认请求停止</button>
    </footer></Modal
  >
</template>
