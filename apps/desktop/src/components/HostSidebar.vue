<script setup lang="ts">
import { useBackgroundStore } from '../stores/background';
const background = useBackgroundStore();
import { useOpsStore } from '../stores/ops';
import { computed, ref, watch } from 'vue';
import { useHostsStore } from '../stores/hosts';
import type { Host } from '../types/hosts';
import { useFilesStore } from '../stores/files';
const store = useHostsStore();
const files = useFilesStore();
const operations = useOpsStore();
const hostState = (id: string) =>
  background.connections
    ? background.hostState(id)
    : operations.hostState(id) !== '未连接'
      ? operations.hostState(id)
      : files.hostState(id);
defineEmits<{
  create: [];
  groups: [];
  select: [];
  connect: [host: Host];
  menu: [host: Host, event: MouseEvent];
}>();
const collapsed = ref<string[]>([]);
const limit = ref(200);
watch(
  () => [store.search, store.favorites, store.sort, store.tag],
  () => (limit.value = 200),
);
const nodes = computed(() => {
  const map = new Map<string | null, Host[]>();
  for (const host of store.visible.slice(0, limit.value)) {
    const list = map.get(host.groupId) ?? [];
    list.push(host);
    map.set(host.groupId, list);
  }
  return [{ id: null, name: '未分组' }, ...(store.catalog?.groups ?? [])].map((g) => ({
    ...g,
    hosts: map.get(g.id) ?? [],
  }));
});
function keys(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (!target.matches('.tree-host') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
    return;
  event.preventDefault();
  const buttons = Array.from(
    target.closest('section')!.querySelectorAll<HTMLButtonElement>('.tree-host'),
  );
  const n = buttons.indexOf(target as HTMLButtonElement),
    i =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, n + (event.key === 'ArrowDown' ? 1 : -1)));
  buttons[i]?.focus();
}

function toggle(id: string): void {
  collapsed.value = collapsed.value.includes(id)
    ? collapsed.value.filter((i) => i !== id)
    : [...collapsed.value, id];
}
</script>
<template>
  <section class="host-tree-section" aria-label="主机树" @keydown="keys">
    <div class="sidebar-caption">
      主机
      <button class="text-button" :disabled="!store.catalog || store.busy" @click="$emit('groups')">
        管理分组
      </button>
    </div>
    <input
      v-model="store.search"
      class="sidebar-search"
      aria-label="搜索主机"
      placeholder="搜索主机、地址、标签…"
    />
    <div class="sidebar-tools">
      <button
        class="text-button"
        :aria-pressed="store.favorites"
        @click="store.favorites = !store.favorites"
      >
        {{ store.favorites ? '★ 仅收藏' : '☆ 全部主机' }}</button
      ><button class="text-button" :disabled="store.busy" @click="store.load">刷新</button>
    </div>
    <button
      class="button add-host"
      :disabled="!store.catalog || store.busy"
      @click="$emit('create')"
    >
      ＋ 新建主机
    </button>
    <p v-if="store.busy && !store.catalog" class="subtle">正在读取主机…</p>
    <p v-else-if="!store.catalog" class="subtle">未能读取主机，请检查错误并刷新。</p>
    <p v-else-if="!store.visible.length" class="host-empty">
      {{ store.catalog.hosts.length ? '没有匹配的主机' : '尚未添加主机' }}
    </p>
    <div v-for="group in nodes" :key="group.id ?? 'ungrouped'" class="tree-group">
      <template v-if="group.hosts.length || group.id">
        <button
          class="group-toggle"
          :aria-expanded="!collapsed.includes(group.id ?? 'ungrouped')"
          @click="toggle(group.id ?? 'ungrouped')"
        >
          {{ collapsed.includes(group.id ?? 'ungrouped') ? '▸' : '▾' }} {{ group.name
          }}<span>{{ group.hosts.length }}</span>
        </button>
        <template v-if="!collapsed.includes(group.id ?? 'ungrouped')">
          <button
            v-for="host in group.hosts"
            :key="host.id"
            :class="['tree-host', { selected: store.selectedId === host.id }]"
            :title="`${host.username}@${host.hostname}:${host.port}`"
            :aria-current="store.selectedId === host.id ? 'true' : undefined"
            @click="
              store.selectedId = host.id;
              $emit('select');
            "
            @contextmenu.prevent="$emit('menu', host, $event)"
            @dblclick="$emit('connect', host)"
          >
            <span
              :class="['disconnected-dot', { connected: hostState(host.id) === '已连接' }]"
              :aria-label="hostState(host.id)"
            ></span
            ><span class="host-name">{{ host.name }}</span
            ><span v-if="host.favorite" class="favorite">★</span>
          </button>
        </template>
      </template>
    </div>
    <button v-if="store.visible.length > limit" class="button" @click="limit += 200">
      显示更多主机（{{ limit }} / {{ store.visible.length }}）
    </button>
  </section>
</template>
