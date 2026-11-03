<script setup lang="ts">
import {
  ArchiveRestore,
  Info,
  KeyRound,
  ListChecks,
  Layers,
  Network,
  Play,
  PanelLeftClose,
  Settings2,
  Waypoints,
} from '@lucide/vue';
import { messages, type WorkspaceView } from '../types/product';
import { computed } from 'vue';
import { navigationModules, type NavigationModule } from '../types/navigation';

const props = defineProps<{
  active: WorkspaceView | null;
  tasks: number;
  module: NavigationModule;
}>();
defineEmits<{ navigate: [view: WorkspaceView]; collapse: [] }>();
const groups = {
  hosts: [],
  tools: [
    { view: 'batch', icon: Layers },
    { view: 'automation', icon: Play },
    { view: 'network', icon: Network },
    { view: 'tasks', icon: ListChecks },
  ],
  assets: [
    { view: 'credentials', icon: KeyRound },
    { view: 'backup', icon: ArchiveRestore },
  ],
  system: [
    { view: 'settings', icon: Settings2 },
    { view: 'overview', icon: Waypoints },
    { view: 'about', icon: Info },
  ],
} as const;
const module = computed(() => props.module);
const moduleLabel = computed(
  () => navigationModules.find((item) => item.id === module.value)!.label,
);
</script>

<template>
  <nav class="activity-rail" aria-label="主导航">
    <div class="sidebar-workspace-heading">
      <strong class="sidebar-module-title">{{
        module === 'hosts' ? '主机管理' : moduleLabel
      }}</strong>
      <button
        class="shell-icon-button"
        aria-label="收起主机栏"
        title="收起侧栏"
        :aria-expanded="true"
        aria-controls="host-sidebar"
        @click="$emit('collapse')"
      >
        <PanelLeftClose :size="16" aria-hidden="true" />
      </button>
    </div>
    <slot />
    <div v-if="groups[module].length" class="activity-group module-menu">
      <button
        v-for="item in groups[module]"
        :key="item.view"
        :class="['nav-item', { active: active === item.view }]"
        :aria-label="messages['zh-CN'][item.view]"
        :aria-current="active === item.view ? 'page' : undefined"
        :data-tooltip="messages['zh-CN'][item.view]"
        @click="$emit('navigate', item.view)"
      >
        <component :is="item.icon" :size="16" :stroke-width="1.6" aria-hidden="true" />
        <span class="nav-label">{{ messages['zh-CN'][item.view] }}</span>
        <small v-if="item.view === 'automation' && tasks" class="nav-badge">{{
          Math.min(99, tasks)
        }}</small>
      </button>
    </div>
  </nav>
</template>
