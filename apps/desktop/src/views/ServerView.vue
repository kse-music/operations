<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Server } from '@lucide/vue';
import { usePluginsStore } from '../stores/plugins';
import { useHostsStore } from '../stores/hosts';
import { hostDisplayName } from '../types/hosts';
import type { ServerSection } from '../types/server';
import { serverPluginFor } from '../services/server-plugins';
import { errorMessage } from '../services/ipc';
import { useErrorNotifications } from '../composables/error-notifications';
const props = defineProps<{ hostId: string; initialSection?: ServerSection }>();
const emit = defineEmits<{
  plugin: [id: string, contribution: string, hostId: string, section?: ServerSection];
  settings: [id: string];
  manage: [];
}>();
const plugins = usePluginsStore(),
  hosts = useHostsStore();
const error = ref<string | null>(null);
useErrorNotifications(error);
const host = computed(() => hosts.catalog?.hosts.find((host) => host.id === props.hostId));
const entries = computed(() =>
  plugins.installed.flatMap((plugin) =>
    plugin.manifest.contributions
      .filter((entry) => entry.kind === 'server')
      .map((entry) => ({
        plugin,
        entry,
        ready: plugins.extensions.some(
          (e) => e.pluginId === plugin.manifest.id && e.id === entry.id,
        ),
      })),
  ),
);
async function load() {
  error.value = null;
  await plugins.refresh();
  if (!props.initialSection) return;
  try {
    const entry = await serverPluginFor(props.hostId, props.initialSection);
    if (entry) emit('plugin', entry.pluginId, entry.id, props.hostId, props.initialSection);
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
onMounted(() => void load());
</script>
<template>
  <section class="server-view page-view" aria-label="服务器管理">
    <header class="server-heading">
      <div class="server-emblem"><Server :size="22" aria-hidden="true" /></div>
      <div>
        <h1>服务器管理</h1>
        <p class="subtle">{{ hostDisplayName(host) || '当前主机' }} · 选择服务器插件</p>
      </div>
    </header>
    <p v-if="plugins.loading" role="status">正在读取插件…</p>
    <p v-if="error || plugins.error" role="status">
      插件列表读取失败。<button class="text-button" @click="load">重试</button>
    </p>
    <p v-if="plugins.loaded && !entries.length" class="host-empty">尚未安装服务器插件。</p>
    <div class="plugin-list">
      <article
        v-for="{ plugin, entry, ready } in entries"
        :key="`${plugin.manifest.id}:${entry.id}`"
        class="plugin-card"
      >
        <h2>
          {{ plugin.manifest.name }}
        </h2>
        <p>{{ plugin.manifest.description }}</p>
        <button
          v-if="ready"
          class="button primary"
          @click="emit('plugin', plugin.manifest.id, entry.id, hostId)"
        >
          打开 {{ entry.label }}
        </button>
        <button v-else class="button" @click="emit('settings', plugin.manifest.id)">
          {{ plugin.enabled ? '插件设置' : '启用并设置' }}
        </button>
      </article>
    </div>
    <button class="button" @click="emit('manage')">插件管理</button>
  </section>
</template>
