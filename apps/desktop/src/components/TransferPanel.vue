<script setup lang="ts">
import { tr } from '../i18n/messages';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';

import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
import { computed, ref } from 'vue';
import { useFilesStore } from '../stores/files';
import { useHostsStore } from '../stores/hosts';
import { hostDisplayName } from '../types/hosts';
import {
  bytes,
  taskLabels,
  unfinished,
  transferDuration,
  transferRemainingTime,
  type TransferInfo,
  remoteJoin,
  transferUsesHost,
} from '../types/files';
const store = useFilesStore();
const hosts = useHostsStore();
const hostLabel = (id: string) =>
  hostDisplayName(hosts.catalog?.hosts.find((host) => host.id === id)) || id;
const props = defineProps<{ hostId: string; history?: boolean; hideHeading?: boolean }>();
const tasks = computed(() =>
  store.tasks.filter(
    (task) =>
      transferUsesHost(task, props.hostId) &&
      unfinished(task) !== props.history &&
      (!task.dragExport || !props.history),
  ),
);
defineEmits<{ retry: [task: TransferInfo] }>();
const decisions = ref(new Set<string>());
const decisionErrors = ref<Record<string, string>>({});
async function choose(task: TransferInfo, choice: 'restart' | 'cancel') {
  const prompt = task.restartPrompt;
  if (!prompt || decisions.value.has(prompt.token)) return;
  decisions.value.add(prompt.token);
  delete decisionErrors.value[prompt.token];
  try {
    if (choice === 'cancel') await filesApi.cancel(task.id);
    else await filesApi.confirmRestart(task.id, prompt.token);
    await store.poll();
  } catch (error) {
    decisionErrors.value[prompt.token] = errorMessage(error);
  } finally {
    decisions.value.delete(prompt.token);
  }
}
function displayedSources(task: TransferInfo): string[] {
  return !task.remoteCopy && task.direction === 'upload'
    ? task.sources.map(displayLocalPath)
    : task.sources;
}
function displayedDestination(task: TransferInfo): string {
  if (task.dragExport) return tr('拖放到的 Windows 文件夹');
  if (task.remoteCopy)
    return task.remoteName ? remoteJoin(task.destination, task.remoteName) : task.destination;
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
      {{ tr('关闭此主机后清除任务记录。') }}
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
            >{{
              task.remoteCopy
                ? tr('远程复制')
                : task.direction === 'upload'
                  ? tr('↑ 上传')
                  : tr('↓ 下载')
            }}
            · {{ taskLabels[task.state] ?? task.state }}</strong
          ><span class="subtle"
            >{{ task.filesDone }} / {{ task.filesTotal
            }}{{ task.remoteCopy ? tr(' 项目 · 跳过 ') : tr(' 文件 · 跳过 ')
            }}{{ task.skipped }}</span
          >
        </div>
        <p v-if="task.remoteCopy && task.remoteTargetHostId" class="subtle">
          {{ tr('从 {0} 到 {1}', hostLabel(task.hostId), hostLabel(task.remoteTargetHostId)) }}
        </p>
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
        <div v-if="task.state === 'awaitingRestart' && task.restartPrompt" class="upload-resume">
          <p>
            {{ tr('发现未完成的上传') }} · {{ task.restartPrompt.target }} ·
            {{ bytes(task.restartPrompt.partialBytes) }}
          </p>
          <p>{{ tr('源文件、目标或断点大小已变化。要丢弃旧进度并从头上传吗？') }}</p>
          <div class="dialog-actions">
            <button
              type="button"
              class="button"
              :disabled="decisions.has(task.restartPrompt.token)"
              @click="choose(task, 'restart')"
            >
              {{ tr('从头上传') }}
            </button>
            <button
              type="button"
              class="button"
              :disabled="decisions.has(task.restartPrompt.token)"
              @click="choose(task, 'cancel')"
            >
              {{ tr('取消') }}
            </button>
          </div>
          <p v-if="decisionErrors[task.restartPrompt.token]" class="error-text" role="alert">
            {{ decisionErrors[task.restartPrompt.token] }}
          </p>
        </div>
        <p v-if="task.message && unfinished(task)" class="subtle">{{ tr(task.message) }}</p>
        <p v-if="task.resumedBytes" class="subtle">
          {{ tr('已复用') }} · {{ bytes(task.resumedBytes) }}
        </p>
        <p v-if="task.recoveryPaths.length" class="error-text">
          {{ tr('恢复路径') }} · {{ task.recoveryPaths.join('、') }}
        </p>
        <progress
          :max="
            Math.max(
              task.remoteCopy && task.totalBytes === 0 ? task.filesTotal : task.totalBytes,
              1,
            )
          "
          :value="
            task.remoteCopy && task.totalBytes === 0
              ? task.filesDone + task.skipped
              : task.totalBytes === 0 && task.state === 'completed'
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
          <div :title="tr('仅统计数据传输阶段，不含扫描、校验和提交耗时。')">
            <dt>{{ tr('速度') }}</dt>
            <dd>{{ bytes(task.bytesPerSecond) }}/s</dd>
          </div>
          <div>
            <dt>{{ tr('剩余大小') }}</dt>
            <dd>{{ bytes(task.remainingBytes) }}</dd>
          </div>
          <div :title="tr('仅统计数据传输阶段，不含扫描、校验和提交耗时。')">
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
