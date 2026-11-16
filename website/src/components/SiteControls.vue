<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useColorMode } from '@vueuse/core';
import { Search, Sun, Moon, X, ArrowUpRight } from '@lucide/vue';
import type MiniSearch from 'minisearch';
import { loadSearchIndex, searchExcerpt } from '../search';
import type { SearchDocument } from '../search';
import { carryAppearance } from '../appearance';

const props = defineProps<{ documentationOrigin: string }>();
const emit = defineEmits<{ 'search-open': [] }>();
const appearance = useColorMode({ storageKey: 'vitepress-theme-appearance', initialValue: 'dark' });
const isDark = computed({
  get: () => appearance.value === 'dark',
  set: (dark: boolean) => {
    appearance.value = dark ? 'dark' : 'light';
  },
});
const ready = ref(false);
const dialog = ref<HTMLDialogElement>();
const input = ref<HTMLInputElement>();
const query = ref('');
const loading = ref(false);
const error = ref('');
const selected = ref(0);
const index = shallowRef<MiniSearch<SearchDocument>>();
const results = computed(() =>
  !index.value || !query.value.trim() ? [] : index.value.search(query.value).slice(0, 20),
);
watch(results, () => {
  selected.value = 0;
});

async function load(reload = false) {
  loading.value = true;
  error.value = '';
  try {
    index.value = await loadSearchIndex(reload);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文档搜索暂时不可用，请重试';
  } finally {
    loading.value = false;
  }
}
function openSearch() {
  if (dialog.value?.open) return;
  emit('search-open');
  dialog.value?.showModal();
  input.value?.focus();
  void load();
}
function closeSearch() {
  dialog.value?.close();
}
function move(direction: number) {
  if (!results.value.length) return;
  selected.value = (selected.value + direction + results.value.length) % results.value.length;
  void nextTick(() =>
    document.getElementById(`sd-result-${selected.value}`)?.scrollIntoView({ block: 'nearest' }),
  );
}
function openSelected() {
  document.getElementById(`sd-result-${selected.value}`)?.click();
}
function handleResult(event: MouseEvent) {
  carryAppearance(event);
  closeSearch();
}
function handleKey(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (!event.repeat) openSearch();
  }
}
onMounted(() => {
  ready.value = true;
  document.addEventListener('keydown', handleKey);
});
onUnmounted(() => document.removeEventListener('keydown', handleKey));
</script>

<template>
  <div class="sd-site-controls">
    <button
      class="sd-search-trigger"
      type="button"
      :disabled="!ready"
      aria-label="搜索文档"
      title="搜索文档（Ctrl K / ⌘ K）"
      @click="openSearch"
    >
      <Search :size="16" /><span class="sd-control-label">搜索文档</span><kbd>Ctrl K</kbd>
    </button>
    <button
      class="sd-appearance-trigger"
      type="button"
      :disabled="!ready"
      aria-label="切换深浅主题"
      title="切换深浅主题"
      @click="isDark = !isDark"
    >
      <Sun class="sd-theme-sun" :size="16" /><Moon class="sd-theme-moon" :size="16" /><span
        class="sd-control-label"
        >外观</span
      >
    </button>
    <dialog
      ref="dialog"
      class="sd-search-dialog"
      aria-labelledby="sd-search-title"
      @keydown.esc.prevent="closeSearch"
      @click="
        (event) => {
          if (event.target === dialog) closeSearch();
        }
      "
    >
      <div class="sd-search-panel">
        <div class="sd-search-bar">
          <Search :size="20" />
          <label id="sd-search-title" class="sd-visually-hidden" for="sd-search-input"
            >搜索用户文档和开发者中心</label
          >
          <input
            id="sd-search-input"
            ref="input"
            v-model="query"
            type="search"
            placeholder="搜索用户文档和开发者中心…"
            autocomplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="sd-search-results"
            :aria-expanded="results.length > 0"
            :aria-activedescendant="results.length ? `sd-result-${selected}` : undefined"
            @keydown.down.prevent="move(1)"
            @keydown.up.prevent="move(-1)"
            @keydown.enter.prevent="openSelected"
          />
          <button class="sd-search-close" type="button" aria-label="关闭搜索" @click="closeSearch">
            <X :size="19" />
          </button>
        </div>
        <p v-if="loading" class="sd-search-message" role="status">正在加载文档索引…</p>
        <div v-else-if="error" class="sd-search-message" role="alert">
          <p>{{ error }}</p>
          <button type="button" @click="load(true)">重新加载</button>
        </div>
        <p v-else-if="!query.trim()" class="sd-search-message">
          搜索安装、SSH、文件传输、插件 SDK 等主题。
        </p>
        <p v-else-if="!results.length" class="sd-search-message" role="status">
          没有找到相关内容，试试其他关键词。
        </p>
        <ul
          v-show="!loading && !error && results.length"
          id="sd-search-results"
          class="sd-search-results"
          role="listbox"
          aria-label="文档搜索结果"
        >
          <li v-for="(result, position) in results" :key="result.id" role="none">
            <a
              :id="`sd-result-${position}`"
              :href="props.documentationOrigin + result.url"
              role="option"
              :aria-selected="position === selected"
              :class="{ selected: position === selected }"
              @mouseenter="selected = position"
              @click="handleResult"
            >
              <span v-if="result.pageTitle !== result.title" class="sd-result-page">{{
                result.pageTitle
              }}</span>
              <strong>{{ result.title }} <ArrowUpRight :size="14" /></strong>
              <span class="sd-result-excerpt">{{ searchExcerpt(result.text, query) }}</span>
            </a>
          </li>
        </ul>
        <div class="sd-search-footer">
          <span>↑ ↓ 切换 &nbsp; Enter 打开 &nbsp; Esc 关闭</span><span>站内全文搜索</span>
        </div>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.sd-site-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}
.sd-site-controls > button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 36px;
  padding: 8px;
  border: 0;
  background: transparent;
  color: var(--sd-muted);
  font:
    12px/1.5 Inter,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
  cursor: pointer;
  white-space: nowrap;
}
.sd-site-controls > .sd-search-trigger {
  padding-inline: 12px;
  background: var(--sd-soft);
  border: 1px solid var(--sd-border);
  border-radius: 6px;
}
.sd-site-controls > button:hover {
  color: var(--sd-accent);
}
.sd-site-controls :deep(svg) {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
}
kbd {
  border: 1px solid var(--sd-border);
  border-radius: 4px;
  padding: 0 5px;
  font:
    11px/20px Consolas,
    monospace;
}
.sd-theme-sun {
  display: none;
}
.sd-search-dialog {
  padding: 0;
  border: 1px solid var(--sd-border);
  border-radius: 12px;
  width: min(760px, calc(100% - 40px));
  max-width: none;
  max-height: 80dvh;
  margin: 10dvh auto 0;
  background: var(--sd-bg);
  color: var(--sd-text);
  font:
    14px/1.6 'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
  box-shadow: 0 24px 90px #0005;
}
.sd-search-dialog::backdrop {
  background: #07130eb3;
  backdrop-filter: blur(5px);
}
.sd-search-panel {
  display: flex;
  flex-direction: column;
  max-height: 78dvh;
}
.sd-search-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--sd-border);
  color: var(--sd-muted);
}
.sd-search-bar input {
  flex: 1;
  min-width: 0;
  width: 100%;
  border: 0;
  outline: none;
  padding: 5px 0;
  background: transparent;
  color: var(--sd-text);
  font: inherit;
}
.sd-search-bar input::placeholder {
  color: var(--sd-muted);
}
.sd-search-close {
  display: flex;
  padding: 8px;
  border: 0;
  color: var(--sd-muted);
  background: transparent;
  cursor: pointer;
}
.sd-search-message {
  padding: 35px 24px;
  color: var(--sd-muted);
  margin: 0;
}
.sd-search-message p {
  margin: 0 0 14px;
}
.sd-search-message button {
  padding: 8px 14px;
  border: 1px solid var(--sd-border);
  border-radius: 5px;
  color: var(--sd-accent);
  background: var(--sd-soft);
  cursor: pointer;
}
.sd-search-results {
  overflow-y: auto;
  margin: 0;
  padding: 10px;
  list-style: none;
}
.sd-search-results li {
  margin: 0;
  padding: 0;
}
.sd-search-results a {
  display: block;
  padding: 15px;
  border: 1px solid transparent;
  border-radius: 6px;
  text-decoration: none;
  color: var(--sd-text);
}
.sd-search-results a.selected,
.sd-search-results a:hover {
  background: var(--sd-soft);
  border-color: var(--sd-border);
}
.sd-search-results strong {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  color: var(--sd-accent);
}
.sd-result-page {
  display: block;
  margin-bottom: 5px;
  font-size: 11px;
  color: var(--sd-muted);
}
.sd-result-excerpt {
  display: block;
  margin-top: 7px;
  font-size: 12px;
  color: var(--sd-muted);
  line-height: 1.8;
}
.sd-search-footer {
  display: flex;
  justify-content: space-between;
  gap: 15px;
  padding: 12px 20px;
  border-top: 1px solid var(--sd-border);
  font-size: 10px;
  color: var(--sd-muted);
}
.sd-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--sd-accent);
  outline-offset: 3px;
}
@media (max-width: 640px) {
  .sd-site-controls {
    gap: 4px;
  }
  .sd-site-controls .sd-control-label,
  kbd {
    display: none;
  }
  .sd-site-controls > button {
    width: 34px;
    min-height: 36px;
    padding: 8px;
  }
  .sd-site-controls > .sd-search-trigger {
    padding-inline: 8px;
  }
  .sd-search-dialog {
    width: calc(100% - 24px);
    margin-top: 16px;
    max-height: calc(100dvh - 32px);
  }
  .sd-search-panel {
    max-height: calc(100dvh - 34px);
  }
  .sd-search-bar {
    padding: 12px;
    gap: 8px;
  }
  .sd-search-bar input {
    font-size: 16px;
  }
  .sd-search-footer span:first-child {
    display: none;
  }
}
</style>
