<script setup lang="ts">
import { FolderSync, SquareTerminal, Wrench, ChevronDown } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { messages, type WorkspaceView } from '../types/product';
import { usePluginsStore } from '../stores/plugins';
import { hasPluginFunction, primaryPluginPage } from '../services/plugin-pages';
import PluginIcon from './PluginIcon.vue';
const plugins = usePluginsStore();

const props = defineProps<{ active: WorkspaceView; local: boolean }>();
const emit = defineEmits<{
  navigate: [view: WorkspaceView];
  plugin: [id: string, contribution: string];
}>();
const tools = [
  { view: 'terminals', label: 'SSH 终端', icon: SquareTerminal },
  { view: 'files', label: 'SFTP 文件', icon: FolderSync },
] as const;
const enabled = computed(() =>
  plugins.installed.filter((plugin) => plugin.enabled && hasPluginFunction(plugin)),
);
const open = ref(false),
  trigger = ref<HTMLButtonElement>(),
  menu = ref<HTMLElement>();
const position = ref({ top: '0px', right: '0px', maxHeight: '0px' });
function close(restore = false) {
  open.value = false;
  if (restore) trigger.value?.focus();
}
async function toggle() {
  if (open.value) return close();
  const rect = trigger.value!.getBoundingClientRect();
  const top = Math.min(rect.bottom + 5, window.innerHeight - 80);
  position.value = {
    top: `${Math.max(8, top)}px`,
    right: `${Math.max(8, window.innerWidth - rect.right)}px`,
    maxHeight: `${Math.max(60, window.innerHeight - top - 8)}px`,
  };
  open.value = true;
  await nextTick();
  menu.value?.querySelector<HTMLButtonElement>('button')?.focus();
}
function outside(event: Event) {
  if (!menu.value?.contains(event.target as Node) && !trigger.value?.contains(event.target as Node))
    close();
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    close(true);
  }
  if (event.key === 'Tab') close();
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const items = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index]?.focus();
  }
}
watch(
  () => [props.active, props.local],
  () => close(),
);
onMounted(() => {
  document.addEventListener('pointerdown', outside);
  window.addEventListener('resize', closeMenu);
});
const closeMenu = () => close();
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside);
  window.removeEventListener('resize', closeMenu);
});
</script>

<template>
  <nav class="host-tools" aria-label="当前主机工具">
    <button
      v-for="tool in tools.filter((item) => !local || item.view === 'terminals')"
      :key="tool.view"
      :class="['host-tool', { active: active === tool.view }]"
      :aria-label="messages['zh-CN'][tool.view]"
      :aria-current="active === tool.view ? 'page' : undefined"
      @click="$emit('navigate', tool.view)"
    >
      <component :is="tool.icon" :size="16" aria-hidden="true" />{{
        local ? '本地终端' : tool.label
      }}
    </button>
    <button
      v-if="!local"
      ref="trigger"
      class="host-tool"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
      @keydown.down.prevent="toggle"
      @keydown.esc.prevent="close(true)"
    >
      <Wrench :size="16" aria-hidden="true" />工具<ChevronDown :size="13" aria-hidden="true" />
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="menu"
        class="host-plugin-menu"
        role="menu"
        aria-label="已启用的插件"
        :style="position"
        @keydown="keyboard"
      >
        <button
          v-for="plugin in enabled"
          :key="plugin.manifest.id"
          role="menuitem"
          :data-plugin-id="plugin.manifest.id"
          @click="
            emit('plugin', plugin.manifest.id, primaryPluginPage(plugin));
            close(true);
          "
        >
          <PluginIcon :manifest="plugin.manifest" :source="plugin.source" />
          <span>{{ plugin.manifest.name }}</span>
        </button>
        <p v-if="!enabled.length">暂无已启用的插件</p>
      </div>
    </Teleport>
  </nav>
</template>
