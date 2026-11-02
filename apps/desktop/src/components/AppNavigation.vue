<script setup lang="ts">
import {
  ArchiveRestore,
  KeyRound,
  Layers,
  Network,
  Play,
  PanelsTopLeft,
  Settings2,
  Waypoints,
} from '@lucide/vue';
import { hostViews, messages, type WorkspaceView } from '../types/product';

defineProps<{
  active: WorkspaceView | null;
  tasks: number;
}>();
defineEmits<{ navigate: [view: WorkspaceView]; workspace: [] }>();
const groups = [
  [
    { view: 'batch', icon: Layers },
    { view: 'automation', icon: Play },
    { view: 'network', icon: Network },
  ],
  [
    { view: 'credentials', icon: KeyRound },
    { view: 'backup', icon: ArchiveRestore },
    { view: 'overview', icon: Waypoints },
    { view: 'settings', icon: Settings2 },
  ],
] as const;
</script>

<template>
  <nav class="activity-rail" aria-label="主导航">
    <div class="activity-group">
      <button
        :class="['nav-item', { active: active !== null && hostViews.has(active) }]"
        aria-label="主机管理"
        :aria-current="active !== null && hostViews.has(active) ? 'page' : undefined"
        data-tooltip="主机管理"
        @click="$emit('workspace')"
      >
        <PanelsTopLeft :size="20" :stroke-width="1.6" aria-hidden="true" />
        <span class="nav-label">主机管理</span>
      </button>
    </div>
    <div v-for="(group, index) in groups" :key="index" class="activity-group">
      <button
        v-for="item in group"
        :key="item.view"
        :class="['nav-item', { active: active === item.view }]"
        :aria-label="messages['zh-CN'][item.view]"
        :aria-current="active === item.view ? 'page' : undefined"
        :data-tooltip="messages['zh-CN'][item.view]"
        @click="$emit('navigate', item.view)"
      >
        <component :is="item.icon" :size="20" :stroke-width="1.6" aria-hidden="true" />
        <span class="nav-label">{{ messages['zh-CN'][item.view] }}</span>
        <small v-if="item.view === 'automation' && tasks" class="nav-badge">{{
          Math.min(99, tasks)
        }}</small>
      </button>
    </div>
  </nav>
</template>
