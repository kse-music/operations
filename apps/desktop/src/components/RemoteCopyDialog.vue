<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import Modal from './Modal.vue';
import RemoteDirectorySelect from './RemoteDirectorySelect.vue';
import { tr } from '../i18n/messages';
import { useFilesStore } from '../stores/files';
import { useHostsStore, filterHosts } from '../stores/hosts';
import { hostDisplayName, type Host } from '../types/hosts';
import { errorMessage } from '../services/ipc';
import {
  remoteJoin,
  remoteDirectoryLocations,
  type TransferInfo,
  type RemoteCopyInput,
} from '../types/files';

const props = defineProps<{
  sessionId: string;
  sourceHostId: string;
  host: string;
  sources: string[];
  directory: string;
  retry?: TransferInfo;
}>();
const emit = defineEmits<{ close: []; started: [task: TransferInfo] }>();
const store = useFilesStore();
const hosts = useHostsStore();
const fieldId = useId();
const targetHostId = ref(
  props.retry?.remoteTargetHostId ?? (props.retry ? props.sourceHostId : ''),
);
const targetSessionId = ref<string | null>(null);
const destination = ref(props.retry ? props.directory : '');
const availableHosts = computed(() => filterHosts(hosts.catalog?.hosts ?? [], ''));
const targetConnection = computed(() => store.connections[targetHostId.value]);
const connecting = computed(
  () =>
    !!targetConnection.value?.loading ||
    ['opening', 'connecting', 'authenticating', 'awaiting_trust'].includes(
      targetConnection.value?.state ?? '',
    ),
);
const targetReady = computed(
  () =>
    !!targetHostId.value &&
    targetConnection.value?.id === targetSessionId.value &&
    targetConnection.value.state === 'connected' &&
    !targetConnection.value.loading &&
    !targetConnection.value.switchingUser &&
    !store.closingHosts.includes(targetHostId.value),
);
function targetLabel(host: Host): string {
  const connection = store.connections[host.id];
  return `${hostDisplayName(host)} · ${connection?.username ?? host.username}@${host.hostname}${host.port === 22 ? '' : `:${host.port}`}`;
}
async function selectTarget(): Promise<void> {
  targetSessionId.value = null;
  destination.value = '';
  error.value = null;
  bindTarget();
  await connectTarget();
}
function bindTarget(): void {
  const connection = targetConnection.value;
  if (connection?.id && connection.state === 'connected' && !connection.switchingUser) {
    if (!targetSessionId.value) targetSessionId.value = connection.id;
  }
}
watch(
  () => [
    targetConnection.value?.id,
    targetConnection.value?.state,
    targetConnection.value?.switchingUser,
  ],
  bindTarget,
);
async function connectTarget(): Promise<void> {
  const host = availableHosts.value.find((host) => host.id === targetHostId.value);
  if (
    !host ||
    targetReady.value ||
    connecting.value ||
    busy.value ||
    store.closingHosts.includes(host.id)
  )
    return;
  targetSessionId.value = null;
  if (!props.retry) destination.value = '';
  error.value = null;
  try {
    await store.open(host, undefined, undefined, { background: true });
    if (!disposed && targetHostId.value === host.id) bindTarget();
  } catch (cause) {
    if (!disposed && targetHostId.value === host.id) error.value = errorMessage(cause);
  }
}
const name = ref(props.retry?.remoteName ?? props.sources[0]?.split('/').at(-1) ?? '');
const conflict = ref<RemoteCopyInput['conflict']>(props.retry ? 'skip' : 'fail');
const confirmedOverwrite = ref(false),
  busy = ref(false),
  error = ref<string | null>(null);
let disposed = false;
const issue = computed(() => {
  if (!targetHostId.value) return tr('请选择目标主机。');
  if (!targetReady.value) return tr('目标连接尚未就绪。');
  if (!remoteDirectoryLocations(destination.value).length) return tr('请选择目标目录。');
  try {
    for (const source of props.sources) {
      const target = remoteJoin(
        destination.value,
        props.sources.length === 1 ? name.value : (source.split('/').at(-1) ?? ''),
      );
      if (
        targetHostId.value === props.sourceHostId &&
        props.sources.some(
          (original) =>
            original === target ||
            target.startsWith(`${original}/`) ||
            original.startsWith(`${target}/`),
        )
      )
        return tr('目标不能与源相同，或位于源项目的内部、祖先路径。');
    }
  } catch (cause) {
    return errorMessage(cause);
  }
  return null;
});
async function submit(): Promise<void> {
  if (busy.value || issue.value || (conflict.value === 'overwrite' && !confirmedOverwrite.value))
    return;
  busy.value = true;
  error.value = null;
  try {
    const task = await store.startRemoteCopy({
      sessionId: props.sessionId,
      targetSessionId: targetSessionId.value,
      sources: [...props.sources],
      destination: destination.value,
      name: props.sources.length === 1 ? name.value : null,
      conflict: conflict.value,
      confirmed: true,
      confirmOverwrite: confirmedOverwrite.value,
    });
    emit('started', task);
    if (!disposed) emit('close');
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
onBeforeUnmount(() => {
  disposed = true;
});
onMounted(async () => {
  if (!hosts.catalog && !hosts.busy) await hosts.load();
  if (disposed) return;
  bindTarget();
  await connectTarget();
});
</script>

<template>
  <Modal
    :title="tr('远程复制')"
    :host-ids="[sourceHostId, targetHostId]"
    panel-class="remote-copy-dialog"
    :busy="busy"
    @close="emit('close')"
  >
    <form class="remote-copy" @submit.prevent="submit">
      <p class="subtle">{{ host }} · {{ tr('{0} 个选中项目', sources.length) }}</p>
      <pre class="file-path-preview">{{ sources.join('\n') }}</pre>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <div class="remote-copy-field">
        <label :for="`${fieldId}-host`">{{ tr('目标主机') }}</label>
        <select
          :id="`${fieldId}-host`"
          v-model="targetHostId"
          :disabled="busy || hosts.busy || !!retry"
          :aria-busy="connecting"
          @change="selectTarget"
        >
          <option value="" disabled>{{ tr('请选择目标主机') }}</option>
          <option
            v-for="target in availableHosts"
            :key="target.id"
            :value="target.id"
            :disabled="store.closingHosts.includes(target.id)"
          >
            {{ targetLabel(target) }}
          </option>
        </select>
      </div>
      <p v-if="connecting" class="hint" role="status">{{ tr('连接中') }}…</p>
      <p v-if="hosts.busy" role="status">{{ tr('正在读取主机…') }}</p>
      <p v-else-if="!availableHosts.length" class="hint">
        {{ tr('暂无可用主机，请先添加主机。') }}
      </p>
      <p v-if="hosts.error" class="error-text" role="alert">
        {{ hosts.error }}
        <button class="button" type="button" @click="hosts.load">{{ tr('重试') }}</button>
      </p>
      <div v-if="targetConnection?.trust" class="target-trust">
        <p>
          {{ tr('确认目标主机指纹') }} · {{ targetConnection.trust.hostname }}:{{
            targetConnection.trust.port
          }}
          · {{ targetConnection.trust.algorithm }}
        </p>
        <code class="fingerprint">{{ targetConnection.trust.fingerprint }}</code>
        <p class="hint">
          {{ tr('请从服务器控制台或其他可信渠道核对后再继续；不会在确认前发送认证信息。') }}
        </p>
        <div class="dialog-actions">
          <button class="button" type="button" @click="store.trust(false, targetConnection)">
            {{ tr('拒绝连接') }}</button
          ><button
            class="button primary"
            type="button"
            @click="store.trust(true, targetConnection)"
          >
            {{ tr('已核对，信任并连接') }}
          </button>
        </div>
      </div>
      <div v-if="targetConnection?.error" class="error-text connection-error" role="alert">
        <span>{{ targetConnection.error }}</span>
        <button class="button" type="button" :disabled="busy || connecting" @click="connectTarget">
          {{ tr('重试') }}
        </button>
      </div>
      <div class="remote-copy-field">
        <label :for="`${fieldId}-destination`">{{ tr('目标目录') }}</label>
        <RemoteDirectorySelect
          :id="`${fieldId}-destination`"
          :key="targetSessionId ?? targetHostId"
          v-model="destination"
          :session-id="targetSessionId ?? ''"
          :disabled="busy || !!retry || !targetReady"
        />
      </div>
      <label v-if="sources.length === 1"
        >{{ tr('目标名称')
        }}<input v-model="name" :readonly="busy || !!retry" required spellcheck="false"
      /></label>
      <label
        >{{ tr('同名项目')
        }}<select v-model="conflict" :disabled="busy">
          <option value="fail">{{ tr('停止并提示冲突') }}</option>
          <option value="skip">{{ tr('跳过同名项目') }}</option>
          <option value="overwrite">{{ tr('覆盖文件，复制目录时合并') }}</option>
        </select></label
      >
      <label v-if="conflict === 'overwrite'" class="checkbox-label"
        ><input v-model="confirmedOverwrite" type="checkbox" :disabled="busy" />{{
          tr('确认覆盖已有普通文件；复制目录按内容合并。')
        }}</label
      >
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="busy" @click="emit('close')">
          {{ tr('取消') }}
        </button>
        <button
          class="button primary"
          :disabled="busy || !!issue || (conflict === 'overwrite' && !confirmedOverwrite)"
          :title="issue ?? undefined"
        >
          {{ busy ? tr('正在提交…') : tr('确认') }}
        </button>
      </footer>
    </form>
  </Modal>
</template>

<style scoped>
:global(.modal.remote-copy-dialog) {
  padding: 20px;
}
:global(.remote-copy-dialog .modal-heading) {
  margin-bottom: 14px;
}
.remote-copy {
  display: grid;
  gap: 8px;
}
.remote-copy > label:not(.checkbox-label),
.remote-copy-field {
  display: grid;
  grid-template-columns: calc(90px * var(--interface-font-scale, 1)) minmax(0, 1fr);
  gap: 8px;
  align-items: center;
}
.remote-copy input:not([type='checkbox']),
.remote-copy select {
  width: 100%;
  min-width: 0;
}
.remote-copy .file-path-preview {
  max-height: 88px;
  margin: 0;
  padding: 8px 10px;
}
.remote-copy p {
  margin: 0;
}
.remote-copy .dialog-actions {
  margin-top: 4px;
  padding-top: 12px;
}
.checkbox-label {
  display: flex;
  gap: 8px;
  align-items: center;
}
.hint {
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.connection-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.target-trust {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--control-radius);
  overflow-wrap: anywhere;
}
</style>
