<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { ChevronDown, Folder, HardDrive } from '@lucide/vue';
import type { FileLocation } from '../types/files';

const props = defineProps<{
  items: FileLocation[];
  value: string;
  label: string;
  listLabel: string;
  icon: 'drive' | 'folder';
  loading: boolean;
  emptyText: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ select: [path: string]; refresh: [] }>();
const listId = useId();
const trigger = ref<HTMLButtonElement>(),
  popup = ref<HTMLElement>(),
  open = ref(false),
  active = ref(-1);
const current = computed(() => props.items.find((item) => item.path === props.value));
const disabled = computed(() => props.disabled || (props.loading && !props.items.length));
function close(): void {
  open.value = false;
}
function place(): void {
  const menu = popup.value;
  if (!open.value || !trigger.value || !menu) return;
  const anchor = trigger.value.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  menu.style.setProperty('--location-trigger-width', `${anchor.width}px`);
  const below = Math.max(0, window.innerHeight - anchor.bottom - 12),
    above = Math.max(0, anchor.top - 12),
    height = Math.min(260, menu.scrollHeight + menu.offsetHeight - menu.clientHeight),
    useBelow = below >= height || below >= above;
  menu.style.maxHeight = `${Math.min(260, useBelow ? below : above)}px`;
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(anchor.left, viewportWidth - bounds.width - 8))}px`;
  menu.style.top = `${useBelow ? anchor.bottom + 4 : Math.max(8, anchor.top - bounds.height - 4)}px`;
}
async function show(): Promise<void> {
  if (disabled.value) return;
  active.value = Math.max(
    0,
    props.items.findIndex((item) => item.path === props.value),
  );
  open.value = true;
  emit('refresh');
  await nextTick();
  place();
  revealActive();
}
function choose(index: number): void {
  const item = props.items[index];
  if (!item || disabled.value) return;
  close();
  emit('select', item.path);
}
function revealActive(): void {
  if (!popup.value || popup.value.scrollHeight <= popup.value.clientHeight) return;
  popup.value
    ?.querySelector(`[id="${listId}-${active.value}"]`)
    ?.scrollIntoView({ block: 'nearest' });
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
  const arrow = event.key === 'ArrowDown' || event.key === 'ArrowUp',
    edge = event.key === 'Home' || event.key === 'End',
    confirm = event.key === 'Enter' || event.key === ' ',
    letter = !event.ctrlKey && !event.metaKey && /^[a-z]$/i.test(event.key);
  if (!arrow && !edge && !confirm && !letter) return;
  event.preventDefault();
  if (confirm) {
    if (open.value) choose(active.value);
    else await show();
    return;
  }
  const wasOpen = open.value;
  if (!wasOpen) await show();
  if (edge) active.value = event.key === 'Home' ? 0 : props.items.length - 1;
  else if (letter) {
    const index = props.items.findIndex((item) =>
      item.name.toLowerCase().startsWith(event.key.toLowerCase()),
    );
    if (index >= 0) active.value = index;
  } else if (wasOpen && props.items.length)
    active.value = Math.max(
      0,
      Math.min(props.items.length - 1, active.value + (event.key === 'ArrowDown' ? 1 : -1)),
    );
  revealActive();
}
watch(
  () => props.items,
  (items, previous) => {
    const path = previous[active.value]?.path ?? props.value;
    active.value = Math.max(
      0,
      items.findIndex((item) => item.path === path),
    );
    if (open.value) void nextTick(place);
  },
);
watch(disabled, (value) => {
  if (value) close();
});
watch(open, (value, _previous, cleanup) => {
  if (!value) return;
  const outside = (event: Event) => {
    const target = event.target as Node | null;
    if (target && !trigger.value?.contains(target) && !popup.value?.contains(target)) close();
  };
  const scroll = (event: Event) => {
    if (!(event.target instanceof Node) || event.target.contains(trigger.value ?? null)) close();
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('focusin', outside);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  window.addEventListener('scroll', scroll, true);
  cleanup(() => {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('focusin', outside);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    window.removeEventListener('scroll', scroll, true);
  });
});
</script>

<template>
  <button
    ref="trigger"
    class="file-location-picker"
    type="button"
    role="combobox"
    :aria-label="label"
    :title="current?.path || label"
    aria-haspopup="listbox"
    :aria-controls="listId"
    :aria-expanded="open"
    :aria-activedescendant="open && items[active] ? `${listId}-${active}` : undefined"
    :aria-busy="loading"
    :disabled="disabled"
    @focus="emit('refresh')"
    @click="open ? close() : show()"
    @keydown="key"
  >
    <span class="file-location-value">
      <component
        :is="icon === 'folder' ? Folder : HardDrive"
        v-if="current"
        :class="{ 'file-entry-icon': icon === 'folder' }"
        :data-kind="icon === 'folder' ? 'directory' : undefined"
        :size="icon === 'folder' ? undefined : 15"
        aria-hidden="true"
      />
      <span>{{ current?.name ?? (items.length ? '' : emptyText) }}</span>
    </span>
    <ChevronDown :size="15" aria-hidden="true" />
  </button>
  <Teleport to="body">
    <ul
      v-if="open"
      :id="listId"
      ref="popup"
      class="file-location-menu"
      :data-kind="icon"
      role="listbox"
      :aria-label="listLabel"
      :aria-busy="loading"
    >
      <li
        v-for="(item, index) in items"
        :id="`${listId}-${index}`"
        :key="item.path"
        class="file-location-option"
        :class="{ active: index === active }"
        role="option"
        :aria-selected="item.path === value"
        :style="{ '--location-depth': item.depth ?? 0 }"
        :title="item.path"
        @pointermove="active = index"
        @pointerdown.prevent
        @click="choose(index)"
      >
        <component
          :is="icon === 'folder' ? Folder : HardDrive"
          :class="{ 'file-entry-icon': icon === 'folder' }"
          :data-kind="icon === 'folder' ? 'directory' : undefined"
          :size="icon === 'folder' ? undefined : 15"
          aria-hidden="true"
        />
        <span>{{ item.name }}</span>
      </li>
      <li v-if="!items.length" class="file-location-status" role="status">{{ emptyText }}</li>
    </ul>
  </Teleport>
</template>
