<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';
import { tr } from '../i18n/messages';
import SettingsPanel from '../components/SettingsPanel.vue';
import AboutView from './AboutView.vue';
import { useWorkspaceStore } from '../stores/workspace';
import { settingsCategories } from '../types/product';
const ModelsView = defineAsyncComponent(() => import('./ModelsView.vue'));
const PluginsView = defineAsyncComponent(() => import('./PluginsView.vue'));
const PluginSettingsPanel = defineAsyncComponent(
  () => import('../components/PluginSettingsPanel.vue'),
);
const workspace = useWorkspaceStore();
defineProps<{ active: boolean }>();
const category = computed(() =>
  settingsCategories.find((item) => item.view === workspace.settingsView),
);
</script>
<template>
  <section class="settings-page" :aria-label="tr('设置页面')">
    <SettingsPanel
      v-show="category"
      :category="category?.id ?? 'general'"
      @category="
        (id) => workspace.navigate(settingsCategories.find((item) => item.id === id)!.view)
      "
    />
    <ModelsView v-if="workspace.settingsView === 'models'" />
    <template v-else-if="workspace.settingsView === 'plugins'">
      <PluginsView
        v-show="!workspace.pluginConfiguration"
        @settings="workspace.openPluginSettings"
      />
      <PluginSettingsPanel
        v-if="workspace.pluginConfiguration"
        :key="workspace.pluginConfiguration.pluginId"
        :plugin-id="workspace.pluginConfiguration.pluginId"
        :active="active"
      />
    </template>
    <AboutView v-else-if="workspace.settingsView === 'about'" />
  </section>
</template>
