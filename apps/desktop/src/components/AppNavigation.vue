<script setup lang="ts">
import {
  ArchiveRestore,
  Info,
  KeyRound,
  Boxes,
  PanelLeftClose,
  Settings2,
  Keyboard,
  Terminal,
  PanelsTopLeft,
} from '@lucide/vue';
import { messages, type WorkspaceView } from '../types/product';
import { computed } from 'vue';
import { navigationModules, type NavigationModule } from '../types/navigation';

const props = defineProps<{
  active: WorkspaceView | null;
  module: NavigationModule;
}>();
defineEmits<{
  navigate: [view: WorkspaceView];
  collapse: [];
}>();
const groups = {
  hosts: [],
  assets: [
    { view: 'credentials', icon: KeyRound },
    { view: 'models', icon: Boxes },
    { view: 'backup', icon: ArchiveRestore },
  ],
  system: [
    { view: 'settings', icon: Settings2 },
    { view: 'settingsTerminal', icon: Terminal },
    { view: 'settingsShortcuts', icon: Keyboard },
    { view: 'settingsWorkspace', icon: PanelsTopLeft },
    { view: 'plugins', icon: Boxes },
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
        :class="[
          'nav-item',
          {
            active:
              active === item.view || (item.view === 'plugins' && active === 'pluginSettings'),
          },
        ]"
        :aria-label="messages['zh-CN'][item.view]"
        :aria-current="
          active === item.view || (item.view === 'plugins' && active === 'pluginSettings')
            ? 'page'
            : undefined
        "
        :data-tooltip="messages['zh-CN'][item.view]"
        @click="$emit('navigate', item.view)"
      >
        <component :is="item.icon" :size="16" :stroke-width="1.6" aria-hidden="true" />
        <span class="nav-label">{{ messages['zh-CN'][item.view] }}</span>
      </button>
    </div>
  </nav>
</template>
