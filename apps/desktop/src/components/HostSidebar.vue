<script setup lang="ts">
import { tr } from '../i18n/messages';

import { useBackgroundStore } from '../stores/background';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eraser,
  FileInput,
  FileOutput,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plug,
  Puzzle,
  Save,
  Search,
  Server,
  Star,
  Tags,
  TextCursorInput,
  Trash2,
} from '@lucide/vue';
const background = useBackgroundStore();
import { useOpsStore } from '../stores/ops';
import { usePluginsStore } from '../stores/plugins';
const plugins = usePluginsStore();
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type Component,
} from 'vue';
import { useHostsStore } from '../stores/hosts';
import { useTerminalsStore } from '../stores/terminals';
import { hostDisplayName, type Host, type HostGroup } from '../types/hosts';
import { useFilesStore } from '../stores/files';
import HostTreeControls from './HostTreeControls.vue';
import HostIcon from './HostIcon.vue';
import EnvironmentTagBadge from './EnvironmentTagBadge.vue';
import TreeRenameInput from './TreeRenameInput.vue';
import SavedTerminalSessions from './SavedTerminalSessions.vue';
import GroupManager from './GroupManager.vue';
import Modal from './Modal.vue';
import { hostsApi } from '../services/hosts';
import { folderAncestors, hostFolderRows } from '../services/host-tree';
import { submenuPosition } from '../services/context-menu';
const store = useHostsStore();
const terminals = useTerminalsStore();
const files = useFilesStore();
const operations = useOpsStore();
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
  importHosts: [];
  select: [host: Host];
  saved: [host: Host];
  plugin: [id: string, contribution: string, hostId: string];
  manageEnvironmentTags: [];
  restoreSession: [host: Host, id: string];
}>();
const collapsedFoldersKey = 'serverdeck.host-tree.collapsed.v1';
function readCollapsedFolders(): string[] {
  try {
    const saved = window.localStorage.getItem(collapsedFoldersKey);
    if (saved === null) return [];
    const ids: unknown = JSON.parse(saved);
    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) return ids;
  } catch {
    // Unavailable or malformed storage falls back to the default tree.
  }
  console.warn('Could not restore host folder expansion state.');
  return [];
}
const collapsed = ref(readCollapsedFolders());
watch(
  collapsed,
  (ids) => {
    try {
      window.localStorage.setItem(collapsedFoldersKey, JSON.stringify(ids));
    } catch {
      console.warn('Could not save host folder expansion state.');
    }
  },
  { flush: 'sync' },
);
const selectedFolder = ref<string>();
watch(
  () => store.selectedId,
  () => (selectedFolder.value = undefined),
  { flush: 'sync' },
);
function selectFolder(id: string, event: MouseEvent): void {
  selectedFolder.value = id;
  (event.currentTarget as HTMLElement).focus({ preventScroll: true });
}
function selectHost(host: Host): void {
  selectedFolder.value = undefined;
  store.selectedId = host.id;
}
const tree = ref<HTMLElement>();
const list = ref<HTMLElement>();
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
function isListBackground(element: Element): boolean {
  return element === list.value || !!element.closest('.host-empty');
}
function targetGroup(event: PointerEvent): string | null {
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  if (!hit || !list.value?.contains(hit)) return null;
  const group = hit.closest<HTMLElement>('.tree-group');
  if (!group && !isListBackground(hit)) return null;
  const id = group?.dataset.groupId || null;
  return id === pendingDrag.value?.host.groupId ? null : (id ?? 'root');
}
function beginDrag(host: Host, event: PointerEvent): void {
  if (event.button !== 0 || event.pointerType === 'touch' || store.busy || renaming.value) return;
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
function openHost(host: Host): void {
  if (suppressClick || store.busy || renaming.value) return;
  selectHost(host);
  emit('select', host);
}
onBeforeUnmount(() => {
  endDrag();
  clearTimeout(clickTimer);
});
const limit = ref(200);
const favoritesOnly = ref(false);
const visibleHosts = computed(() =>
  favoritesOnly.value ? store.visible.filter((host) => host.favorite) : store.visible,
);
const emptyMessage = computed(() => {
  if (!store.catalog || visibleHosts.value.length) return '';
  if (store.search.trim()) return tr('没有匹配的主机');
  if (favoritesOnly.value) return tr('暂无收藏的主机');
  return store.catalog.groups.length ? '' : tr('尚未添加主机');
});
function showFavorites(onlyFavorites: boolean): void {
  if (favoritesOnly.value === onlyFavorites) return;
  favoritesOnly.value = onlyFavorites;
  limit.value = 200;
  dismissContext();
  void finishRename(false);
  if (list.value) list.value.scrollTop = 0;
}
watch(
  () => store.search,
  () => (limit.value = 200),
);
watch(
  () => [store.selectedId, store.catalog] as const,
  ([id], [previousId, previousCatalog]) => {
    const host = store.selected;
    if (!host) return;
    if (id !== previousId && favoritesOnly.value && !host.favorite) showFavorites(false);
    if (
      id !== previousId ||
      previousCatalog?.hosts.find((item) => item.id === id)?.groupId !== host.groupId
    )
      revealFolder(host.groupId);
    const index = visibleHosts.value.findIndex((item) => item.id === id);
    if (index >= limit.value) limit.value = Math.ceil((index + 1) / 200) * 200;
  },
);
const sections = computed(() => {
  if (favoritesOnly.value)
    return [
      {
        id: null,
        name: tr('收藏'),
        depth: 0,
        hosts: visibleHosts.value.slice(0, limit.value),
        count: visibleHosts.value.length,
        favorites: true,
      },
    ];
  return hostFolderRows(
    store.catalog?.groups ?? [],
    visibleHosts.value,
    collapsed.value,
    !!store.search.trim(),
    limit.value,
  )
    .filter((folder) => folder.id !== null || folder.hosts.length > 0)
    .map((folder) => ({ ...folder, depth: Math.max(0, folder.depth - 1), favorites: false }));
});
const isCollapsed = (id: string | null) =>
  id !== null && !store.search.trim() && collapsed.value.includes(id);
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
function revealFolder(id: string | null): void {
  const ancestors = folderAncestors(store.catalog?.groups ?? [], id);
  const remaining = collapsed.value.filter((group) => !ancestors.includes(group));
  if (remaining.length !== collapsed.value.length) collapsed.value = remaining;
}

type HostTarget = { kind: 'host'; id: string; favoriteRow: boolean };
type ContextTarget = { kind: 'folder'; id: string | null } | HostTarget;
function hostTarget(id: string, favoriteRow: boolean): HostTarget {
  return { kind: 'host', id, favoriteRow };
}
function hostRowKey(id: string, favoriteRow: boolean): string {
  return favoriteRow ? `favorite:${id}` : id;
}
const renaming = ref<{
  target: ContextTarget;
  name: string;
  initialName: string;
  busy: boolean;
  error: string | null;
}>();
function isRenaming(kind: ContextTarget['kind'], id: string | null, favoriteRow = false): boolean {
  const target = renaming.value?.target;
  return (
    target?.kind === kind &&
    target.id === id &&
    (target.kind !== 'host' || target.favoriteRow === favoriteRow)
  );
}
async function toggleFavorite(host: Host, event: MouseEvent): Promise<void> {
  const trigger = event.currentTarget as HTMLButtonElement;
  if (!(await store.setFavorite(host.id, !host.favorite))) return;
  await nextTick();
  if (!trigger.isConnected && document.activeElement === document.body) {
    const row = [...(tree.value?.querySelectorAll<HTMLElement>('.tree-host') ?? [])].find(
      (row) => row.dataset.hostId === host.id,
    );
    (row ?? tree.value?.querySelector<HTMLElement>('#host-tree-search'))?.focus();
  }
}
function beginRename(target: ContextTarget): void {
  if (
    !props.active ||
    store.busy ||
    renaming.value ||
    dragged.value ||
    document.querySelector('dialog[open]')
  )
    return;
  const host =
    target.kind === 'host' ? store.catalog?.hosts.find((host) => host.id === target.id) : undefined;
  const name = host
    ? hostDisplayName(host)
    : target.kind === 'folder'
      ? store.catalog?.groups.find((group) => group.id === target.id)?.name
      : undefined;
  if (name === undefined) return;
  renaming.value = { target, name, initialName: name, busy: false, error: null };
}
async function finishRename(restoreFocus: boolean): Promise<void> {
  const target = renaming.value?.target;
  renaming.value = undefined;
  if (!restoreFocus || !target) return;
  await nextTick();
  const row =
    target.kind === 'host'
      ? [...(tree.value?.querySelectorAll<HTMLElement>('.tree-host') ?? [])].find(
          (row) => row.dataset.hostRowKey === hostRowKey(target.id, target.favoriteRow),
        )
      : [...(tree.value?.querySelectorAll<HTMLElement>('.tree-group') ?? [])]
          .find((row) => row.dataset.groupId === target.id)
          ?.querySelector<HTMLElement>('.group-toggle');
  row?.focus({ preventScroll: true });
}
function changeRename(name: string): void {
  if (!renaming.value || renaming.value.busy) return;
  renaming.value.name = name;
  renaming.value.error = null;
}
async function saveRename(reason: 'enter' | 'blur'): Promise<void> {
  const edit = renaming.value;
  if (!edit || edit.busy || store.busy) return;
  const name = edit.name.trim();
  if (edit.target.kind === 'folder' && !name) {
    edit.error = tr('名称须为 1–128 个字符，且不含控制字符');
    return;
  }
  if (name === edit.initialName.trim()) {
    await finishRename(reason === 'enter');
    return;
  }
  edit.busy = true;
  const ok =
    edit.target.kind === 'host'
      ? await store.renameHost(edit.target.id, name)
      : edit.target.id !== null && (await store.renameGroup(edit.target.id, name));
  if (renaming.value !== edit) return;
  edit.busy = false;
  if (ok) await finishRename(reason === 'enter');
  else edit.error = store.error ?? tr('操作未完成，请重试并检查本地应用日志。');
}
type MenuAction =
  | 'export'
  | 'import'
  | 'newHost'
  | 'newFolder'
  | 'rename'
  | 'deleteFolder'
  | 'connect'
  | 'edit'
  | 'copy'
  | 'deleteHost'
  | `plugin:${string}:${string}`;
const context = ref<{ target: ContextTarget; x: number; y: number }>();
const contextHostId = computed(() =>
  context.value?.target.kind === 'host' ? context.value.target.id : null,
);
const contextHost = computed(() =>
  store.catalog?.hosts.find((host) => host.id === contextHostId.value),
);
const contextTagId = computed(() =>
  contextHostId.value ? store.environmentTag(contextHostId.value)?.id : undefined,
);
const menuElement = ref<HTMLElement>();
type HostSubmenu = 'tags' | 'sessions';
const submenuElement = ref<HTMLElement>();
const tagMenuTrigger = ref<HTMLButtonElement>();
const savedMenuTrigger = ref<HTMLButtonElement>();
const submenu = ref<{ kind: HostSubmenu; x: number; y: number; width?: string }>();
let contextTrigger: HTMLElement | undefined;
let contextScrollTop = 0;
const controls = new Map<string, InstanceType<typeof HostTreeControls>>();
function setControls(id: string, component: unknown): void {
  if (component) controls.set(id, component as InstanceType<typeof HostTreeControls>);
  else controls.delete(id);
}
const folderEditor = ref<{ parentId: string | null }>();
const deletingFolder = ref<HostGroup>();
function confirmDelete(target: ContextTarget): void {
  if (target.kind === 'host')
    controls.get(hostRowKey(target.id, target.favoriteRow))?.confirmDelete();
  else {
    const group = store.catalog?.groups.find((group) => group.id === target.id);
    if (group) deletingFolder.value = { ...group };
  }
}
type MenuItem = {
  key: MenuAction;
  label: string;
  icon: Component;
  iconClass: string;
  danger?: boolean;
};
const menuItems = computed<MenuItem[]>(() => {
  const target = context.value?.target;
  if (!target) return [];
  if (target.kind === 'host')
    return [
      { key: 'connect', label: tr('连接'), icon: Plug, iconClass: 'menu-icon-green' },
      { key: 'edit', label: tr('编辑'), icon: Pencil, iconClass: 'menu-icon-gold' },
      { key: 'rename', label: tr('重命名'), icon: TextCursorInput, iconClass: 'menu-icon-gold' },
      { key: 'copy', label: tr('复制'), icon: Copy, iconClass: 'menu-icon-blue' },
      ...plugins.extensions
        .filter((e) => e.kind === 'host_menu')
        .map((e) => ({
          key: `plugin:${e.pluginId}:${e.id}` as MenuAction,
          label: e.label,
          icon: Puzzle,
          iconClass: 'menu-icon-purple',
        })),
      {
        key: 'deleteHost',
        label: tr('删除'),
        icon: Trash2,
        iconClass: 'menu-icon-red',
        danger: true,
      },
    ];
  const createItems: MenuItem[] = [
    { key: 'newHost', label: tr('新建主机'), icon: Server, iconClass: 'menu-icon-blue' },
    { key: 'newFolder', label: tr('新建文件夹'), icon: FolderPlus, iconClass: 'menu-icon-gold' },
  ];
  if (target.id !== null)
    return [
      ...createItems,
      { key: 'rename', label: tr('重命名'), icon: TextCursorInput, iconClass: 'menu-icon-gold' },
      {
        key: 'deleteFolder',
        label: tr('删除'),
        icon: Trash2,
        iconClass: 'menu-icon-red',
        danger: true,
      },
    ];
  const transferItems: MenuItem[] = [
    { key: 'import', label: tr('导入…'), icon: FileInput, iconClass: 'menu-icon-green' },
    { key: 'export', label: tr('导出…'), icon: FileOutput, iconClass: 'menu-icon-blue' },
  ];
  if (!store.catalog) return transferItems;
  return [...createItems, ...transferItems];
});
function dismissContext(restoreFocus = false): void {
  closeSubmenu();
  context.value = undefined;
  if (restoreFocus && contextTrigger?.isConnected) contextTrigger.focus({ preventScroll: true });
}
function submenuTrigger(kind: HostSubmenu): HTMLButtonElement | undefined {
  return kind === 'tags' ? tagMenuTrigger.value : savedMenuTrigger.value;
}
function closeSubmenu(restoreFocus = false): void {
  const current = submenu.value;
  submenu.value = undefined;
  if (restoreFocus && current) submenuTrigger(current.kind)?.focus({ preventScroll: true });
}
function positionSubmenu(): void {
  const current = submenu.value;
  const trigger = current && submenuTrigger(current.kind);
  if (!current || !trigger || !menuElement.value || !submenuElement.value) return;
  Object.assign(
    current,
    submenuPosition(
      menuElement.value.getBoundingClientRect(),
      trigger.getBoundingClientRect().top,
      submenuElement.value.getBoundingClientRect(),
    ),
  );
}
async function openSubmenu(kind: HostSubmenu, focus = false): Promise<void> {
  const target = context.value;
  const parent = menuElement.value;
  if (!target || !parent || !submenuTrigger(kind) || store.busy) return;
  if (submenu.value?.kind !== kind)
    submenu.value = {
      kind,
      x: target.x,
      y: target.y,
      width: kind === 'sessions' ? `${parent.getBoundingClientRect().width}px` : undefined,
    };
  await nextTick();
  const element = submenuElement.value;
  if (context.value !== target || submenu.value?.kind !== kind || !element) return;
  positionSubmenu();
  if (focus) (element.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? element).focus();
}
function hoverMenu(event: PointerEvent): void {
  const current = submenu.value;
  const button = (event.target as Element).closest('button');
  if (current && button && button !== submenuTrigger(current.kind))
    closeSubmenu(submenuElement.value?.contains(document.activeElement));
}
watch(
  () => {
    const id = contextHostId.value;
    return submenu.value?.kind === 'sessions' && id
      ? [terminals.savedSessions(id).length, terminals.sshLoading.has(id), terminals.sshErrors[id]]
      : undefined;
  },
  (state) => {
    if (state) positionSubmenu();
  },
  { flush: 'post' },
);
function restoreSession(id: string): void {
  const host = contextHost.value;
  if (!host) return;
  dismissContext(true);
  emit('restoreSession', host, id);
}
async function assignEnvironmentTag(tagId: string | null): Promise<void> {
  const hostId = contextHostId.value;
  if (!hostId || store.busy) return;
  dismissContext(true);
  if ((store.environmentTag(hostId)?.id ?? null) !== tagId)
    await store.setEnvironmentTag(hostId, tagId);
}
function manageEnvironmentTags(): void {
  dismissContext(true);
  emit('manageEnvironmentTags');
}
function outsideContext(event: PointerEvent): void {
  const target = event.target as Node;
  if (
    context.value &&
    !menuElement.value?.contains(target) &&
    !submenuElement.value?.contains(target)
  )
    dismissContext();
}
function treeScrolled(event: Event): void {
  if (context.value && (event.currentTarget as HTMLElement).scrollTop !== contextScrollTop)
    dismissContext();
}
function openBackgroundMenu(event: MouseEvent): void {
  if (event.target instanceof Element && isListBackground(event.target)) {
    event.preventDefault();
    event.stopPropagation();
    void openContext({ kind: 'folder', id: null }, event);
  }
}
async function openContext(
  target: ContextTarget,
  event: MouseEvent | KeyboardEvent,
): Promise<void> {
  if (
    props.active === false ||
    (!store.catalog && target.id !== null) ||
    document.querySelector('dialog[open]') ||
    dragged.value ||
    renaming.value
  )
    return;
  contextTrigger = event.currentTarget as HTMLElement;
  contextScrollTop = list.value?.scrollTop ?? 0;
  const anchor = contextTrigger.getBoundingClientRect();
  const anchored = event instanceof KeyboardEvent || (!event.clientX && !event.clientY);
  closeSubmenu();
  context.value = {
    target,
    x: anchored ? anchor.left : event.clientX,
    y: anchored ? (contextTrigger === list.value ? anchor.top : anchor.bottom) : event.clientY,
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
function rowKeys(target: ContextTarget, event: KeyboardEvent): void {
  if (
    event.defaultPrevented ||
    (event.target !== event.currentTarget &&
      !(event.target instanceof HTMLElement && event.target.matches('.group-expander')))
  )
    return;
  if (event.key === 'Delete' || event.key === 'F2') {
    if (
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      !props.active ||
      store.busy ||
      !store.catalog ||
      document.querySelector('dialog[open]') ||
      dragged.value ||
      context.value ||
      renaming.value ||
      (target.kind === 'folder' && target.id === null)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'F2') beginRename(target);
    else confirmDelete(target);
    return;
  }
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
  event.preventDefault();
  event.stopPropagation();
  void openContext(target, event);
}
function menuKeys(event: KeyboardEvent): void {
  const element = event.currentTarget as HTMLElement;
  if (element === submenuElement.value && ['Escape', 'ArrowLeft'].includes(event.key)) {
    event.preventDefault();
    closeSubmenu(true);
    return;
  }
  if (event.key === 'ArrowRight' && document.activeElement === tagMenuTrigger.value) {
    event.preventDefault();
    void openSubmenu('tags', true);
    return;
  }
  if (event.key === 'ArrowRight' && document.activeElement === savedMenuTrigger.value) {
    event.preventDefault();
    void openSubmenu('sessions', true);
    return;
  }
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    dismissContext(true);
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = [...element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  if (!items.length) return;
  const focused = items.indexOf(document.activeElement as HTMLButtonElement);
  const delta = event.key === 'ArrowUp' ? -1 : 1;
  const index = focused < 0 && delta < 0 ? 0 : focused;
  const next =
    items[
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + delta + items.length) % items.length
    ];
  if (element === menuElement.value && submenu.value && next !== submenuTrigger(submenu.value.kind))
    closeSubmenu();
  next?.focus();
}
async function runContext(action: MenuAction): Promise<void> {
  const target = context.value?.target;
  if (!target || store.busy) return;
  dismissContext(true);
  if (target.kind === 'folder') {
    if (target.id === null && action === 'import') {
      emit('importHosts');
      return;
    }
    if (target.id === null && action === 'export') {
      await store.backup('export');
      return;
    }
    const group = store.catalog?.groups.find((group) => group.id === target.id);
    if (target.id !== null && !group) {
      store.error = tr('目标文件夹已不存在，请刷新后重试。');
      return;
    }
    if (action === 'newHost') emit('create', target.id);
    else if (action === 'newFolder') folderEditor.value = { parentId: target.id };
    else if (action === 'rename' && group) beginRename(target);
    else if (action === 'deleteFolder' && group) confirmDelete(target);
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
    selectHost(host);
    emit('select', host);
  } else if (action === 'edit') controls.get(hostRowKey(host.id, target.favoriteRow))?.edit();
  else if (action === 'rename') beginRename(target);
  else if (action === 'deleteHost') confirmDelete(target);
  else if (action === 'copy') {
    const result = await store.run(() => hostsApi.copy(host.id), tr('主机已复制。'));
    if (result.ok) emit('saved', result.value);
  }
}
function folderSaved(group: HostGroup): void {
  showFavorites(false);
  store.search = '';
  revealFolder(group.id);
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
watch(
  () => store.catalog,
  (catalog) => {
    if (
      !catalog ||
      (selectedFolder.value !== undefined &&
        !catalog.groups.some((group) => group.id === selectedFolder.value))
    )
      selectedFolder.value = undefined;
    if (catalog && collapsed.value.length) {
      const groupIds = new Set(catalog.groups.map((group) => group.id));
      const remaining = collapsed.value.filter((id) => groupIds.has(id));
      if (remaining.length !== collapsed.value.length) collapsed.value = remaining;
    }
  },
  { immediate: true },
);
watch(
  () => [store.catalog, store.search] as const,
  () => {
    closeContext();
    if (!renaming.value?.busy) void finishRename(false);
  },
);
watch(
  () => props.active,
  (active) => {
    if (active === false) {
      dismissContext();
      void finishRename(false);
    }
  },
);
onMounted(() => {
  window.addEventListener('contextmenu', closeContext, true);
  window.addEventListener('pointerdown', outsideContext, true);
  window.addEventListener('blur', closeContext);
  window.addEventListener('resize', closeContext);
});
onBeforeUnmount(() => {
  window.removeEventListener('contextmenu', closeContext, true);
  window.removeEventListener('pointerdown', outsideContext, true);
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
    <div class="host-list-heading host-library-heading">
      <h2 class="host-list-title">{{ tr('主机管理') }}</h2>
      <slot name="heading-actions"></slot>
    </div>
    <div class="host-views" role="group" :aria-label="tr('主机列表')">
      <button
        type="button"
        :aria-pressed="!favoritesOnly"
        :disabled="!!renaming || !!dragged"
        @click="showFavorites(false)"
      >
        <Server :size="14" aria-hidden="true" /><span>{{ tr('全部') }}</span>
      </button>
      <button
        type="button"
        :aria-pressed="favoritesOnly"
        :disabled="!!renaming || !!dragged"
        @click="showFavorites(true)"
      >
        <Star :size="14" aria-hidden="true" /><span>{{ tr('收藏') }}</span>
      </button>
    </div>
    <div class="host-sidebar-controls">
      <label class="host-search-field">
        <Search :size="15" aria-hidden="true" />
        <input
          id="host-tree-search"
          v-model="store.search"
          class="sidebar-search"
          :aria-label="tr('搜索主机')"
          :placeholder="tr('搜索主机、地址、用户名…')"
        />
      </label>
    </div>
    <div
      ref="list"
      class="host-tree-scroll"
      :class="{ 'drop-target': dropTarget === 'root' }"
      tabindex="0"
      role="region"
      :aria-label="tr('主机列表')"
      :aria-busy="store.busy"
      @contextmenu="openBackgroundMenu"
      @keydown.self="rowKeys({ kind: 'folder', id: null }, $event)"
      @scroll="treeScrolled"
    >
      <p v-if="store.busy && !store.catalog" class="host-empty" role="status">
        {{ tr('正在读取主机…') }}
      </p>
      <p v-else-if="!store.catalog" class="host-empty" role="status">
        {{ tr('未能读取主机，请刷新重试。') }}
      </p>
      <div
        v-for="group in store.catalog ? sections : []"
        :key="group.favorites ? 'favorites' : (group.id ?? 'root')"
        :class="{
          'host-favorites': group.favorites,
          'tree-group': !group.favorites,
          'drop-target': group.id !== null && dropTarget === group.id,
        }"
        :data-group-id="group.favorites ? undefined : (group.id ?? '')"
        :style="{ '--folder-depth': group.depth }"
      >
        <div
          v-if="group.id !== null"
          class="group-toggle"
          :class="{ selected: selectedFolder === group.id }"
          :aria-current="selectedFolder === group.id ? 'true' : undefined"
          tabindex="0"
          @contextmenu.prevent.stop="openContext({ kind: 'folder', id: group.id }, $event)"
          @keydown="rowKeys({ kind: 'folder', id: group.id }, $event)"
          @click="selectFolder(group.id, $event)"
        >
          <button
            type="button"
            class="group-expander"
            :aria-expanded="!isCollapsed(group.id)"
            :aria-label="
              isCollapsed(group.id) ? tr('展开 {0}', group.name) : tr('收起 {0}', group.name)
            "
            :disabled="!!renaming || !!store.search.trim()"
            @click.stop="toggle(group.id)"
          >
            <ChevronRight v-if="isCollapsed(group.id)" :size="12" aria-hidden="true" />
            <ChevronDown v-else :size="12" aria-hidden="true" />
          </button>
          <component
            :is="isCollapsed(group.id) ? Folder : FolderOpen"
            class="host-group-icon"
            :size="18"
            :stroke-width="1.2"
            aria-hidden="true"
          />
          <TreeRenameInput
            v-if="isRenaming('folder', group.id) && renaming"
            :name="renaming.name"
            :label="tr('重命名 {0}', renaming.initialName)"
            :required="true"
            :busy="renaming.busy"
            :error="renaming.error"
            @change="changeRename"
            @submit="saveRename"
            @cancel="finishRename(true)"
          />
          <span v-else class="group-name">{{ group.name }}</span>
          <span class="group-count">{{ group.count }}</span>
        </div>
        <template v-if="!isCollapsed(group.id)">
          <div v-for="host in group.hosts" :key="host.id" class="tree-host-row">
            <component
              :is="isRenaming('host', host.id, group.favorites) ? 'div' : 'button'"
              :data-host-id="host.id"
              :data-host-row-key="hostRowKey(host.id, group.favorites)"
              class="tree-host"
              :class="{
                selected: selectedFolder === undefined && store.selectedId === host.id,
                'drag-ready': pendingDrag?.host.id === host.id,
              }"
              :aria-current="
                selectedFolder === undefined && store.selectedId === host.id ? 'true' : undefined
              "
              :draggable="false"
              @pointerdown="!group.favorites && beginDrag(host, $event)"
              @dragstart.prevent
              @click="selectHost(host)"
              @dblclick="openHost(host)"
              @keydown.enter.prevent="openHost(host)"
              @keydown.space.prevent="openHost(host)"
              @contextmenu.prevent.stop="openContext(hostTarget(host.id, group.favorites), $event)"
              @keydown="rowKeys(hostTarget(host.id, group.favorites), $event)"
            >
              <HostIcon
                :connected="hostState(host.id) === tr('已连接')"
                :label="hostState(host.id)"
              />
              <span
                class="host-label"
                :class="{ renaming: isRenaming('host', host.id, group.favorites) }"
              >
                <TreeRenameInput
                  v-if="isRenaming('host', host.id, group.favorites) && renaming"
                  :name="renaming.name"
                  :label="tr('重命名 {0}', renaming.initialName)"
                  :required="false"
                  :busy="renaming.busy"
                  :error="renaming.error"
                  @change="changeRename"
                  @submit="saveRename"
                  @cancel="finishRename(true)"
                />
                <span v-else class="host-name">{{ hostDisplayName(host) }}</span>
              </span>
              <EnvironmentTagBadge
                v-if="!isRenaming('host', host.id, group.favorites)"
                :tag="store.environmentTag(host.id)"
              />
            </component>
            <button
              type="button"
              class="host-favorite-button"
              :class="{ starred: host.favorite }"
              :aria-pressed="host.favorite"
              :aria-label="tr('收藏主机 {0}', hostDisplayName(host))"
              :title="host.favorite ? tr('取消收藏') : tr('添加到收藏')"
              :disabled="!props.active || store.busy || !!renaming || !!dragged"
              @click="toggleFavorite(host, $event)"
            >
              <Star :size="14" aria-hidden="true" />
            </button>
            <HostTreeControls
              :ref="(component) => setControls(hostRowKey(host.id, group.favorites), component)"
              :host="host"
              @saved="$emit('saved', $event)"
            />
          </div>
        </template>
      </div>
      <div v-if="emptyMessage" class="host-empty" role="status">
        <component
          :is="favoritesOnly ? Star : Server"
          :size="24"
          :stroke-width="1.5"
          aria-hidden="true"
        />
        <p>{{ emptyMessage }}</p>
        <p v-if="!favoritesOnly && !store.search.trim()" class="subtle">
          {{ tr('右键列表空白处可新建主机或文件夹') }}
        </p>
      </div>
      <button
        v-if="visibleHosts.length > limit"
        class="button host-load-more"
        @click="limit += 200"
      >
        {{ tr(' 显示更多主机（') }}{{ limit }} / {{ visibleHosts.length }}）
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
          {{ tr('删除') }}
        </button>
      </footer>
    </Modal>
    <Teleport to="body">
      <template v-if="context">
        <div
          ref="menuElement"
          class="context-menu host-tree-menu"
          data-sidebar-menu="home"
          role="menu"
          :aria-label="tr('主机树操作')"
          :style="{ left: `${context.x}px`, top: `${context.y}px` }"
          @keydown="menuKeys"
          @pointerover="hoverMenu"
          @contextmenu.prevent
        >
          <template v-for="item in menuItems" :key="item.key">
            <div v-if="item.key === 'import' && store.catalog" role="separator"></div>
            <button
              role="menuitem"
              :class="{ danger: item.danger }"
              :disabled="store.busy"
              @click="runContext(item.key)"
            >
              <component :is="item.icon" :class="item.iconClass" aria-hidden="true" />{{
                item.label
              }}
            </button>
          </template>
          <template v-if="contextHost">
            <div role="separator"></div>
            <button
              ref="savedMenuTrigger"
              role="menuitem"
              aria-haspopup="menu"
              aria-controls="host-saved-sessions-menu"
              :aria-expanded="submenu?.kind === 'sessions'"
              :disabled="store.busy"
              @pointerenter="openSubmenu('sessions')"
              @click="openSubmenu('sessions', true)"
            >
              <Save class="menu-icon-green" aria-hidden="true" />
              <span>{{ tr('已保存会话') }}</span>
              <ChevronRight
                class="host-menu-environment-arrow menu-icon-muted"
                aria-hidden="true"
              />
            </button>
            <button
              v-if="store.catalog?.environmentTags"
              ref="tagMenuTrigger"
              role="menuitem"
              aria-haspopup="menu"
              aria-controls="host-environment-menu"
              :aria-expanded="submenu?.kind === 'tags'"
              :disabled="store.busy"
              @pointerenter="openSubmenu('tags')"
              @click="openSubmenu('tags', true)"
            >
              <Tags class="menu-icon-purple" aria-hidden="true" />
              <span>{{ tr('标签') }}</span>
              <ChevronRight
                class="host-menu-environment-arrow menu-icon-muted"
                aria-hidden="true"
              />
            </button>
          </template>
        </div>
        <div
          v-if="submenu?.kind === 'tags' && contextHost && store.catalog?.environmentTags"
          id="host-environment-menu"
          ref="submenuElement"
          class="context-menu host-environment-menu"
          data-sidebar-menu="home"
          role="menu"
          :aria-label="tr('标签')"
          :style="{ left: `${submenu.x}px`, top: `${submenu.y}px` }"
          tabindex="-1"
          @keydown="menuKeys"
          @contextmenu.prevent
        >
          <button
            v-for="tag in store.catalog.environmentTags.tags"
            :key="tag.id"
            role="menuitemradio"
            :aria-checked="contextTagId === tag.id"
            :disabled="store.busy"
            @click="assignEnvironmentTag(tag.id)"
          >
            <EnvironmentTagBadge :tag="tag" />
            <Check
              v-if="contextTagId === tag.id"
              class="host-menu-environment-check"
              aria-hidden="true"
            />
          </button>
          <div v-if="store.catalog.environmentTags.tags.length" role="separator"></div>
          <button
            role="menuitem"
            :disabled="store.busy || !contextTagId"
            @click="assignEnvironmentTag(null)"
          >
            <Eraser class="menu-icon-muted" aria-hidden="true" />{{ tr('清除标签') }}
          </button>
          <button role="menuitem" @click="manageEnvironmentTags">
            <Tags class="menu-icon-muted" aria-hidden="true" />{{ tr('管理标签…') }}
          </button>
        </div>
        <div
          v-else-if="submenu?.kind === 'sessions' && contextHost"
          id="host-saved-sessions-menu"
          ref="submenuElement"
          class="context-menu"
          data-sidebar-menu="home"
          role="menu"
          :aria-label="tr('已保存会话')"
          :style="{ left: `${submenu.x}px`, top: `${submenu.y}px`, width: submenu.width }"
          tabindex="-1"
          @keydown="menuKeys"
          @contextmenu.prevent
        >
          <SavedTerminalSessions
            :key="contextHost.id"
            :host="contextHost"
            menu
            @restore="restoreSession"
          />
        </div>
      </template>
    </Teleport>
  </section>
</template>
