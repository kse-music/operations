<script setup lang="ts">
import { useBackgroundStore } from '../stores/background';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderCog,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Server,
  Star,
} from '@lucide/vue';
const background = useBackgroundStore();
import { useOpsStore } from '../stores/ops';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useHostsStore } from '../stores/hosts';
import type { Host } from '../types/hosts';
import { useFilesStore } from '../stores/files';
import HostTreeControls from './HostTreeControls.vue';
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
  import: [];
  export: [];
  select: [host: Host];
  saved: [host: Host];
}>();
const collapsed = ref<string[]>([]);
const toolsOpen = ref(false);
const tags = computed(() =>
  [...new Set(store.catalog?.hosts.flatMap((host) => host.tags) ?? [])].sort(),
);
const tree = ref<HTMLElement>();
const dragged = ref<string | null>(null),
  dropTarget = ref<string | null>(null),
  dragPosition = ref({ x: 0, y: 0 });
let pendingDrag:
  { host: Host; x: number; y: number; pointerId: number; source: HTMLElement } | undefined;
let suppressClick = false,
  clickTimer: ReturnType<typeof setTimeout> | undefined;
function targetGroup(event: PointerEvent): string | null {
  const group = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest<HTMLElement>('.tree-group');
  if (!group || !tree.value?.contains(group)) return null;
  const id = group.dataset.groupId || null;
  return id === pendingDrag?.host.groupId ? null : (id ?? 'ungrouped');
}
function beginDrag(host: Host, event: PointerEvent): void {
  if (event.button !== 0 || event.pointerType === 'touch' || store.busy) return;
  endDrag();
  pendingDrag = {
    host,
    x: event.clientX,
    y: event.clientY,
    pointerId: event.pointerId,
    source: event.currentTarget as HTMLElement,
  };
  window.addEventListener('pointermove', moveDrag);
  window.addEventListener('pointerup', dropHost);
  window.addEventListener('pointercancel', cancelDrag);
  window.addEventListener('blur', cancelDrag);
  window.addEventListener('keydown', dragKey);
}
function moveDrag(event: PointerEvent): void {
  if (!pendingDrag || event.pointerId !== pendingDrag.pointerId) return;
  if (store.busy || event.buttons !== 1) {
    cancelDrag();
    return;
  }
  if (!dragged.value) {
    if (Math.hypot(event.clientX - pendingDrag.x, event.clientY - pendingDrag.y) < 6) return;
    dragged.value = pendingDrag.host.id;
    pendingDrag.source.setPointerCapture(event.pointerId);
  }
  event.preventDefault();
  dragPosition.value = { x: event.clientX, y: event.clientY };
  dropTarget.value = targetGroup(event);
}
function endDrag(): void {
  const pending = pendingDrag;
  pendingDrag = undefined;
  dragged.value = null;
  dropTarget.value = null;
  window.removeEventListener('pointermove', moveDrag);
  window.removeEventListener('pointerup', dropHost);
  window.removeEventListener('pointercancel', cancelDrag);
  window.removeEventListener('blur', cancelDrag);
  window.removeEventListener('keydown', dragKey);
  if (pending?.source.hasPointerCapture(pending.pointerId))
    pending.source.releasePointerCapture(pending.pointerId);
}
function blockDragClick(): void {
  suppressClick = true;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    suppressClick = false;
  }, 0);
}
function dropHost(event: PointerEvent): void {
  if (!pendingDrag || event.pointerId !== pendingDrag.pointerId) return;
  const id = dragged.value,
    target = id ? targetGroup(event) : null;
  if (id) blockDragClick();
  endDrag();
  if (id && target !== null) void store.move(id, target === 'ungrouped' ? null : target);
}
function cancelDrag(): void {
  if (dragged.value) blockDragClick();
  endDrag();
}
function dragKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelDrag();
  }
}
function ignoreDragClick(event: MouseEvent): void {
  if (!suppressClick) return;
  event.preventDefault();
  event.stopPropagation();
}
onBeforeUnmount(() => {
  endDrag();
  clearTimeout(clickTimer);
});
const connectedCount = computed(
  () => (store.catalog?.hosts ?? []).filter((host) => hostState(host.id) === '已连接').length,
);
const limit = ref(200);
watch(
  () => [store.search, store.favorites, store.sort, store.tag],
  () => (limit.value = 200),
);
watch(
  () => [store.selectedId, store.catalog] as const,
  ([id]) => {
    const host = store.catalog?.hosts.find((item) => item.id === id);
    if (!host) return;
    collapsed.value = collapsed.value.filter((group) => group !== (host.groupId ?? 'ungrouped'));
    const index = store.visible.findIndex((item) => item.id === id);
    if (index >= limit.value) limit.value = Math.ceil((index + 1) / 200) * 200;
  },
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
  <section
    ref="tree"
    class="host-tree-section"
    :class="{ 'host-dragging': dragged }"
    aria-label="主机树"
    @keydown="keys"
    @click.capture="ignoreDragClick"
  >
    <header class="host-sidebar-heading">
      <h2>主机</h2>
      <div class="host-sidebar-actions">
        <button
          class="shell-icon-button"
          aria-label="主机树工具"
          title="导入、导出和筛选排序"
          :aria-expanded="toolsOpen"
          aria-controls="host-tree-tools"
          @click="toolsOpen = !toolsOpen"
        >
          <MoreHorizontal :size="16" aria-hidden="true" />
        </button>
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
      <div
        v-if="toolsOpen"
        id="host-tree-tools"
        class="host-tree-tools"
        role="group"
        aria-label="主机树工具选项"
      >
        <div class="host-tree-import-export">
          <button class="button" :disabled="!store.catalog || store.busy" @click="$emit('import')">
            导入 OpenSSH
          </button>
          <button class="button" :disabled="!store.catalog || store.busy" @click="$emit('export')">
            导出配置
          </button>
        </div>
        <label
          >标签
          <select
            v-model="store.tag"
            aria-label="按标签筛选主机"
            :disabled="!store.catalog || store.busy"
          >
            <option value="">全部标签</option>
            <option v-for="tag in tags" :key="tag" :value="tag">{{ tag }}</option>
          </select>
        </label>
        <label
          >排序
          <select
            v-model="store.sort"
            aria-label="主机排序"
            :disabled="!store.catalog || store.busy"
          >
            <option value="name">名称排序</option>
            <option value="hostname">地址排序</option>
            <option value="updated">最近修改</option>
          </select>
        </label>
      </div>
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
      <div
        v-for="group in nodes"
        :key="group.id ?? 'ungrouped'"
        class="tree-group"
        :data-group-id="group.id ?? ''"
        :class="{ 'drop-target': dropTarget === (group.id ?? 'ungrouped') }"
      >
        <template v-if="group.hosts.length || group.id || store.catalog?.hosts.length">
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
            <div v-for="host in group.hosts" :key="host.id" class="tree-host-row">
              <button
                :data-host-id="host.id"
                :class="['tree-host', { selected: store.selectedId === host.id }]"
                :title="`${host.username}@${host.hostname}:${host.port} · 拖动可移动到其他分组`"
                :aria-current="store.selectedId === host.id ? 'true' : undefined"
                :draggable="false"
                @pointerdown="beginDrag(host, $event)"
                @dragstart.prevent
                @click="
                  store.selectedId = host.id;
                  $emit('select', host);
                "
                @contextmenu.prevent
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
              <HostTreeControls :host="host" @saved="$emit('saved', $event)" />
            </div>
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
    <div
      v-if="dragged"
      class="host-drag-preview"
      aria-hidden="true"
      :style="{ left: `${dragPosition.x + 12}px`, top: `${dragPosition.y + 12}px` }"
    >
      {{ store.catalog?.hosts.find((h) => h.id === dragged)?.name }}
      <span>{{
        dropTarget
          ? `移动到 ${dropTarget === 'ungrouped' ? '未分组' : store.catalog?.groups.find((g) => g.id === dropTarget)?.name}`
          : '拖到其他分组，Esc 取消'
      }}</span>
    </div>
  </section>
</template>
