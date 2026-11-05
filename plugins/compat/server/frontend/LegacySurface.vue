<script setup lang="ts">
import Docker from '../../../system/docker/frontend/App.vue';
import type { ServerSection } from '@serverdeck/plugin-sdk/types/server';
import type { PluginUiPage } from '@serverdeck/plugin-sdk/types/plugins';
import type { ContainerShell } from '@serverdeck/plugin-sdk/types/ops';
import type { Host } from '@serverdeck/plugin-sdk/types/hosts';
const props = defineProps<{
  pluginId: string;
  hostId: string;
  page: PluginUiPage;
  initialSection?: ServerSection;
}>();
const emit = defineEmits<{
  section: [section: ServerSection];
  shell: [host: Host, shell: ContainerShell];
}>();
</script>
<template>
  <Docker
    :host-id="hostId"
    :initial-section="initialSection"
    :page="page"
    @section="(value) => emit('section', value)"
    @shell="(host, shell) => emit('shell', host, { ...shell, pluginId: props.pluginId })"
  />
</template>
