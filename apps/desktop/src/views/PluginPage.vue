<script setup lang="ts">
import { computed, ref } from 'vue';
import PluginIcon from '../components/PluginIcon.vue';
import { usePluginsStore } from '../stores/plugins';
import PluginSettings from '../components/PluginSettings.vue';
import PluginView from './PluginView.vue';
const props = defineProps<{ pluginId: string }>();
const plugins = usePluginsStore();
const plugin = computed(() => plugins.installed.find((p) => p.manifest.id === props.pluginId));
const settingPages = computed(
  () => plugin.value?.manifest.contributions.filter((entry) => entry.kind === 'settings') ?? [],
);
const selected = ref('');
const selection = computed(() =>
  settingPages.value.some((entry) => entry.id === selected.value)
    ? selected.value
    : settingPages.value[0]?.id,
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
            }}</span>
            <span>v{{ plugin.manifest.version }}</span>
            <span>{{ plugin.enabled ? '已启用' : '已禁用' }}</span>
          </p>
        </div>
      </div>
    </header>
    <p v-if="plugin.manifest.description" class="plugin-page-description">
      {{ plugin.manifest.description }}
    </p>
    <p class="subtle">能力适用于所有主机；使用工具时由主机工作区或任务目标确定实际操作对象。</p>
    <PluginSettings :plugin="plugin" />
    <label v-if="settingPages.length > 1"
      >插件配置<select v-model="selected" aria-label="插件配置页面">
        <option v-for="entry in settingPages" :key="entry.id" :value="entry.id">
          {{ entry.label }}
        </option>
      </select></label
    >
    <PluginView
      v-if="selection"
      :key="selection"
      settings-page
      :plugin-id="pluginId"
      :contribution-id="selection"
      host-id=""
      :tab-key="`plugin-settings:${pluginId}:${selection}`"
    />
  </section>
  <p v-else class="host-empty">{{ plugins.loading ? '正在读取插件…' : '插件已卸载。' }}</p>
</template>
