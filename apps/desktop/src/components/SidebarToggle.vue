<script setup lang="ts">
import { PanelLeftClose, PanelLeftOpen } from '@lucide/vue';

defineProps<{ collapsed?: boolean; controls: string; label: string }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    class="shell-icon-button sidebar-toggle"
    :aria-label="label"
    :title="label"
    :aria-controls="controls"
    :aria-expanded="!collapsed"
    @click="$emit('toggle')"
  >
    <PanelLeftOpen v-if="collapsed" :size="16" aria-hidden="true" />
    <PanelLeftClose v-else :size="16" aria-hidden="true" />
  </button>
</template>
