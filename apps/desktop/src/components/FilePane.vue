<script setup lang="ts">
import {
  ArrowDown,
  ArrowUp,
  File,
  FileArchive,
  FileImage,
  FileQuestionMark,
  FileSymlink,
  FileTerminal,
  Folder,
} from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import type { DirectoryListing, FileEntry } from '../types/files';
import { bytes, permissionText } from '../types/files';
const props = defineProps<{
  side: 'local' | 'remote';
  listing: DirectoryListing | null;
  loading: boolean;
  selected: string[];
  hideDotfiles?: boolean;
}>();
const emit = defineEmits<{
  select: [paths: string[]];
  open: [entry: FileEntry];
  menu: [entry: FileEntry, event: MouseEvent];
  drag: [entry: FileEntry, event: PointerEvent];
}>();
const localColumns = [
  ['name', '名称'],
  ['size', '大小'],
  ['kind', '类型'],
  ['modified', '修改时间'],
] as const;
const remoteColumns = [...localColumns, ['permissions', '权限'], ['owner', '拥有者']] as const;
type SortKey = (typeof remoteColumns)[number][0];
const columns = computed(() => (props.side === 'local' ? localColumns : remoteColumns));
const sort = ref<SortKey>('name'),
  descending = ref(false);

function sortBy(key: SortKey): void {
  descending.value = sort.value === key && !descending.value;
  sort.value = key;
}

function sortText(entry: FileEntry, key: 'name' | 'kind' | 'owner'): string {
  return key === 'owner' ? String(entry.owner ?? entry.uid ?? '') : entry[key];
}

const entries = computed(() => {
  const rows = props.listing?.entries ?? [];
  const displayed = props.hideDotfiles
    ? rows.filter((entry) => !entry.name.startsWith('.'))
    : [...rows];
  return displayed.sort((a, b) => {
    const dir = (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1);
    if (dir) return dir;
    const key = sort.value;
    const value =
      key === 'size' || key === 'permissions'
        ? (a[key] ?? -1) - (b[key] ?? -1)
        : key === 'modified'
          ? (a.modified ?? 0) - (b.modified ?? 0)
          : sortText(a, key).localeCompare(sortText(b, key), 'zh-CN', { numeric: true });
    return descending.value ? -value : value;
  });
});
const page = ref(1);
const pages = computed(() => Math.max(1, Math.ceil(entries.value.length / 200)));
const visibleEntries = computed(() =>
  entries.value.slice((page.value - 1) * 200, page.value * 200),
);
watch([() => props.listing?.path, sort, descending], () => {
  page.value = 1;
});
watch(
  () => props.hideDotfiles,
  (hidden) => {
    page.value = 1;
    if (!hidden || !props.selected.length) return;
    const displayed = new Set(entries.value.map((entry) => entry.path));
    emit(
      'select',
      props.selected.filter((path) => displayed.has(path)),
    );
  },
);
watch(pages, (value) => {
  page.value = Math.min(page.value, value);
});
function toggle(path: string): void {
  emit(
    'select',
    props.selected.includes(path)
      ? props.selected.filter((p) => p !== path)
      : [...props.selected, path],
  );
}
function clicked(entry: FileEntry, event: MouseEvent): void {
  if (event.ctrlKey || event.metaKey) toggle(entry.path);
  else emit('select', [entry.path]);
}
function context(entry: FileEntry, event: MouseEvent): void {
  if (!props.selected.includes(entry.path)) emit('select', [entry.path]);
  emit('menu', entry, event);
}
function beginDrag(entry: FileEntry, event: PointerEvent): void {
  if (props.side === 'remote' && !(event.target instanceof HTMLInputElement))
    emit('drag', entry, event);
}
const kinds = {
  file: { label: '文件', icon: File },
  directory: { label: '目录', icon: Folder },
  symlink: { label: '链接', icon: FileSymlink },
  other: { label: '特殊', icon: FileQuestionMark },
};
const fileIcons = [
  {
    icon: FileTerminal,
    extensions: new Set([
      'sh',
      'bash',
      'zsh',
      'fish',
      'ksh',
      'ps1',
      'psm1',
      'bat',
      'cmd',
      'py',
      'rb',
      'pl',
      'lua',
      'js',
      'mjs',
      'cjs',
      'vbs',
    ]),
  },
  {
    icon: FileArchive,
    extensions: new Set([
      'zip',
      'rar',
      '7z',
      'tar',
      'gz',
      'bz2',
      'xz',
      'zst',
      'tgz',
      'tbz',
      'tbz2',
      'txz',
      'tzst',
    ]),
  },
  {
    icon: FileImage,
    extensions: new Set([
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'svg',
      'bmp',
      'ico',
      'tif',
      'tiff',
      'heic',
      'heif',
      'avif',
      'apng',
    ]),
  },
];
function entryIcon(entry: FileEntry) {
  const defaultIcon = kinds[entry.kind].icon;
  const dot = entry.name.lastIndexOf('.');
  if (entry.kind !== 'file' || dot <= 0) return defaultIcon;
  const extension = entry.name.slice(dot + 1).toLowerCase();
  return fileIcons.find(({ extensions }) => extensions.has(extension))?.icon ?? defaultIcon;
}
</script>
<template>
  <div class="file-list-tools">
    <span>{{ entries.length }} 项 · {{ selected.length }} 已选</span>
  </div>
  <div class="file-table" :aria-busy="loading">
    <p v-if="loading" role="status">正在读取目录…</p>
    <p v-else-if="!listing" class="host-empty">尚未读取目录。</p>
    <table v-if="listing" :aria-label="side === 'local' ? '本地文件' : '远程文件'">
      <thead>
        <tr>
          <th>
            <input
              type="checkbox"
              :aria-label="`全选当前页${side === 'local' ? '本地' : '远程'}文件`"
              :checked="
                visibleEntries.length > 0 && visibleEntries.every((e) => selected.includes(e.path))
              "
              @change="
                emit(
                  'select',
                  ($event.target as HTMLInputElement).checked
                    ? [...new Set([...selected, ...visibleEntries.map((e) => e.path)])]
                    : selected.filter((path) => !visibleEntries.some((e) => e.path === path)),
                )
              "
            />
          </th>
          <th
            v-for="[key, label] in columns"
            :key="key"
            class="file-sort-column"
            scope="col"
            :aria-sort="sort === key ? (descending ? 'descending' : 'ascending') : undefined"
          >
            <button type="button" class="file-sort-button" @click="sortBy(key)">
              {{ label }}
              <component
                :is="descending ? ArrowDown : ArrowUp"
                v-if="sort === key"
                :size="12"
                aria-hidden="true"
              />
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="entry in visibleEntries"
          :key="entry.path"
          :class="{ selected: selected.includes(entry.path) }"
          @pointerdown="beginDrag(entry, $event)"
          @click="clicked(entry, $event)"
          @contextmenu.prevent="context(entry, $event)"
          @dblclick="emit('open', entry)"
        >
          <td>
            <input
              type="checkbox"
              :aria-label="`选择 ${entry.name}`"
              :checked="selected.includes(entry.path)"
              @click.stop="toggle(entry.path)"
            />
          </td>
          <td>
            <button
              type="button"
              class="file-name"
              :title="entry.name"
              @click.stop="clicked(entry, $event)"
              @dblclick.stop="emit('open', entry)"
            >
              <component
                :is="entryIcon(entry)"
                class="file-entry-icon"
                :data-kind="entry.kind"
                aria-hidden="true"
              />
              <span class="file-name-text">{{ entry.name }}</span>
            </button>
          </td>
          <td>{{ entry.kind === 'directory' ? '—' : bytes(entry.size) }}</td>
          <td>{{ kinds[entry.kind].label }}</td>
          <td>
            {{ entry.modified === null ? '—' : new Date(entry.modified * 1000).toLocaleString() }}
          </td>
          <template v-if="side === 'remote'">
            <td class="file-metadata">
              {{ permissionText(entry.permissions) }}
            </td>
            <td class="file-metadata" :title="entry.uid === null ? undefined : `UID ${entry.uid}`">
              {{ entry.owner ?? entry.uid ?? '—' }}
            </td>
          </template>
        </tr>
      </tbody>
    </table>
    <p v-if="listing && !loading && !entries.length" class="host-empty">
      {{ listing.entries.length ? '当前目录只有隐藏项' : '空目录' }}
    </p>
  </div>
  <div v-if="pages > 1" class="file-pagination">
    <button class="button" :disabled="page === 1" @click="page--">上一页</button
    ><span>第 {{ page }} / {{ pages }} 页，每页 200 项</span
    ><button class="button" :disabled="page === pages" @click="page++">下一页</button>
  </div>
</template>
