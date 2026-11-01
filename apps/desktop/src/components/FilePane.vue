<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DirectoryListing, FileEntry } from '../types/files';
import { bytes } from '../types/files';
const props = defineProps<{
  side: 'local' | 'remote';
  listing: DirectoryListing | null;
  loading: boolean;
  selected: string[];
}>();
const emit = defineEmits<{
  select: [paths: string[]];
  open: [entry: FileEntry];
  menu: [entry: FileEntry, event: MouseEvent];
}>();
const sort = ref<'name' | 'size' | 'modified' | 'kind'>('name'),
  descending = ref(false);
const entries = computed(() =>
  [...(props.listing?.entries ?? [])].sort((a, b) => {
    const dir = (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1);
    if (dir) return dir;
    const value =
      sort.value === 'size'
        ? (a.size ?? -1) - (b.size ?? -1)
        : sort.value === 'modified'
          ? (a.modified ?? 0) - (b.modified ?? 0)
          : String(a[sort.value]).localeCompare(String(b[sort.value]), 'zh-CN', { numeric: true });
    return descending.value ? -value : value;
  }),
);
const page = ref(1);
const pages = computed(() => Math.max(1, Math.ceil(entries.value.length / 200)));
const visibleEntries = computed(() =>
  entries.value.slice((page.value - 1) * 200, page.value * 200),
);
watch([() => props.listing?.path, sort, descending], () => {
  page.value = 1;
});
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
const kinds = { file: '文件', directory: '目录', symlink: '链接', other: '特殊' };
</script>
<template>
  <div class="file-list-tools">
    <span>{{ listing?.entries.length ?? 0 }} 项 · {{ selected.length }} 已选</span
    ><label
      >排序<select v-model="sort" :aria-label="`${side === 'local' ? '本地' : '远程'}排序`">
        <option value="name">名称</option>
        <option value="size">大小</option>
        <option value="modified">修改时间</option>
        <option value="kind">类型</option>
      </select></label
    ><button class="text-button" @click="descending = !descending">
      {{ descending ? '↓ 降序' : '↑ 升序' }}
    </button>
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
          <th>名称</th>
          <th>大小</th>
          <th>修改时间</th>
          <th>类型</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="entry in visibleEntries"
          :key="entry.path"
          :class="{ selected: selected.includes(entry.path) }"
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
              class="file-name"
              :title="entry.name"
              @click.stop="clicked(entry, $event)"
              @dblclick.stop="emit('open', entry)"
            >
              {{ entry.kind === 'directory' ? '▸' : entry.kind === 'symlink' ? '↗' : '·' }}
              {{ entry.name }}
            </button>
          </td>
          <td>{{ entry.kind === 'directory' ? '—' : bytes(entry.size) }}</td>
          <td>
            {{ entry.modified === null ? '—' : new Date(entry.modified * 1000).toLocaleString() }}
          </td>
          <td>{{ kinds[entry.kind] }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="listing && !loading && !entries.length" class="host-empty">空目录</p>
  </div>
  <div v-if="pages > 1" class="file-pagination">
    <button class="button" :disabled="page === 1" @click="page--">上一页</button
    ><span>第 {{ page }} / {{ pages }} 页，每页 200 项</span
    ><button class="button" :disabled="page === pages" @click="page++">下一页</button>
  </div>
</template>
