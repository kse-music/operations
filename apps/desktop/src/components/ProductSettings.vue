<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { computed, ref } from 'vue';
import ProxyPasswordDialog from './ProxyPasswordDialog.vue';
import { useHostsStore } from '../stores/hosts';
import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
import { globalKey, type ProductPreferences } from '../types/product';
const model = defineModel<ProductPreferences>({ required: true });
defineProps<{ section: 'general' | 'connection' | 'shortcuts' | 'storage'; disabled?: boolean }>();
const hosts = useHostsStore(),
  error = ref('');
const newProxyPassword = ref(false);
function proxyPasswordSaved(id: string): void {
  if (model.value.sshDefaults.proxy) model.value.sshDefaults.proxy.credentialId = id;
  newProxyPassword.value = false;
}
const mode = computed({
  get: () => model.value.sshDefaults.proxy?.kind ?? 'direct',
  set: (kind: 'direct' | 'socks5' | 'http_connect') => {
    model.value.sshDefaults.proxy =
      kind === 'direct'
        ? null
        : {
            kind,
            hostname: '127.0.0.1',
            port: kind === 'socks5' ? 1080 : 8080,
            username: null,
            credentialId: null,
          };
  },
});
const authenticated = computed({
  get: () => model.value.sshDefaults.proxy?.username !== null && !!model.value.sshDefaults.proxy,
  set: (value: boolean) => {
    const p = model.value.sshDefaults.proxy;
    if (p) {
      p.username = value ? '' : null;
      p.credentialId = null;
    }
  },
});
async function browse() {
  try {
    const paths = await filesApi.pick('folder');
    if (paths[0]) model.value.downloadDirectory = paths[0];
  } catch (e) {
    error.value = errorMessage(e);
  }
}
function capture(action: string, e: KeyboardEvent) {
  if (e.key === 'Tab') return;
  e.preventDefault();
  const key = globalKey(e);
  if (key) model.value.shortcuts[action] = key;
}
useErrorNotifications(error);
</script>
<template>
  <fieldset :disabled="disabled">
    <legend>
      {{
        {
          general: '界面与运行',
          connection: 'SSH 连接',
          shortcuts: '全局快捷键',
          storage: '下载与传输',
        }[section]
      }}
    </legend>
    <div class="settings-fields">
      <slot />
      <template v-if="section === 'general'">
        <label
          >界面语言<select v-model="model.language" aria-label="界面语言">
            <option value="zh-CN">简体中文</option>
          </select></label
        >
      </template>
      <template v-if="section === 'storage'">
        <div class="full-width settings-field">
          <label for="default-download-directory">默认下载目录</label>
          <div class="input-action">
            <input
              id="default-download-directory"
              v-model="model.downloadDirectory"
              placeholder="未设置时使用本地文件栏当前目录"
              aria-label="默认下载目录"
              @change="model.downloadDirectory ||= null"
            />
            <button type="button" class="button" @click="browse">选择下载目录</button>
          </div>
        </div>
      </template>
      <template v-if="section === 'connection'">
        <label
          >默认认证超时（秒）<input
            v-model.number="model.sshDefaults.authTimeoutSecs"
            type="number"
            min="1"
            max="120"
            required
        /></label>
        <label
          >默认 Keepalive 间隔（秒）<input
            v-model.number="model.sshDefaults.keepaliveIntervalSecs"
            aria-label="默认 Keepalive 间隔"
            type="number"
            min="1"
            max="3600"
            required
        /></label>
        <label
          >默认 Keepalive 失败次数<input
            v-model.number="model.sshDefaults.keepaliveCountMax"
            type="number"
            min="1"
            max="10"
            required
        /></label>
        <div class="settings-fields settings-subsection full-width">
          <label
            >默认代理<select v-model="mode" aria-label="全局默认代理">
              <option value="direct">直连</option>
              <option value="socks5">SOCKS5</option>
              <option value="http_connect">HTTP CONNECT</option>
            </select></label
          >
          <template v-if="model.sshDefaults.proxy"
            ><label
              >代理地址<input
                v-model="model.sshDefaults.proxy.hostname"
                required
                aria-label="默认代理地址" /></label
            ><label
              >代理端口<input
                v-model.number="model.sshDefaults.proxy.port"
                type="number"
                min="1"
                max="65535"
                required /></label
            ><label class="checkbox-label full-width"
              ><input v-model="authenticated" type="checkbox" />代理需要认证</label
            ><template v-if="authenticated"
              ><label
                >代理用户名<input
                  v-model="model.sshDefaults.proxy.username"
                  aria-label="代理用户名"
                  required /></label
              ><label
                >代理安全凭据<select
                  v-model="model.sshDefaults.proxy.credentialId"
                  aria-label="代理安全凭据"
                  required
                >
                  <option :value="null">选择密码凭据</option>
                  <option
                    v-for="c in hosts.catalog?.credentials.filter((c) => c.kind === 'password')"
                    :key="c.id"
                    :value="c.id"
                  >
                    {{ c.name }}
                  </option>
                </select></label
              >
              <button type="button" class="text-button" @click="newProxyPassword = true">
                ＋ 新建代理密码
              </button>
            </template></template
          >
        </div>
        <p class="subtle full-width">
          连接超时、Keepalive
          和代理作为新建主机的默认值，不改写已有主机或在途连接。认证代理必须关联系统凭据；HTTP
          CONNECT 的代理连接本身不使用 TLS。
        </p>
      </template>
      <template v-if="section === 'shortcuts'">
        <label v-for="(title, key) in { search: '全局搜索', settings: '打开设置' }" :key="key"
          >{{ title
          }}<input
            :value="model.shortcuts[key]"
            readonly
            :aria-label="`${title}全局快捷键`"
            @keydown="capture(key, $event)"
        /></label>
        <p class="subtle full-width">
          使用 Ctrl（macOS 可用 Command）及可选 Shift。不会覆盖远端 Ctrl+C/Z
          等控制键；对话框中不触发全局导航。
        </p>
      </template>
    </div>
  </fieldset>
  <ProxyPasswordDialog
    v-if="newProxyPassword"
    @close="newProxyPassword = false"
    @saved="proxyPasswordSaved"
  />
</template>
