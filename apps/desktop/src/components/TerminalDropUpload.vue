<script setup lang="ts">
import { tr } from '../i18n/messages';

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import { TerminalDropUpload, type DropProgress } from '../services/terminal-drop';
import type { TerminalDropSelection, TerminalFileDrag } from '../types/terminal';
import { bytes, transferDuration } from '../types/files';
import Modal from './Modal.vue';

const props = defineProps<{
  sessionId: string;
  target: string;
  enabled: boolean;
  canReceive: () => boolean;
  area?: HTMLElement;
  send: (id: string, data: Uint8Array) => Promise<void>;
  interrupt: (id: string) => Promise<void>;
}>();
const emit = defineEmits<{
  error: [error: unknown];
  activate: [sessionId: string];
  closed: [sessionId: string];
}>();
const selected = ref<TerminalDropSelection | null>(null);
const progress = ref<DropProgress | null>(null);
const remainingBytes = computed(() =>
  Math.max(0, (progress.value?.size ?? 0) - (progress.value?.sent ?? 0)),
);
const remainingTime = computed(() => {
  const value = progress.value;
  if (value?.phase !== 'uploading') return '—';
  if (remainingBytes.value === 0) return transferDuration(0);
  return value.bytesPerSecond > 0
    ? transferDuration(Math.ceil(remainingBytes.value / value.bytesPerSecond))
    : tr('估算中');
});
const over = ref(false);
const claiming = ref(false);
const confirmed = ref(false);
const failure = ref('');
const dialogOpen = computed(() => !!(selected.value || progress.value || failure.value));
const busy = computed(
  () => claiming.value || !!progress.value || (!!selected.value && !confirmed.value),
);
let transfer: TerminalDropUpload | undefined;
let running: Promise<void> | undefined;
let unlisten: UnlistenFn | undefined;
let disposed = false;
const id = props.sessionId;
const phaseNames: Record<DropProgress['phase'], string> = {
  get preparing() {
    return tr('正在准备文件与目录…');
  },
  get starting() {
    return tr('等待当前 Shell 接收…');
  },
  get uploading() {
    return tr('正在上传…');
  },
  get verifying() {
    return tr('正在校验并解包…');
  },
  get committing() {
    return tr('正在提交文件…');
  },
  get cancelling() {
    return tr('正在停止上传并恢复终端…');
  },
  get blocked() {
    return tr('接收状态未确定，请关闭此会话后重新打开。');
  },
};
function eligible(): boolean {
  return !disposed && props.enabled && props.canReceive() && !props.area?.closest('[inert]');
}
function inside(event: Exclude<TerminalFileDrag, { type: 'leave' }>): boolean {
  if (!eligible() || document.querySelector('dialog[open]')) return false;
  const box = props.area?.getBoundingClientRect();
  if (!box || box.width <= 0 || box.height <= 0) return false;
  const x = event.x / window.devicePixelRatio,
    y = event.y / window.devicePixelRatio;
  return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
}
async function drag(event: TerminalFileDrag): Promise<void> {
  if (event.type === 'leave') {
    over.value = false;
    return;
  }
  const hit = inside(event);
  over.value = hit && event.type === 'over' && !busy.value;
  if (!hit || event.type === 'over') return;
  over.value = false;
  if (busy.value) {
    emit('error', new Error(tr('当前终端已有待确认或进行中的上传。')));
    return;
  }
  emit('activate', id);
  if (event.type === 'error') {
    failure.value = event.message;
    confirmed.value = true;
    return;
  }
  claiming.value = true;
  failure.value = '';
  confirmed.value = false;
  try {
    const selection = await terminalApi.claimDrop(id, event.grant);
    if (disposed) await terminalApi.uploadRelease(id, selection.token);
    else selected.value = selection;
  } catch (error) {
    if (!disposed) {
      failure.value = errorMessage(error);
      confirmed.value = true;
    } else emit('error', error);
  } finally {
    claiming.value = false;
  }
}
async function dismiss(): Promise<void> {
  const selection = selected.value;
  selected.value = null;
  failure.value = '';
  if (selection && !confirmed.value) {
    try {
      await terminalApi.uploadRelease(id, selection.token);
    } catch (error) {
      emit('error', error);
    }
  }
  confirmed.value = false;
}
function start(): void {
  const selection = selected.value;
  if (!selection || !eligible()) {
    void dismiss();
    return;
  }
  confirmed.value = true;
  failure.value = '';
  const current = new TerminalDropUpload({
    prepare: () => terminalApi.prepareDrop(id, selection.token),
    read: (offset) => terminalApi.uploadRead(id, selection.token, 0, offset),
    release: () => terminalApi.uploadRelease(id, selection.token),
    send: (data) => props.send(id, data),
    interrupt: () => props.interrupt(id),
    write: (data) => {
      // Protocol parsing returns ordinary output to TerminalPane synchronously.
      output.push(data);
    },
    progress: (value) => {
      if (!disposed) progress.value = value;
    },
    failed: (error) => {
      if (!disposed) failure.value = errorMessage(error);
      else emit('error', error);
    },
  });
  transfer = current;
  running = current.run().then(() => {
    if (!disposed && !failure.value) {
      selected.value = null;
      confirmed.value = false;
    }
  });
}
// A PTY packet can contain both control frames and ordinary Shell output.
let output: Uint8Array[] = [];
function consume(data: Uint8Array): Uint8Array | undefined {
  if (disposed && confirmed.value) return new Uint8Array();
  if (!transfer || (!transfer.busy && !transfer.pendingOutput)) return undefined;
  output = [];
  transfer.consume(data);
  const bytes = new Uint8Array(output.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of output) {
    bytes.set(part, offset);
    offset += part.length;
  }
  output = [];
  return bytes;
}
function cancel(): void {
  if (selected.value && !confirmed.value) void dismiss();
  else transfer?.cancel();
}
async function stop(): Promise<void> {
  if (!confirmed.value) await dismiss();
  transfer?.cancel();
  await running;
}
function dispose(): void {
  const interrupted = confirmed.value && !!progress.value;
  disposed = true;
  transfer?.dispose();
  if (interrupted) failure.value = tr('终端会话已结束，上传已停止。请核对远端已提交的文件。');
  else if (!confirmed.value) void dismiss();
  progress.value = null;
  claiming.value = false;
  over.value = false;
}
async function closeSession(): Promise<void> {
  try {
    await terminalApi.close(id);
    selected.value = null;
    progress.value = null;
    failure.value = '';
  } catch (error) {
    failure.value = errorMessage(error);
  }
}
defineExpose({ busy, consume, cancel, dispose, stop });
watch(
  dialogOpen,
  async (open, wasOpen) => {
    if (open || !wasOpen || disposed) return;
    await nextTick();
    if (!disposed && !dialogOpen.value) emit('closed', id);
  },
  { flush: 'post' },
);
watch(
  () => props.enabled,
  (value) => {
    if (!value) {
      over.value = false;
      if (!confirmed.value) void dismiss();
    }
  },
);
onMounted(async () => {
  if (!isTauri()) return;
  try {
    const release = await listen<TerminalFileDrag>('terminal-file-drag', (event) => {
      void drag(event.payload);
    });
    if (disposed) release();
    else unlisten = release;
  } catch (error) {
    emit('error', new Error(tr('终端拖放入口不可用：') + errorMessage(error)));
  }
});
onBeforeUnmount(() => {
  dispose();
  unlisten?.();
});
</script>
<template>
  <div v-if="over" class="terminal-drop-overlay" role="status">
    {{ tr('松开后确认上传到当前 Shell 目录') }}
  </div>
  <Modal
    v-if="dialogOpen"
    :title="confirmed ? tr('终端文件上传') : tr('确认终端拖放上传')"
    :busy="!!progress"
    @close="dismiss"
  >
    <p>
      {{ confirmed ? tr('上传到') : tr('将上传到') }} {{ target }}{{ tr(' 的当前 Shell 目录：') }}
    </p>
    <ul v-if="selected" class="terminal-drop-items">
      <li v-for="(item, index) in selected.names" :key="index">{{ item }}</li>
    </ul>
    <template v-if="!confirmed">
      <p>{{ tr('请先回到空白 Shell 提示符，不要停留在编辑器、运行中的命令或密码输入界面。') }}</p>
      <p class="subtle">
        {{
          tr(
            ' 使用当前 Shell 的用户身份；sudo -i 后使用切换后的身份和目录。遇到同名文件或文件夹即停止，不覆盖、不合并。上传期间占用此窗格输入。 ',
          )
        }}
      </p>
    </template>
    <div v-if="progress" class="terminal-drop-progress" role="status" aria-live="polite">
      <div class="terminal-drop-status">
        <span>{{ phaseNames[progress.phase] }}</span>
        <span v-if="progress.directory" class="terminal-drop-destination">
          {{ progress.username || `UID ${progress.uid}` }} · {{ progress.directory }}
        </span>
      </div>
      <progress
        v-if="progress.phase === 'uploading'"
        :value="progress.sent"
        :max="progress.size || 1"
        :aria-label="tr('拖放上传进度')"
      ></progress>
      <progress
        v-else-if="!['blocked', 'cancelling'].includes(progress.phase)"
        :aria-label="tr('拖放上传进度')"
      ></progress>
      <div v-if="progress.size" class="terminal-drop-statistics">
        {{ bytes(progress.sent) }} / {{ bytes(progress.size) }}
        <template v-if="progress.phase === 'uploading'">
          · <span :aria-label="tr('平均上传速度')">{{ bytes(progress.bytesPerSecond) }}/s</span>
        </template>
        {{ tr(' · 剩余 ') }}{{ bytes(remainingBytes) }}
      </div>
      <div
        v-if="['uploading', 'verifying', 'committing'].includes(progress.phase)"
        class="terminal-drop-times"
      >
        <span data-time="elapsed">
          {{ tr('已用时间：{0}', transferDuration(progress.elapsedSeconds)) }}
        </span>
        <span
          data-time="remaining"
          :title="tr('根据平均速度估算剩余数据传输时间，不含校验和提交耗时。')"
        >
          {{ tr('预计剩余时间：{0}', remainingTime) }}
        </span>
      </div>
    </div>
    <p v-if="failure" class="banner error" role="alert">{{ failure }}</p>
    <footer class="dialog-actions">
      <template v-if="!confirmed">
        <button class="button" @click="dismiss">{{ tr('取消') }}</button>
        <button class="button primary" @click="start">{{ tr('确认上传') }}</button>
      </template>
      <button v-else-if="progress?.phase === 'blocked'" class="button" @click="closeSession">
        {{ tr(' 关闭此终端会话 ') }}
      </button>
      <button
        v-else-if="progress && progress.phase !== 'cancelling'"
        class="button"
        @click="cancel"
      >
        {{ tr(' 取消上传 ') }}
      </button>
      <button v-else-if="progress || !failure" class="button" disabled>
        {{ tr('正在结束上传…') }}
      </button>
      <button v-else class="button" @click="dismiss">{{ tr('关闭') }}</button>
    </footer>
  </Modal>
</template>
