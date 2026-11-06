<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { ref } from 'vue';
import { KeyRound, ShieldCheck } from '@lucide/vue';
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
useErrorNotifications(() =>
  status.value && !status.value.available ? status.value.message : null,
);
</script>
<template>
  <section class="credentials-view asset-view page-view" aria-labelledby="credentials-title">
    <div class="section-heading">
      <div>
        <h1 id="credentials-title">安全凭据</h1>
        <p class="section-description">
          集中管理主机认证使用的 SSH 密码与私钥。密码和导入的私钥保存在系统凭据库。
        </p>
      </div>
      <button class="button primary" :disabled="store.busy || !store.catalog" @click="open()">
        ＋ 新建凭据
      </button>
    </div>
    <div class="asset-columns">
      <section class="asset-panel" aria-labelledby="saved-credentials-title">
        <h2 id="saved-credentials-title" class="asset-title">
          已保存凭据
          <span v-if="store.catalog" class="asset-count">{{
            store.catalog.credentials.length
          }}</span>
        </h2>
        <ul v-if="store.catalog?.credentials.length" class="credential-list">
          <li v-for="credential in store.catalog.credentials" :key="credential.id">
            <div class="asset-identity">
              <span class="asset-icon"><KeyRound :size="17" aria-hidden="true" /></span>
              <div>
                <h3>{{ credential.name }}</h3>
                <p class="subtle">
                  {{ credential.kind === 'password' ? 'SSH 密码' : 'SSH 私钥' }} ·
                  {{ credential.hostCount }} 台主机关联
                </p>
              </div>
            </div>
            <div class="toolbar credential-actions">
              <button class="text-button" :disabled="store.busy" @click="open(credential)">
                编辑
              </button>
              <button
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
            <div class="credential-details">
              <p v-if="credential.keyPath" class="path">{{ credential.keyPath }}</p>
              <p class="subtle">
                {{
                  credential.kind === 'private_key' && !credential.keyPath
                    ? '私钥已导入系统凭据库'
                    : credential.hasSecret
                      ? '秘密已保存于系统凭据库'
                      : '未保存口令'
                }}
              </p>
            </div>
          </li>
        </ul>
        <div v-else-if="store.catalog" class="asset-empty">
          <span class="asset-icon"><KeyRound :size="18" aria-hidden="true" /></span>
          <div>
            <h3>尚无安全凭据</h3>
            <p class="subtle">点击“新建凭据”添加主机认证所需的密码或私钥。</p>
          </div>
        </div>
        <p v-else class="subtle" role="status">
          {{ store.busy ? '正在读取凭据…' : '凭据列表暂不可用。' }}
        </p>
      </section>
      <section class="asset-panel" aria-labelledby="credential-store-title">
        <h2 id="credential-store-title" class="asset-title">
          <ShieldCheck :size="16" aria-hidden="true" />系统凭据库
        </h2>
        <p class="subtle">待清理 {{ store.catalog?.pendingSecretDeletions ?? '—' }} 项</p>
        <div class="toolbar">
          <button class="button" :disabled="store.busy" @click="check">检查系统凭据库</button>
          <button
            class="button"
            :disabled="store.busy"
            @click="store.run(hostsApi.cleanup, '清理检查已完成。')"
          >
            重试清理旧秘密
          </button>
        </div>
        <p v-if="status?.available" class="asset-feedback success" role="status">
          {{ status.message }}
        </p>
      </section>
    </div>
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
