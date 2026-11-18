<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { ChevronDown } from '@lucide/vue';
import DirectoryTree from './DirectoryTree.vue';
import { tr } from '../i18n/messages';

const props = defineProps<{ id: string; sessionId: string; disabled?: boolean }>();
const value = defineModel<string>({ required: true });
const popupId = useId();
const trigger = ref<HTMLButtonElement>(),
  popup = ref<HTMLElement>(),
  open = ref(false);
const position = ref<Record<string, string>>({});
function close(restoreFocus = false): void {
  popup.value?.hidePopover();
  open.value = false;
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function place(): void {
  if (!open.value || !trigger.value) return;
  const anchor = trigger.value.getBoundingClientRect();
  const below = Math.max(0, innerHeight - anchor.bottom - 12),
    above = Math.max(0, anchor.top - 12);
  const useBelow = below >= 280 || below >= above;
  const width = Math.min(anchor.width, innerWidth - 24);
  position.value = {
    left: `${Math.max(12, Math.min(anchor.left, innerWidth - width - 12))}px`,
    top: useBelow ? `${anchor.bottom + 4}px` : 'auto',
    bottom: useBelow ? 'auto' : `${innerHeight - anchor.top + 4}px`,
    width: `${width}px`,
    maxHeight: `${Math.min(320, useBelow ? below : above)}px`,
  };
}
async function show(): Promise<void> {
  if (props.disabled) return;
  open.value = true;
  await nextTick();
  if (!open.value || props.disabled || !popup.value) return;
  popup.value.showPopover();
  place();
  await nextTick();
  if (open.value) popup.value?.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
}
function select(path: string): void {
  if (props.disabled || !open.value) return;
  value.value = path;
  close(true);
}
watch(
  () => [props.sessionId, props.disabled],
  () => close(),
);
watch(open, (visible, _previous, cleanup) => {
  if (!visible) return;
  const resize = () => close();
  const scroll = (event: Event) => {
    if (!(event.target instanceof Node) || !popup.value?.contains(event.target)) place();
  };
  window.addEventListener('resize', resize);
  window.addEventListener('scroll', scroll, true);
  cleanup(() => {
    window.removeEventListener('resize', resize);
    window.removeEventListener('scroll', scroll, true);
  });
});
onBeforeUnmount(() => popup.value?.hidePopover());
</script>

<template>
  <button
    :id="id"
    ref="trigger"
    class="remote-directory-select"
    type="button"
    role="combobox"
    aria-haspopup="tree"
    :aria-controls="popupId"
    :aria-expanded="open"
    :disabled="disabled"
    :title="value || tr('请选择目标目录')"
    :value="value"
    @click="open ? close() : show()"
    @keydown.down.prevent="show"
    @keydown.up.prevent="show"
  >
    <span :class="{ subtle: !value }">{{ value || tr('请选择目标目录') }}</span>
    <ChevronDown :size="16" aria-hidden="true" />
  </button>
  <div
    :id="popupId"
    ref="popup"
    class="remote-directory-popup"
    popover="auto"
    :style="position"
    @beforetoggle="open = $event.newState === 'open'"
    @keydown.esc.stop.prevent="close(true)"
  >
    <DirectoryTree
      v-if="open"
      :source="{ side: 'remote', sessionId }"
      :selected="value"
      :disabled="disabled"
      @select="select"
    />
  </div>
</template>

<style scoped>
.remote-directory-select {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  min-height: var(--control-height);
  padding: 6px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--control-radius);
  background: var(--panel);
  color: var(--text);
  font: inherit;
  text-align: left;
}
.remote-directory-select > span {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.remote-directory-select > svg {
  flex-shrink: 0;
  color: var(--muted);
}
.remote-directory-popup {
  position: fixed;
  inset: auto;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--control-radius);
  background: var(--panel);
  color: var(--text);
  font-size: var(--font-size-body);
  overflow: auto;
  overscroll-behavior: contain;
  box-shadow: 0 6px 24px #0004;
}
.remote-directory-popup :deep(.file-directory-tree) {
  border: 0;
}
</style>
