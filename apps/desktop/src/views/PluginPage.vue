<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Settings2, ArrowLeft } from '@lucide/vue';
import PluginIcon from '../components/PluginIcon.vue';
import { usePluginsStore } from '../stores/plugins';
import PluginSettings from '../components/PluginSettings.vue';
import PluginView from './PluginView.vue';
import type { ServerSection } from '../types/server';
import type { ContainerShell, LogInput } from '../types/ops';
import type { Host } from '../types/hosts';
import { primaryPluginPage } from '../services/plugin-pages';
const props = defineProps<{
  pluginId: string;
  contributionId: string;
  hostId: string;
  tabKey: string;
  initialSection?: ServerSection;
  logIntent?: { input: LogInput; title: string; sequence: number };
  toolIntent?: import('../types/plugins').PluginToolIntent;
}>();
const emit = defineEmits<{
  host: [id: string];
  contribution: [id: string];
  surfaceNavigate: [
    section: ServerSection,
    intent?: { input: LogInput; title: string; sequence: number },
  ];
  shell: [host: Host, shell: ContainerShell];
  section: [section: ServerSection];
  intentConsumed: [];
}>();
const plugins = usePluginsStore();
const plugin = computed(() => plugins.installed.find((p) => p.manifest.id === props.pluginId));
const contribution = computed(
  () =>
    plugin.value?.manifest.contributions.find((c) => c.id === props.contributionId)?.id ??
    (plugin.value ? primaryPluginPage(plugin.value) : '__details'),
);
const ready = computed(() =>
  plugins.extensions.some((e) => e.pluginId === props.pluginId && e.id === contribution.value),
);
const settings = ref(!ready.value);
const opened = ref(ready.value);
function toggleSettings() {
  settings.value = !settings.value;
  if (!settings.value) opened.value = true;
}
watch(ready, (available) => {
  if (!available) {
    settings.value = true;
    opened.value = false;
  }
});
const generation = computed(() =>
  JSON.stringify([plugin.value?.revision, plugins.grants[props.pluginId]]),
);
</script>
<template>
  <section v-if="plugin" class="plugin-page" :data-plugin-id="pluginId">
    <header class="plugin-heading plugin-page-heading">
      <div class="plugin-page-identity">
        <span class="plugin-page-icon">
          <PluginIcon :manifest="plugin.manifest" :source="plugin.source" :size="23" />
        </span>
        <div>
          <h1>{{ plugin.manifest.name }}</h1>
          <p class="subtle">
            <span class="plugin-source">{{
              plugin.source === 'system' ? '系统内置' : '用户上传'
            }}</span
            ><span>v{{ plugin.manifest.version }}</span
            ><span>{{ plugin.enabled ? '已启用' : '已禁用' }}</span>
          </p>
        </div>
      </div>
      <button v-if="ready" class="button" @click="toggleSettings">
        <ArrowLeft v-if="settings" :size="15" aria-hidden="true" /><Settings2
          v-else
          :size="15"
          aria-hidden="true"
        />{{ settings ? '返回功能' : '插件设置' }}
      </button>
    </header>
    <template v-if="settings"
      ><p v-if="plugin.manifest.description" class="plugin-page-description">
        {{ plugin.manifest.description }}
      </p>
      <p v-if="!ready && plugin.manifest.contributions.length" class="plugin-setup-note">
        {{
          plugin.source === 'system'
            ? '在下方启用插件后即可使用，权限已由系统配置，适用于所有主机。'
            : '启用插件并授权“插件界面”后，即可打开功能。远程操作需要对应能力，适用于所有主机。'
        }}
      </p>
      <PluginSettings :plugin="plugin"
    /></template>
    <template v-if="!settings">
      <label v-if="plugin.manifest.contributions.length > 1" class="plugin-contribution-select"
        >插件页面<select
          :value="contribution"
          aria-label="插件页面"
          @change="emit('contribution', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="entry in plugin.manifest.contributions" :key="entry.id" :value="entry.id">
            {{ entry.label }}
          </option>
        </select></label
      >
    </template>
    <PluginView
      v-if="ready && opened"
      v-show="!settings"
      :key="generation"
      embedded
      :plugin-id="pluginId"
      :contribution-id="contribution"
      :host-id="hostId"
      :tab-key="tabKey"
      :initial-section="initialSection"
      :log-intent="logIntent"
      :tool-intent="toolIntent"
      @intent-consumed="emit('intentConsumed')"
      @host="emit('host', $event)"
      @surface-navigate="(section, intent) => emit('surfaceNavigate', section, intent)"
      @shell="(host, shell) => emit('shell', host, shell)"
      @section="emit('section', $event)"
    />
  </section>
  <p v-else class="host-empty">{{ plugins.loading ? '正在读取插件…' : '插件已卸载。' }}</p>
</template>
