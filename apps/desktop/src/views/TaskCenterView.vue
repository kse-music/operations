<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { computed, ref } from 'vue';
import Modal from '../components/Modal.vue';
import TransferPanel from '../components/TransferPanel.vue';
import { useBackgroundStore } from '../stores/background';
import { useHostsStore } from '../stores/hosts';
import { tasksApi } from '../services/tasks';
import { errorMessage } from '../services/ipc';
import { taskLabels } from '../types/tasks';
import type { BackgroundTask, WorkspaceView } from '../types/product';
import { hostDisplayName } from '../types/hosts';
const emit = defineEmits<{ navigate: [view: WorkspaceView, hostId?: string] }>();
const background = useBackgroundStore(),
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
}
async function stop() {
  if (!stopping.value) return;
  try {
    const t = stopping.value;
    await tasksApi.stop(t.id);
    stopping.value = null;
  } catch (e) {
    error.value = errorMessage(e);
  }
}
useErrorNotifications(error);
</script>
<template>
  <section class="page-view" aria-label="任务中心">
    <p class="subtle">
      统一查看文件传输和网络诊断任务。关闭弹窗不会停止任务；停止在途远端命令后仍需核对实际状态。
    </p>

    <TransferPanel @retry="(t) => open('files', t.hostId)" />
    <section class="work-section" aria-label="网络诊断任务">
      <div class="section-heading">
        <h2>网络诊断任务</h2>
        <span>{{ background.pending }} 个活动任务</span>
      </div>
      <p v-if="background.connections === null && !background.error" role="status">
        正在读取后台任务…
      </p>
      <p v-else-if="background.error && !tasks.length" class="subtle">后台任务暂不可用</p>
      <p v-else-if="!tasks.length" class="host-empty">没有网络诊断任务</p>
      <article v-for="t in tasks" :key="t.id" class="ops-detail">
        <strong>{{ t.label }} · {{ taskLabels[t.state] ?? t.state }}</strong>
        <ul v-if="t.hostIds.length">
          <li v-for="name in names(t.hostIds)" :key="name">{{ name }}</li>
        </ul>
        <p v-else>执行来源：本机</p>
        <div class="action-row">
          <button class="button" @click="open('network', t.hostIds[0])">查看任务结果</button
          ><button v-if="t.active" class="button" @click="stopping = t">请求停止此任务</button>
        </div>
      </article>
    </section>
  </section>
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
