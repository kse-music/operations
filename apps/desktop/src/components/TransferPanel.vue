<script setup lang="ts">
import { computed } from 'vue';
import { useFilesStore } from '../stores/files';
import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
import { bytes, taskLabels, unfinished, type TransferInfo } from '../types/files';
const store = useFilesStore();
const props = defineProps<{ hostId: string }>();
const tasks = computed(() => store.tasks.filter((task) => task.hostId === props.hostId));
const pending = computed(() => tasks.value.filter(unfinished).length);
defineEmits<{ retry: [task: TransferInfo] }>();
async function cancel(id: string): Promise<void> {
  try {
    await filesApi.cancel(id);
    await store.poll();
  } catch (cause) {
    store.error = errorMessage(cause);
  }
}
</script>
<template>
  <section v-if="tasks.length" class="transfer-panel" aria-label="传输任务">
    <div class="section-heading">
      <h2>传输任务</h2>
      <span>{{ pending }} 个未完成 · 关闭此主机后清除记录</span>
    </div>
    <p class="subtle">
      失败后从头重新传输；不支持断点续传。取消保留已完成文件，提交中的单文件会等待结果。
    </p>
    <div
      v-for="task in [...tasks].reverse()"
      :key="task.id"
      class="transfer-row"
      :data-task-id="task.id"
    >
      <div>
        <strong
          >{{ task.direction === 'upload' ? '↑ 上传' : '↓ 下载' }} ·
          {{ taskLabels[task.state] ?? task.state }}</strong
        ><span class="subtle"
          >{{ task.filesDone }} / {{ task.filesTotal }} 文件 · 跳过 {{ task.skipped }}</span
        >
        <p class="transfer-path" :title="task.destination">
          {{ task.sources.length }} 项 → {{ task.destination }}
        </p>
        <progress
          :max="Math.max(task.totalBytes, 1)"
          :value="
            task.totalBytes === 0 && task.state === 'completed'
              ? 1
              : task.totalBytes - task.remainingBytes
          "
        ></progress>
        <p>
          {{ bytes(task.transferredBytes) }} / {{ bytes(task.totalBytes) }} ·
          {{ bytes(task.bytesPerSecond) }}/s · 剩余 {{ bytes(task.remainingBytes) }}
        </p>
      </div>
      <button
        v-if="unfinished(task)"
        class="button"
        :disabled="task.state === 'cancelling'"
        @click="cancel(task.id)"
      >
        取消传输</button
      ><button
        v-else-if="['failed', 'cancelled'].includes(task.state)"
        class="button"
        @click="$emit('retry', task)"
      >
        重试传输
      </button>
    </div>
  </section>
</template>
