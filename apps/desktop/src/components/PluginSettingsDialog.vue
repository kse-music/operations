<script setup lang="ts">
import { tr } from '../i18n/messages';

import { computed, nextTick, onUnmounted } from 'vue';
import Modal from './Modal.vue';
import PluginSettingsPanel from './PluginSettingsPanel.vue';
import { usePluginsStore } from '../stores/plugins';
import { useWorkspaceStore } from '../stores/workspace';

const props = defineProps<{ pluginId: string }>();
const plugins = usePluginsStore();
const workspace = useWorkspaceStore();
const plugin = computed(() =>
  plugins.installed.find((item) => item.manifest.id === props.pluginId),
);
const busy = computed(() => plugins.busy || workspace.pluginSettingsBusy);
const opener = document.activeElement;
onUnmounted(() => {
  void nextTick(() => {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
  });
});
</script>

<template>
  <Modal
    :title="
      tr('{0} · 插件设置', plugin ? plugins.metadata(plugin, plugin.manifest.name) : tr('插件'))
    "
    :busy="busy"
    @close="workspace.closePluginSettings()"
  >
    <div class="plugin-settings-dialog-body">
      <PluginSettingsPanel :plugin-id="pluginId" standalone />
    </div>
  </Modal>
</template>
