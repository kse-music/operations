<script setup lang="ts">
import { tr } from '../i18n/messages';

import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { Settings2 } from '@lucide/vue';
import { usePluginsStore } from '../stores/plugins';
import { useHostsStore } from '../stores/hosts';
import { useOpsStore } from '../stores/ops';
import { useFilesStore } from '../stores/files';
import { pluginsApi } from '../services/plugins';
import { filesApi } from '../services/files';
import { sameHostConnection } from '../services/product-links';
import { useWorkspaceStore, isHostTab } from '../stores/workspace';
import { errorMessage } from '../services/ipc';
import { useErrorNotifications } from '../composables/error-notifications';
import type { PluginUi } from '../types/plugins';
import Modal from '../components/Modal.vue';
import PluginFrame from '../components/PluginFrame.vue';
import type { ServerSection } from '../types/server';
const props = withDefaults(
  defineProps<{
    pluginId: string;
    contributionId: string;
    hostId: string;
    tabKey: string;
    initialSection?: ServerSection;
    active?: boolean;
    settingsPage?: boolean;
  }>(),
  {
    active: true,
    settingsPage: false,
    initialSection: undefined,
  },
);
const emit = defineEmits<{
  settings: [];
  settingsAction: [action: 'close' | 'models'];
  busy: [value: boolean];
  contribution: [id: string];
  surfaceNavigate: [section: ServerSection];
  section: [section: ServerSection];
}>();
const plugins = usePluginsStore(),
  hosts = useHostsStore(),
  ops = useOpsStore(),
  files = useFilesStore();
const plugin = computed(() => plugins.installed.find((p) => p.manifest.id === props.pluginId));
const workspace = useWorkspaceStore();
const retainRequests = computed(
  () =>
    !props.settingsPage &&
    workspace.tabs.some((tab) =>
      props.hostId ? isHostTab(tab) && tab.hostId === props.hostId : tab.key === props.tabKey,
    ),
);
const available = computed(() =>
  plugins.extensions.some(
    (entry) => entry.pluginId === props.pluginId && entry.id === props.contributionId,
  ),
);
const grant = computed(() => plugins.grants[props.pluginId]);
const runtime = computed(() => plugins.statuses.find((s) => s.id === props.pluginId));
const schema = shallowRef<PluginUi | null>(null),
  loading = ref(false),
  busy = ref(false),
  error = ref<string | null>(null),
  failed = ref(false);
const page = computed(() => schema.value?.pages.find((p) => p.id === props.contributionId));
const host = computed(() => hosts.catalog?.hosts.find((h) => h.id === props.hostId));
const operations = computed(() => ops.connections[props.hostId]),
  connection = computed(() => files.connections[props.hostId]);
const trust = computed(() => operations.value?.trust ?? connection.value?.trust);
const disposed = ref(false);
const contextReady = ref(false);
const needsConnection = computed(
  () =>
    grant.value?.permissions.some((permission) =>
      [
        'ssh.execute',
        'sftp.read',
        'sftp.write',
        'metrics.read',
        'system.read',
        'system.manage',
        'logs.read',
        'assistant.use',
      ].includes(permission),
    ) ?? false,
);
const frameReload = ref(0);
const frameOpened = ref(false);
const frameSaving = ref(false);
if (props.settingsPage)
  watch([busy, frameSaving], ([invoking, saving]) => emit('busy', invoking || saving));
const generationKey = computed(() => JSON.stringify([plugin.value?.revision, grant.value]));
const connectionChanged = computed(
  () =>
    !!host.value &&
    ((operations.value?.state === 'connected' &&
      !sameHostConnection(operations.value.host, host.value)) ||
      (connection.value?.state === 'connected' &&
        !sameHostConnection(connection.value.host, host.value))),
);
let generation = 0;
async function bind() {
  if (!props.active || !available.value || disposed.value) return;
  contextReady.value = false;
  const ticket = ++generation;
  await plugins.bind(props.pluginId, props.tabKey);
  if (
    !disposed.value &&
    props.active &&
    ticket === generation &&
    plugins.owns(props.pluginId, props.tabKey)
  ) {
    contextReady.value =
      !props.hostId || !needsConnection.value || operations.value?.state === 'connected';
    if (contextReady.value && page.value) frameOpened.value = true;
  }
  return ticket;
}
async function load() {
  if (!plugin.value || !available.value || !props.active) return;
  loading.value = true;
  failed.value = false;
  error.value = null;
  try {
    schema.value = await plugins.schema(props.pluginId);
    if (!props.active || !available.value || disposed.value) return;
    const selected = page.value;
    if (!selected) throw { message: tr('插件贡献页面不存在') };
    if (props.hostId && !connectionChanged.value) await connect();
    await bind();
  } catch (cause) {
    failed.value = true;
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}
async function connect() {
  if (!host.value || !grant.value || !props.active) return;
  busy.value = true;
  try {
    const changed =
      (operations.value?.state === 'connected' &&
        !sameHostConnection(operations.value.host, host.value)) ||
      (connection.value?.state === 'connected' &&
        !sameHostConnection(connection.value.host, host.value));
    if (changed) {
      if (
        !(await plugins.ask(
          plugins.t(tr('重新连接主机？'), 'Reconnect host?'),
          plugins.t(
            tr('旧运维/SFTP 租约将关闭，终端保持连接。'),
            'Closes old operations/SFTP leases; terminals remain connected.',
          ),
        ))
      )
        return;
      await plugins.release(props.pluginId, props.tabKey);
      await ops.close(host.value.id);
      if (connection.value?.id) await filesApi.close(connection.value.id, false);
      if (connection.value) connection.value.state = 'closed';
    }
    if (
      grant.value.permissions.some((p) =>
        [
          'ssh.execute',
          'sftp.read',
          'sftp.write',
          'metrics.read',
          'system.read',
          'system.manage',
          'logs.read',
          'assistant.use',
        ].includes(p),
      )
    )
      await ops.open(host.value, false);
    if (grant.value.permissions.some((p) => p === 'sftp.read' || p === 'sftp.write'))
      await files.open(host.value);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function acceptTrust(accept: boolean) {
  if (operations.value?.trust) await ops.trust(accept, props.hostId);
  else {
    files.active = props.hostId;
    await files.trust(accept);
  }
}
async function restart() {
  try {
    await pluginsApi.activate(props.pluginId);
    await plugins.refresh();
    await load();
    frameReload.value++;
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
watch(
  () => [
    operations.value?.state === 'connected' ? operations.value.session?.id : '',
    connection.value?.state === 'connected' ? connection.value.id : '',
  ],
  () => {
    if (schema.value && props.active && available.value)
      void bind().catch((cause) => {
        if (!disposed.value) error.value = errorMessage(cause);
      });
  },
);
watch(
  () => [props.active, available.value, generationKey.value],
  async (value, previous) => {
    if (!props.active && available.value && retainRequests.value && previous?.[2] === value[2]) {
      return;
    }
    generation++;
    contextReady.value = false;
    if (previous && value[2] !== previous[2]) {
      schema.value = null;
      frameOpened.value = false;
      frameSaving.value = false;
    }
    try {
      if (!props.active || !available.value) {
        await plugins.release(props.pluginId, props.tabKey);
        return;
      }
      if (!schema.value) await load();
      else {
        if (props.hostId && !connectionChanged.value) await connect();
        await bind();
      }
    } catch (cause) {
      if (!disposed.value) error.value = errorMessage(cause);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed.value = true;
  generation++;
  void plugins.release(props.pluginId, props.tabKey).catch((cause) => {
    plugins.error = errorMessage(cause);
  });
});
useErrorNotifications(error);
</script>
<template>
  <section
    class="plugin-workspace plugin-embedded"
    :class="{ 'plugin-settings-workspace': settingsPage }"
    :data-plugin-id="pluginId"
    :data-host-id="hostId"
  >
    <header v-if="!settingsPage" class="plugin-heading">
      <h1>
        {{
          schema
            ? plugins.label(schema.title)
            : plugin
              ? plugins.metadata(plugin, plugin.manifest.name)
              : ''
        }}
      </h1>
      <button class="button" :aria-label="tr('插件设置')" @click="emit('settings')">
        <Settings2 :size="15" aria-hidden="true" />{{ tr('插件设置 ') }}
      </button>
    </header>
    <label
      v-if="
        !settingsPage &&
        (plugin?.manifest.contributions.filter((entry) => entry.kind !== 'settings').length ?? 0) >
          1
      "
      class="plugin-contribution-select"
      >{{ tr(' 插件页面')
      }}<select
        :value="contributionId"
        :aria-label="tr('插件页面')"
        @change="emit('contribution', ($event.target as HTMLSelectElement).value)"
      >
        <option
          v-for="entry in plugin?.manifest.contributions.filter(
            (entry) => entry.kind !== 'settings',
          )"
          :key="entry.id"
          :value="entry.id"
        >
          {{ plugin ? plugins.metadata(plugin, entry.label) : entry.label }}
        </option>
      </select>
    </label>
    <p v-if="!available" class="host-empty">
      {{ tr('此插件尚未启用或授权，请在插件设置中配置。') }}
    </p>
    <div
      v-else-if="
        hostId && needsConnection && (connectionChanged || operations?.state !== 'connected')
      "
      class="plugin-context action-row"
    >
      <span>{{
        connectionChanged
          ? tr('主机配置已更新，请重新连接以使用新配置。')
          : operations?.state === 'failed'
            ? tr('主机连接失败')
            : tr('正在连接当前主机…')
      }}</span>
      <button class="button" :disabled="busy" @click="connect">
        {{ connectionChanged ? tr('重新连接') : tr('重试连接') }}
      </button>
    </div>
    <p v-if="available && loading" role="status">
      {{ plugins.t(tr('正在加载插件…'), 'Loading plugin…') }}
    </p>
    <div v-else-if="available && (failed || runtime?.state === 'crashed')" class="host-empty">
      <p>
        {{ plugins.t(tr('插件暂不可用'), 'Plugin unavailable') }} {{ runtime?.errorCode ?? '' }}
      </p>
      <button class="button" @click="restart">{{ plugins.t(tr('重新激活'), 'Restart') }}</button>
    </div>
    <template v-else-if="available && page">
      <PluginFrame
        v-if="plugin && frameOpened"
        v-show="contextReady"
        :key="`${generationKey}:${frameReload}`"
        :active="active && contextReady"
        :retain-requests="retainRequests"
        :settings-page="settingsPage"
        :context-key="tabKey"
        :plugin-id="pluginId"
        :revision="plugin.revision"
        :host-id="hostId"
        :page="page"
        :initial-section="initialSection"
        @navigate="(section) => emit('surfaceNavigate', section)"
        @section="emit('section', $event)"
        @settings-action="emit('settingsAction', $event)"
        @saving="frameSaving = $event"
        @retry="restart"
      />
      <p v-if="!frameOpened || !contextReady" class="host-empty" role="status">
        {{ tr(' 正在准备插件，请稍候… ') }}
      </p>
    </template>
    <Modal
      v-if="active && trust"
      :title="plugins.t(tr('核验 SSH 主机指纹'), 'Verify SSH host key')"
      @close="acceptTrust(false)"
      ><p>{{ trust.hostname }}:{{ trust.port }} · {{ trust.algorithm }}</p>
      <code class="fingerprint">{{ trust.fingerprint }}</code>
      <footer class="action-row">
        <button class="button" @click="acceptTrust(false)">
          {{ plugins.t(tr('拒绝'), 'Reject') }}</button
        ><button class="button primary" @click="acceptTrust(true)">
          {{ plugins.t(tr('已核对，信任并连接'), 'Verified, trust and connect') }}
        </button>
      </footer></Modal
    >
  </section>
</template>
