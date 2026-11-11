<script setup lang="ts">
import { tr } from '../i18n/messages';

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ArrowLeft } from '@lucide/vue';
import PluginIcon from './PluginIcon.vue';
import PluginSettings from './PluginSettings.vue';
import PluginView from '../views/PluginView.vue';
import { usePluginsStore } from '../stores/plugins';
import { useWorkspaceStore } from '../stores/workspace';

const props = defineProps<{ pluginId: string; standalone?: boolean }>();
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
const saving = ref(false);
const activeTab = ref<'info' | 'settings'>(contribution.value ? 'settings' : 'info');
const busy = computed(() => saving.value || plugins.busy);
watch(saving, (value) => (workspace.pluginSettingsBusy = value), { flush: 'sync' });
onBeforeUnmount(() => (workspace.pluginSettingsBusy = false));
watch(contribution, (value) => {
  if (value) return;
  saving.value = false;
  if (workspace.pluginConfiguration?.pluginId === props.pluginId)
    workspace.pluginConfiguration.contributionId = null;
});

async function showPanel(tab: 'info' | 'settings', id?: string): Promise<void> {
  const configuration = workspace.pluginConfiguration;
  if (!configuration || busy.value) return;
  activeTab.value = tab;
  configuration.contributionId =
    tab === 'settings' ? (id ?? contribution.value?.id ?? pages.value[0]?.id ?? null) : null;
}

function navigateTabs(event: KeyboardEvent) {
  if (busy.value || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const target =
    event.key === 'Home'
      ? 'info'
      : event.key === 'End'
        ? 'settings'
        : activeTab.value === 'info'
          ? 'settings'
          : 'info';
  void showPanel(target);
  (event.currentTarget as HTMLElement)
    .querySelector<HTMLButtonElement>(`#plugin-tab-${target}`)
    ?.focus();
}

async function select(event: Event): Promise<void> {
  const field = event.target as HTMLSelectElement;
  const id = field.value;
  field.value = contribution.value?.id ?? '';
  await showPanel('settings', id);
}

async function finish(action: 'close' | 'models' = 'close'): Promise<void> {
  if (busy.value) return;
  if (props.standalone && action === 'close') {
    workspace.closePluginSettings();
    return;
  }
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
        .querySelector<HTMLButtonElement>(
          '.settings-dialog-navigation [data-settings-view="plugins"]',
        )
        ?.focus();
  }
}
</script>

<template>
  <section
    class="plugin-configuration"
    :aria-label="
      tr('{0} · 配置', plugin ? plugins.metadata(plugin, plugin.manifest.name) : tr('插件'))
    "
  >
    <header v-if="!standalone" class="plugin-configuration-heading">
      <button class="button" :aria-label="tr('返回插件列表')" :disabled="busy" @click="finish()">
        <ArrowLeft :size="16" aria-hidden="true" />{{ tr('插件 ') }}
      </button>
      <h1>{{ plugin?.manifest.name ?? tr('插件') }}</h1>
    </header>
    <div class="plugin-config-body plugin-settings-body">
      <div
        class="plugin-config-nav"
        role="tablist"
        :aria-label="tr('插件详情')"
        @keydown="navigateTabs"
      >
        <button
          id="plugin-tab-info"
          class="button"
          role="tab"
          :aria-selected="activeTab === 'info'"
          aria-controls="plugin-panel-info"
          :tabindex="activeTab === 'info' ? 0 : -1"
          :disabled="busy"
          @click="showPanel('info')"
        >
          {{ tr(' 基本信息 ') }}
        </button>
        <button
          id="plugin-tab-settings"
          class="button"
          role="tab"
          :aria-selected="activeTab === 'settings'"
          aria-controls="plugin-panel-settings"
          :tabindex="activeTab === 'settings' ? 0 : -1"
          :disabled="busy"
          @click="showPanel('settings')"
        >
          {{ tr(' 插件配置 ') }}
        </button>
      </div>
      <div
        v-show="activeTab === 'settings'"
        id="plugin-panel-settings"
        class="plugin-config-content"
        role="tabpanel"
        aria-labelledby="plugin-tab-settings"
      >
        <label v-if="contribution && pages.length > 1" class="plugin-contribution-select">
          <span>{{ tr('配置页面') }}</span>
          <select
            :value="contribution?.id"
            :aria-label="tr('插件配置页面')"
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
        <div v-else class="plugin-config-empty" role="status">
          <h2>
            {{
              plugin?.manifest.contributions.some((entry) => entry.kind === 'settings')
                ? tr('配置暂不可用')
                : tr('无需单独配置')
            }}
          </h2>
          <p>
            {{
              plugin?.manifest.contributions.some((entry) => entry.kind === 'settings')
                ? tr('启用插件并授予所需权限后，可在此修改插件配置。')
                : tr('此插件直接使用当前主机的连接与平台配置，可从主机工具栏打开使用。')
            }}
          </p>
        </div>
      </div>
      <section
        v-if="plugin"
        v-show="activeTab === 'info'"
        id="plugin-panel-info"
        class="plugin-management-panel"
        role="tabpanel"
        aria-labelledby="plugin-tab-info"
      >
        <header class="plugin-management-header">
          <span class="plugin-row-icon">
            <PluginIcon :manifest="plugin.manifest" :source="plugin.source" :size="23" />
          </span>
          <div>
            <p class="plugin-management-meta">
              <span class="plugin-source">{{
                plugin.source === 'system' ? tr('系统内置') : tr('用户上传')
              }}</span>
              <span>v{{ plugin.manifest.version }}</span>
            </p>
            <p v-if="plugins.metadata(plugin, plugin.manifest.description)" class="subtle">
              {{ plugins.metadata(plugin, plugin.manifest.description) }}
            </p>
          </div>
        </header>
        <PluginSettings :plugin="plugin" />
      </section>
      <p v-else class="host-empty" role="status">{{ tr('插件已卸载。') }}</p>
    </div>
  </section>
</template>
