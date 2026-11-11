<script setup lang="ts">
import { tr } from '../i18n/messages';

import { useBackgroundStore } from '../stores/background';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Search, Server, Plus } from '@lucide/vue';
const background = useBackgroundStore();
import { useOpsStore } from '../stores/ops';
import { usePluginsStore } from '../stores/plugins';
const plugins = usePluginsStore();
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useHostsStore } from '../stores/hosts';
import { hostDisplayName, type Host, type HostGroup } from '../types/hosts';
import { useFilesStore } from '../stores/files';
import HostTreeControls from './HostTreeControls.vue';
import GroupManager from './GroupManager.vue';
import Modal from './Modal.vue';
import { hostsApi } from '../services/hosts';
import { folderAncestors, hostFolderRows } from '../services/host-tree';
const store = useHostsStore();
const files = useFilesStore();
const operations = useOpsStore();
const hostAddress = ({ hostname, port }: Host) => hostDisplayName({ name: '', hostname, port });
const props = withDefaults(defineProps<{ active?: boolean }>(), {
  active: true,
});
const hostState = (id: string) =>
  background.connections
    ? background.hostState(id)
    : operations.hostState(id) !== tr('未连接')
      ? operations.hostState(id)
      : files.hostState(id);
const emit = defineEmits<{
  create: [groupId: string | null];
  importOpenssh: [];
  select: [host: Host];
  saved: [host: Host];
  plugin: [id: string, contribution: string, hostId: string];
}>();
const collapsed = ref<string[]>([]);
const tree = ref<HTMLElement>();
const dragged = ref<string | null>(null),
  dropTarget = ref<string | null>(null),
  dragPosition = ref({ x: 0, y: 0 });
const pendingDrag = shallowRef<{
  host: Host;
  x: number;
  y: number;
  pointerId: number;
  source: HTMLElement;
}>();
let suppressClick = false,
  clickTimer: ReturnType<typeof setTimeout> | undefined;
function targetGroup(event: PointerEvent): string | null {
  const group = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest<HTMLElement>('.tree-group');
  if (!group || !tree.value?.contains(group)) return null;
  const id = group.dataset.groupId || null;
  return id === pendingDrag.value?.host.groupId ? null : (id ?? 'root');
}
function beginDrag(host: Host, event: PointerEvent): void {
  if (event.button !== 0 || event.pointerType === 'touch' || store.busy) return;
  endDrag();
  pendingDrag.value = {
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
  const pending = pendingDrag.value;
  if (!pending || event.pointerId !== pending.pointerId) return;
  if (store.busy || event.buttons !== 1) {
    cancelDrag();
    return;
  }
  if (!dragged.value) {
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 6) return;
    dragged.value = pending.host.id;
    pending.source.setPointerCapture(event.pointerId);
  }
  event.preventDefault();
  dragPosition.value = { x: event.clientX, y: event.clientY };
  dropTarget.value = targetGroup(event);
}
function endDrag(): void {
  const pending = pendingDrag.value;
  pendingDrag.value = undefined;
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
  if (event.pointerId !== pendingDrag.value?.pointerId) return;
  const id = dragged.value,
    target = id ? targetGroup(event) : null;
  if (id) blockDragClick();
  endDrag();
  if (id && target !== null) void store.move(id, target === 'root' ? null : target);
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
const limit = ref(200);
watch(
  () => store.search,
  () => (limit.value = 200),
);
watch(
  () => [store.selectedId, store.catalog] as const,
  ([id]) => {
    const host = store.catalog?.hosts.find((item) => item.id === id);
    if (!host) return;
    const ancestors = ['root', ...folderAncestors(store.catalog?.groups ?? [], host.groupId)];
    collapsed.value = collapsed.value.filter((group) => !ancestors.includes(group));
    const index = store.visible.findIndex((item) => item.id === id);
    if (index >= limit.value) limit.value = Math.ceil((index + 1) / 200) * 200;
  },
);
const nodes = computed(() =>
  hostFolderRows(
    store.catalog?.groups ?? [],
    store.visible,
    collapsed.value,
    !!store.search.trim(),
    limit.value,
  ),
);
const isCollapsed = (id: string | null) =>
  !store.search.trim() && collapsed.value.includes(id ?? 'root');
function keys(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
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

type ContextTarget = { kind: 'folder'; id: string | null } | { kind: 'host'; id: string };
type MenuAction =
  | 'newHost'
  | 'newFolder'
  | 'importOpenssh'
  | 'rename'
  | 'deleteFolder'
  | 'connect'
  | 'edit'
  | 'copy'
  | 'deleteHost'
  | `plugin:${string}:${string}`;
const context = ref<{ target: ContextTarget; x: number; y: number }>();
const menuElement = ref<HTMLElement>();
let contextTrigger: HTMLElement | undefined;
let contextScrollTop = 0;
const controls = new Map<string, InstanceType<typeof HostTreeControls>>();
function setControls(id: string, component: unknown): void {
  if (component) controls.set(id, component as InstanceType<typeof HostTreeControls>);
  else controls.delete(id);
}
const folderEditor = ref<{ parentId: string | null; group?: HostGroup }>();
const deletingFolder = ref<HostGroup>();
const menuItems = computed<{ key: MenuAction; label: string; danger?: boolean }[]>(() => {
  const target = context.value?.target;
  if (!target) return [];
  if (target.kind === 'host')
    return [
      { key: 'connect', label: tr('连接') },
      { key: 'edit', label: tr('编辑') },
      { key: 'copy', label: tr('复制') },
      ...plugins.extensions
        .filter((e) => e.kind === 'host_menu')
        .map((e) => ({ key: `plugin:${e.pluginId}:${e.id}` as MenuAction, label: e.label })),
      { key: 'deleteHost', label: tr('删除'), danger: true },
    ];
  return [
    { key: 'newHost', label: tr('新建主机') },
    { key: 'newFolder', label: tr('新建文件夹') },
    ...(target.id === null
      ? [{ key: 'importOpenssh' as const, label: tr('导入 SSH 配置…') }]
      : [
          { key: 'rename' as const, label: tr('重命名文件夹') },
          { key: 'deleteFolder' as const, label: tr('删除文件夹'), danger: true },
        ]),
  ];
});
function dismissContext(restoreFocus = false): void {
  context.value = undefined;
  if (restoreFocus && contextTrigger?.isConnected) contextTrigger.focus({ preventScroll: true });
}
function treeScrolled(event: Event): void {
  if (context.value && (event.currentTarget as HTMLElement).scrollTop !== contextScrollTop)
    dismissContext();
}
async function openContext(
  target: ContextTarget,
  event: MouseEvent | KeyboardEvent,
): Promise<void> {
  if (
    props.active === false ||
    !store.catalog ||
    document.querySelector('dialog[open]') ||
    dragged.value
  )
    return;
  contextTrigger = event.currentTarget as HTMLElement;
  contextScrollTop = tree.value?.querySelector<HTMLElement>('.host-tree-scroll')?.scrollTop ?? 0;
  const anchor = contextTrigger.getBoundingClientRect();
  const keyboard = event instanceof KeyboardEvent || (!event.clientX && !event.clientY);
  context.value = {
    target,
    x: keyboard ? anchor.left : event.clientX,
    y: keyboard ? anchor.bottom : event.clientY,
  };
  await nextTick();
  if (!context.value || !menuElement.value) return;
  const bounds = menuElement.value.getBoundingClientRect();
  context.value.x = Math.max(8, Math.min(context.value.x, window.innerWidth - bounds.width - 8));
  context.value.y = Math.max(8, Math.min(context.value.y, window.innerHeight - bounds.height - 8));
  menuElement.value
    .querySelector<HTMLButtonElement>('button:not(:disabled)')
    ?.focus({ preventScroll: true });
}
function contextKeys(target: ContextTarget, event: KeyboardEvent): void {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
  event.preventDefault();
  event.stopPropagation();
  void openContext(target, event);
}
function menuKeys(event: KeyboardEvent): void {
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    dismissContext(true);
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = [
    ...(menuElement.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ];
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  items[
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  ]?.focus();
}
async function runContext(action: MenuAction): Promise<void> {
  const target = context.value?.target;
  if (!target || store.busy) return;
  dismissContext(true);
  if (target.kind === 'folder') {
    const group = store.catalog?.groups.find((group) => group.id === target.id);
    if (target.id !== null && !group) {
      store.error = tr('目标文件夹已不存在，请刷新后重试。');
      return;
    }
    if (action === 'newHost') emit('create', target.id);
    else if (action === 'newFolder') folderEditor.value = { parentId: target.id };
    else if (action === 'importOpenssh') emit('importOpenssh');
    else if (action === 'rename' && group)
      folderEditor.value = { parentId: group.parentId ?? null, group: { ...group } };
    else if (action === 'deleteFolder' && group) deletingFolder.value = { ...group };
    return;
  }
  const host = store.catalog?.hosts.find((host) => host.id === target.id);
  if (!host) {
    store.error = tr('目标主机已不存在，请刷新后重试。');
    return;
  }
  if (action.startsWith('plugin:')) {
    const [, id, contribution] = action.split(':');
    if (id && contribution) emit('plugin', id, contribution, host.id);
  } else if (action === 'connect') {
    store.selectedId = host.id;
    emit('select', host);
  } else if (action === 'edit') controls.get(host.id)?.edit();
  else if (action === 'deleteHost') controls.get(host.id)?.confirmDelete();
  else if (action === 'copy') {
    const result = await store.run(() => hostsApi.copy(host.id), tr('主机已复制。'));
    if (result.ok) emit('saved', result.value);
  }
}
function folderSaved(group: HostGroup): void {
  store.search = '';
  const ancestors = ['root', ...folderAncestors(store.catalog?.groups ?? [], group.id)];
  collapsed.value = collapsed.value.filter((id) => !ancestors.includes(id));
}
async function removeFolder(): Promise<void> {
  const group = deletingFolder.value;
  if (!group) return;
  const result = await store.run(
    () => hostsApi.groupRemove(group.id),
    tr('文件夹已删除，主机和子文件夹已保留在父目录。'),
  );
  if (result.ok) deletingFolder.value = undefined;
}
const closeContext = () => dismissContext();
watch(() => store.catalog, closeContext);
watch(
  () => props.active,
  (active) => {
    if (active === false) dismissContext();
  },
);
onMounted(() => {
  window.addEventListener('blur', closeContext);
  window.addEventListener('resize', closeContext);
});
onBeforeUnmount(() => {
  window.removeEventListener('blur', closeContext);
  window.removeEventListener('resize', closeContext);
});
</script>
<template>
  <section
    ref="tree"
    class="host-tree-section"
    :class="{ 'host-dragging': dragged }"
    :aria-label="tr('主机树')"
    @keydown="keys"
    @click.capture="ignoreDragClick"
  >
    <div class="host-list-heading">
      <span class="host-list-title"
        >{{ tr(' 主机')
        }}<small v-if="store.catalog" class="host-count">{{ store.catalog.hosts.length }}</small>
      </span>
      <button
        type="button"
        class="shell-icon-button"
        :aria-label="tr('新建主机')"
        :title="tr('新建主机')"
        @click="$emit('create', null)"
      >
        <Plus :size="16" aria-hidden="true" />
      </button>
    </div>
    <div class="host-sidebar-controls">
      <label class="host-search-field">
        <Search :size="14" aria-hidden="true" />
        <input
          id="host-tree-search"
          v-model="store.search"
          class="sidebar-search"
          :aria-label="tr('搜索主机')"
          :placeholder="tr('搜索主机、地址、用户名…')"
        />
      </label>
    </div>
    <div class="host-tree-scroll" :aria-busy="store.busy" @scroll="treeScrolled">
      <p v-if="store.busy && !store.catalog" class="host-empty" role="status">
        {{ tr('正在读取主机…') }}
      </p>
      <p v-else-if="!store.catalog" class="host-empty" role="status">
        {{ tr('未能读取主机，请刷新重试。') }}
      </p>
      <div
        v-for="group in store.catalog ? nodes : []"
        :key="group.id ?? 'root'"
        class="tree-group"
        :data-group-id="group.id ?? ''"
        :class="{ 'drop-target': dropTarget === (group.id ?? 'root') }"
      >
        <button
          class="group-toggle"
          :aria-expanded="!isCollapsed(group.id)"
          :style="{ paddingLeft: `${6 + group.depth * 14}px` }"
          @contextmenu.prevent.stop="openContext({ kind: 'folder', id: group.id }, $event)"
          @keydown="contextKeys({ kind: 'folder', id: group.id }, $event)"
          @click="toggle(group.id ?? 'root')"
        >
          <ChevronRight v-if="isCollapsed(group.id)" :size="12" aria-hidden="true" />
          <ChevronDown v-else :size="12" aria-hidden="true" />
          <Folder v-if="isCollapsed(group.id)" :size="14" aria-hidden="true" />
          <FolderOpen v-else :size="14" aria-hidden="true" />
          <span class="group-name">{{ group.name }}</span
          ><span class="group-count">{{ group.count }}</span>
        </button>
        <template v-if="!isCollapsed(group.id)">
          <div
            v-for="host in group.hosts"
            :key="host.id"
            class="tree-host-row"
            :style="{ paddingLeft: `${group.depth * 14}px` }"
          >
            <button
              :data-host-id="host.id"
              class="tree-host"
              :class="{
                selected: store.selectedId === host.id,
                'drag-ready': pendingDrag?.host.id === host.id,
              }"
              :title="
                tr('{0}@{1}:{2} · 拖动可移动到其他文件夹', host.username, host.hostname, host.port)
              "
              :aria-current="store.selectedId === host.id ? 'true' : undefined"
              :draggable="false"
              @pointerdown="beginDrag(host, $event)"
              @dragstart.prevent
              @click="
                store.selectedId = host.id;
                $emit('select', host);
              "
              @contextmenu.prevent.stop="openContext({ kind: 'host', id: host.id }, $event)"
              @keydown="contextKeys({ kind: 'host', id: host.id }, $event)"
            >
              <span
                :class="['disconnected-dot', { connected: hostState(host.id) === tr('已连接') }]"
                :aria-label="hostState(host.id)"
              ></span
              ><span class="host-label"
                ><span class="host-name">{{ hostDisplayName(host) }}</span
                ><span v-if="hostDisplayName(host) !== hostAddress(host)" class="host-address">{{
                  hostAddress(host)
                }}</span></span
              >
            </button>
            <HostTreeControls
              :ref="(component) => setControls(host.id, component)"
              :host="host"
              @saved="$emit('saved', $event)"
            />
          </div>
        </template>
      </div>
      <div v-if="store.catalog && !store.visible.length" class="host-empty">
        <Server :size="26" :stroke-width="1.3" aria-hidden="true" />
        <p>{{ store.catalog.hosts.length ? tr('没有匹配的主机') : tr('尚未添加主机') }}</p>
        <p v-if="!store.catalog.hosts.length" class="subtle">
          {{ tr('右键根目录新建主机或文件夹') }}
        </p>
      </div>
      <button
        v-if="store.visible.length > limit"
        class="button host-load-more"
        @click="limit += 200"
      >
        {{ tr(' 显示更多主机（') }}{{ limit }} / {{ store.visible.length }}）
      </button>
    </div>
    <div
      v-if="dragged"
      class="host-drag-preview"
      aria-hidden="true"
      :style="{ left: `${dragPosition.x + 12}px`, top: `${dragPosition.y + 12}px` }"
    >
      {{ hostDisplayName(store.catalog?.hosts.find((h) => h.id === dragged)) }}
      <span>{{
        dropTarget
          ? tr(
              '移动到 {0}',
              dropTarget === 'root'
                ? tr('根目录')
                : store.catalog?.groups.find((g) => g.id === dropTarget)?.name,
            )
          : tr('拖到其他文件夹，Esc 取消')
      }}</span>
    </div>
    <GroupManager
      v-if="folderEditor"
      :parent-id="folderEditor.parentId"
      :group="folderEditor.group"
      @saved="folderSaved"
      @close="folderEditor = undefined"
    />
    <Modal
      v-if="deletingFolder"
      :title="tr('确认删除文件夹')"
      :busy="store.busy"
      @close="deletingFolder = undefined"
    >
      <p>
        {{ tr(' 删除“') }}{{ deletingFolder.name
        }}{{ tr('”？其中的主机和子文件夹会保留并移到父目录，不会删除主机配置或关闭连接。 ') }}
      </p>
      <footer class="dialog-actions">
        <button class="button" :disabled="store.busy" @click="deletingFolder = undefined">
          {{ tr(' 取消 ') }}
        </button>
        <button class="button danger" :disabled="store.busy" @click="removeFolder">
          {{ tr(' 确认删除文件夹 ') }}
        </button>
      </footer>
    </Modal>
    <Teleport to="body">
      <template v-if="context">
        <button
          class="context-backdrop"
          :aria-label="tr('关闭主机树菜单')"
          @click="dismissContext(true)"
          @contextmenu.prevent="dismissContext(true)"
        ></button>
        <div
          ref="menuElement"
          class="context-menu host-tree-menu"
          role="menu"
          :aria-label="tr('主机树操作')"
          :style="{ left: `${context.x}px`, top: `${context.y}px` }"
          @keydown="menuKeys"
          @contextmenu.prevent
        >
          <template v-for="item in menuItems" :key="item.key">
            <div v-if="item.key === 'importOpenssh'" role="separator"></div>
            <button
              role="menuitem"
              :class="{ danger: item.danger }"
              :disabled="store.busy"
              @click="runContext(item.key)"
            >
              {{ item.label }}
            </button>
          </template>
        </div>
      </template>
    </Teleport>
  </section>
</template>
