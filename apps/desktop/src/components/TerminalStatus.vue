<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { tr } from '../i18n/messages';
import type { TerminalPaneModel } from '../stores/terminals';
import { stateLabels } from '../types/terminal';

const props = defineProps<{ pane: TerminalPaneModel }>();
const capsLock = ref<boolean | null>(null);
const numLock = ref<boolean | null>(null);
const connection = computed(() => {
  if (props.pane.state !== 'connected') return stateLabels[props.pane.state] ?? tr('未连接');
  if (!props.pane.host) return props.pane.shell || tr('本地终端');
  return props.pane.cipher ? `SSH2 · ${props.pane.cipher}` : tr('SSH2 · 加密算法读取中');
});
function updateLocks(event: KeyboardEvent): void {
  capsLock.value = event.getModifierState('CapsLock');
  numLock.value = event.getModifierState('NumLock');
}
function resetLocks(): void {
  capsLock.value = null;
  numLock.value = null;
}
function lockLabel(name: string, value: boolean | null): string {
  return tr(
    '{0}：{1}',
    name,
    value === null ? tr('未知（等待键盘输入）') : value ? tr('开启') : tr('关闭'),
  );
}
onMounted(() => {
  window.addEventListener('keydown', updateLocks, true);
  window.addEventListener('keyup', updateLocks, true);
  window.addEventListener('blur', resetLocks);
  window.addEventListener('focus', resetLocks);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', updateLocks, true);
  window.removeEventListener('keyup', updateLocks, true);
  window.removeEventListener('blur', resetLocks);
  window.removeEventListener('focus', resetLocks);
});
</script>

<template>
  <div class="terminal-status" role="group" tabindex="0" :aria-label="tr('当前终端状态')">
    <span class="terminal-status-connection" :title="connection">{{ connection }}</span>
    <template v-if="pane.screen">
      <span>{{ tr('光标 {0}:{1}', pane.screen.cursorRow, pane.screen.cursorCol) }}</span>
      <span>{{ tr('{0} 行 × {1} 列', pane.screen.rows, pane.screen.cols) }}</span>
    </template>
    <span :title="tr('终端仿真类型')">xterm-256color</span>
    <span class="terminal-status-locks">
      <span
        :class="{ locked: capsLock === true }"
        :title="lockLabel(tr('大写锁定'), capsLock)"
        :aria-label="lockLabel(tr('大写锁定'), capsLock)"
        >{{ capsLock === null ? 'CAP ?' : 'CAP' }}</span
      >
      <span
        :class="{ locked: numLock === true }"
        :title="lockLabel(tr('数字锁定'), numLock)"
        :aria-label="lockLabel(tr('数字锁定'), numLock)"
        >{{ numLock === null ? 'NUM ?' : 'NUM' }}</span
      >
    </span>
  </div>
</template>
