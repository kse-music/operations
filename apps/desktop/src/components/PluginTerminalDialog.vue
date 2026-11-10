<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import {
  Eraser,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Search,
  Terminal,
  X,
} from '@lucide/vue';
import type { TerminalPresentation } from '@serverdeck/plugin-sdk/terminal';
import type { Host } from '../types/hosts';
import { hostDisplayName } from '../types/hosts';
import { stateLabels } from '../types/terminal';
import type { TerminalPaneModel } from '../stores/terminals';
import Modal from './Modal.vue';
import TerminalPane from './TerminalPane.vue';

const props = defineProps<{
  host: Host;
  pluginId: string;
  owner: string;
  ticket: string;
  presentation?: TerminalPresentation;
}>();
const emit = defineEmits<{ close: [] }>();
const terminal = ref<InstanceType<typeof TerminalPane>>();
const expanded = ref(false);
const title = computed(() => props.presentation?.title || '插件终端');
const hostAddress = computed(() => {
  const address = props.host.hostname.includes(':')
    ? `[${props.host.hostname}]`
    : props.host.hostname;
  return `${props.host.username}@${address}:${props.host.port}`;
});
const pane = ref<TerminalPaneModel>({
  key: crypto.randomUUID(),
  host: props.host,
  pluginTerminal: { pluginId: props.pluginId, owner: props.owner, ticket: props.ticket },
  state: 'opening',
  connectRequested: true,
});
const connecting = computed(() =>
  ['opening', 'connecting', 'authenticating'].includes(pane.value.state),
);
const ended = computed(() => ['closed', 'disconnected', 'failed'].includes(pane.value.state));
const status = computed(() =>
  pane.value.state === 'disconnected'
    ? '已断开'
    : (stateLabels[pane.value.state] ?? pane.value.state),
);
async function toggleExpanded(): Promise<void> {
  expanded.value = !expanded.value;
  await nextTick();
  terminal.value?.focus();
}
</script>
<template>
  <Modal
    :title="`${title} · ${hostDisplayName(host)}`"
    :panel-class="`plugin-terminal-dialog${expanded ? ' is-expanded' : ''}`"
    @close="emit('close')"
  >
    <template #header>
      <header class="plugin-terminal-heading">
        <span class="plugin-terminal-icon"><Terminal :size="22" aria-hidden="true" /></span>
        <div class="plugin-terminal-identity">
          <div class="plugin-terminal-title">
            <h2 :title="title">{{ title }}</h2>
            <span class="plugin-terminal-kind">终端</span>
          </div>
          <p :title="`${hostDisplayName(host)} · ${hostAddress}`">
            {{ hostDisplayName(host) }}<span aria-hidden="true"> · </span>{{ hostAddress }}
          </p>
        </div>
        <span class="plugin-terminal-status" :data-state="pane.state" role="status">
          <LoaderCircle v-if="connecting" :size="12" class="spinning" aria-hidden="true" />
          <span v-else class="plugin-terminal-status-dot" aria-hidden="true"></span>
          {{ status }}
        </span>
        <div class="plugin-terminal-window-actions">
          <button
            class="icon-button"
            :aria-label="expanded ? '还原终端窗口' : '最大化终端窗口'"
            :title="expanded ? '还原终端窗口' : '最大化终端窗口'"
            :aria-pressed="expanded"
            @click="toggleExpanded"
          >
            <Minimize2 v-if="expanded" :size="16" aria-hidden="true" />
            <Maximize2 v-else :size="16" aria-hidden="true" />
          </button>
          <button class="icon-button" aria-label="关闭终端" title="关闭终端" @click="emit('close')">
            <X :size="18" aria-hidden="true" />
          </button>
        </div>
      </header>
    </template>
    <div class="plugin-terminal-toolbar" role="toolbar" aria-label="终端工具栏">
      <span class="plugin-terminal-context" :title="presentation?.description">
        {{ presentation?.description || '交互式 Shell' }}
      </span>
      <div class="plugin-terminal-tools">
        <button
          class="plugin-terminal-find tool-button"
          :aria-pressed="terminal?.finding ?? false"
          @click="terminal?.toggleFind()"
        >
          <Search :size="14" aria-hidden="true" />查找
        </button>
        <span class="plugin-terminal-tool-divider" aria-hidden="true"></span>
        <button
          class="icon-button"
          aria-label="缩小终端字号"
          title="缩小字号"
          :disabled="(terminal?.fontSize ?? 16) <= 10"
          @click="terminal?.zoom('zoomOut')"
        >
          <Minus :size="14" aria-hidden="true" />
        </button>
        <button
          class="plugin-terminal-font tool-button"
          aria-label="重置终端字号"
          title="重置字号"
          @click="terminal?.zoom('zoomReset')"
        >
          {{ terminal?.fontSize ?? 16 }}<span>px</span>
        </button>
        <button
          class="icon-button"
          aria-label="放大终端字号"
          title="放大字号"
          :disabled="(terminal?.fontSize ?? 16) >= 32"
          @click="terminal?.zoom('zoomIn')"
        >
          <Plus :size="14" aria-hidden="true" />
        </button>
        <span class="plugin-terminal-tool-divider" aria-hidden="true"></span>
        <button
          class="icon-button"
          aria-label="清空终端显示"
          title="清空显示（保留远端进程）"
          @click="terminal?.clearScreen()"
        >
          <Eraser :size="15" aria-hidden="true" />
        </button>
      </div>
    </div>
    <p
      v-if="ended"
      class="plugin-terminal-ended"
      :class="{ failed: pane.state === 'failed' }"
      role="status"
    >
      {{
        terminal?.message ||
        (pane.state === 'failed' ? '终端连接失败。' : '终端会话已结束，历史输出已保留。')
      }}
      关闭后可从原入口重新打开。
    </p>
    <div class="plugin-terminal">
      <TerminalPane
        ref="terminal"
        :tab="pane"
        active
        standalone
        @update="(value) => Object.assign(pane, value)"
        @close="emit('close')"
        @action="
          (_key, action) => {
            if (action === 'close') emit('close');
          }
        "
      />
      <div v-if="connecting" class="plugin-terminal-loading" role="status">
        <LoaderCircle :size="22" class="spinning" aria-hidden="true" />
        正在建立终端会话…
      </div>
    </div>
  </Modal>
</template>
<style>
.modal.plugin-terminal-dialog {
  display: flex;
  flex-direction: column;
  width: min(1200px, calc(100vw - 48px));
  height: min(780px, calc(100dvh - 64px));
  max-width: calc(100vw - 24px);
  max-height: calc(100dvh - 24px);
  padding: 0;
  overflow: hidden;
}
.modal.plugin-terminal-dialog.is-expanded {
  width: calc(100vw - 24px);
  height: calc(100dvh - 24px);
}
</style>
<style scoped>
.plugin-terminal-heading {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.plugin-terminal-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--accent-bg);
  color: var(--accent);
}
.plugin-terminal-identity {
  flex: 1;
  min-width: 0;
}
.plugin-terminal-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.plugin-terminal-title h2 {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-section);
  font-weight: 600;
}
.plugin-terminal-kind {
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.plugin-terminal-identity p {
  margin: 4px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.plugin-terminal-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.plugin-terminal-status[data-state='connected'] {
  color: var(--accent);
}
.plugin-terminal-status[data-state='failed'],
.plugin-terminal-ended.failed {
  color: var(--error);
}
.plugin-terminal-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.plugin-terminal-window-actions,
.plugin-terminal-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.plugin-terminal-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  flex-shrink: 0;
  padding: 7px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-soft);
}
.plugin-terminal-context {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-family: Consolas, 'Liberation Mono', monospace;
  font-size: var(--font-size-caption);
}
.plugin-terminal-tools {
  margin-left: auto;
}
.plugin-terminal-find {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: auto;
  flex-basis: auto;
  padding: 0 8px;
  white-space: nowrap;
}
.plugin-terminal-tool-divider {
  height: 16px;
  width: 1px;
  margin: 0 5px;
  background: var(--border);
}
.plugin-terminal-font {
  min-width: 48px;
  font-variant-numeric: tabular-nums;
}
.plugin-terminal-font span {
  margin-left: 3px;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.plugin-terminal {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.plugin-terminal :deep(.xterm-container) {
  min-height: 0;
  padding: 14px 16px;
}
.plugin-terminal :deep(.terminal-find) {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}
.plugin-terminal :deep(.terminal-find input) {
  min-width: 0;
}
.plugin-terminal-ended {
  margin: 0;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: var(--font-size-caption);
  overflow-wrap: anywhere;
}
.plugin-terminal-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--muted);
  background: var(--bg);
  font-size: var(--font-size-body);
}
.spinning {
  animation: plugin-terminal-spin 1.2s linear infinite;
}
@keyframes plugin-terminal-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 640px) {
  .plugin-terminal-heading {
    gap: 8px;
    padding: 12px;
    flex-wrap: wrap;
  }
  .plugin-terminal-icon {
    width: 34px;
    height: 34px;
  }
  .plugin-terminal-identity {
    flex-basis: calc(100% - 50px);
  }
  .plugin-terminal-window-actions {
    margin-left: auto;
  }
  .plugin-terminal-toolbar {
    padding: 6px 10px;
  }
  .plugin-terminal :deep(.xterm-container) {
    padding: 10px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
}
</style>
