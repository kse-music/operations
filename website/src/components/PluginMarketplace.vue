<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { ArrowUpRight, Search, X, Info, Terminal, PackageSearch } from '@lucide/vue';
import { links } from '../content';
import { carryAppearance } from '../appearance';
import {
  filterPlugins,
  marketplacePlugins,
  pluginCategories,
  type PluginCategory,
  type PluginSort,
} from '../marketplace';
import MarketplaceCard from './MarketplaceCard.vue';
import '../marketplace.css';

const query = ref('');
const category = ref<PluginCategory>('全部插件');
const sort = ref<PluginSort>('recommended');
const matches = computed(() => filterPlugins(query.value, category.value, sort.value));
const showFeatured = computed(
  () => !query.value.trim() && category.value === '全部插件' && sort.value === 'recommended',
);
const featured = marketplacePlugins.filter((plugin) => plugin.featured);
const catalog = computed(() =>
  showFeatured.value ? matches.value.filter((plugin) => !plugin.featured) : matches.value,
);
const notice = ref(false);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function closeNotice() {
  clearTimeout(noticeTimer);
  notice.value = false;
}
function showNotice() {
  clearTimeout(noticeTimer);
  notice.value = true;
  noticeTimer = setTimeout(closeNotice, 6000);
}
function resetFilters() {
  query.value = '';
  category.value = '全部插件';
  sort.value = 'recommended';
}
onUnmounted(() => clearTimeout(noticeTimer));
</script>

<template>
  <main id="main-content" class="marketplace wrap" aria-labelledby="marketplace-title">
    <header class="market-intro">
      <div>
        <p class="market-eyebrow">EXTEND YOUR WORKSPACE</p>
        <h1 id="marketplace-title">插件市场</h1>
        <p class="market-subtitle">为你的工作台，添一份趁手的工具。</p>
      </div>
      <div class="market-developer">
        <a class="market-outline" :href="links.plugins" @click="carryAppearance"
          >开发插件 <ArrowUpRight :size="16"
        /></a>
        <p>用 SDK 构建你的下一个工具。</p>
      </div>
    </header>
    <section class="market-filters" aria-label="搜索和筛选插件">
      <div class="market-search">
        <Search :size="21" aria-hidden="true" /><input
          v-model="query"
          type="search"
          aria-label="搜索插件"
          placeholder="搜索插件名称、功能或开发者…"
        /><button v-if="query" type="button" aria-label="清空搜索" @click="query = ''">
          <X :size="17" />
        </button>
      </div>
      <div class="market-filter-row">
        <div class="market-categories" role="group" aria-label="插件分类">
          <button
            v-for="item in pluginCategories"
            :key="item"
            type="button"
            :aria-pressed="category === item"
            @click="category = item"
          >
            {{ item }}
          </button>
        </div>
        <select v-model="sort" class="market-sort" aria-label="插件排序">
          <option value="recommended">默认排序</option>
          <option value="updated">最新更新</option>
          <option value="name">按名称排序</option>
        </select>
      </div>
    </section>
    <section v-if="showFeatured" class="market-section" aria-labelledby="featured-title">
      <div class="market-section-heading">
        <h2 id="featured-title">精选插件</h2>
        <p>从常用工具开始，扩展你的运维工作流。</p>
      </div>
      <div class="market-featured-grid">
        <MarketplaceCard
          v-for="plugin in featured"
          :key="plugin.id"
          :plugin="plugin"
          featured
          @download="showNotice"
        />
      </div>
    </section>
    <section class="market-section" aria-labelledby="catalog-title">
      <div class="market-section-heading">
        <h2 id="catalog-title">{{ showFeatured ? '全部插件' : '筛选结果' }}</h2>
        <p aria-live="polite" aria-atomic="true">{{ matches.length }} 款插件</p>
      </div>
      <div v-if="catalog.length" class="market-grid">
        <MarketplaceCard
          v-for="plugin in catalog"
          :key="plugin.id"
          :plugin="plugin"
          @download="showNotice"
        />
      </div>
      <div v-else class="market-empty">
        <PackageSearch :size="34" aria-hidden="true" />
        <h3>没有找到匹配的插件</h3>
        <p>试试其他关键词，或切换插件分类。</p>
        <button type="button" class="market-outline" @click="resetFilters">重置筛选</button>
      </div>
    </section>
    <aside class="market-callout" aria-label="插件开发">
      <Terminal :size="29" aria-hidden="true" />
      <div>
        <h2>把你的想法，变成下一个好工具。</h2>
        <p>阅读插件开发文档，开始构建。</p>
      </div>
      <a :href="links.plugins" @click="carryAppearance"
        >前往开发者中心 <ArrowUpRight :size="16"
      /></a>
    </aside>
    <div class="market-notice-region" aria-live="polite" aria-atomic="true">
      <div v-if="notice" class="market-notice" role="status">
        <Info :size="25" aria-hidden="true" />
        <div>
          <strong>建设中</strong>
          <p>插件下载功能正在建设中，敬请期待。</p>
        </div>
        <button type="button" aria-label="关闭建设中提示" @click="closeNotice">
          <X :size="17" />
        </button>
      </div>
    </div>
  </main>
</template>
