<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import Modal from './Modal.vue';
import CredentialDialog from './CredentialDialog.vue';
import { useApplicationStore } from '../stores/application';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import { hostInput, type Host } from '../types/hosts';
const props = defineProps<{ host?: Host }>();
const emit = defineEmits<{ close: [] }>();
const store = useHostsStore();
const application = useApplicationStore();
const draft = reactive(hostInput(props.host, application.state?.config.connectTimeoutSecs));
if (!props.host && application.state?.config.product)
  draft.ssh = JSON.parse(
    JSON.stringify(application.state.config.product.sshDefaults),
  ) as typeof draft.ssh;
const tags = ref(draft.tags.join(', '));
const newCredential = ref(false);
const proxyMode = computed({
  get: () => draft.ssh.proxy?.kind ?? 'direct',
  set: (kind: 'direct' | 'socks5' | 'http_connect') => {
    draft.ssh.proxy =
      kind === 'direct'
        ? null
        : {
            kind,
            hostname: draft.ssh.proxy?.hostname ?? '127.0.0.1',
            port: draft.ssh.proxy?.port ?? (kind === 'socks5' ? 1080 : 8080),
            username: draft.ssh.proxy?.username ?? null,
            credentialId: draft.ssh.proxy?.credentialId ?? null,
          };
  },
});
const credentials = computed(
  () => store.catalog?.credentials.filter((c) => c.kind === draft.authType) ?? [],
);
watch(
  () => draft.authType,
  () => {
    draft.credentialId = null;
  },
);
async function submit(): Promise<void> {
  const input = {
    ...draft,
    tags: tags.value
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean),
  };
  const result = await store.run(
    () => (props.host ? hostsApi.update(props.host.id, input) : hostsApi.create(input)),
    props.host ? '主机已更新。' : '主机已创建。',
  );
  if (result.ok) {
    store.selectedId = result.value.id;
    emit('close');
  }
}
function credentialSaved(id: string): void {
  draft.credentialId = id;
  newCredential.value = false;
}
</script>
<template>
  <Modal :title="host ? '编辑主机' : '新建主机'" :busy="store.busy" @close="emit('close')">
    <form class="editor-form" @submit.prevent="submit">
      <p v-if="store.error" class="banner error" role="alert">{{ store.error }}</p>
      <fieldset class="form-grid" :disabled="store.busy">
        <label>主机名称<input v-model="draft.name" autofocus required maxlength="128" /></label>
        <label
          >地址（IP / 域名）<input
            v-model="draft.hostname"
            required
            maxlength="253"
            placeholder="192.0.2.10 / server.example.com"
        /></label>
        <label
          >SSH 端口<input
            v-model.number="draft.port"
            type="number"
            min="1"
            max="65535"
            step="1"
            required
        /></label>
        <label
          >用户名<input v-model="draft.username" required maxlength="128" autocomplete="off"
        /></label>
        <label
          >认证方式<select v-model="draft.authType" aria-label="认证方式">
            <option value="agent">系统 SSH Agent</option>
            <option value="password">SSH 密码</option>
            <option value="private_key">SSH 私钥</option>
          </select></label
        >
        <label
          >连接超时（秒）<input
            v-model.number="draft.connectTimeoutSecs"
            type="number"
            min="1"
            max="120"
            step="1"
            required
        /></label>
        <div v-if="draft.authType !== 'agent'" class="full-width">
          <label
            >安全凭据引用<select v-model="draft.credentialId" aria-label="安全凭据引用">
              <option :value="null">暂不关联（后续连接前需补充）</option>
              <option v-for="credential in credentials" :key="credential.id" :value="credential.id">
                {{ credential.name }}
              </option>
            </select></label
          >
          <button type="button" class="text-button" @click="newCredential = true">
            ＋ 新建安全凭据
          </button>
        </div>
        <p v-else class="subtle full-width">
          使用系统 SSH Agent，请预先启动 Agent 并加载密钥。不会转发
          Agent，也不会自动回退其他认证方式。
        </p>
        <label
          >分组<select v-model="draft.groupId" aria-label="分组">
            <option :value="null">未分组</option>
            <option v-for="group in store.catalog?.groups" :key="group.id" :value="group.id">
              {{ group.name }}
            </option>
          </select></label
        >
        <label
          >标签（逗号分隔）<input v-model="tags" maxlength="2048" placeholder="生产, Linux"
        /></label>
        <label class="full-width"
          >备注<textarea v-model="draft.description" rows="3" maxlength="8192"></textarea>
        </label>
        <label class="checkbox-label"
          ><input v-model="draft.favorite" type="checkbox" />收藏此主机</label
        >
        <details class="full-width">
          <summary>SSH 高级连接设置</summary>
          <div class="form-grid">
            <label
              >认证超时（秒）<input
                v-model.number="draft.ssh.authTimeoutSecs"
                type="number"
                min="1"
                max="120"
                required
            /></label>
            <label
              >Keepalive 间隔（秒）<input
                v-model.number="draft.ssh.keepaliveIntervalSecs"
                type="number"
                min="1"
                max="3600"
                required
            /></label>
            <label
              >Keepalive 失败次数<input
                v-model.number="draft.ssh.keepaliveCountMax"
                type="number"
                min="1"
                max="10"
                required
            /></label>
            <label
              >ProxyJump 跳板主机<select v-model="draft.ssh.jumpHostId" aria-label="跳板主机">
                <option :value="null">不使用跳板</option>
                <option
                  v-for="item in store.catalog?.hosts.filter((h) => h.id !== host?.id)"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.name }} · {{ item.username }}@{{ item.hostname }}
                </option>
              </select></label
            >
            <label
              >网络代理<select v-model="proxyMode" aria-label="网络代理">
                <option value="direct">不使用代理</option>
                <option value="socks5">SOCKS5</option>
                <option value="http_connect">HTTP CONNECT</option>
              </select></label
            >
            <template v-if="draft.ssh.proxy"
              ><label
                >代理地址<input
                  v-model="draft.ssh.proxy.hostname"
                  aria-label="代理地址"
                  required
                  maxlength="253" /></label
              ><label
                >代理端口<input
                  v-model.number="draft.ssh.proxy.port"
                  type="number"
                  min="1"
                  max="65535"
                  required /></label
              ><label
                >代理用户名（可选）<input
                  :value="draft.ssh.proxy.username ?? ''"
                  maxlength="128"
                  @input="
                    draft.ssh.proxy.username = ($event.target as HTMLInputElement).value || null
                  " /></label
              ><label
                >代理安全密码凭据<select
                  v-model="draft.ssh.proxy.credentialId"
                  aria-label="代理密码凭据"
                >
                  <option :value="null">无代理认证</option>
                  <option
                    v-for="credential in store.catalog?.credentials.filter(
                      (c) => c.kind === 'password',
                    )"
                    :key="credential.id"
                    :value="credential.id"
                  >
                    {{ credential.name }}
                  </option>
                </select></label
              >
              <p class="subtle full-width">
                网络代理用于连接第一个跳板或目标，密码引用系统安全凭据。当前代理链路不使用
                TLS，SOCKS 用户名密码和 HTTP Basic 认证应仅用于可信代理网络。
              </p></template
            >
            <p class="subtle full-width">
              跳板链最多 4 层，每一跳独立校验主机密钥和认证。ProxyCommand
              不受支持，不执行本地配置中的任意命令。
            </p>
          </div>
        </details>
      </fieldset>
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="store.busy" @click="emit('close')">
          取消</button
        ><button type="submit" class="button primary" :disabled="store.busy">
          {{ store.busy ? '保存中…' : '保存主机' }}
        </button>
      </footer>
    </form>
  </Modal>
  <CredentialDialog v-if="newCredential" @close="newCredential = false" @saved="credentialSaved" />
</template>
