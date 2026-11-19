<script setup lang="ts">
import { computed } from 'vue';
import { tr } from '../i18n/messages';
import { useHostsStore } from '../stores/hosts';
import { hostDisplayName } from '../types/hosts';
import EnvironmentTagBadge from './EnvironmentTagBadge.vue';

const props = defineProps<{ hostIds: readonly string[] }>();
const hosts = useHostsStore();
const targets = computed(() => {
  const ids = new Set(props.hostIds);
  return (hosts.catalog?.hosts ?? []).flatMap((host) => {
    const tag = ids.has(host.id) ? hosts.environmentTag(host.id) : undefined;
    return tag ? [{ host, tag }] : [];
  });
});
</script>

<template>
  <ul v-if="targets.length" class="host-environment-targets" :aria-label="tr('主机环境标签')">
    <li v-for="{ host, tag } in targets" :key="host.id">
      <strong dir="auto">{{ hostDisplayName(host) }}</strong>
      <EnvironmentTagBadge :tag="tag" />
    </li>
  </ul>
</template>

<style scoped>
.host-environment-targets {
  display: grid;
  gap: 5px;
  max-height: 25vh;
  margin: 0 0 10px;
  padding: 7px 9px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel-soft);
  list-style: none;
}
.host-environment-targets li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px 8px;
  overflow-wrap: anywhere;
}
</style>
