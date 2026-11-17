<script setup lang="ts">
import {
  Container,
  Sparkles,
  Layers,
  Database,
  FileSearch,
  ShipWheel,
  ShieldCheck,
  Download,
} from '@lucide/vue';
import type { MarketplacePlugin } from '../marketplace';

defineProps<{ plugin: MarketplacePlugin; featured?: boolean }>();
defineEmits<{ download: [] }>();
const icons = {
  docker: Container,
  assistant: Sparkles,
  redis: Layers,
  database: Database,
  logs: FileSearch,
  kubernetes: ShipWheel,
  shield: ShieldCheck,
};
</script>

<template>
  <article
    class="market-card"
    :class="{ 'market-card-featured': featured }"
    :aria-labelledby="`plugin-${featured ? 'featured-' : ''}${plugin.id}`"
  >
    <div class="market-card-main">
      <div class="market-icon" :class="`market-icon-${plugin.icon}`" aria-hidden="true">
        <span v-if="plugin.icon === 'nginx'" class="market-nginx">N</span>
        <component :is="icons[plugin.icon]" v-else :size="featured ? 35 : 28" :stroke-width="1.8" />
      </div>
      <div class="market-card-copy">
        <div class="market-card-heading">
          <h3 :id="`plugin-${featured ? 'featured-' : ''}${plugin.id}`">{{ plugin.name }}</h3>
          <span class="market-badge">{{
            plugin.author === 'ServerDeck' ? '官方' : plugin.category
          }}</span>
        </div>
        <p>{{ plugin.description }}</p>
        <ul class="market-tags" aria-label="插件标签">
          <li v-for="tag in plugin.tags" :key="tag">{{ tag }}</li>
        </ul>
      </div>
    </div>
    <footer class="market-card-footer">
      <p>
        <span>{{ plugin.author }}</span
        ><span class="market-version">v{{ plugin.version }}</span>
      </p>
      <button
        type="button"
        class="market-download"
        :aria-label="`下载${plugin.name}`"
        @click="$emit('download')"
      >
        <Download :size="15" />{{ featured ? '下载插件' : '下载' }}
      </button>
    </footer>
  </article>
</template>
