<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from 'vue';
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
  keyPath: props.credential?.keyPath ?? '',
  secret: null,
  clearSecret: false,
});
const secret = ref('');
watch(secret, (value) => {
  if (value) draft.clearSecret = false;
});
async function submit(): Promise<void> {
  const input: CredentialInput = {
    ...draft,
    keyPath: draft.kind === 'private_key' ? draft.keyPath : null,
    secret: secret.value || null,
  };
  const result = await store.run(
    () =>
      hostsApi.credentialSave(
        props.credential?.id ?? null,
        props.credential?.revision ?? null,
        input,
      ),
    '凭据已保存。',
  );
  secret.value = '';
  input.secret = null;
  if (result.ok) emit('saved', result.value.value.id);
}
onBeforeUnmount(() => {
  secret.value = '';
});
</script>
<template>
  <Modal :title="credential ? '编辑凭据' : '新建凭据'" :busy="store.busy" @close="emit('close')">
    <form class="editor-form" @submit.prevent="submit">
      <p class="subtle">密码和私钥口令仅写入系统凭据库，保存后无法从此界面回读。</p>
      <p v-if="credential?.hostCount" class="banner">
        此凭据被 {{ credential.hostCount }} 台主机共享，更新后将影响这些主机。
      </p>
      <p v-if="store.error" role="alert" class="banner error">{{ store.error }}</p>
      <fieldset :disabled="store.busy">
        <label>凭据名称<input v-model="draft.name" autofocus maxlength="128" required /></label>
        <label
          >凭据类型<select
            v-model="draft.kind"
            aria-label="凭据类型"
            :disabled="!!credential"
            @change="
              secret = '';
              draft.clearSecret = false;
            "
          >
            <option value="password">SSH 密码</option>
            <option value="private_key">SSH 私钥路径与口令</option>
          </select></label
        >
        <label v-if="draft.kind === 'private_key'"
          >本地私钥路径<input
            v-model="draft.keyPath"
            required
            maxlength="4096"
            placeholder="C:\Users\me\.ssh\id_ed25519 或 ~/.ssh/id_ed25519"
        /></label>
        <label
          >{{ draft.kind === 'password' ? 'SSH 密码' : '加密私钥口令（可选）'
          }}<input
            v-model="secret"
            type="password"
            autocomplete="new-password"
            :required="draft.kind === 'password' && !credential"
            maxlength="2048"
            :placeholder="credential?.hasSecret ? '已保存，留空保持不变' : ''"
        /></label>
        <label v-if="credential?.hasSecret && draft.kind === 'private_key'" class="checkbox-label"
          ><input
            v-model="draft.clearSecret"
            type="checkbox"
            :disabled="!!secret"
          />清除已保存的私钥口令</label
        >
      </fieldset>
      <p class="subtle">
        只保存私钥文件路径，不复制或读取私钥正文。系统凭据库不可用时，秘密保存会明确失败。
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
