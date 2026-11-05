<script setup lang="ts">
import { computed, ref, watch } from 'vue';
const props = defineProps<{
  rows: Record<string, unknown>[];
  columns: { key: string; label: string }[];
  rowKey: string;
  filter: string;
  sort?: string;
  loading?: boolean;
}>();
const page = ref(1),
  order = ref(props.sort ?? ''),
  descending = ref(true);
const filtered = computed(() =>
  props.rows
    .filter((row) =>
      Object.values(row).some((v) =>
        String(v ?? '')
          .toLowerCase()
          .includes(props.filter.toLowerCase()),
      ),
    )
    .sort((a, b) => {
      const left = a[order.value],
        right = b[order.value];
      const n =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true });
      return descending.value ? -n : n;
    }),
);
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 100))),
  visible = computed(() => filtered.value.slice((page.value - 1) * 100, page.value * 100));
watch([() => props.filter, () => props.rows], () => (page.value = 1));
watch(pages, (n) => (page.value = Math.min(page.value, n)));
function changeSort(key: string): void {
  if (order.value === key) descending.value = !descending.value;
  else {
    order.value = key;
    descending.value = true;
  }
}
</script>
<template>
  <div class="ops-table" :aria-busy="loading">
    <p v-if="loading" class="host-empty" role="status">正在读取列表…</p>
    <table v-else>
      <thead>
        <tr>
          <th v-for="column in columns" :key="column.key">
            <button class="text-button" @click="changeSort(column.key)">
              {{ column.label }} {{ order === column.key ? (descending ? '↓' : '↑') : '' }}
            </button>
          </th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, index) in visible"
          :key="String(row[rowKey]) + index"
          :data-ops-target="String(row[rowKey])"
        >
          <td v-for="column in columns" :key="column.key" :title="String(row[column.key] ?? '')">
            <slot name="cell" :row="row" :column="column">{{ row[column.key] ?? '不可用' }}</slot>
          </td>
          <td>
            <div class="ops-row-actions"><slot name="actions" :row="row" /></div>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!loading && !filtered.length" class="host-empty">没有匹配项目。</p>
    <div v-if="!loading && pages > 1" class="ops-toolbar">
      <button class="button" :disabled="page === 1" @click="page--">上一页</button
      ><span>{{ page }} / {{ pages }} · {{ filtered.length }} 项</span
      ><button class="button" :disabled="page === pages" @click="page++">下一页</button>
    </div>
  </div>
</template>
