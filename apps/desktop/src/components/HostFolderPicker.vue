<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from '@lucide/vue';
import { folderAncestors, folderPath, hostFolderRows } from '../services/host-tree';
import type { HostGroup } from '../types/hosts';

const props = defineProps<{
  id: string;
  label: string;
  groups: HostGroup[];
  disabled?: boolean;
}>();
const value = defineModel<string | null>({ required: true });
const treeId = useId();
const trigger = ref<HTMLButtonElement>(),
  popup = ref<HTMLElement>(),
  open = ref(false),
  active = ref(0),
  collapsed = ref<string[]>([]),
  position = ref({ left: '0px', top: '0px', width: '0px', maxHeight: '280px' });
const rows = computed(() => hostFolderRows(props.groups, [], collapsed.value, false, 0));
const parents = computed(() => new Set(props.groups.map((group) => group.parentId)));
const currentPath = computed(() => folderPath(props.groups, value.value));
const isExpanded = (id: string | null) => !collapsed.value.includes(id ?? 'root');

function close(): void {
  popup.value?.hidePopover();
  open.value = false;
}
function revealActive(): void {
  if (!popup.value || popup.value.scrollHeight <= popup.value.clientHeight) return;
  popup.value
    .querySelector(`[id="${treeId}-${active.value}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}
function place(): void {
  if (!open.value || !trigger.value || !popup.value) return;
  const anchor = trigger.value.getBoundingClientRect();
  const below = Math.max(0, window.innerHeight - anchor.bottom - 12),
    above = Math.max(0, anchor.top - 12),
    height = Math.min(280, popup.value.scrollHeight),
    useBelow = below >= height || below >= above,
    width = Math.min(Math.max(anchor.width, 240), window.innerWidth - 16);
  position.value = {
    left: `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`,
    top: `${useBelow ? anchor.bottom + 4 : Math.max(8, anchor.top - Math.min(height, above) - 4)}px`,
    width: `${width}px`,
    maxHeight: `${Math.min(280, useBelow ? below : above)}px`,
  };
}
async function show(): Promise<void> {
  if (props.disabled || !trigger.value || !popup.value) return;
  const ancestors = new Set(['root', ...folderAncestors(props.groups, value.value)]);
  collapsed.value = collapsed.value.filter((id) => !ancestors.has(id));
  active.value = Math.max(
    0,
    rows.value.findIndex((row) => row.id === value.value),
  );
  open.value = true;
  await nextTick();
  if (!open.value || props.disabled) return;
  popup.value.showPopover();
  place();
  revealActive();
}
function choose(index: number): void {
  const row = rows.value[index];
  if (!row || props.disabled) return;
  value.value = row.id;
  close();
  trigger.value?.focus({ preventScroll: true });
}
function toggle(index: number): void {
  const row = rows.value[index];
  if (!row || props.disabled || !parents.value.has(row.id)) return;
  const id = row.id ?? 'root';
  collapsed.value = isExpanded(row.id)
    ? [...collapsed.value, id]
    : collapsed.value.filter((key) => key !== id);
  active.value = index;
  void nextTick(place);
}
async function key(event: KeyboardEvent): Promise<void> {
  if (event.key === 'Tab') return close();
  if (event.key === 'Escape') {
    if (open.value) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    return;
  }
  if (
    !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(
      event.key,
    )
  )
    return;
  event.preventDefault();
  if (!open.value) return show();
  if (event.key === 'Enter' || event.key === ' ') return choose(active.value);
  const row = rows.value[active.value];
  if (!row) return;
  if (event.key === 'Home') active.value = 0;
  else if (event.key === 'End') active.value = rows.value.length - 1;
  else if (event.key === 'ArrowDown')
    active.value = Math.min(rows.value.length - 1, active.value + 1);
  else if (event.key === 'ArrowUp') active.value = Math.max(0, active.value - 1);
  else if (event.key === 'ArrowRight' && parents.value.has(row.id)) {
    if (!isExpanded(row.id)) toggle(active.value);
    else active.value += 1;
  } else if (event.key === 'ArrowLeft') {
    if (parents.value.has(row.id) && isExpanded(row.id)) toggle(active.value);
    else if (row.id !== null) {
      const parent = props.groups.find((group) => group.id === row.id)?.parentId ?? null;
      active.value = rows.value.findIndex((item) => item.id === parent);
    }
  }
  await nextTick();
  revealActive();
}
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close();
  },
);
watch(open, (visible, _previous, cleanup) => {
  if (!visible) return;
  const scroll = (event: Event) => {
    if (!(event.target instanceof Node) || !popup.value?.contains(event.target)) place();
  };
  window.addEventListener('resize', close);
  window.addEventListener('scroll', scroll, true);
  cleanup(() => {
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', scroll, true);
  });
});
</script>

<template>
  <button
    :id="id"
    ref="trigger"
    class="host-folder-picker"
    type="button"
    role="combobox"
    :aria-label="label"
    :title="currentPath"
    aria-haspopup="tree"
    :aria-controls="treeId"
    :aria-expanded="open"
    :aria-activedescendant="open ? `${treeId}-${active}` : undefined"
    :disabled="disabled"
    @click="open ? close() : show()"
    @keydown="key"
  >
    <Folder class="host-group-icon" :size="16" aria-hidden="true" />
    <span>{{ currentPath }}</span>
    <ChevronDown :size="14" aria-hidden="true" />
  </button>
  <div
    :id="treeId"
    ref="popup"
    class="host-folder-tree"
    popover="auto"
    role="tree"
    :aria-label="label"
    :style="position"
    @beforetoggle="open = $event.newState === 'open'"
  >
    <div
      v-for="(row, index) in rows"
      :id="`${treeId}-${index}`"
      :key="row.id ?? 'root'"
      class="host-folder-option"
      :class="{ active: index === active }"
      role="treeitem"
      :aria-label="row.name"
      :aria-level="row.depth + 1"
      :aria-selected="row.id === value"
      :aria-expanded="parents.has(row.id) ? isExpanded(row.id) : undefined"
      :style="{ '--folder-depth': row.depth }"
      :title="folderPath(groups, row.id)"
      @pointerdown.prevent
      @pointermove="active = index"
      @click="choose(index)"
    >
      <span class="host-folder-toggle" aria-hidden="true" @click.stop="toggle(index)">
        <component
          :is="isExpanded(row.id) ? ChevronDown : ChevronRight"
          v-if="parents.has(row.id)"
          :size="14"
        />
      </span>
      <component
        :is="parents.has(row.id) && isExpanded(row.id) ? FolderOpen : Folder"
        class="host-group-icon"
        :size="17"
        aria-hidden="true"
      />
      <span class="host-folder-name">{{ row.name }}</span>
    </div>
  </div>
</template>

<style scoped>
.host-folder-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  width: clamp(128px, 36vw, 280px);
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  text-align: left;
}
.host-folder-picker > span,
.host-folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-folder-picker svg,
.host-folder-option svg {
  flex-shrink: 0;
}
.host-folder-tree {
  position: fixed;
  inset: auto;
  margin: 0;
  height: auto;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font-size: var(--font-size-body);
  overflow: auto;
  overscroll-behavior: contain;
  box-shadow: 0 6px 24px #0004;
}
.host-folder-option {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 4px 8px 4px calc(4px + var(--folder-depth) * 18px);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}
.host-folder-option.active {
  background: var(--accent-bg);
}
.host-folder-option[aria-selected='true'] {
  background: var(--accent-bg);
}
.host-folder-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  flex: 0 0 18px;
  color: var(--muted);
}
@media (max-width: 480px) {
  .host-folder-picker {
    width: 100%;
  }
}
</style>
