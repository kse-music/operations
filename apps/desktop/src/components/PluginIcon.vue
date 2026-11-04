<script setup lang="ts">
import { computed } from 'vue';
import { pluginIcon } from '../services/plugin-icons';
import type { InstalledPlugin, PluginManifest } from '../types/plugins';
const props = withDefaults(
  defineProps<{
    manifest: Pick<PluginManifest, 'id' | 'icon'>;
    source?: InstalledPlugin['source'];
    size?: number;
  }>(),
  { size: 16, source: 'user' },
);
const icon = computed(() => pluginIcon(props.manifest, props.source));
</script>
<template>
  <component :is="icon" :size="size" :stroke-width="1.6" aria-hidden="true" focusable="false" />
</template>
