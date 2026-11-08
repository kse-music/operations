<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onUnmounted } from 'vue';
import { Boxes, Info, Keyboard, PanelsTopLeft, Puzzle, Settings2, Terminal } from '@lucide/vue';
import Modal from './Modal.vue';
import SettingsPanel from './SettingsPanel.vue';
import AboutView from '../views/AboutView.vue';
import { useWorkspaceStore } from '../stores/workspace';
import { useApplicationStore } from '../stores/application';
import { usePluginsStore } from '../stores/plugins';
import { settingsNavigation } from '../types/navigation';
import { settingsCategories } from '../types/product';
const ModelsView = defineAsyncComponent(() => import('../views/ModelsView.vue'));
const PluginsView = defineAsyncComponent(() => import('../views/PluginsView.vue'));
const PluginSettingsPanel = defineAsyncComponent(() => import('./PluginSettingsPanel.vue'));
const workspace = useWorkspaceStore();
const application = useApplicationStore();
const plugins = usePluginsStore();
const opener = document.activeElement;
onUnmounted(() => {
  void nextTick(() => {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
  });
});
const busy = computed(() => application.saving || plugins.busy || workspace.pluginSettingsBusy);
const icons = {
  general: Settings2,
  terminal: Terminal,
  shortcuts: Keyboard,
  storage: PanelsTopLeft,
  models: Boxes,
  plugins: Puzzle,
  about: Info,
};
const category = computed(() =>
  settingsCategories.find((item) => item.view === workspace.settingsView),
);
</script>
<template>
  <Modal title="设置" :busy="busy" @close="workspace.closeSettings()">
    <div class="settings-dialog-body">
      <nav class="settings-dialog-navigation" aria-label="设置分类">
        <button
          v-for="item in settingsNavigation"
          :key="item.view"
          class="nav-item"
          :class="{ active: workspace.settingsView === item.view }"
          :aria-label="item.label"
          :aria-current="workspace.settingsView === item.view ? 'page' : undefined"
          :disabled="busy"
          @click="workspace.navigate(item.view)"
        >
          <component :is="icons[item.icon]" :size="16" aria-hidden="true" />{{ item.label }}
        </button>
      </nav>
      <div class="settings-dialog-content">
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
          />
        </template>
        <AboutView v-else-if="workspace.settingsView === 'about'" />
      </div>
    </div>
  </Modal>
</template>
