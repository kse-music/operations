<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import Modal from './Modal.vue';
import ProxyPasswordDialog from './ProxyPasswordDialog.vue';
import { useApplicationStore } from '../stores/application';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import { errorMessage } from '../services/ipc';
import {
  authLabels,
  hostDisplayName,
  hostInput,
  type Host,
  type HostAuthenticationInput,
  type HostKeyFingerprint,
} from '../types/hosts';
const props = defineProps<{ host?: Host; groupId?: string | null }>();
const emit = defineEmits<{ close: []; saved: [host: Host] }>();
const store = useHostsStore();
const application = useApplicationStore();
const draft = reactive(hostInput(props.host, application.state?.config.connectTimeoutSecs));
if (!props.host) {
  draft.groupId = props.groupId ?? null;
  draft.authType = 'password';
}
if (!props.host && application.state?.config.product)
  draft.ssh = JSON.parse(
    JSON.stringify(application.state.config.product.sshDefaults),
  ) as typeof draft.ssh;
const newProxyPassword = ref(false);
const secret = ref('');
const keyData = ref('');
const keyFile = shallowRef<File | null>(null);
const keyFileInput = ref<HTMLInputElement | null>(null);
const form = ref<HTMLFormElement | null>(null);
const testing = ref(false);
const testId = ref('');
const testMessage = ref('');
const testError = ref('');
const trust = ref<HostKeyFingerprint>();
const busy = computed(() => store.busy || testing.value);
let expiry: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const authSelection = computed({
  get: () => (draft.authType === 'agent' ? '' : draft.authType),
  set: (authType: '' | 'password' | 'private_key') => {
    if (authType) draft.authType = authType;
  },
});
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
const legacyKey = computed(
  () => store.catalog?.credentials.find((c) => c.id === draft.credentialId)?.keyPath,
);
function clearKeyFile(): void {
  if (keyFileInput.value) {
    keyFileInput.value.value = '';
    keyFileInput.value.setCustomValidity('');
  }
  keyFile.value = null;
  secret.value = '';
}
function clearAuthentication(): void {
  keyData.value = '';
  clearKeyFile();
}
function selectKey(event: Event): void {
  const field = event.target as HTMLInputElement;
  const file = field.files?.[0] ?? null;
  field.setCustomValidity(
    file && (file.size === 0 || file.size > 1024 * 1024) ? '私钥文件须为 1 字节至 1 MiB' : '',
  );
  keyFile.value = file;
  keyData.value = '';
  secret.value = '';
}
function invalidateTest(): void {
  testId.value = '';
  testMessage.value = '';
  testError.value = '';
  trust.value = undefined;
  clearTimeout(expiry);
}
watch([draft, secret, keyData, keyFile], invalidateTest, { deep: true, flush: 'sync' });
onBeforeUnmount(() => {
  disposed = true;
  invalidateTest();
  clearAuthentication();
});
watch(
  () => draft.authType,
  (type) => {
    clearAuthentication();
    draft.credentialId = type === props.host?.authType ? props.host.credentialId : null;
  },
);
async function authenticationInput(): Promise<HostAuthenticationInput | undefined> {
  if (draft.authType === 'password' && secret.value) {
    return { kind: 'password', password: secret.value };
  }
  if (draft.authType === 'private_key' && (keyFile.value || keyData.value)) {
    return {
      kind: 'private_key',
      passphrase: secret.value || null,
      keyData: keyFile.value ? await keyFile.value.text() : keyData.value,
    };
  }
}
async function testConnection(confirmed?: HostKeyFingerprint): Promise<void> {
  if (busy.value || !form.value?.reportValidity()) return;
  invalidateTest();
  testing.value = true;
  try {
    const result = await hostsApi.test(
      { ...draft },
      await authenticationInput(),
      confirmed,
      props.host?.id,
    );
    if (disposed) return;
    if (result.status === 'trust_required') {
      trust.value = result.key;
      return;
    }
    testId.value = result.testId;
    testMessage.value = 'SSH 连接和认证成功，可以保存主机。';
    expiry = setTimeout(() => {
      invalidateTest();
      testMessage.value = '测试结果已过期，请重新测试连接。';
    }, result.expiresInSeconds * 1000);
  } catch (error) {
    if (!disposed) testError.value = errorMessage(error);
  } finally {
    testing.value = false;
  }
}
async function submit(): Promise<void> {
  if (busy.value || !testId.value) return;
  const result = await store.run(
    async () => {
      const input = { ...draft };
      const authentication = await authenticationInput();
      const receipt = testId.value;
      invalidateTest();
      return props.host
        ? hostsApi.updateTested(props.host.id, input, authentication, receipt)
        : hostsApi.create(input, authentication, receipt);
    },
    props.host ? '主机已更新。' : '主机已创建。',
  );
  if (result.ok) {
    clearAuthentication();
    store.selectedId = result.value.id;
    emit('saved', result.value);
    emit('close');
  }
}
function proxyPasswordSaved(id: string): void {
  if (draft.ssh.proxy) draft.ssh.proxy.credentialId = id;
  newProxyPassword.value = false;
}
</script>
<template>
  <Modal :title="host ? '编辑主机' : '新建主机'" :busy="busy" @close="emit('close')">
    <form ref="form" class="editor-form" @submit.prevent="submit">
      <fieldset class="form-grid" :disabled="busy">
        <label
          >主机名称（可选）<input
            v-model="draft.name"
            autofocus
            maxlength="128"
            placeholder="留空时显示地址，非 22 端口会附加端口号"
        /></label>
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
          >认证方式<select v-model="authSelection" aria-label="认证方式">
            <option v-if="draft.authType === 'agent'" value="" disabled hidden>沿用当前认证</option>
            <option value="password">{{ authLabels.password }}</option>
            <option value="private_key">{{ authLabels.private_key }}</option>
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
        <label v-if="draft.authType === 'password'" class="full-width">
          SSH 密码
          <input
            v-model="secret"
            type="password"
            autocomplete="new-password"
            maxlength="2048"
            :required="!host"
            :placeholder="draft.credentialId ? '已保存，留空沿用原密码' : '输入 SSH 登录密码'"
          />
        </label>
        <template v-else-if="draft.authType === 'private_key'">
          <p class="subtle full-width">
            服务器授权公钥，本机使用对应的私钥签名。请粘贴私钥内容或选择本机私钥文件。
          </p>
          <label v-if="!keyFile" class="full-width">
            私钥内容
            <textarea
              v-model="keyData"
              class="private-key-input"
              rows="3"
              maxlength="1048576"
              :required="!host"
              autocomplete="off"
              spellcheck="false"
              placeholder="粘贴完整私钥内容"
            />
          </label>
          <div class="full-width">
            <label>
              私钥文件
              <input ref="keyFileInput" type="file" aria-label="选择私钥文件" @change="selectKey" />
            </label>
            <button v-if="keyFile" type="button" class="text-button" @click="clearKeyFile">
              清除文件选择
            </button>
          </div>
          <label v-if="keyData || keyFile" class="full-width">
            加密私钥口令（可选）
            <input v-model="secret" type="password" autocomplete="new-password" maxlength="2048" />
          </label>
          <p v-else class="subtle full-width">
            {{
              legacyKey
                ? '当前使用已有的私钥文件路径。留空沿用，选择或粘贴私钥可重新导入。'
                : draft.credentialId
                  ? '已保存私钥，留空沿用。'
                  : '请先填写私钥，再测试连接。'
            }}
          </p>
        </template>
        <p v-else class="subtle full-width">
          当前主机使用系统 SSH Agent。可改用 SSH 密码或公钥认证。
        </p>
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
                  {{ hostDisplayName(item) }} · {{ item.username }}@{{ item.hostname }}
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
                  <option :value="null">
                    {{ draft.ssh.proxy.username ? '请选择安全密码凭据' : '无代理认证' }}
                  </option>
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
              <button
                v-if="draft.ssh.proxy.username"
                class="text-button"
                type="button"
                @click="newProxyPassword = true"
              >
                ＋ 新建代理密码
              </button>
              <p
                v-if="draft.ssh.proxy.username && !draft.ssh.proxy.credentialId"
                class="banner full-width"
              >
                请关联代理密码凭据后再连接此主机。
              </p>
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
      <section v-if="trust" class="banner" aria-label="核对 SSH 主机指纹">
        <p>首次连接 {{ trust.hostname }}:{{ trust.port }}。请通过可信渠道核对指纹。</p>
        <p>
          {{ trust.algorithm }} <code class="fingerprint">{{ trust.fingerprint }}</code>
        </p>
        <div class="toolbar">
          <button class="button" type="button" @click="invalidateTest">拒绝指纹</button>
          <button class="button" type="button" @click="testConnection(trust)">
            信任并继续测试
          </button>
        </div>
      </section>
      <p v-if="testError" class="banner" role="alert">{{ testError }}</p>
      <p class="subtle" role="status">
        {{ testMessage || (testing ? '正在连接并验证 SSH 登录…' : '测试连接成功后即可保存。') }}
      </p>
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="busy" @click="testConnection()">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button type="submit" class="button primary" :disabled="busy || !testId">
          {{ store.busy ? '保存中…' : '保存主机' }}
        </button>
      </footer>
    </form>
  </Modal>
  <ProxyPasswordDialog
    v-if="newProxyPassword"
    @close="newProxyPassword = false"
    @saved="proxyPasswordSaved"
  />
</template>

<style scoped>
.private-key-input {
  -webkit-text-security: disc;
}
</style>
