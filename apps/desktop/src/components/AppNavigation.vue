<script setup lang="ts">
import {
  ArchiveRestore,
  ChartNoAxesCombined,
  FolderSync,
  KeyRound,
  Layers,
  Network,
  Play,
  Server,
  Settings2,
  SquareTerminal,
  Waypoints,
  Wrench,
} from '@lucide/vue';
import { messages, type WorkspaceView } from '../types/product';

defineProps<{
  active: WorkspaceView;
  terminals: number;
  transfers: number;
  tasks: number;
}>();
defineEmits<{ navigate: [view: WorkspaceView] }>();
const groups = [
  [
    { view: 'hosts', icon: Server },
    { view: 'terminals', icon: SquareTerminal },
    { view: 'files', icon: FolderSync },
    { view: 'monitor', icon: ChartNoAxesCombined },
    { view: 'operations', icon: Wrench },
  ],
  [
    { view: 'automation', icon: Play },
    { view: 'batch', icon: Layers },
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
        <small
          v-if="
            (item.view === 'terminals' && terminals) ||
            (item.view === 'files' && transfers) ||
            (item.view === 'automation' && tasks)
          "
          class="nav-badge"
          >{{
            Math.min(
              99,
              item.view === 'terminals' ? terminals : item.view === 'files' ? transfers : tasks,
            )
          }}</small
        >
      </button>
    </div>
  </nav>
</template>
