<script setup lang="ts">
import { ref, watch } from 'vue';
import MonitorView from './MonitorView.vue';
import ServerTabs from '@serverdeck/plugin-sdk/ui/ServerTabs.vue';
import type { ServerSection, MonitorSection } from '@serverdeck/plugin-sdk/types/server';
import type { PluginUiPage } from '@serverdeck/plugin-sdk/types/plugins';
const props = defineProps<{
  hostId?: string;
  initialSection?: ServerSection;
  page?: PluginUiPage;
}>();
const emit = defineEmits<{
  section: [section: ServerSection];
  navigate: [section: ServerSection];
}>();
const sections = (['overview', 'disks', 'network'] as MonitorSection[]).filter(
  (section) =>
    !props.page?.surface ||
    props.page.surface.kind !== 'monitor' ||
    props.page.surface.sections.includes(section),
);
const section = ref<ServerSection>(
  sections.includes(props.initialSection as MonitorSection) ? props.initialSection! : sections[0]!,
);
watch(
  () => props.initialSection,
  (value) => {
    if (sections.includes(value as MonitorSection)) section.value = value!;
  },
);
watch(section, (value) => emit('section', value));
</script>
<template>
  <div class="plugin-server-surface">
    <ServerTabs v-model="section" :sections="sections" /><MonitorView
      :host-id="hostId"
      :section="section as MonitorSection"
      @processes="emit('navigate', 'processes')"
    />
  </div>
</template>
