<script setup lang="ts">
import { Pin, PinOff } from '@lucide/vue';

defineProps<{ pinned: boolean; controls: string; label: string }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    class="shell-icon-button sidebar-toggle"
    :aria-label="label"
    :title="label"
    :aria-controls="controls"
    @click="$emit('toggle')"
  >
    <PinOff v-if="pinned" :size="16" aria-hidden="true" />
    <Pin v-else :size="16" aria-hidden="true" />
  </button>
</template>
