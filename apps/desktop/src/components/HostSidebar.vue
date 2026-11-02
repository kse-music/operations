<script setup lang="ts">
import { useBackgroundStore } from '../stores/background';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderCog,
  Plus,
  RefreshCw,
  Search,
  Server,
  Star,
} from '@lucide/vue';
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
const connectedCount = computed(
  () => (store.catalog?.hosts ?? []).filter((host) => hostState(host.id) === '已连接').length,
);
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
    <header class="host-sidebar-heading">
      <h2>主机</h2>
      <div class="host-sidebar-actions">
        <button
          class="shell-icon-button"
          aria-label="管理分组"
          title="管理分组"
          :disabled="!store.catalog || store.busy"
          @click="$emit('groups')"
        >
          <FolderCog :size="16" aria-hidden="true" />
        </button>
        <button
          class="shell-icon-button"
          aria-label="刷新"
          title="刷新主机"
          :disabled="store.busy"
          @click="store.load"
        >
          <RefreshCw :size="15" :class="{ spinning: store.busy }" aria-hidden="true" />
        </button>
        <button
          class="shell-icon-button add-host-button"
          aria-label="新建主机"
          title="新建主机"
          :disabled="!store.catalog || store.busy"
          @click="$emit('create')"
        >
          <Plus :size="18" aria-hidden="true" />
        </button>
      </div>
    </header>
    <div class="host-sidebar-controls">
      <label class="host-search-field">
        <Search :size="14" aria-hidden="true" />
        <input
          v-model="store.search"
          class="sidebar-search"
          aria-label="搜索主机"
          placeholder="搜索主机、地址、标签…"
        />
      </label>
      <div class="host-filter" role="group" aria-label="主机筛选">
        <button :aria-pressed="!store.favorites" @click="store.favorites = false">全部主机</button>
        <button :aria-pressed="store.favorites" @click="store.favorites = true">
          <Star :size="12" aria-hidden="true" />收藏
        </button>
      </div>
    </div>
    <div class="host-tree-scroll" :aria-busy="store.busy">
      <p v-if="store.busy && !store.catalog" class="host-empty" role="status">正在读取主机…</p>
      <p v-else-if="!store.catalog" class="host-empty" role="status">未能读取主机，请刷新重试。</p>
      <div v-else-if="!store.visible.length" class="host-empty">
        <Server :size="26" :stroke-width="1.3" aria-hidden="true" />
        <p>{{ store.catalog.hosts.length ? '没有匹配的主机' : '尚未添加主机' }}</p>
        <button
          v-if="!store.catalog.hosts.length"
          class="text-button"
          :disabled="store.busy"
          @click="$emit('create')"
        >
          新建主机
        </button>
      </div>
      <div v-for="group in nodes" :key="group.id ?? 'ungrouped'" class="tree-group">
        <template v-if="group.hosts.length || group.id">
          <button
            class="group-toggle"
            :aria-expanded="!collapsed.includes(group.id ?? 'ungrouped')"
            @click="toggle(group.id ?? 'ungrouped')"
          >
            <ChevronRight
              v-if="collapsed.includes(group.id ?? 'ungrouped')"
              :size="12"
              aria-hidden="true"
            />
            <ChevronDown v-else :size="12" aria-hidden="true" />
            <Folder
              v-if="collapsed.includes(group.id ?? 'ungrouped')"
              :size="14"
              aria-hidden="true"
            />
            <FolderOpen v-else :size="14" aria-hidden="true" />
            <span class="group-name">{{ group.name }}</span
            ><span class="group-count">{{ group.hosts.length }}</span>
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
              ><span class="host-label"
                ><span class="host-name">{{ host.name }}</span
                ><span class="host-address"
                  >{{ host.hostname
                  }}<template v-if="host.port !== 22">:{{ host.port }}</template></span
                ></span
              ><Star v-if="host.favorite" class="favorite" :size="12" aria-label="已收藏" />
            </button>
          </template>
        </template>
      </div>
      <button
        v-if="store.visible.length > limit"
        class="button host-load-more"
        @click="limit += 200"
      >
        显示更多主机（{{ limit }} / {{ store.visible.length }}）
      </button>
    </div>
    <footer class="host-sidebar-footer">
      <span>{{
        store.catalog
          ? `${store.visible.length} / ${store.catalog.hosts.length} 台主机`
          : '主机列表未加载'
      }}</span>
      <span v-if="store.catalog" class="host-online-count"
        ><span :class="['status-dot', { offline: !connectedCount }]"></span
        >{{ connectedCount }} 已连接</span
      >
    </footer>
  </section>
</template>
