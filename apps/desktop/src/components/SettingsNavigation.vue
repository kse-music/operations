<script setup lang="ts">
import { Boxes, Info, Keyboard, PanelsTopLeft, Puzzle, Settings2, Terminal } from '@lucide/vue';
import { tr } from '../i18n/messages';
import { useWorkspaceStore } from '../stores/workspace';
import { settingsNavigation } from '../types/navigation';
const workspace = useWorkspaceStore();
const icons = {
  general: Settings2,
  terminal: Terminal,
  shortcuts: Keyboard,
  storage: PanelsTopLeft,
  models: Boxes,
  plugins: Puzzle,
  about: Info,
};
</script>
<template>
  <section class="settings-sidebar">
    <h2>{{ tr('设置') }}</h2>
    <nav class="settings-navigation" :aria-label="tr('设置分类')">
      <button
        v-for="item in settingsNavigation"
        :key="item.view"
        :data-settings-view="item.view"
        class="nav-item"
        :class="{ active: workspace.settingsView === item.view }"
        :aria-label="item.label"
        :aria-current="workspace.settingsView === item.view ? 'page' : undefined"
        :disabled="workspace.navigationBlocked"
        @click="workspace.navigate(item.view)"
      >
        <component :is="icons[item.icon]" :size="16" aria-hidden="true" />{{ item.label }}
      </button>
    </nav>
  </section>
</template>
