<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { locale } from '@serverdeck/plugin-sdk/i18n';
import { File, Folder } from '@lucide/vue';
import Modal from './Modal.vue';
import { tr } from '../i18n/messages';
import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
import { useNotificationsStore } from '../stores/notifications';
import { bytes, type FileEntry, type PropertyOperation, type PropertyResult } from '../types/files';

const props = defineProps<{ id: string; hostId?: string; entry: FileEntry }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const notifications = useNotificationsStore();
const current = ref<FileEntry | null>(null);
const loading = ref(false),
  error = ref<string | null>(null),
  status = ref<string | null>(null);
const tab = ref<'general' | 'checksum'>('general');
const mode = ref(''),
  uid = ref(''),
  gid = ref('');
const recursive = ref(false),
  directoryExecute = ref(false),
  confirming = ref(false);
const request = ref<string | null>(null),
  stopping = ref(false);
const calculation = ref<PropertyResult | null>(null),
  checksum = ref<string | null>(null);
const confirmation = ref<HTMLElement>();
let disposed = false;
const editable = computed(
  () => current.value && ['file', 'directory'].includes(current.value.kind),
);
const directory = computed(() => current.value?.kind === 'directory');
const displaySize = computed(
  () => calculation.value?.bytes ?? (directory.value ? null : (current.value?.size ?? null)),
);
const numericMode = computed(() =>
  /^[0-7]{3,4}$/.test(mode.value) ? parseInt(mode.value, 8) : null,
);
const validId = (value: string) => /^\d{1,10}$/.test(value) && Number(value) < 4294967295;
const valid = computed(
  () =>
    (current.value?.permissions === null || numericMode.value !== null) &&
    (current.value?.uid === null || validId(uid.value)) &&
    (current.value?.gid === null || validId(gid.value)),
);
const changed = computed(
  () =>
    !!current.value &&
    (numericMode.value !== current.value.permissions ||
      uid.value !== String(current.value.uid ?? '') ||
      gid.value !== String(current.value.gid ?? '') ||
      recursive.value ||
      directoryExecute.value),
);
const parent = computed(() => props.entry.path.slice(0, props.entry.path.lastIndexOf('/')) || '/');
const permissionRows = [
  { label: '拥有者', bits: [0o400, 0o200, 0o100], special: { label: '设置 UID', bit: 0o4000 } },
  { label: '组', bits: [0o40, 0o20, 0o10], special: { label: '设置 GID', bit: 0o2000 } },
  { label: '其他', bits: [0o4, 0o2, 0o1], special: { label: '粘附位', bit: 0o1000 } },
];
function toggle(bit: number, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  const value = numericMode.value ?? 0;
  mode.value = (checked ? value | bit : value & ~bit).toString(8).padStart(4, '0');
}
async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const entry = await filesApi.properties(props.id, props.entry.path);
    if (disposed) return;
    current.value = entry;
    mode.value = entry.permissions?.toString(8).padStart(4, '0') ?? '';
    uid.value = String(entry.uid ?? '');
    gid.value = String(entry.gid ?? '');
    recursive.value = false;
    directoryExecute.value = false;
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}
async function run(operation: PropertyOperation): Promise<void> {
  if (request.value || loading.value) return;
  const requestId = crypto.randomUUID();
  request.value = requestId;
  error.value = null;
  status.value = null;
  confirming.value = false;
  if (operation.kind === 'size') calculation.value = null;
  if (operation.kind === 'checksum') checksum.value = null;
  try {
    const result = await filesApi.propertyOperation(props.id, {
      requestId,
      path: props.entry.path,
      operation,
    });
    if (operation.kind === 'apply') emit('changed');
    if (disposed) return;
    if (operation.kind === 'size') calculation.value = result;
    if (operation.kind === 'checksum') checksum.value = result.checksum;
    if (operation.kind === 'apply') {
      await load();
      checksum.value = null;
      status.value = tr(
        '已应用 {0} 个项目；跳过 {1} 个链接或特殊文件。',
        result.changed,
        result.skippedLinks,
      );
    }
    if (result.message) error.value = tr(result.message);
  } catch (cause) {
    // A lost reply may follow a committed change. Refresh the original pane too.
    if (operation.kind === 'apply') emit('changed');
    if (!disposed) error.value = errorMessage(cause);
  } finally {
    request.value = null;
  }
}
async function stop(): Promise<void> {
  if (!request.value || stopping.value) return;
  stopping.value = true;
  try {
    await filesApi.propertyCancel(props.id, request.value);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    stopping.value = false;
  }
}
function close(): void {
  if (request.value) {
    void stop();
    return;
  }
  emit('close');
}
async function confirm(): Promise<void> {
  confirming.value = true;
  await nextTick();
  confirmation.value?.scrollIntoView?.({ block: 'nearest' });
}
function apply(): void {
  const entry = current.value;
  if (!entry || !editable.value || !valid.value || !changed.value) return;
  void run({
    kind: 'apply',
    change: {
      expected: entry,
      permissions:
        numericMode.value !== entry.permissions || recursive.value || directoryExecute.value
          ? numericMode.value
          : null,
      uid:
        (recursive.value || uid.value !== String(entry.uid ?? '')) && uid.value !== ''
          ? Number(uid.value)
          : null,
      gid:
        (recursive.value || gid.value !== String(entry.gid ?? '')) && gid.value !== ''
          ? Number(gid.value)
          : null,
      recursive: directory.value && recursive.value,
      directoryExecute: directory.value && directoryExecute.value,
      confirmed: true,
    },
  });
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  if (request.value)
    void filesApi
      .propertyCancel(props.id, request.value)
      .catch((cause) => notifications.push(errorMessage(cause), true));
});
</script>

<template>
  <Modal
    :host-ids="hostId ? [hostId] : undefined"
    :title="`${entry.name} · ${tr('属性')}`"
    panel-class="file-properties-dialog"
    @close="close"
  >
    <div class="property-dialog-content">
      <nav class="property-tabs" :aria-label="tr('属性页')">
        <button class="button" :class="{ primary: tab === 'general' }" @click="tab = 'general'">
          {{ tr('通用') }}
        </button>
        <button class="button" :class="{ primary: tab === 'checksum' }" @click="tab = 'checksum'">
          {{ tr('校验码') }}
        </button>
      </nav>
      <p v-if="loading" role="status">{{ tr('正在读取属性…') }}</p>
      <template v-else-if="current">
        <div v-show="tab === 'general'">
          <div class="property-name">
            <component :is="directory ? Folder : File" :size="32" aria-hidden="true" /><strong>{{
              entry.name
            }}</strong>
          </div>
          <dl class="file-properties">
            <dt>{{ tr('位置') }}</dt>
            <dd>{{ parent }}</dd>
            <dt>{{ tr('大小') }}</dt>
            <dd class="property-size">
              <span
                >{{ directory && !calculation ? tr('未知') : bytes(displaySize)
                }}<span v-if="displaySize !== null">
                  ({{ displaySize.toLocaleString(locale) }} B)</span
                ></span
              >
              <button
                v-if="directory"
                class="button"
                :disabled="!!request"
                @click="run({ kind: 'size' })"
              >
                {{ tr('计算') }}
              </button>
              <span v-if="calculation" class="property-count"
                >{{
                  tr(
                    '{0} 个文件，{1} 个目录；跳过 {2} 个链接或特殊文件。',
                    calculation.files,
                    Math.max(0, calculation.directories - 1),
                    calculation.skippedLinks,
                  )
                }}
                {{ calculation.message ? tr('统计不完整') : '' }}</span
              >
            </dd>
          </dl>
          <fieldset class="property-fields" :disabled="!editable || !!request || confirming">
            <legend>{{ tr('所有者与权限') }}</legend>
            <label
              >{{ tr('拥有者 UID')
              }}<input
                v-model="uid"
                inputmode="numeric"
                :placeholder="tr('未提供')"
                :disabled="current.uid === null"
            /></label>
            <label
              >{{ tr('组 GID')
              }}<input
                v-model="gid"
                inputmode="numeric"
                :placeholder="tr('未提供')"
                :disabled="current.gid === null"
            /></label>
            <fieldset class="permission-fields" :disabled="current.permissions === null">
              <legend>{{ tr('权限') }}</legend>
              <div class="permission-grid">
                <span></span><span>{{ tr('读取') }} R</span><span>{{ tr('写入') }} W</span
                ><span>{{ tr('执行') }} X</span><span></span>
                <template v-for="row in permissionRows" :key="row.label">
                  <span>{{ tr(row.label) }}</span>
                  <label v-for="(bit, index) in row.bits" :key="bit"
                    ><input
                      type="checkbox"
                      :checked="!!((numericMode ?? 0) & bit)"
                      :aria-label="`${tr(row.label)} ${['R', 'W', 'X'][index]}`"
                      @change="toggle(bit, $event)"
                  /></label>
                  <label class="permission-special"
                    ><input
                      type="checkbox"
                      :checked="!!((numericMode ?? 0) & row.special.bit)"
                      @change="toggle(row.special.bit, $event)"
                    />{{ tr(row.special.label) }}</label
                  >
                </template>
              </div>
              <label
                >{{ tr('八进制表示')
                }}<input
                  v-model="mode"
                  class="property-mode"
                  maxlength="4"
                  inputmode="numeric"
                  :aria-invalid="numericMode === null"
                  placeholder="0755"
              /></label>
              <label v-if="directory" class="checkbox-label"
                ><input v-model="directoryExecute" type="checkbox" />{{
                  tr('为目录的读取权限添加对应执行权限')
                }}</label
              >
            </fieldset>
            <label v-if="directory" class="checkbox-label"
              ><input v-model="recursive" type="checkbox" />{{
                tr('递归设置所有者、分组与权限')
              }}</label
            >
          </fieldset>
          <p v-if="!editable" class="hint">
            {{ tr('链接和特殊文件仅展示属性，不修改或跟随目标。') }}
          </p>
        </div>
        <div v-show="tab === 'checksum'" class="property-checksum">
          <p>{{ tr('SHA-256 通过 SFTP 读取文件计算，大文件可能需要较长时间。') }}</p>
          <p v-if="current.kind !== 'file'" class="hint">{{ tr('校验码只适用于普通文件。') }}</p>
          <button
            class="button"
            :disabled="current.kind !== 'file' || !!request"
            @click="run({ kind: 'checksum' })"
          >
            {{ tr('计算 SHA-256') }}
          </button>
          <label v-if="checksum"
            >SHA-256<textarea :value="checksum" readonly rows="3" aria-label="SHA-256" />
          </label>
        </div>
      </template>
      <p v-if="request" role="status">
        {{ stopping ? tr('正在停止并等待收尾…') : tr('正在处理属性…') }}
      </p>
      <p v-if="status" role="status">{{ status }}</p>
      <p v-if="error" role="alert" class="error-text">{{ error }}</p>
      <div v-if="confirming" ref="confirmation" class="property-confirm">
        <p>
          {{ tr('确认修改以下路径的属性？') }} <strong>{{ entry.path }}</strong>
        </p>
        <p>UID: {{ uid || '—' }} · GID: {{ gid || '—' }} · {{ tr('权限') }}: {{ mode || '—' }}</p>
        <p v-if="recursive">
          {{
            tr('将应用到目录及全部子项，跳过链接和特殊文件；中途失败或取消不会回退已完成的修改。')
          }}
        </p>
      </div>
    </div>
    <footer v-if="confirming" class="dialog-actions property-dialog-actions">
      <button class="button" @click="confirming = false">{{ tr('返回') }}</button
      ><button class="button primary" @click="apply">{{ tr('确认应用') }}</button>
    </footer>
    <footer v-else class="dialog-actions property-dialog-actions">
      <button v-if="request" class="button" :disabled="stopping" @click="stop">
        {{ tr('停止') }}
      </button>
      <button v-else class="button" @click="close">{{ tr('关闭') }}</button>
      <button v-if="!current && !loading" class="button" @click="load">{{ tr('重试') }}</button>
      <button
        v-if="tab === 'general' && current"
        class="button primary"
        :disabled="!editable || !valid || !changed || loading || !!request"
        @click="confirm"
      >
        {{ tr('应用') }}
      </button>
    </footer>
  </Modal>
</template>

<style scoped>
.property-tabs,
.property-name {
  display: flex;
  gap: 10px;
  align-items: center;
}
.property-tabs {
  margin-bottom: 8px;
}
.property-name {
  padding: 2px 0 6px;
  overflow-wrap: anywhere;
}
.property-name svg {
  flex-shrink: 0;
  color: var(--accent);
}
.file-properties {
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 4px 10px;
  margin: 8px 0;
}
.property-size {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.property-count {
  flex-basis: 100%;
  font-size: 0.9em;
}
.property-fields,
.permission-fields {
  border: 0;
  padding: 6px 0 0;
  margin: 8px 0 0;
  border-top: 1px solid var(--border);
  min-width: 0;
}
.property-fields > label:not(.checkbox-label),
.permission-fields > label:not(.checkbox-label) {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.property-fields input:not([type='checkbox']) {
  min-width: 0;
  width: 100%;
}
.permission-grid {
  display: grid;
  grid-template-columns: minmax(70px, max-content) repeat(3, minmax(42px, max-content)) minmax(
      0,
      1fr
    );
  gap: 2px 12px;
  align-items: center;
  margin: 4px 0 8px;
}
.permission-grid label {
  display: flex;
  align-items: center;
  margin: 0;
}
.permission-special {
  gap: 6px;
  white-space: nowrap;
}
.checkbox-label {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 4px 0;
}
.property-mode {
  max-width: 100px;
  font-family: monospace;
}
.property-fields input.property-mode {
  width: 100px;
}
.file-properties dd,
.property-name strong,
.property-dialog-content p {
  -webkit-user-select: text;
  user-select: text;
}
.property-checksum {
  min-height: 220px;
}
.property-checksum textarea {
  width: 100%;
  resize: none;
  font-family: monospace;
  margin-top: 8px;
}
.property-confirm {
  border-top: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.property-dialog-content {
  overflow: auto;
  min-height: 0;
  padding: 0 22px 10px;
  line-height: 1.35;
}
.property-dialog-actions {
  flex-shrink: 0;
  margin: 0;
  padding: 10px 22px;
  border-top: 1px solid var(--border);
}
</style>
