<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { Settings2 } from '@lucide/vue';
import { usePluginsStore } from '../stores/plugins';
import { useHostsStore } from '../stores/hosts';
import { useOpsStore } from '../stores/ops';
import { useFilesStore } from '../stores/files';
import { pluginsApi } from '../services/plugins';
import { filesApi } from '../services/files';
import { sameHostConnection } from '../services/product-links';
import { isBuiltinAssistant } from '../services/plugin-pages';
import { useWorkspaceStore, isHostTab } from '../stores/workspace';
import { sendPluginAction, uiResult } from '../services/plugin-ui';
import { errorMessage } from '../services/ipc';
import { useErrorNotifications } from '../composables/error-notifications';
import type { PluginApproval, PluginUi, PluginValues } from '../types/plugins';
import Modal from '../components/Modal.vue';
import PluginLog from '../components/PluginLog.vue';
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
    isBuiltinAssistant(plugin.value) &&
    props.contributionId === 'assistant' &&
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
  values = ref<PluginValues>({}),
  output = shallowRef<unknown>(null),
  dirty = ref(false),
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
let dirtyTimer: ReturnType<typeof setTimeout> | undefined;
const logResource = computed(() => {
  const key = page.value?.log?.resourceField;
  return key && typeof values.value[key] === 'string' ? String(values.value[key]) : '';
});
function saveDraft() {
  if (plugin.value)
    plugins.drafts[props.tabKey] = {
      values: { ...values.value },
      output: output.value,
      dirty: dirty.value,
      revision: plugin.value.revision,
    };
}
async function bind() {
  if (!props.active || !available.value || disposed.value) return;
  contextReady.value = false;
  const ticket = ++generation;
  await plugins.bind(
    props.pluginId,
    props.hostId
      ? {
          hostId: props.hostId,
          opsSession:
            operations.value?.state === 'connected' ? (operations.value.session?.id ?? null) : null,
          fileSession:
            connection.value?.state === 'connected' ? (connection.value.id ?? null) : null,
        }
      : null,
    props.tabKey,
  );
  if (
    !disposed.value &&
    props.active &&
    ticket === generation &&
    plugins.owns(props.pluginId, props.tabKey)
  ) {
    contextReady.value =
      !props.hostId ||
      !needsConnection.value ||
      page.value?.surface?.kind === 'tool' ||
      operations.value?.state === 'connected';
    if (contextReady.value && page.value?.surface) frameOpened.value = true;
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
    if (!selected) throw { message: '插件贡献页面不存在' };
    const draft = plugins.drafts[props.tabKey];
    values.value = Object.fromEntries(selected.fields.map((f) => [f.id, f.default]));
    if (draft?.revision === plugin.value.revision) {
      values.value = { ...values.value, ...draft.values };
      output.value = draft.output;
      dirty.value = draft.dirty;
    }
    if (props.hostId && !connectionChanged.value) await connect();
    await bind();
    if (selected.initialAction && !draft && (props.hostId || props.contributionId === 'settings'))
      await invoke(selected.initialAction);
  } catch (cause) {
    failed.value = true;
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}
async function invoke(action: string) {
  const selected = page.value;
  if (!selected || busy.value || !plugin.value || !props.active || !contextReady.value) return;
  const definition = selected.actions.find((a) => a.id === action);
  if (definition?.discardDirty && dirty.value && !(await plugins.discard(props.tabKey))) return;
  clearTimeout(dirtyTimer);
  busy.value = true;
  const ticket = generation;
  const frozen = { ...values.value };
  try {
    let reply = await sendPluginAction(props.pluginId, selected, action, frozen);
    if (reply.error?.code === 'PLUGIN_CONFIRMATION_REQUIRED') {
      const approval = reply.result as PluginApproval;
      const target = hosts.catalog?.hosts.find((h) => h.id === approval.hostId);
      const accepted = await plugins.ask(
        plugins.t('插件操作需要单独确认', 'Confirm plugin operation'),
        `${approval.pluginName} ${approval.pluginVersion}\n${target ? `${target.username}@${target.hostname}:${target.port}` : approval.hostId}\n${approval.operation}\n\n${approval.description}\n\n${plugins.t('本次确认 60 秒内有效；超时后请重新点击原操作。', 'This confirmation is valid for 60 seconds. If it expires, start the operation again.')}`,
      );
      await pluginsApi.approve(approval.id, accepted);
      if (!accepted) return;
      reply = await sendPluginAction(props.pluginId, selected, action, frozen);
    }
    if (reply.error) throw reply.error;
    if (disposed.value || ticket !== generation) return;
    const result = uiResult(reply.result);
    if (result.values) values.value = { ...values.value, ...result.values };
    if (result.output !== undefined) output.value = result.output;
    if (result.saved || definition?.discardDirty) {
      dirty.value = false;
    }
    saveDraft();
  } catch (cause) {
    if (!disposed.value) error.value = errorMessage(cause);
  } finally {
    busy.value = false;
    void plugins.refresh(true);
  }
}
function edit(id: string, value: string | boolean) {
  values.value[id] = value;
  const field = page.value?.fields.find((f) => f.id === id);
  if (field?.documentField) {
    dirty.value = true;
    const document = values.value[field.documentField];
    clearTimeout(dirtyTimer);
    if (typeof document === 'string')
      dirtyTimer = setTimeout(() => {
        if (!props.active || !contextReady.value) return;
        void pluginsApi
          .capability(props.pluginId, {
            apiVersion: 1,
            requestId: crypto.randomUUID(),
            operation: { kind: 'file_dirty', documentId: document, dirty: true },
          })
          .then(
            (reply) => {
              if (reply.error) error.value = reply.error.message;
            },
            (cause) => {
              error.value = errorMessage(cause);
            },
          );
      }, 200);
  }
  saveDraft();
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
          plugins.t('重新连接主机？', 'Reconnect host?'),
          plugins.t(
            '旧运维/SFTP 租约将关闭，终端保持连接。',
            'Closes old operations/SFTP leases; terminals remain connected.',
          ),
        ))
      )
        return;
      if (!isBuiltinAssistant(plugin.value)) await plugins.bind(props.pluginId, null);
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
async function cancel() {
  try {
    await pluginsApi.cancel(props.pluginId);
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
      saveDraft();
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
        clearTimeout(dirtyTimer);
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
  clearTimeout(dirtyTimer);
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
      <h1>{{ schema ? plugins.label(schema.title) : plugin?.manifest.name }}</h1>
      <button class="button" aria-label="插件设置" @click="emit('settings')">
        <Settings2 :size="15" aria-hidden="true" />插件设置
      </button>
    </header>
    <label
      v-if="
        !settingsPage &&
        (plugin?.manifest.contributions.filter((entry) => entry.kind !== 'settings').length ?? 0) >
          1
      "
      class="plugin-contribution-select"
    >
      插件页面<select
        :value="contributionId"
        aria-label="插件页面"
        @change="emit('contribution', ($event.target as HTMLSelectElement).value)"
      >
        <option
          v-for="entry in plugin?.manifest.contributions.filter(
            (entry) => entry.kind !== 'settings',
          )"
          :key="entry.id"
          :value="entry.id"
        >
          {{ entry.label }}
        </option>
      </select>
    </label>
    <p v-if="!available" class="host-empty">此插件尚未启用或授权，请在插件设置中配置。</p>
    <div
      v-else-if="
        hostId && needsConnection && (connectionChanged || operations?.state !== 'connected')
      "
      class="plugin-context action-row"
    >
      <span>{{
        connectionChanged
          ? '主机配置已更新，请重新连接以使用新配置。'
          : operations?.state === 'failed'
            ? '主机连接失败'
            : '正在连接当前主机…'
      }}</span>
      <button class="button" :disabled="busy" @click="connect">
        {{ connectionChanged ? '重新连接' : '重试连接' }}
      </button>
    </div>
    <p v-if="available && loading" role="status">
      {{ plugins.t('正在加载插件…', 'Loading plugin…') }}
    </p>
    <div v-else-if="available && (failed || runtime?.state === 'crashed')" class="host-empty">
      <p>{{ plugins.t('插件暂不可用', 'Plugin unavailable') }} {{ runtime?.errorCode ?? '' }}</p>
      <button class="button" @click="restart">{{ plugins.t('重新激活', 'Restart') }}</button>
    </div>
    <template v-else-if="available && page"
      ><h2 v-if="!page.surface">{{ plugins.label(page.title) }}</h2>
      <template v-if="page.surface">
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
          正在准备插件，请稍候…
        </p>
      </template>
      <form v-else class="plugin-form" @submit.prevent>
        <label
          v-for="field in page.fields"
          :key="field.id"
          :class="{ 'checkbox-label': field.kind === 'checkbox' }"
          ><span>{{ plugins.label(field.label) }}</span
          ><input
            v-if="field.kind === 'checkbox'"
            type="checkbox"
            :checked="values[field.id] === true"
            :disabled="busy || field.readonly"
            @change="edit(field.id, ($event.target as HTMLInputElement).checked)" /><textarea
            v-else-if="field.kind === 'textarea'"
            :value="String(values[field.id] ?? '')"
            :readonly="
              field.readonly ||
              (!!field.documentField && !grant?.permissions.includes('sftp.write'))
            "
            :disabled="busy"
            maxlength="32768"
            rows="14"
            spellcheck="false"
            @input="edit(field.id, ($event.target as HTMLTextAreaElement).value)" /><input
            v-else
            :value="String(values[field.id] ?? '')"
            :readonly="field.readonly"
            :disabled="busy"
            maxlength="32768"
            @input="edit(field.id, ($event.target as HTMLInputElement).value)"
        /></label>
        <div class="action-row">
          <button
            v-for="action in page.actions"
            :key="action.id"
            class="button"
            :disabled="busy || (!!action.enabledWhen && values[action.enabledWhen] !== true)"
            @click="invoke(action.id)"
          >
            {{ plugins.label(action.label) }}</button
          ><button v-if="busy" class="button danger" @click="cancel">
            {{ plugins.t('取消调用', 'Cancel call') }}</button
          ><span v-if="dirty" class="subtle">{{
            plugins.t('有未保存编辑', 'Unsaved changes')
          }}</span>
        </div>
      </form>
      <pre v-if="output !== null" class="plugin-output">{{
        typeof output === 'string' ? output : JSON.stringify(output, null, 2)
      }}</pre>
      <PluginLog
        v-if="active && contextReady && page.log && logResource"
        :key="logResource"
        :plugin-id="pluginId"
        :resource="logResource"
    /></template>
    <Modal
      v-if="active && trust"
      :title="plugins.t('核验 SSH 主机指纹', 'Verify SSH host key')"
      @close="acceptTrust(false)"
      ><p>{{ trust.hostname }}:{{ trust.port }} · {{ trust.algorithm }}</p>
      <code class="fingerprint">{{ trust.fingerprint }}</code>
      <footer class="action-row">
        <button class="button" @click="acceptTrust(false)">{{ plugins.t('拒绝', 'Reject') }}</button
        ><button class="button primary" @click="acceptTrust(true)">
          {{ plugins.t('已核对，信任并连接', 'Verified, trust and connect') }}
        </button>
      </footer></Modal
    >
  </section>
</template>
