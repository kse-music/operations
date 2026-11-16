<script setup lang="ts">
import { computed } from 'vue';
import { useData } from 'vitepress';
import SiteHeader from '../../../src/components/SiteHeader.vue';

const { page } = useData();
const section = computed(() =>
  page.value.relativePath.startsWith('developers/') ? 'developers' : 'docs',
);
</script>

<template>
  <div class="sd-docs-header"><SiteHeader :section="section" /></div>
</template>

<style scoped>
.sd-docs-header {
  position: sticky;
  top: 0;
  z-index: 31;
  flex-shrink: 0;
}
@media (min-width: 960px) {
  .sd-docs-header {
    position: fixed;
    left: 0;
    right: 0;
  }
}
</style>
