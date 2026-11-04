<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { serverSections, type ServerSection } from '../types/server';
const props = defineProps<{ sections: readonly ServerSection[]; modelValue: ServerSection }>();
const emit = defineEmits<{ 'update:modelValue': [value: ServerSection] }>();
const tabs = ref<HTMLElement>();
async function key(event: KeyboardEvent) {
  const index = props.sections.indexOf(props.modelValue);
  const target =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? props.sections.length - 1
        : event.key === 'ArrowRight'
          ? (index + 1) % props.sections.length
          : event.key === 'ArrowLeft'
            ? (index + props.sections.length - 1) % props.sections.length
            : -1;
  if (target < 0) return;
  event.preventDefault();
  emit('update:modelValue', props.sections[target]!);
  await nextTick();
  tabs.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
}
</script>
<template>
  <div ref="tabs" class="server-tabs" role="tablist" aria-label="插件功能分类" @keydown="key">
    <button
      v-for="section in sections"
      :id="`server-tab-${section}`"
      :key="section"
      role="tab"
      :aria-selected="modelValue === section"
      :tabindex="modelValue === section ? 0 : -1"
      @click="emit('update:modelValue', section)"
    >
      {{ serverSections.find((s) => s.key === section)?.label }}
    </button>
  </div>
</template>
