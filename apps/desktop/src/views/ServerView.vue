<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Server } from '@lucide/vue';
import MonitorView from './MonitorView.vue';
import OperationsView from './OperationsView.vue';
import { serverSections, isMonitorSection, type ServerSection } from '../types/server';
import { useHostsStore } from '../stores/hosts';
import { hostDisplayName, type Host } from '../types/hosts';
import type { ContainerShell } from '../types/ops';

const props = defineProps<{ hostId: string; initialSection?: ServerSection }>();
const emit = defineEmits<{
  section: [value: ServerSection];
  shell: [host: Host, shell: ContainerShell];
}>();
const hosts = useHostsStore();
const host = computed(() => hosts.catalog?.hosts.find((item) => item.id === props.hostId));
const section = ref<ServerSection>(props.initialSection ?? 'overview');
const tabs = ref<HTMLElement>();
watch(
  () => props.initialSection,
  (value) => {
    section.value = value ?? 'overview';
  },
);
watch(section, (value) => emit('section', value));
async function tabKey(event: KeyboardEvent) {
  const index = serverSections.findIndex((item) => item.key === section.value);
  let target: number;
  switch (event.key) {
    case 'ArrowRight':
      target = (index + 1) % serverSections.length;
      break;
    case 'ArrowLeft':
      target = (index + serverSections.length - 1) % serverSections.length;
      break;
    case 'Home':
      target = 0;
      break;
    case 'End':
      target = serverSections.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  section.value = serverSections[target]!.key;
  await nextTick();
  tabs.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
}
</script>

<template>
  <section class="server-view page-view" aria-label="服务器管理">
    <header class="server-heading">
      <div class="server-emblem"><Server :size="22" aria-hidden="true" /></div>
      <div>
        <h1>服务器管理</h1>
        <p class="subtle">{{ hostDisplayName(host) || '当前主机' }} · 资源监控与日常运维</p>
      </div>
    </header>
    <div
      ref="tabs"
      class="server-tabs"
      role="tablist"
      aria-label="服务器管理分类"
      @keydown="tabKey"
    >
      <button
        v-for="item in serverSections"
        :id="`server-tab-${item.key}`"
        :key="item.key"
        role="tab"
        :aria-selected="section === item.key"
        aria-controls="server-panel"
        :tabindex="section === item.key ? 0 : -1"
        @click="section = item.key"
      >
        {{ item.label }}
      </button>
    </div>
    <div
      id="server-panel"
      class="server-panel"
      role="tabpanel"
      :aria-labelledby="`server-tab-${section}`"
    >
      <MonitorView
        v-if="isMonitorSection(section)"
        :host-id="hostId"
        :section="section"
        @processes="section = 'processes'"
      />
      <OperationsView
        v-else
        :host-id="hostId"
        :initial-tab="section"
        @section="section = $event"
        @shell="(target, shell) => emit('shell', target, shell)"
      />
    </div>
  </section>
</template>
