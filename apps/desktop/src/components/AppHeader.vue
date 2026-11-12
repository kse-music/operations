<script setup lang="ts">
import { tr } from '../i18n/messages';
import { useWindowControls } from '../composables/window-controls';

import { Copy, Minus, PanelsTopLeft, Search, Square, X } from '@lucide/vue';
defineProps<{ searchShortcut: string }>();
const emit = defineEmits<{
  search: [];
}>();
const { available, maximized, minimize, toggleMaximize, close } = useWindowControls();
</script>
<template>
  <header
    class="app-header"
    :class="{ 'native-titlebar': available }"
    data-tauri-drag-region="deep"
  >
    <div class="app-brand">
      <PanelsTopLeft :size="20" aria-hidden="true" /><strong>ServerDeck</strong>
    </div>
    <button class="app-search-button" :aria-label="tr('全局搜索')" @click="emit('search')">
      <Search :size="15" aria-hidden="true" /><span>{{ tr('搜索主机与命令') }}</span
      ><kbd>{{ searchShortcut }}</kbd>
    </button>
    <div v-if="available" class="window-controls" role="group" :aria-label="tr('窗口操作')">
      <button
        type="button"
        class="window-control"
        :aria-label="tr('最小化窗口')"
        :title="tr('最小化窗口')"
        @click="minimize"
      >
        <Minus :size="16" :stroke-width="1.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="window-control"
        :aria-label="maximized ? tr('还原窗口') : tr('最大化窗口')"
        :title="maximized ? tr('还原窗口') : tr('最大化窗口')"
        @click="toggleMaximize"
      >
        <Copy v-if="maximized" :size="14" :stroke-width="1.5" aria-hidden="true" />
        <Square v-else :size="14" :stroke-width="1.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="window-control window-control-close"
        :aria-label="tr('关闭窗口')"
        :title="tr('关闭窗口')"
        @click="close"
      >
        <X :size="17" :stroke-width="1.5" aria-hidden="true" />
      </button>
    </div>
  </header>
</template>
