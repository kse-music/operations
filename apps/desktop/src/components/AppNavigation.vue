<script setup lang="ts">
import { Server, Settings2, SquareTerminal } from '@lucide/vue';
import type { WorkspaceView } from '../types/product';
defineProps<{
  localActive: boolean;
  settingsOpen: boolean;
  collapsed: boolean;
}>();
defineEmits<{ navigate: [view: WorkspaceView]; expand: [] }>();
</script>
<template>
  <div class="activity-rail" :class="{ 'activity-rail-collapsed': collapsed }">
    <nav v-if="collapsed" class="activity-group sidebar-quick-actions" aria-label="收起后的导航">
      <button
        class="nav-item"
        aria-label="展开主机列表"
        title="展开主机列表"
        :aria-expanded="false"
        aria-controls="host-tree-panel"
        @click="$emit('expand')"
      >
        <Server :size="20" aria-hidden="true" />
      </button>
    </nav>
    <nav class="activity-group sidebar-work-actions" aria-label="本地工作区">
      <button
        class="nav-item"
        aria-label="本地终端"
        :title="collapsed ? '本地终端' : undefined"
        :class="{ active: localActive }"
        :aria-current="localActive ? 'page' : undefined"
        @click="$emit('navigate', 'terminals')"
      >
        <SquareTerminal :size="collapsed ? 20 : 16" aria-hidden="true" /><span
          v-if="!collapsed"
          class="nav-label"
          >本地终端</span
        >
      </button>
    </nav>
    <slot />
    <nav class="activity-group sidebar-app-actions" aria-label="应用导航">
      <button
        class="nav-item"
        aria-label="设置"
        :title="collapsed ? '设置' : undefined"
        :class="{ active: settingsOpen }"
        :aria-current="settingsOpen ? 'page' : undefined"
        @click="$emit('navigate', 'settings')"
      >
        <Settings2 :size="collapsed ? 20 : 16" aria-hidden="true" /><span
          v-if="!collapsed"
          class="nav-label"
          >设置</span
        >
      </button>
    </nav>
  </div>
</template>
