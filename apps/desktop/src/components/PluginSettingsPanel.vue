<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ArrowLeft } from '@lucide/vue';
import PluginIcon from './PluginIcon.vue';
import PluginSettings from './PluginSettings.vue';
import PluginView from '../views/PluginView.vue';
import { usePluginsStore } from '../stores/plugins';
import { useWorkspaceStore } from '../stores/workspace';
import { isBuiltinAssistant } from '../services/plugin-pages';

const props = defineProps<{ pluginId: string }>();
const plugins = usePluginsStore();
const workspace = useWorkspaceStore();
const opener = document.activeElement;
const plugin = computed(() =>
  plugins.installed.find((item) => item.manifest.id === props.pluginId),
);
const pages = computed(() =>
  plugins.extensions.filter(
    (entry) => entry.pluginId === props.pluginId && entry.kind === 'settings',
  ),
);
const contribution = computed(() =>
  pages.value.find((entry) => entry.id === workspace.pluginConfiguration?.contributionId),
);
const contextKey = computed(
  () => `plugin-settings:${props.pluginId}:${workspace.pluginConfiguration?.contributionId}`,
);
const builtinAssistant = computed(() => isBuiltinAssistant(plugin.value));
const assistantSettings = computed(
  () => builtinAssistant.value && contribution.value?.id === 'settings',
);
const saving = ref(false);
const busy = computed(() => saving.value || plugins.busy);
watch(saving, (value) => (workspace.pluginSettingsBusy = value), { flush: 'sync' });
onBeforeUnmount(() => (workspace.pluginSettingsBusy = false));
watch(contribution, (value) => {
  if (value) return;
  saving.value = false;
  if (workspace.pluginConfiguration?.pluginId === props.pluginId)
    workspace.pluginConfiguration.contributionId = null;
});

async function showPanel(id: string | null): Promise<void> {
  const configuration = workspace.pluginConfiguration;
  if (!configuration || configuration.contributionId === id || busy.value) return;
  configuration.contributionId = id;
}

async function select(event: Event): Promise<void> {
  const field = event.target as HTMLSelectElement;
  const id = field.value;
  field.value = contribution.value?.id ?? '';
  await showPanel(id);
}

async function finish(action: 'close' | 'models' = 'close'): Promise<void> {
  if (busy.value) return;
  workspace.navigate(action === 'models' ? 'models' : 'plugins');
  if (action === 'close') {
    await nextTick();
    if (
      opener instanceof HTMLElement &&
      opener.isConnected &&
      opener.closest('.settings-dialog-body')
    )
      opener.focus();
    else
      document
        .querySelector<HTMLButtonElement>('.settings-dialog-navigation [aria-label="插件"]')
        ?.focus();
  }
}
</script>

<template>
  <section class="plugin-configuration" :aria-label="`${plugin?.manifest.name ?? '插件'} · 配置`">
    <header class="plugin-configuration-heading">
      <button class="button" aria-label="返回插件列表" :disabled="busy" @click="finish()">
        <ArrowLeft :size="16" aria-hidden="true" />插件
      </button>
      <h1>{{ plugin?.manifest.name ?? '插件' }}</h1>
    </header>
    <div class="plugin-config-body" :class="{ 'assistant-config-body': builtinAssistant }">
      <div v-if="pages.length" class="plugin-config-nav" role="group" aria-label="插件设置分类">
        <button
          class="button"
          :aria-pressed="!!contribution"
          :disabled="busy"
          @click="showPanel(contribution?.id ?? pages[0]!.id)"
        >
          插件配置
        </button>
        <button
          class="button"
          :aria-pressed="!contribution"
          :disabled="busy"
          @click="showPanel(null)"
        >
          权限与详情
        </button>
      </div>
      <label v-if="contribution && pages.length > 1" class="plugin-contribution-select">
        <span>配置页面</span>
        <select
          :value="contribution?.id"
          aria-label="插件配置页面"
          :disabled="busy"
          @change="select"
        >
          <option v-for="entry in pages" :key="entry.id" :value="entry.id">
            {{ entry.label }}
          </option>
        </select>
      </label>
      <PluginView
        v-if="contribution"
        :key="contextKey"
        settings-page
        :plugin-id="pluginId"
        :contribution-id="contribution.id"
        host-id=""
        :tab-key="contextKey"
        @busy="saving = $event"
        @settings-action="finish($event)"
      />
      <section v-if="plugin" v-show="!contribution" class="plugin-management-panel">
        <header class="plugin-management-header">
          <span class="plugin-row-icon">
            <PluginIcon :manifest="plugin.manifest" :source="plugin.source" :size="23" />
          </span>
          <div>
            <p class="plugin-management-meta">
              <span class="plugin-source">{{
                plugin.source === 'system' ? '系统内置' : '用户上传'
              }}</span>
              <span>v{{ plugin.manifest.version }}</span>
            </p>
            <p v-if="plugin.manifest.description" class="subtle">
              {{ plugin.manifest.description }}
            </p>
          </div>
        </header>
        <PluginSettings :plugin="plugin" />
      </section>
      <p v-else class="host-empty" role="status">插件已卸载。</p>
    </div>
    <footer v-if="contribution && !assistantSettings" class="dialog-actions plugin-config-footer">
      <button class="button" :disabled="busy" @click="finish()">取消</button>
    </footer>
  </section>
</template>
