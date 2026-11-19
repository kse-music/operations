<script setup lang="ts">
import type { EnvironmentTagInput } from '../types/hosts';

defineProps<{ tag?: EnvironmentTagInput }>();
</script>

<template>
  <span v-if="tag" class="environment-tag" :data-color="tag.color" :title="tag.name" dir="auto">
    <span class="environment-tag-name">{{ tag.name }}</span>
  </span>
</template>

<style scoped>
.environment-tag {
  --tag-tone: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  padding: 0 5px;
  border: 1px solid color-mix(in srgb, var(--tag-tone) 30%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--tag-tone) 10%, transparent);
  color: var(--tag-tone);
  font-size: var(--font-size-caption);
  line-height: 1.4;
}
.environment-tag::before {
  content: '';
  width: 5px;
  height: 5px;
  flex: 0 0 5px;
  border-radius: 50%;
  background: currentColor;
}
.environment-tag-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.environment-tag[data-color='red'] {
  --tag-tone: light-dark(#a92f44, #ffa1aa);
}
.environment-tag[data-color='amber'] {
  --tag-tone: light-dark(#875405, #f4c27a);
}
.environment-tag[data-color='blue'] {
  --tag-tone: light-dark(#215eb8, #92c2ff);
}
.environment-tag[data-color='green'] {
  --tag-tone: light-dark(#14694a, #83d6a7);
}
.environment-tag[data-color='violet'] {
  --tag-tone: light-dark(#6942a6, #c9acf8);
}
</style>
