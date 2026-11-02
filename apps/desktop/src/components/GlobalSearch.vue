<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { computed, onMounted, ref, shallowRef } from 'vue';
import Modal from './Modal.vue';
import { useHostsStore } from '../stores/hosts';
import { automationApi } from '../services/automation';
import { errorMessage } from '../services/ipc';
import { messages, type WorkspaceView } from '../types/product';
import type { Entry } from '../types/automation';
import { hostDisplayName } from '../types/hosts';
const emit = defineEmits<{
  close: [];
  selectHost: [hostId: string];
  navigate: [view: WorkspaceView, hostId?: string, entryId?: string];
}>();
const hosts = useHostsStore(),
  query = ref(''),
  entries = shallowRef<Entry[]>([]),
  error = ref(''),
  loading = ref(true),
  index = ref(0);
const results = computed(() => {
  const q = query.value.trim().toLowerCase();
  return [
    ...Object.entries(messages['zh-CN']).map(([view, name]) => ({
      key: view,
      kind: 'view',
      name: `工作区 · ${name}`,
      view: view as WorkspaceView,
      hostId: hosts.selectedId ?? '',
      entryId: '',
    })),
    ...(hosts.catalog?.hosts ?? []).map((h) => ({
      key: h.id,
      kind: 'host',
      name: `主机 · ${hostDisplayName(h)} · ${h.username}@${h.hostname}:${h.port}`,
      view: 'terminals' as WorkspaceView,
      hostId: h.id,
      entryId: '',
    })),
    ...entries.value.map((e) => ({
      key: e.id,
      kind: 'entry',
      name: `任务 · ${e.name} · ${e.description}`,
      view: 'automation' as WorkspaceView,
      hostId: hosts.selectedId ?? '',
      entryId: e.id,
    })),
  ]
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .slice(0, 50);
});
function choose(n: number) {
  const r = results.value[n];
  if (r) {
    if (r.kind === 'host') emit('selectHost', r.hostId);
    else emit('navigate', r.view, r.hostId, r.entryId);
    emit('close');
  }
}
function key(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    index.value =
      (index.value + (e.key === 'ArrowDown' ? 1 : -1) + results.value.length) %
      Math.max(1, results.value.length);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(index.value);
  }
}
onMounted(async () => {
  try {
    entries.value = (await automationApi.catalog()).entries;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});
useErrorNotifications(error);
</script>
<template>
  <Modal title="全局搜索" @close="emit('close')"
    ><input
      v-model="query"
      autofocus
      class="global-search-input"
      aria-label="全局搜索内容"
      placeholder="搜索主机、工作区、命令和脚本…"
      aria-controls="global-search-results"
      :aria-activedescendant="results[index] ? `result-${results[index]!.key}` : undefined"
      @input="index = 0"
      @keydown="key"
    />
    <p class="subtle">↑↓ 选择，Enter 打开，Esc 关闭。任务执行仍需目标预览和确认。</p>
    <p v-if="loading" role="status">正在读取任务库…</p>

    <div id="global-search-results" role="listbox" aria-label="全局搜索结果">
      <button
        v-for="(r, n) in results"
        :id="`result-${r.key}`"
        :key="r.key"
        class="search-result"
        :class="{ selected: n === index }"
        role="option"
        :aria-selected="n === index"
        @click="choose(n)"
      >
        {{ r.name }}
      </button>
    </div>
    <p v-if="!results.length" class="host-empty">没有匹配结果</p></Modal
  >
</template>
