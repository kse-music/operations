<script setup lang="ts">
import { computed, ref } from 'vue';
import Modal from './Modal.vue';
import { useHostsStore } from '../stores/hosts';
import { messages, type WorkspaceView } from '../types/product';
import { hostDisplayName } from '../types/hosts';
import { usePluginsStore } from '../stores/plugins';
import { useWorkspaceStore } from '../stores/workspace';
const plugins = usePluginsStore();
const workspace = useWorkspaceStore();
const emit = defineEmits<{
  close: [];
  selectHost: [hostId: string];
  plugin: [id: string, contribution: string, hostId: string];
  navigate: [view: WorkspaceView, hostId?: string];
  tasks: [];
}>();
const hosts = useHostsStore(),
  query = ref(''),
  index = ref(0);
const results = computed(() => {
  const q = query.value.trim().toLowerCase();
  return [
    ...Object.entries(messages['zh-CN'])
      .filter(([view]) => !['extension', 'pluginSettings'].includes(view))
      .map(([view, name]) => ({
        key: view,
        kind: 'view',
        name: `工作区 · ${name}`,
        view: view as WorkspaceView,
        hostId: hosts.selectedId ?? '',
        entryId: '',
      })),
    {
      key: 'tasks',
      kind: 'tasks',
      name: '任务中心',
      view: 'tasks' as const,
      hostId: '',
      entryId: '',
    },
    ...(hosts.catalog?.hosts ?? []).map((h) => ({
      key: h.id,
      kind: 'host',
      name: `主机 · ${hostDisplayName(h)} · ${h.username}@${h.hostname}:${h.port}`,
      view: 'terminals' as WorkspaceView,
      hostId: h.id,
      entryId: '',
    })),
    ...plugins.extensions
      .filter((e) => e.kind === 'command')
      .map((e) => ({
        key: `${e.pluginId}:${e.id}`,
        kind: 'plugin',
        name: `插件命令 · ${e.pluginName} · ${e.label}`,
        view: 'extension' as WorkspaceView,
        hostId: workspace.current?.hostId ?? '',
        entryId: e.id,
        pluginId: e.pluginId,
      })),
  ]
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .slice(0, 50);
});
function choose(n: number) {
  const r = results.value[n];
  if (r) {
    if (r.view === 'tasks') emit('tasks');
    else if (r.kind === 'host') emit('selectHost', r.hostId);
    else if (r.kind === 'plugin' && 'pluginId' in r)
      emit('plugin', String(r.pluginId), r.entryId, r.hostId);
    else emit('navigate', r.view, r.hostId);
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
</script>
<template>
  <Modal title="全局搜索" @close="emit('close')"
    ><input
      v-model="query"
      autofocus
      class="global-search-input"
      aria-label="全局搜索内容"
      placeholder="搜索主机、工作区和插件命令…"
      aria-controls="global-search-results"
      :aria-activedescendant="results[index] ? `result-${results[index]!.key}` : undefined"
      @input="index = 0"
      @keydown="key"
    />
    <p class="subtle">↑↓ 选择，Enter 打开，Esc 关闭。任务执行仍需目标预览和确认。</p>

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
