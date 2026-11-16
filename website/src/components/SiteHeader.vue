<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Menu, X } from '@lucide/vue';
import GitHubIcon from './GitHubIcon.vue';
import SiteControls from './SiteControls.vue';
import { carryAppearance } from '../appearance';
import '../appearance.css';

const props = withDefaults(defineProps<{ section?: 'site' | 'docs' | 'developers' }>(), {
  section: 'site',
});
const open = ref(false);
const shell = ref<HTMLElement>();
const toggle = ref<HTMLButtonElement>();
const home = computed(() =>
  import.meta.env.DEV && props.section !== 'site' ? 'http://127.0.0.1:4180' : '',
);
const documentation = computed(() =>
  import.meta.env.DEV && props.section === 'site' ? 'http://127.0.0.1:4181' : '',
);
const navigation = computed(() => [
  { text: '产品能力', href: `${home.value}/#capabilities` },
  { text: '工作台', href: `${home.value}/#workspace` },
  { text: '快速上手', href: `${home.value}/#start` },
  { text: '使用文档', href: `${documentation.value}/docs/`, section: 'docs' },
  { text: '开发者中心', href: `${documentation.value}/developers/`, section: 'developers' },
]);
function handleKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    open.value = false;
    toggle.value?.focus();
  }
}
function handlePointer(event: PointerEvent) {
  if (event.target instanceof Node && !shell.value?.contains(event.target)) open.value = false;
}
function handleNavigation(event: MouseEvent) {
  carryAppearance(event);
  open.value = false;
}
onMounted(() => {
  document.addEventListener('keydown', handleKey);
  document.addEventListener('pointerdown', handlePointer);
});
onUnmounted(() => {
  document.removeEventListener('keydown', handleKey);
  document.removeEventListener('pointerdown', handlePointer);
});
</script>

<template>
  <header ref="shell" class="sd-site-header-shell">
    <div class="sd-site-header">
      <a
        class="sd-site-brand"
        :href="`${home}/`"
        aria-label="ServerDeck 首页"
        @click="carryAppearance"
      >
        <img src="/assets/serverdeck.svg" width="35" height="35" alt="" /><span>ServerDeck</span>
      </a>
      <div class="sd-header-right">
        <nav
          id="site-nav"
          class="sd-site-nav"
          :class="{ open }"
          aria-label="主要导航"
          @click="handleNavigation"
        >
          <a
            v-for="item in navigation"
            :key="item.text"
            :href="item.href"
            :class="{ active: item.section === section }"
            :aria-current="item.section === section ? 'location' : undefined"
            >{{ item.text }}</a
          >
          <a
            class="sd-github-link"
            href="https://github.com/kse-music/operations"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub 源码（新窗口）"
            title="GitHub"
          >
            <GitHubIcon :size="19" /><span>GitHub</span>
          </a>
        </nav>
        <SiteControls :documentation-origin="documentation" @search-open="open = false" />
        <button
          ref="toggle"
          class="sd-site-menu"
          type="button"
          :aria-expanded="open"
          aria-controls="site-nav"
          :aria-label="open ? '关闭菜单' : '打开菜单'"
          @click="open = !open"
        >
          <X v-if="open" :size="20" /><Menu v-else :size="20" />
        </button>
      </div>
    </div>
  </header>
</template>

<style>
:root {
  --sd-header-height: 82px;
  --sd-shell-width: min(1240px, calc(100% - 112px));
}
@media (min-width: 1600px) {
  :root {
    --sd-shell-width: min(1320px, calc(100% - 160px));
  }
}
@media (max-width: 1200px) {
  :root {
    --sd-shell-width: calc(100% - 72px);
  }
}
@media (max-width: 1000px) {
  :root {
    --sd-header-height: 76px;
  }
}
@media (max-width: 960px) {
  :root {
    --sd-shell-width: calc(100% - 60px);
  }
}
@media (max-width: 640px) {
  :root {
    --sd-shell-width: calc(100% - 40px);
  }
}
</style>

<style scoped>
.sd-site-header-shell {
  position: sticky;
  top: 0;
  z-index: 30;
  flex-shrink: 0;
  background: var(--sd-header-bg);
  backdrop-filter: blur(18px);
  border-bottom: 1px solid var(--sd-border);
  color: var(--sd-text);
  font-family: Inter, 'Segoe UI', 'Microsoft YaHei', sans-serif;
  font-weight: 400;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.sd-site-header {
  box-sizing: border-box;
  position: relative;
  width: var(--sd-shell-width);
  height: calc(var(--sd-header-height) - 1px);
  margin-inline: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sd-header-right {
  display: flex;
  align-items: center;
  gap: 22px;
}
.sd-site-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--sd-text);
  font-size: 23px;
  font-weight: 650;
  line-height: 1.5;
  letter-spacing: -0.7px;
  text-decoration: none;
  white-space: nowrap;
}
.sd-site-brand img {
  display: block;
  width: 35px;
  height: 35px;
  flex-shrink: 0;
}
.sd-site-nav {
  display: flex;
  align-items: center;
  gap: 25px;
}
.sd-site-nav a {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--sd-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  letter-spacing: 0;
  text-decoration: none;
  white-space: nowrap;
}
.sd-site-nav a:hover {
  color: var(--sd-text);
}
.sd-site-nav a.active {
  color: var(--sd-accent);
}
.sd-site-nav .sd-github-link {
  padding: 8px;
  color: var(--sd-muted);
}
.sd-github-link span {
  display: none;
}
.sd-site-menu {
  display: none;
  color: var(--sd-muted);
  border: 0;
  background: transparent;
  padding: 10px;
  cursor: pointer;
}
.sd-site-menu :deep(svg) {
  width: 20px;
  height: 20px;
}
a:focus-visible,
button:focus-visible {
  outline: 3px solid #339e86;
  outline-offset: 5px;
}
@media (max-width: 1200px) {
  .sd-site-nav {
    gap: 17px;
  }
}
@media (max-width: 1000px) {
  .sd-header-right {
    gap: 8px;
  }
  .sd-site-menu {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    min-width: 44px;
  }
  .sd-site-nav {
    display: none;
    position: absolute;
    top: calc(100% - 5px);
    left: 0;
    right: 0;
    background: var(--sd-soft);
    border: 1px solid var(--sd-border);
    padding: 16px;
    border-radius: 7px;
    box-shadow: 0 15px 35px #0005;
    max-height: calc(100dvh - var(--sd-header-height) - 12px);
    overflow-y: auto;
  }
  .sd-site-nav.open {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
  .sd-site-nav a {
    padding: 13px 8px;
    font-size: 13px;
    min-height: 44px;
    box-sizing: border-box;
  }
  .sd-site-nav .sd-github-link {
    padding: 13px 8px;
  }
  .sd-github-link span {
    display: inline;
  }
}
@media (max-width: 960px) {
  .sd-site-brand {
    font-size: 21px;
  }
}
@media (max-width: 640px) {
  .sd-site-brand {
    font-size: 22px;
  }
  .sd-site-brand img {
    width: 32px;
    height: 32px;
  }
}
@media (max-width: 380px) {
  .sd-site-brand {
    font-size: 19px;
    gap: 8px;
  }
  .sd-site-brand img {
    width: 28px;
    height: 28px;
  }
}
</style>
