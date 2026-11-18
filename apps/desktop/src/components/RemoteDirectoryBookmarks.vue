<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { Bookmark, ChevronDown, Plus, Trash2 } from '@lucide/vue';
import { tr } from '../i18n/messages';
import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
import type { DirectoryBookmark } from '../types/files';

const props = defineProps<{ hostId: string; path: string; disabled: boolean }>();
const emit = defineEmits<{ select: [path: string] }>();
const popupId = useId();
const trigger = ref<HTMLButtonElement>();
const popup = ref<HTMLElement>();
const heading = ref<HTMLElement>();
const nameInput = ref<HTMLInputElement>();
const open = ref(false);
const loading = ref(false);
const loaded = ref(false);
const saving = ref(false);
const error = ref('');
const draft = ref<string | null>(null);
const items = ref<DirectoryBookmark[]>([]);
const alreadySaved = computed(() => items.value.some(({ path }) => path === props.path));
const canSave = computed(() => {
  const name = draft.value?.trim();
  return !!name && Array.from(name).length <= 80 && !/\p{Cc}/u.test(name);
});

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  loaded.value = false;
  error.value = '';
  try {
    items.value = await filesApi.bookmarks(props.hostId);
    loaded.value = true;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}
function place(): void {
  if (!trigger.value || !popup.value) return;
  const anchor = trigger.value.getBoundingClientRect();
  const below = Math.max(0, window.innerHeight - anchor.bottom - 12);
  const above = Math.max(0, anchor.top - 12);
  const useBelow = below >= 300 || below >= above;
  popup.value.style.right = `${Math.max(8, window.innerWidth - anchor.right)}px`;
  popup.value.style.top = useBelow ? `${anchor.bottom + 4}px` : 'auto';
  popup.value.style.bottom = useBelow ? 'auto' : `${window.innerHeight - anchor.top + 4}px`;
  popup.value.style.maxHeight = `${Math.min(440, useBelow ? below : above)}px`;
}
function resetPopup() {
  open.value = false;
  draft.value = null;
}
function close() {
  if (open.value) popup.value?.hidePopover();
  resetPopup();
}
function toggle() {
  if (open.value) {
    close();
    return;
  }
  if (props.disabled || saving.value || !popup.value) return;
  place();
  popup.value.showPopover();
  open.value = true;
  heading.value?.focus({ preventScroll: true });
  void load();
}
function dismiss(event: KeyboardEvent) {
  if (event.isComposing || !open.value) return;
  event.preventDefault();
  event.stopPropagation();
  close();
  trigger.value?.focus({ preventScroll: true });
}
function choose(path: string) {
  if (props.disabled || saving.value) return;
  close();
  trigger.value?.focus({ preventScroll: true });
  emit('select', path);
}
async function startDraft() {
  if (props.disabled || saving.value || alreadySaved.value) return;
  error.value = '';
  const basename = props.path.slice(props.path.lastIndexOf('/') + 1) || '/';
  draft.value = Array.from(basename).slice(0, 80).join('');
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.select();
}
async function change(request: () => Promise<DirectoryBookmark[]>): Promise<void> {
  if (props.disabled || !loaded.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    items.value = await request();
    draft.value = null;
    if (open.value) heading.value?.focus({ preventScroll: true });
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
function save() {
  if (!canSave.value || alreadySaved.value || draft.value === null) return;
  const bookmark = { name: draft.value.trim(), path: props.path };
  void change(() => filesApi.addBookmark(props.hostId, bookmark));
}
watch(() => [props.disabled, props.path], close);
watch(open, (visible, _previous, cleanup) => {
  if (!visible) return;
  const scroll = (event: Event) => {
    if (event.target instanceof Node && popup.value?.contains(event.target)) return;
    close();
  };
  window.addEventListener('resize', close);
  window.addEventListener('scroll', scroll, true);
  cleanup(() => {
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', scroll, true);
  });
});
onBeforeUnmount(close);
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="tool-button bookmark-trigger"
    :aria-label="tr('目录书签')"
    :title="tr('目录书签')"
    :aria-controls="popupId"
    :aria-expanded="open"
    :disabled="disabled || (saving && !open)"
    aria-haspopup="dialog"
    @click="toggle"
    @keydown.esc="dismiss"
  >
    <Bookmark :size="16" aria-hidden="true" />
    <ChevronDown :size="13" aria-hidden="true" />
  </button>
  <Teleport to="body">
    <section
      :id="popupId"
      ref="popup"
      class="directory-bookmarks"
      popover="auto"
      role="dialog"
      :aria-label="tr('目录书签')"
      :aria-busy="loading || saving"
      @beforetoggle="$event.newState === 'closed' && resetPopup()"
      @keydown.esc="dismiss"
    >
      <h3 ref="heading" tabindex="-1">{{ tr('目录书签') }}</h3>
      <p v-if="loading" class="subtle" role="status">{{ tr('正在加载目录书签…') }}</p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <button v-if="!loading && !loaded" class="button" type="button" @click="load">
        {{ tr('重试') }}
      </button>
      <template v-if="loaded">
        <ul v-if="items.length" class="bookmark-list">
          <li v-for="item in items" :key="item.path">
            <button
              type="button"
              class="bookmark-link"
              :aria-current="item.path === path ? 'location' : undefined"
              :disabled="saving"
              @click="choose(item.path)"
            >
              <Bookmark :size="16" aria-hidden="true" />
              <span>
                <strong>{{ item.name }}</strong>
                <code :title="item.path">{{ item.path }}</code>
              </span>
            </button>
            <button
              type="button"
              class="tool-button"
              :aria-label="tr('移除书签：{0}', item.name)"
              :title="tr('移除书签：{0}', item.name)"
              :disabled="saving"
              @click="change(() => filesApi.removeBookmark(hostId, item.path))"
            >
              <Trash2 class="bookmark-remove-icon" :size="15" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p v-else class="subtle">{{ tr('暂无目录书签') }}</p>
        <div v-if="!alreadySaved" class="bookmark-actions">
          <form v-if="draft !== null" class="bookmark-form" @submit.prevent="save">
            <label :for="`${popupId}-name`">{{ tr('书签名称') }}</label>
            <input
              :id="`${popupId}-name`"
              ref="nameInput"
              v-model="draft"
              :disabled="saving"
              autocomplete="off"
              required
            />
            <button type="submit" class="button primary" :disabled="saving || !canSave">
              {{ tr('保存') }}
            </button>
            <button type="button" class="button" :disabled="saving" @click="draft = null">
              {{ tr('取消') }}
            </button>
            <p v-if="draft.trim() && !canSave" class="error-text" role="alert">
              {{ tr('书签名称须为 1–80 个字符，不能含控制字符') }}
            </p>
          </form>
          <button v-else type="button" class="bookmark-link" :disabled="saving" @click="startDraft">
            <Plus :size="16" aria-hidden="true" />
            {{ tr('收藏当前目录') }}
          </button>
        </div>
      </template>
    </section>
  </Teleport>
</template>

<style scoped>
.bookmark-trigger {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
}
.bookmark-trigger[aria-expanded='true'],
.bookmark-link[aria-current='location'] {
  color: var(--accent);
  background: var(--accent-bg);
}
.directory-bookmarks {
  position: fixed;
  inset: auto;
  margin: 0;
  width: min(22rem, calc(100vw - 24px));
  padding: 10px;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--border-strong);
  border-radius: var(--control-radius);
  color: var(--text);
  background: var(--panel);
  font-size: var(--font-size-body);
  box-shadow: 0 6px 24px #0004;
}
.directory-bookmarks h3 {
  font-size: inherit;
  margin: 2px 4px 6px;
}
.directory-bookmarks p {
  margin: 6px 4px;
}
.bookmark-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.bookmark-list li {
  display: flex;
  align-items: center;
  gap: 5px;
}
.bookmark-remove-icon {
  color: var(--error);
}
.bookmark-link {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  width: 100%;
  padding: 6px 5px;
  border: 0;
  border-radius: var(--control-radius);
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.bookmark-link:hover:not(:disabled) {
  background: var(--accent-bg);
}
.bookmark-link > svg {
  flex: none;
}
.bookmark-link span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.bookmark-link code {
  display: block;
  color: var(--muted);
}
.bookmark-actions {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.bookmark-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 5px;
}
.bookmark-form label,
.bookmark-form p {
  grid-column: 1 / -1;
}
.bookmark-form input {
  min-width: 0;
  padding: 0 6px;
  border: 1px solid var(--border-strong);
  border-radius: var(--control-radius);
  background: var(--panel);
  color: inherit;
  font: inherit;
}
</style>
