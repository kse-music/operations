<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw } from '@lucide/vue';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';
import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
import { tr } from '../i18n/messages';
import {
  localDirectoryLocations,
  remoteDirectoryLocations,
  type DirectoryListing,
} from '../types/files';

interface DirectoryNode {
  name: string;
  path: string;
  parent: string | null;
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  children: DirectoryNode[];
}
const props = defineProps<{
  source: { side: 'local' } | { side: 'remote'; sessionId: string };
  selected: string;
  disabled?: boolean;
  listing?: DirectoryListing;
  hideDotfiles?: boolean;
}>();
const emit = defineEmits<{ select: [path: string] }>();
const tree = ref<HTMLElement>(),
  root = ref<DirectoryNode>(),
  active = ref('/');
let generation = 0;
const label = computed(() => (props.source.side === 'local' ? tr('本地文件夹') : tr('远程文件夹')));
const locations = computed(() =>
  props.source.side === 'local'
    ? localDirectoryLocations(props.listing?.path ?? '')
    : remoteDirectoryLocations(props.listing?.path ?? '/'),
);
const rootLocation = computed(() => locations.value[0]);
const selectedBranch = computed(() => new Set(locations.value.map((item) => item.path)));
const node = (name: string, path: string, parent: string | null): DirectoryNode => ({
  name,
  path,
  parent,
  expanded: false,
  loading: false,
  loaded: false,
  error: null,
  children: [],
});
const rows = computed(() => {
  const result: { node: DirectoryNode; depth: number; leaf: boolean }[] = [];
  function visit(current: DirectoryNode, depth: number): void {
    const children = props.hideDotfiles
      ? current.children.filter(
          (child) => !child.name.startsWith('.') || selectedBranch.value.has(child.path),
        )
      : current.children;
    result.push({ node: current, depth, leaf: current.loaded && !children.length });
    if (current.expanded) for (const child of children) visit(child, depth + 1);
  }
  if (root.value) visit(root.value, 0);
  return result;
});
const tabStop = computed(() =>
  rows.value.some(({ node }) => node.path === active.value) ? active.value : root.value?.path,
);
function applyListing(current: DirectoryNode, listing: DirectoryListing): void {
  const existing = new Map(current.children.map((child) => [child.path, child]));
  const children = listing.entries
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => existing.get(entry.path) ?? node(entry.name, entry.path, current.path));
  // A branch read may predate navigation or omit a traversable directory.
  const onPath =
    props.listing && current.children.find((child) => selectedBranch.value.has(child.path));
  if (onPath && !children.includes(onPath)) children.push(onPath);
  current.children = children.sort((a, b) => a.name.localeCompare(b.name));
  current.loaded = true;
  current.error = null;
  current.loading = false;
}
async function load(current: DirectoryNode): Promise<void> {
  if (current.loading || props.disabled) return;
  const request = generation;
  current.loading = true;
  current.error = null;
  try {
    const result =
      props.source.side === 'local'
        ? await filesApi.local(current.path)
        : await filesApi.list(props.source.sessionId, current.path);
    if (request !== generation || !current.loading) return;
    // A Windows share root may be returned with or without its final backslash.
    const sameRoot =
      props.source.side === 'local' &&
      result.parent === null &&
      current.parent === null &&
      result.path.replace(/\\$/, '') === current.path.replace(/\\$/, '');
    if (result.path !== current.path && !sameRoot)
      throw new Error(tr('目录路径已变化，请刷新后重试。'));
    applyListing(current, result);
  } catch (cause) {
    if (request === generation && current.loading) current.error = errorMessage(cause);
  } finally {
    if (request === generation) current.loading = false;
  }
}
async function syncBrowser(listing: DirectoryListing, reveal: boolean): Promise<void> {
  let current = root.value!;
  const ancestors: DirectoryNode[] = [];
  for (const location of locations.value.slice(1)) {
    ancestors.push(current);
    if (reveal) current.expanded = true;
    let child = current.children.find((item) => item.path === location.path);
    if (!child) {
      // A confirmed path can be traversable even if its parent cannot be listed.
      current.children.push(node(location.name, location.path, current.path));
      child = current.children.at(-1)!;
    }
    current = child;
  }
  applyListing(current, listing);
  if (!reveal) return;
  current.expanded = true;
  active.value = listing.path;
  const request = generation;
  for (const parent of ancestors.reverse()) {
    if (request !== generation || props.listing?.path !== listing.path) return;
    if (parent.expanded && !parent.loaded && !parent.error) await load(parent);
  }
  await nextTick();
  if (request !== generation || active.value !== listing.path || !tree.value) return;
  const selected = tree.value
    .querySelector('[aria-selected="true"] .directory-entry')
    ?.getBoundingClientRect();
  if (!selected) return;
  const viewport = tree.value.getBoundingClientRect();
  if (selected.top < viewport.top) tree.value.scrollTop += selected.top - viewport.top;
  else if (selected.bottom > viewport.bottom)
    tree.value.scrollTop += selected.bottom - viewport.bottom;
  if (selected.left < viewport.left) tree.value.scrollLeft += selected.left - viewport.left;
  else if (selected.right > viewport.right)
    tree.value.scrollLeft += Math.min(
      selected.left - viewport.left,
      selected.right - viewport.right,
    );
}
function reset(): void {
  generation++;
  const location = rootLocation.value;
  if (!location) {
    root.value = undefined;
    return;
  }
  root.value = node(location.path === '/' ? '/' : location.name, location.path, null);
  root.value.expanded = true;
  active.value = location.path;
  if (props.listing) void syncBrowser(props.listing, true);
  else void load(root.value);
}
function toggle(current: DirectoryNode): void {
  if (props.disabled) return;
  active.value = current.path;
  current.expanded = !current.expanded;
  if (current.expanded && !current.loaded) void load(current);
}
function choose(current: DirectoryNode): void {
  if (props.disabled) return;
  active.value = current.path;
  emit('select', current.path);
}
async function focus(path: string): Promise<void> {
  active.value = path;
  await nextTick();
  [...(tree.value?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
    .find((element) => element.dataset.path === path)
    ?.focus();
}
function keydown(event: KeyboardEvent, current: DirectoryNode): void {
  if (props.disabled) return;
  const index = rows.value.findIndex((row) => row.node === current);
  let path: string | undefined;
  switch (event.key) {
    case 'ArrowDown':
      path = rows.value[Math.min(index + 1, rows.value.length - 1)]?.node.path;
      break;
    case 'ArrowUp':
      path = rows.value[Math.max(0, index - 1)]?.node.path;
      break;
    case 'Home':
      path = rows.value[0]?.node.path;
      break;
    case 'End':
      path = rows.value.at(-1)?.node.path;
      break;
    case 'ArrowRight':
      if (!current.expanded && !rows.value[index]?.leaf) toggle(current);
      else if (rows.value[index + 1]?.node.parent === current.path)
        path = rows.value[index + 1]?.node.path;
      break;
    case 'ArrowLeft':
      if (current.expanded) toggle(current);
      else path = current.parent ?? undefined;
      break;
    case 'Enter':
    case ' ':
      choose(current);
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (path) void focus(path);
}
watch(
  [
    () => (props.source.side === 'remote' ? props.source.sessionId : null),
    () => rootLocation.value?.path,
    () => props.listing,
  ],
  ([session, path, listing], [oldSession, oldPath, previous]) => {
    if (!root.value || session !== oldSession || path !== oldPath) reset();
    else if (listing) void syncBrowser(listing, listing.path !== previous?.path);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
});
</script>

<template>
  <div class="file-directory-tree" :class="{ 'directory-browser': listing }">
    <div class="directory-heading">
      <span class="subtle">{{ label }}</span>
      <button
        v-if="!listing"
        class="icon-button"
        type="button"
        :disabled="disabled || root?.loading"
        :title="tr('刷新目录')"
        :aria-label="tr('刷新目录')"
        @click="reset"
      >
        <RefreshCw :size="16" aria-hidden="true" />
      </button>
    </div>
    <ul ref="tree" class="directory-tree" role="tree" :aria-label="label">
      <li
        v-for="row in rows"
        :key="row.node.path"
        class="directory-node"
        role="treeitem"
        :data-path="row.node.path"
        :aria-level="row.depth + 1"
        :aria-expanded="row.leaf ? undefined : row.node.expanded"
        :aria-selected="selected === row.node.path"
        :aria-busy="row.node.loading"
        :tabindex="tabStop === row.node.path ? 0 : -1"
        @focus="active = row.node.path"
        @keydown="keydown($event, row.node)"
      >
        <div class="directory-row" :style="{ paddingInlineStart: `${row.depth * 20 + 4}px` }">
          <button
            class="directory-toggle"
            type="button"
            tabindex="-1"
            :disabled="disabled || row.leaf"
            :aria-label="
              row.node.expanded ? tr('收起 {0}', row.node.name) : tr('展开 {0}', row.node.name)
            "
            @click="toggle(row.node)"
          >
            <component
              :is="row.node.expanded ? ChevronDown : ChevronRight"
              v-if="!row.leaf"
              :size="16"
              aria-hidden="true"
            />
          </button>
          <button
            class="directory-entry"
            type="button"
            tabindex="-1"
            :disabled="disabled"
            :title="source.side === 'local' ? displayLocalPath(row.node.path) : row.node.path"
            @click="choose(row.node)"
          >
            <component
              :is="row.node.expanded ? FolderOpen : Folder"
              class="file-entry-icon"
              data-kind="directory"
              :size="18"
              aria-hidden="true"
            />
            <span>{{ row.node.name }}</span>
          </button>
        </div>
        <div
          v-if="row.node.expanded"
          class="directory-status"
          :style="{ paddingInlineStart: `${row.depth * 20 + 32}px` }"
        >
          <p v-if="row.node.loading" role="status">{{ tr('正在读取目录…') }}</p>
          <div v-else-if="row.node.error" class="error-text" role="alert">
            <p>{{ row.node.error }}</p>
            <button
              class="button"
              type="button"
              :disabled="disabled"
              @keydown.stop
              @click="load(row.node)"
            >
              {{ tr('重试') }}
            </button>
          </div>
          <p v-else-if="row.leaf && !listing" class="subtle">{{ tr('没有子文件夹') }}</p>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.file-directory-tree {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--control-radius);
}
.directory-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.directory-tree {
  list-style: none;
  margin: 0;
  padding: 4px;
  min-height: 100px;
  max-height: min(280px, 35vh);
  overflow: auto;
}
.directory-browser {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 0;
  border-block-end: 1px solid var(--border);
  border-radius: 0;
}
.directory-browser .directory-heading {
  padding: 8px 4px;
  border: 0;
}
.directory-browser .directory-tree {
  flex: 1;
  contain: size;
  min-height: 0;
  max-height: none;
  overscroll-behavior: contain;
}
.directory-browser .directory-row {
  min-width: max-content;
}
.directory-browser .directory-entry {
  white-space: nowrap;
}
.directory-row {
  display: flex;
  align-items: center;
  border-radius: var(--control-radius);
}
.directory-node[aria-selected='true'] > .directory-row {
  background: var(--accent-bg);
}
.directory-node:focus-visible {
  outline: none;
}
.directory-node:focus-visible > .directory-row {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.directory-row:hover {
  background: var(--panel-soft);
}
.directory-toggle,
.directory-entry {
  display: flex;
  align-items: center;
  background: transparent;
  color: var(--text);
  border: 0;
  border-radius: var(--control-radius);
}
.directory-toggle {
  justify-content: center;
  flex: 0 0 26px;
  height: 30px;
  padding: 0;
}
.directory-entry {
  flex: 1;
  min-width: 0;
  gap: 8px;
  padding: 6px 4px;
  text-align: left;
}
.directory-entry span {
  overflow-wrap: anywhere;
  min-width: 0;
}
.directory-entry svg {
  flex-shrink: 0;
}
.directory-status p {
  margin: 4px 0;
  overflow-wrap: anywhere;
}
.error-text {
  padding-bottom: 6px;
}
</style>
