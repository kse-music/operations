<script setup lang="ts">
import { tr } from '../i18n/messages';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';

import { computed } from 'vue';
import { useFilesStore } from '../stores/files';
import {
  bytes,
  taskLabels,
  unfinished,
  transferDuration,
  transferRemainingTime,
  type TransferInfo,
} from '../types/files';
const store = useFilesStore();
const props = defineProps<{ hostId: string; history?: boolean; hideHeading?: boolean }>();
const tasks = computed(() =>
  store.tasks.filter(
    (task) =>
      task.hostId === props.hostId &&
      unfinished(task) !== props.history &&
      (!task.dragExport || !props.history),
  ),
);
defineEmits<{ retry: [task: TransferInfo] }>();
function displayedSources(task: TransferInfo): string[] {
  return task.direction === 'upload' ? task.sources.map(displayLocalPath) : task.sources;
}
function displayedDestination(task: TransferInfo): string {
  if (task.dragExport) return tr('拖放到的 Windows 文件夹');
  return task.direction === 'download' ? displayLocalPath(task.destination) : task.destination;
}
</script>
<template>
  <section
    v-if="tasks.length"
    class="transfer-panel"
    :aria-label="history ? tr('已结束的传输') : tr('传输任务')"
  >
    <div v-if="!history && !hideHeading" class="section-heading">
      <h2>{{ tr('传输任务') }}</h2>
      <span>{{ tasks.length }}{{ tr(' 个未完成') }}</span>
    </div>
    <p v-else-if="history" class="subtle">
      {{ tr('关闭此主机后清除记录。重试会从头传输。') }}
    </p>
    <div
      v-for="task in [...tasks].reverse()"
      :key="task.id"
      class="transfer-row"
      :data-task-id="task.id"
    >
      <div>
        <div class="transfer-summary">
          <strong
            >{{ task.direction === 'upload' ? tr('↑ 上传') : tr('↓ 下载') }} ·
            {{ taskLabels[task.state] ?? task.state }}</strong
          ><span class="subtle"
            >{{ task.filesDone }} / {{ task.filesTotal }}{{ tr(' 文件 · 跳过 ')
            }}{{ task.skipped }}</span
          >
        </div>
        <div class="transfer-paths">
          <div>
            <span class="subtle">{{ tr('文件') }}</span>
            <p class="transfer-path" :title="displayedSources(task).join('\n')">
              {{ displayedSources(task).join('、') }}
            </p>
          </div>
          <div>
            <span class="subtle">{{ tr('目标') }}</span>
            <p class="transfer-path" :title="displayedDestination(task)">
              {{ displayedDestination(task) }}
            </p>
          </div>
        </div>
        <progress
          :max="Math.max(task.totalBytes, 1)"
          :value="
            task.totalBytes === 0 && task.state === 'completed'
              ? 1
              : task.totalBytes - task.remainingBytes
          "
        ></progress>
        <dl class="transfer-details">
          <div>
            <dt>{{ tr('已传输') }}</dt>
            <dd>{{ bytes(task.transferredBytes) }}</dd>
          </div>
          <div>
            <dt>{{ tr('总大小') }}</dt>
            <dd>{{ bytes(task.totalBytes) }}</dd>
          </div>
          <div>
            <dt>{{ tr('速度') }}</dt>
            <dd>{{ bytes(task.bytesPerSecond) }}/s</dd>
          </div>
          <div>
            <dt>{{ tr('剩余大小') }}</dt>
            <dd>{{ bytes(task.remainingBytes) }}</dd>
          </div>
          <div>
            <dt>{{ tr('已用时间') }}</dt>
            <dd data-time="elapsed">{{ transferDuration(task.elapsedSeconds) }}</dd>
          </div>
          <div :title="tr('根据平均速度估算剩余数据传输时间，不含校验和提交耗时。')">
            <dt>{{ tr('预计剩余时间') }}</dt>
            <dd data-time="remaining">{{ transferRemainingTime(task) }}</dd>
          </div>
        </dl>
      </div>
      <button
        v-if="['failed', 'cancelled'].includes(task.state)"
        class="button"
        @click="$emit('retry', task)"
      >
        {{ tr(' 重试传输 ') }}
      </button>
    </div>
  </section>
</template>
