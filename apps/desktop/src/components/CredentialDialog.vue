<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import Modal from './Modal.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import type { Credential, CredentialInput } from '../types/hosts';
const props = defineProps<{ credential?: Credential }>();
const emit = defineEmits<{ close: []; saved: [id: string] }>();
const store = useHostsStore();
const draft = reactive<CredentialInput>({
  name: props.credential?.name ?? '',
  kind: props.credential?.kind ?? 'password',
  keyPath: null,
  secret: null,
  clearSecret: false,
});
const secret = ref('');
const keyFile = shallowRef<File | null>(null);
const legacyKey = computed(
  () => draft.kind === 'private_key' && !!props.credential?.keyPath && !keyFile.value,
);
watch(secret, (value) => {
  if (value) draft.clearSecret = false;
});
function selectKey(event: Event): void {
  const field = event.target as HTMLInputElement;
  const file = field.files?.[0] ?? null;
  field.setCustomValidity(
    file && (file.size === 0 || file.size > 1024 * 1024) ? '私钥文件须为 1 字节至 1 MiB' : '',
  );
  keyFile.value = file;
  secret.value = '';
  draft.clearSecret = false;
}
async function submit(): Promise<void> {
  const file = keyFile.value;
  const input: CredentialInput = {
    ...draft,
    secret: secret.value || null,
  };
  try {
    const result = await store.run(async () => {
      if (file) input.keyData = await file.text();
      return hostsApi.credentialSave(
        props.credential?.id ?? null,
        props.credential?.revision ?? null,
        input,
      );
    }, '凭据已保存。');
    if (result.ok) emit('saved', result.value.value.id);
  } finally {
    secret.value = '';
    input.secret = null;
    input.keyData = null;
  }
}
onBeforeUnmount(() => {
  secret.value = '';
});
</script>
<template>
  <Modal :title="credential ? '编辑凭据' : '新建凭据'" :busy="store.busy" @close="emit('close')">
    <form class="editor-form" @submit.prevent="submit">
      <p class="subtle">密码和导入的私钥保存在系统凭据库。</p>
      <p v-if="credential?.hostCount" class="banner">
        此凭据被 {{ credential.hostCount }} 台主机共享，更新后将影响这些主机。
      </p>

      <fieldset :disabled="store.busy">
        <label>凭据名称<input v-model="draft.name" autofocus maxlength="128" required /></label>
        <label
          >凭据类型<select
            v-model="draft.kind"
            aria-label="凭据类型"
            :disabled="!!credential"
            @change="
              secret = '';
              keyFile = null;
              draft.clearSecret = false;
            "
          >
            <option value="password">SSH 密码</option>
            <option value="private_key">SSH 私钥</option>
          </select></label
        >
        <label v-if="draft.kind === 'private_key'">
          私钥文件
          <input
            type="file"
            aria-label="选择私钥文件"
            aria-describedby="credential-key-help"
            :required="!credential"
            @change="selectKey"
          />
          <span id="credential-key-help" class="subtle">
            {{
              legacyKey
                ? '当前使用旧路径。选择文件可迁移到系统凭据库。'
                : credential && !keyFile
                  ? '已导入私钥。选择文件可替换当前私钥。'
                  : '选择本机的 SSH 私钥文件，最大 1 MiB。加密私钥需要填写口令以完成导入。'
            }}
          </span>
        </label>
        <label v-if="draft.kind === 'password' || keyFile || legacyKey"
          >{{ draft.kind === 'password' ? 'SSH 密码' : '加密私钥口令（可选）'
          }}<input
            v-model="secret"
            type="password"
            autocomplete="new-password"
            :required="draft.kind === 'password' && !credential"
            maxlength="2048"
            :placeholder="credential?.hasSecret && !keyFile ? '已保存，留空保持不变' : ''"
        /></label>
        <label v-if="credential?.hasSecret && legacyKey" class="checkbox-label"
          ><input
            v-model="draft.clearSecret"
            type="checkbox"
            :disabled="!!secret"
          />清除已保存的私钥口令</label
        >
      </fieldset>
      <p v-if="keyFile" class="subtle">
        口令仅用于解锁所选文件。导入完成后，连接会使用系统凭据库中的私钥。
      </p>
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="store.busy" @click="emit('close')">
          取消</button
        ><button class="button primary" type="submit" :disabled="store.busy">
          {{ store.busy ? '保存中…' : '保存凭据' }}
        </button>
      </footer>
    </form>
  </Modal>
</template>
