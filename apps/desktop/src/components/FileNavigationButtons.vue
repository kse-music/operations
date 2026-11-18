<script setup lang="ts">
import { Folder, FolderUp, House } from '@lucide/vue';
import { tr } from '../i18n/messages';

defineProps<{ parent?: string | null; root?: string | null; disabled: boolean }>();
const emit = defineEmits<{ navigate: [path: string]; home: [] }>();
</script>

<template>
  <button
    class="tool-button"
    type="button"
    :aria-label="tr('上一级')"
    :title="tr('上一级')"
    :disabled="disabled || !parent"
    @click="parent && emit('navigate', parent)"
  >
    <FolderUp class="menu-icon-gold" :size="16" aria-hidden="true" />
  </button>
  <button
    class="tool-button"
    type="button"
    :aria-label="tr('根目录')"
    :title="tr('根目录')"
    :disabled="disabled || !root"
    @click="root && emit('navigate', root)"
  >
    <Folder class="menu-icon-gold" :size="16" aria-hidden="true">
      <path d="m10 17 5-8" />
    </Folder>
  </button>
  <button
    class="tool-button"
    type="button"
    :aria-label="tr('主目录')"
    :title="tr('主目录')"
    :disabled="disabled"
    @click="emit('home')"
  >
    <House class="menu-icon-blue" :size="16" aria-hidden="true" />
  </button>
</template>
