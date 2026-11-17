<script setup lang="ts">
import { computed, ref } from 'vue';
import Modal from './Modal.vue';
import { tr } from '../i18n/messages';
import type { NewDirectoryInput, NewDirectorySettings } from '../types/files';

const props = defineProps<{
  settings?: NewDirectorySettings;
  busy: boolean;
  error: string | null;
}>();
const emit = defineEmits<{ close: []; submit: [input: NewDirectoryInput] }>();
const name = ref('');
const setPermissions = ref(props.settings?.permissions != null);
const mode = ref((props.settings?.permissions ?? 0o755).toString(8).padStart(4, '0'));
const remember = ref(!!props.settings);
const help = ref(false);
const numericMode = computed(() =>
  /^[0-7]{3,4}$/.test(mode.value) ? parseInt(mode.value, 8) : null,
);
const valid = computed(
  () =>
    !!name.value.trim() &&
    !['.', '..'].includes(name.value) &&
    !name.value.includes('/') &&
    !name.value.includes('\0') &&
    (!setPermissions.value || numericMode.value !== null),
);
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
function submit(): void {
  if (props.busy || !valid.value) return;
  emit('submit', {
    name: name.value,
    permissions: setPermissions.value ? numericMode.value : null,
    remember: remember.value,
  });
}
</script>

<template>
  <Modal
    :title="tr('创建文件夹')"
    panel-class="new-directory-dialog"
    :busy="busy"
    @close="emit('close')"
  >
    <form class="editor-form new-directory-form" @submit.prevent="submit">
      <label>
        {{ tr('新文件夹名') }}
        <input v-model="name" autofocus required maxlength="255" :disabled="busy" />
      </label>
      <fieldset class="directory-attributes" :disabled="busy">
        <legend>{{ tr('属性') }}</legend>
        <label class="checkbox-label">
          <input v-model="setPermissions" type="checkbox" />{{ tr('设置权限') }}
        </label>
        <fieldset class="directory-permissions" :disabled="!setPermissions">
          <div class="directory-permission-grid">
            <template v-for="row in permissionRows" :key="row.label">
              <span>{{ tr(row.label) }}</span>
              <label v-for="(bit, index) in row.bits" :key="bit">
                <input
                  type="checkbox"
                  :checked="!!((numericMode ?? 0) & bit)"
                  :aria-label="`${tr(row.label)} ${['R', 'W', 'X'][index]}`"
                  @change="toggle(bit, $event)"
                />{{ ['R', 'W', 'X'][index] }}
              </label>
              <label>
                <input
                  type="checkbox"
                  :checked="!!((numericMode ?? 0) & row.special.bit)"
                  @change="toggle(row.special.bit, $event)"
                />{{ tr(row.special.label) }}
              </label>
            </template>
          </div>
          <label class="directory-mode">
            {{ tr('八进制表示') }}
            <input
              v-model="mode"
              maxlength="4"
              inputmode="numeric"
              :aria-invalid="numericMode === null"
              aria-describedby="directory-mode-error"
            />
          </label>
        </fieldset>
        <p
          v-if="setPermissions && numericMode === null"
          id="directory-mode-error"
          class="error-text"
          role="alert"
        >
          {{ tr('请输入三位或四位八进制权限（0000–7777）。') }}
        </p>
        <label class="checkbox-label directory-remember">
          <input v-model="remember" type="checkbox" />{{ tr('下次使用相同的设置') }}
        </label>
      </fieldset>
      <div v-if="help" id="new-directory-help" class="hint directory-help">
        <p>
          {{
            tr(
              'R/W/X 分别表示读取、写入和执行。特殊权限位和最终创建权限受服务器支持、umask 及策略约束。',
            )
          }}
        </p>
        <p>{{ tr('相同设置仅在当前 SFTP 会话内记住，切换用户或重新连接后恢复默认。') }}</p>
      </div>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <footer class="dialog-actions">
        <button class="button primary" type="submit" :disabled="busy || !valid">
          {{ busy ? tr('正在创建…') : tr('确定') }}
        </button>
        <button class="button" type="button" :disabled="busy" @click="emit('close')">
          {{ tr('取消') }}
        </button>
        <button
          class="button"
          type="button"
          :aria-expanded="help"
          aria-controls="new-directory-help"
          @click="help = !help"
        >
          {{ tr('帮助') }}
        </button>
      </footer>
    </form>
  </Modal>
</template>

<style scoped>
.new-directory-form {
  gap: 14px;
  margin-top: 0;
}
.new-directory-form .directory-attributes {
  border: 1px solid var(--border);
  padding: 6px 14px 12px;
  gap: 10px;
  min-width: 0;
}
.directory-attributes legend {
  padding: 0 6px;
}
.new-directory-form .directory-permissions {
  gap: 8px;
  min-width: 0;
}
.directory-permissions:disabled {
  opacity: 0.5;
}
.directory-permission-grid {
  display: grid;
  grid-template-columns: max-content repeat(3, minmax(36px, max-content)) minmax(0, 1fr);
  gap: 8px 12px;
  align-items: center;
}
.directory-permission-grid label,
.new-directory-form .directory-mode {
  flex-direction: row;
  align-items: center;
  gap: 5px;
}
.directory-permission-grid label {
  white-space: nowrap;
}
.directory-permission-grid input {
  margin: 0;
  accent-color: var(--accent);
}
.directory-mode input {
  width: 100px;
  flex: 0 0 100px;
  min-width: 0;
  font-family: monospace;
}
.new-directory-form .directory-mode {
  white-space: nowrap;
}
.new-directory-form .directory-remember {
  margin-top: 6px;
}
.directory-help p,
.directory-attributes p {
  margin: 0;
}
.directory-help p + p {
  margin-top: 6px;
}
.new-directory-form .dialog-actions {
  margin-top: 0;
  padding-top: 0;
  border: 0;
  gap: 10px;
}
.dialog-actions .button {
  min-width: 86px;
}
@media (max-width: 520px) {
  .directory-permission-grid {
    gap: 8px 6px;
    grid-template-columns: max-content repeat(3, max-content) minmax(0, 1fr);
  }
}
</style>
