<script setup lang="ts">
import { computed, ref } from 'vue';
import { tr } from '../i18n/messages';
import type { UploadProgress } from '../services/zmodem';
import { bytes, transferDuration } from '../types/files';
import Modal from './Modal.vue';

const props = defineProps<{ target: string; progress: UploadProgress }>();
const emit = defineEmits<{ cancel: [] }>();
const cancelling = ref(false);
const remainingBytes = computed(() => Math.max(0, props.progress.size - props.progress.sent));
const remainingTime = computed(() => {
  if (props.progress.phase !== 'uploading') return '—';
  if (!remainingBytes.value) return transferDuration(0);
  return props.progress.bytesPerSecond > 0
    ? transferDuration(Math.ceil(remainingBytes.value / props.progress.bytesPerSecond))
    : tr('估算中');
});
const status = computed(() => {
  if (cancelling.value) return tr('正在结束上传…');
  if (props.progress.phase === 'finishing') return tr('ZMODEM：等待远端确认完成…');
  return tr('正在上传…');
});
function cancel(): void {
  if (cancelling.value) return;
  cancelling.value = true;
  emit('cancel');
}
</script>

<template>
  <Modal
    v-if="progress.phase !== 'choosing' && progress.files.length > 0"
    :title="tr('终端文件上传')"
    :busy="cancelling"
    :close-label="tr('取消上传')"
    @close="cancel"
  >
    <p>{{ tr('上传到') }} {{ target }}{{ tr(' 的当前 Shell 目录：') }}</p>
    <ul v-if="progress.files.length" class="terminal-drop-items">
      <li v-for="(file, index) in progress.files" :key="index">{{ file }}</li>
    </ul>
    <div class="terminal-drop-progress" role="status" aria-live="polite">
      <div class="terminal-drop-status">
        <span>{{ status }}</span>
        <span v-if="progress.name" class="terminal-drop-destination">{{ progress.name }}</span>
      </div>
      <progress
        v-if="progress.phase === 'uploading' && !cancelling"
        :value="progress.sent"
        :max="progress.size || 1"
        :aria-label="tr('ZMODEM 上传进度')"
      ></progress>
      <progress v-else :aria-label="tr('ZMODEM 上传进度')"></progress>
      <template v-if="progress.name">
        <div class="terminal-drop-statistics">
          {{ bytes(progress.sent) }} / {{ bytes(progress.size) }}
          <template v-if="progress.phase === 'uploading' && !cancelling">
            · <span :aria-label="tr('平均上传速度')">{{ bytes(progress.bytesPerSecond) }}/s</span>
          </template>
          {{ tr(' · 剩余 ') }}{{ bytes(remainingBytes) }}
        </div>
        <div class="terminal-drop-times">
          <span data-time="elapsed">
            {{ tr('已用时间：{0}', transferDuration(progress.elapsedSeconds)) }}
          </span>
          <span
            data-time="remaining"
            :title="tr('根据平均速度估算剩余数据传输时间，不含校验和提交耗时。')"
          >
            {{ tr('预计剩余时间：{0}', cancelling ? '—' : remainingTime) }}
          </span>
        </div>
      </template>
    </div>
    <footer class="dialog-actions">
      <button class="button" :disabled="cancelling" @click="cancel">
        {{ cancelling ? tr('正在结束上传…') : tr('取消上传') }}
      </button>
    </footer>
  </Modal>
</template>
