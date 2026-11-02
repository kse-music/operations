<script setup lang="ts">
import { computed, ref } from 'vue';
import { useHostsStore } from '../stores/hosts';
import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
import { globalKey, type ProductPreferences } from '../types/product';
const model = defineModel<ProductPreferences>({ required: true });
const hosts = useHostsStore(),
  error = ref('');
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
</script>
<template>
  <fieldset>
    <legend>工作区与默认连接</legend>
    <label
      >界面语言<select v-model="model.language" aria-label="界面语言">
        <option value="zh-CN">简体中文</option>
      </select></label
    >
    <div class="full-width">
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
      ><label class="checkbox-label"
        ><input v-model="authenticated" type="checkbox" />代理需要认证</label
      ><template v-if="authenticated"
        ><label>代理用户名<input v-model="model.sshDefaults.proxy.username" required /></label
        ><label
          >代理安全凭据<select v-model="model.sshDefaults.proxy.credentialId" required>
            <option :value="null">选择密码凭据</option>
            <option
              v-for="c in hosts.catalog?.credentials.filter((c) => c.kind === 'password')"
              :key="c.id"
              :value="c.id"
            >
              {{ c.name }}
            </option>
          </select></label
        ></template
      ></template
    >
    <p class="subtle">
      连接超时、Keepalive
      和代理作为新建主机的默认值，不改写已有主机或在途连接。认证代理必须关联系统凭据；HTTP CONNECT
      的代理连接本身不使用 TLS。
    </p>
    <h3>全局快捷键</h3>
    <label
      v-for="(title, key) in { search: '全局搜索', settings: '打开设置', tasks: '后台任务' }"
      :key="key"
      >{{ title
      }}<input
        :value="model.shortcuts[key]"
        readonly
        :aria-label="`${title}全局快捷键`"
        @keydown="capture(key, $event)"
    /></label>
    <p class="subtle">
      使用 Ctrl（macOS 可用 Command）及可选 Shift。不会覆盖远端 Ctrl+C/Z
      等控制键；对话框中不触发全局导航。
    </p>
    <p v-if="error" class="banner error" role="alert">{{ error }}</p>
  </fieldset>
</template>
