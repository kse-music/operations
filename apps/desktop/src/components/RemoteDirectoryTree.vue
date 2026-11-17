<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw } from '@lucide/vue';
import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
import { tr } from '../i18n/messages';

interface DirectoryNode {
  name: string;
  path: string;
  parent: string | null;
  expanded: boolean;
  loading: boolean;
  error: string | null;
  children: DirectoryNode[] | null;
}
const props = defineProps<{ sessionId: string; selected: string; disabled?: boolean }>();
const emit = defineEmits<{ select: [path: string] }>();
const tree = ref<HTMLElement>(),
  root = ref<DirectoryNode>(),
  active = ref('/');
let generation = 0;
const node = (name: string, path: string, parent: string | null): DirectoryNode => ({
  name,
  path,
  parent,
  expanded: false,
  loading: false,
  error: null,
  children: null,
});
const rows = computed(() => {
  const result: { node: DirectoryNode; depth: number }[] = [];
  function visit(current: DirectoryNode, depth: number): void {
    result.push({ node: current, depth });
    if (current.expanded) for (const child of current.children ?? []) visit(child, depth + 1);
  }
  if (root.value) visit(root.value, 0);
  return result;
});
async function load(current: DirectoryNode): Promise<void> {
  if (current.loading || props.disabled) return;
  const request = generation,
    session = props.sessionId;
  current.loading = true;
  current.error = null;
  try {
    const result = await filesApi.list(session, current.path);
    if (request !== generation || session !== props.sessionId) return;
    if (result.path !== current.path) throw new Error(tr('目录路径已变化，请刷新后重试。'));
    current.children = result.entries
      .filter((entry) => entry.kind === 'directory')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => node(entry.name, entry.path, current.path));
  } catch (cause) {
    if (request === generation && session === props.sessionId) current.error = errorMessage(cause);
  } finally {
    if (request === generation && session === props.sessionId) current.loading = false;
  }
}
function reset(): void {
  generation++;
  root.value = node('/', '/', null);
  root.value.expanded = true;
  active.value = '/';
  void load(root.value);
}
function toggle(current: DirectoryNode): void {
  if (props.disabled) return;
  active.value = current.path;
  current.expanded = !current.expanded;
  if (current.expanded && current.children === null) void load(current);
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
      if (!current.expanded) toggle(current);
      else path = current.children?.[0]?.path;
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
watch(() => props.sessionId, reset, { immediate: true });
onBeforeUnmount(() => {
  generation++;
});
</script>

<template>
  <div class="remote-directory-tree">
    <div class="directory-heading">
      <span class="subtle">{{ tr('远程文件夹') }}</span>
      <button
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
    <ul ref="tree" class="directory-tree" role="tree" :aria-label="tr('远程文件夹')">
      <li
        v-for="row in rows"
        :key="row.node.path"
        class="directory-node"
        role="treeitem"
        :data-path="row.node.path"
        :aria-level="row.depth + 1"
        :aria-expanded="row.node.children?.length === 0 ? undefined : row.node.expanded"
        :aria-selected="selected === row.node.path"
        :aria-busy="row.node.loading"
        :tabindex="active === row.node.path ? 0 : -1"
        @focus="active = row.node.path"
        @keydown="keydown($event, row.node)"
      >
        <div class="directory-row" :style="{ paddingInlineStart: `${row.depth * 20 + 4}px` }">
          <button
            class="directory-toggle"
            type="button"
            tabindex="-1"
            :disabled="disabled || row.node.children?.length === 0"
            :aria-label="
              row.node.expanded ? tr('收起 {0}', row.node.name) : tr('展开 {0}', row.node.name)
            "
            @click="toggle(row.node)"
          >
            <component
              :is="row.node.expanded ? ChevronDown : ChevronRight"
              v-if="row.node.children?.length !== 0"
              :size="16"
              aria-hidden="true"
            />
          </button>
          <button
            class="directory-entry"
            type="button"
            tabindex="-1"
            :disabled="disabled"
            :title="row.node.path"
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
          <p v-else-if="row.node.children?.length === 0" class="subtle">{{ tr('没有子文件夹') }}</p>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.remote-directory-tree {
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
