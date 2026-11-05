<script setup lang="ts">
import { FolderSync, SquareTerminal } from '@lucide/vue';
import { computed } from 'vue';
import { messages, type WorkspaceView } from '../types/product';
import { usePluginsStore } from '../stores/plugins';
import { hasPluginFunction, primaryPluginPage } from '../services/plugin-pages';
import PluginIcon from './PluginIcon.vue';
const plugins = usePluginsStore();

defineProps<{ active: WorkspaceView; activePlugin?: string; local: boolean }>();
defineEmits<{
  navigate: [view: WorkspaceView];
  plugin: [id: string, contribution: string];
}>();
const tools = [
  { view: 'terminals', label: 'SSH 终端', icon: SquareTerminal },
  { view: 'files', label: 'SFTP 文件', icon: FolderSync },
] as const;
const enabled = computed(() =>
  plugins.installed.filter((plugin) => plugin.enabled && hasPluginFunction(plugin)),
);
</script>

<template>
  <nav class="host-tools" aria-label="当前主机工具">
    <button
      v-for="tool in tools.filter((item) => !local || item.view === 'terminals')"
      :key="tool.view"
      :class="['host-tool', { active: active === tool.view }]"
      :aria-label="messages['zh-CN'][tool.view]"
      :aria-current="active === tool.view ? 'page' : undefined"
      @click="$emit('navigate', tool.view)"
    >
      <component :is="tool.icon" :size="16" aria-hidden="true" />{{
        local ? '本地终端' : tool.label
      }}
    </button>
    <button
      v-for="plugin in local ? [] : enabled"
      :key="plugin.manifest.id"
      :class="[
        'host-tool',
        { active: active === 'extension' && activePlugin === plugin.manifest.id },
      ]"
      :aria-current="
        active === 'extension' && activePlugin === plugin.manifest.id ? 'page' : undefined
      "
      :data-plugin-id="plugin.manifest.id"
      @click="$emit('plugin', plugin.manifest.id, primaryPluginPage(plugin))"
    >
      <PluginIcon :manifest="plugin.manifest" :source="plugin.source" />
      <span>{{ plugin.manifest.name }}</span>
    </button>
  </nav>
</template>
