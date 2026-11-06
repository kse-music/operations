<script setup lang="ts">
import type { PluginUiPage } from '@serverdeck/plugin-sdk/types/plugins';
import AssistantView from './AssistantView.vue';
import SettingsView from './SettingsView.vue';
defineProps<{
  page?: PluginUiPage;
  hostId?: string;
  keepRunning?: boolean;
  settingsDialog?: boolean;
}>();
</script>
<template>
  <SettingsView v-if="page?.id === 'settings'" :settings-dialog="settingsDialog" />
  <AssistantView v-else :host-id="hostId" :keep-running="keepRunning" />
</template>
