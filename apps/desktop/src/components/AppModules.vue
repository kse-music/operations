<script setup lang="ts">
import { PanelsTopLeft, Puzzle, Server, Settings } from '@lucide/vue';
import { navigationModules, type NavigationModule } from '../types/navigation';

defineProps<{ active: NavigationModule }>();
defineEmits<{ select: [module: NavigationModule] }>();
const moduleIcons = { hosts: Server, plugins: Puzzle, system: Settings };
</script>

<template>
  <header class="module-header">
    <div class="module-brand">
      <PanelsTopLeft :size="23" aria-hidden="true" /><strong>ServerDeck</strong>
    </div>
    <nav class="module-navigation" aria-label="功能模块">
      <button
        v-for="module in navigationModules"
        :key="module.id"
        :data-module="module.id"
        :aria-current="active === module.id ? 'page' : undefined"
        @click="$emit('select', module.id)"
      >
        <component :is="moduleIcons[module.id]" :size="16" :stroke-width="1.6" aria-hidden="true" />
        <span>{{ module.label }}</span>
      </button>
    </nav>
  </header>
</template>
