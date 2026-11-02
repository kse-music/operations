<script setup lang="ts">
import { ref } from 'vue';
import CredentialDialog from '../components/CredentialDialog.vue';
import Modal from '../components/Modal.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import type { Credential, SecureStatus } from '../types/hosts';
const store = useHostsStore();
const dialog = ref(false);
const editing = ref<Credential>();
const deleting = ref<Credential | null>(null);
const detach = ref(false);
const status = ref<SecureStatus | null>(null);
function open(credential?: Credential): void {
  editing.value = credential;
  dialog.value = true;
}
async function check(): Promise<void> {
  const result = await store.run(hostsApi.status);
  if (result.ok) status.value = result.value;
}
async function remove(): Promise<void> {
  if (!deleting.value) return;
  const id = deleting.value.id;
  const result = await store.run(
    () => hostsApi.credentialRemove(id, detach.value),
    '凭据引用已删除。',
  );
  if (result.ok) deleting.value = null;
}
</script>
<template>
  <section class="credentials-view page-view">
    <div class="section-heading">
      <div>
        <p class="eyebrow">SYSTEM CREDENTIAL STORE</p>
        <h1>安全凭据</h1>
      </div>
      <button class="button primary" :disabled="store.busy || !store.catalog" @click="open()">
        ＋ 新建凭据
      </button>
    </div>
    <p class="section-description">
      密码和私钥口令保存在系统凭据库，主机仅引用凭据 ID。此界面不会显示已保存秘密。
    </p>
    <div class="toolbar">
      <button class="button" :disabled="store.busy" @click="check">检查系统凭据库</button
      ><button
        class="button"
        :disabled="store.busy"
        @click="store.run(hostsApi.cleanup, '清理检查已完成。')"
      >
        重试清理旧秘密</button
      ><span class="subtle">待清理 {{ store.catalog?.pendingSecretDeletions ?? '—' }} 项</span>
    </div>
    <p v-if="status" :class="['banner', status.available ? 'success' : 'error']" role="status">
      {{ status.message }}
    </p>
    <p v-if="store.catalog && !store.catalog.credentials.length" class="workspace-empty">
      尚无安全凭据。系统 SSH Agent 不需要创建凭据。
    </p>
    <ul class="credential-list">
      <li v-for="credential in store.catalog?.credentials" :key="credential.id">
        <div>
          <h2>{{ credential.name }}</h2>
          <p class="subtle">
            {{ credential.kind === 'password' ? 'SSH 密码' : 'SSH 私钥' }} ·
            {{ credential.hostCount }} 台主机关联 ·
            {{ credential.hasSecret ? '秘密已保存于系统凭据库' : '未保存口令' }}
          </p>
          <p v-if="credential.keyPath" class="path">{{ credential.keyPath }}</p>
        </div>
        <div class="toolbar">
          <button class="text-button" :disabled="store.busy" @click="open(credential)">编辑</button
          ><button
            class="text-button danger"
            :disabled="store.busy"
            @click="
              deleting = credential;
              detach = false;
            "
          >
            删除
          </button>
        </div>
      </li>
    </ul>
    <section class="system-panel">
      <h2>系统 SSH Agent</h2>
      <p class="subtle">
        在主机表单选择“系统 SSH Agent”，无需保存密码。此阶段仅提供认证入口，不启动
        Agent、不连接服务器。
      </p>
    </section>
  </section>
  <CredentialDialog
    v-if="dialog"
    :credential="editing"
    @close="dialog = false"
    @saved="dialog = false"
  />
  <Modal v-if="deleting" title="确认删除凭据" :busy="store.busy" @close="deleting = null"
    ><p>删除“{{ deleting.name }}”的凭据引用及系统保存的秘密？</p>
    <label v-if="deleting.hostCount" class="checkbox-label"
      ><input v-model="detach" type="checkbox" />同时解除
      {{ deleting.hostCount }} 台主机的关联；主机配置保留，连接前需重新绑定凭据。</label
    >
    <p class="subtle">系统凭据库不可用时，旧秘密会标记为待清理，并明确提示。</p>
    <p v-if="store.error" class="banner error" role="alert">{{ store.error }}</p>
    <footer class="dialog-actions">
      <button class="button" :disabled="store.busy" @click="deleting = null">取消</button
      ><button
        class="button danger"
        :disabled="store.busy || !!(deleting.hostCount && !detach)"
        @click="remove"
      >
        确认删除凭据
      </button>
    </footer></Modal
  >
</template>
