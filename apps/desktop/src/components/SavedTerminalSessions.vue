<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Trash2, X } from '@lucide/vue';
import { tr } from '../i18n/messages';
import { useTerminalsStore } from '../stores/terminals';
import type { Host } from '../types/hosts';

const props = withDefaults(defineProps<{ host?: Host; active?: boolean; menu?: boolean }>(), {
  host: undefined,
  active: true,
});
const emit = defineEmits<{ restore: [id: string] }>();
const store = useTerminalsStore();
const list = ref<HTMLElement>();
const hostId = computed(() => props.host?.id ?? '');
const records = computed(() => store.savedSessions(hostId.value));
const loading = computed(() =>
  hostId.value ? store.sshLoading.has(hostId.value) : store.savedLoading,
);
const error = computed(() => (hostId.value ? store.sshErrors[hostId.value] : store.savedError));

async function load(): Promise<void> {
  const host = props.host;
  if (host) {
    if (!(await store.loadHostSessions(host))) return;
  } else {
    await store.loadSaved();
    if (store.savedError) return;
  }
  await store.loadSavedTitleCommands(host?.id ?? '');
}

function retry(): void {
  const container = list.value;
  (props.menu ? container?.closest<HTMLElement>('[role="menu"]') : container)?.focus({
    preventScroll: true,
  });
  void load();
}

async function remove(id: string, event: MouseEvent): Promise<void> {
  const trigger = event.currentTarget as HTMLButtonElement;
  const container = list.value;
  const index = records.value.findIndex((record) => record.id === id);
  await store.deleteSavedSession(hostId.value, id);
  await nextTick();
  if (
    !container ||
    list.value !== container ||
    trigger.isConnected ||
    document.activeElement !== document.body
  )
    return;
  const remaining = container.querySelectorAll<HTMLButtonElement>(
    '.terminal-saved-session-remove:not(:disabled)',
  );
  (
    remaining[Math.min(index, remaining.length - 1)] ??
    (props.menu ? container.closest<HTMLElement>('[role="menu"]') : container)
  )?.focus({
    preventScroll: true,
  });
}

watch(
  () => [props.active, hostId.value] as const,
  ([active]) => {
    if (active) void load();
  },
  { immediate: true },
);
</script>

<template>
  <div ref="list" class="terminal-saved-sessions" :tabindex="menu ? undefined : -1">
    <p v-if="loading" class="terminal-saved-session-empty" role="status">
      {{ tr('正在加载已保存会话…') }}
    </p>
    <template v-else-if="error">
      <p class="terminal-saved-session-empty" role="alert">{{ error }}</p>
      <button
        :role="menu ? 'menuitem' : undefined"
        class="terminal-saved-session-retry"
        type="button"
        @click="retry"
      >
        {{ tr('重试加载已保存会话') }}
      </button>
    </template>
    <ul v-else-if="records.length" :role="menu ? 'presentation' : undefined">
      <li
        v-for="record in records"
        :key="record.id"
        class="terminal-saved-session-row"
        :role="menu ? 'group' : undefined"
      >
        <button
          type="button"
          :role="menu ? 'menuitem' : undefined"
          :title="store.savedSessionTitle(record)"
          @click="emit('restore', record.id)"
        >
          <span>{{ store.savedSessionTitle(record) }}</span>
        </button>
        <button
          type="button"
          :role="menu ? 'menuitem' : undefined"
          class="terminal-saved-session-remove"
          :aria-label="tr('删除“{0}”的保存记录', record.title)"
          :title="tr('删除保存记录')"
          :disabled="!store.canDeleteSaved(hostId, record.id)"
          @click="remove(record.id, $event)"
        >
          <component :is="menu ? X : Trash2" class="menu-icon-red" :size="15" aria-hidden="true" />
        </button>
      </li>
    </ul>
    <p v-else class="terminal-saved-session-empty" role="status">{{ tr('没有已保存的会话') }}</p>
  </div>
</template>
