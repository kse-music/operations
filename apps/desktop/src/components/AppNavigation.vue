<script setup lang="ts">
import {
  ArchiveRestore,
  Info,
  KeyRound,
  ListChecks,
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
import { usePluginsStore } from '../stores/plugins';
import { primaryPluginPage } from '../services/plugin-pages';
const plugins = usePluginsStore();

const props = defineProps<{
  active: WorkspaceView | null;
  tasks: number;
  module: NavigationModule;
  activePlugin?: string;
}>();
defineEmits<{
  navigate: [view: WorkspaceView];
  collapse: [];
  plugin: [id: string, contribution: string];
}>();
const groups = {
  hosts: [],
  assets: [
    { view: 'credentials', icon: KeyRound },
    { view: 'models', icon: Boxes },
    { view: 'backup', icon: ArchiveRestore },
  ],
  plugins: [],
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
const pluginEntries = computed(() =>
  plugins.installed.map((plugin) => ({
    plugin,
    contribution: primaryPluginPage(plugin),
  })),
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
      </button>
    </div>
    <div v-if="module === 'plugins'" class="activity-group module-menu" aria-label="运维工具导航">
      <button
        v-for="{ plugin, contribution } in pluginEntries"
        :key="plugin.manifest.id"
        :class="[
          'nav-item',
          { active: active === 'extension' && activePlugin === plugin.manifest.id },
        ]"
        :aria-current="
          active === 'extension' && activePlugin === plugin.manifest.id ? 'page' : undefined
        "
        :data-plugin-id="plugin.manifest.id"
        :aria-label="plugin.manifest.name"
        @click="$emit('plugin', plugin.manifest.id, contribution)"
      >
        <Boxes :size="16" aria-hidden="true" /><span class="nav-label">{{
          plugin.manifest.name
        }}</span>
        <small
          v-if="tasks && plugin.manifest.contributions.some((entry) => entry.tool === 'automation')"
          class="nav-badge"
          >{{ Math.min(99, tasks) }}</small
        >
      </button>
      <p v-if="plugins.loaded && !pluginEntries.length" class="plugin-sidebar-empty">
        尚未安装运维工具
      </p>
      <button
        class="nav-item plugin-shared-tool"
        aria-label="任务中心"
        :aria-current="active === 'tasks' ? 'page' : undefined"
        :class="{ active: active === 'tasks' }"
        @click="$emit('navigate', 'tasks')"
      >
        <ListChecks :size="16" aria-hidden="true" /><span class="nav-label">任务中心</span>
      </button>
    </div>
  </nav>
</template>
