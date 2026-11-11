<script setup lang="ts">
import { tr } from '../i18n/messages';

import { PanelLeftClose, PanelLeftOpen, PanelsTopLeft, Search } from '@lucide/vue';
defineProps<{ sidebarOpen: boolean; searchShortcut: string }>();
const emit = defineEmits<{
  sidebar: [];
  search: [];
}>();
</script>
<template>
  <header class="app-header">
    <button
      class="shell-icon-button"
      :aria-label="sidebarOpen ? tr('收起主机栏') : tr('展开主机栏')"
      :title="sidebarOpen ? tr('收起主机栏') : tr('展开主机栏')"
      :aria-expanded="sidebarOpen"
      aria-controls="host-sidebar"
      @click="emit('sidebar')"
    >
      <PanelLeftClose v-if="sidebarOpen" :size="17" aria-hidden="true" /><PanelLeftOpen
        v-else
        :size="17"
        aria-hidden="true"
      />
    </button>
    <div class="app-brand">
      <PanelsTopLeft :size="20" aria-hidden="true" /><strong>ServerDeck</strong>
    </div>
    <button class="app-search-button" :aria-label="tr('全局搜索')" @click="emit('search')">
      <Search :size="15" aria-hidden="true" /><span>{{ tr('搜索主机与命令') }}</span
      ><kbd>{{ searchShortcut }}</kbd>
    </button>
  </header>
</template>
