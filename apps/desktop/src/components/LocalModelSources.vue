<script setup lang="ts">
import { tr } from '../i18n/messages';

import { onBeforeUnmount, onMounted, ref } from 'vue';
import { aiApi } from '../services/ai';
import { errorMessage } from '../services/ipc';
import { usePluginsStore } from '../stores/plugins';
import type { LocalCodexStatus } from '../types/ai';
const prompts = usePluginsStore();
const owner = 'platform-model-sources';
const definitions = [
  {
    id: 'local-codex',
    get name() {
      return tr('本地 Codex');
    },
    read: aiApi.localCodexStatus,
    authorize: aiApi.localCodexAuthorize,
  },
  {
    id: 'local-claude-code',
    get name() {
      return tr('本地 Claude Code');
    },
    read: aiApi.localClaudeCodeStatus,
    authorize: aiApi.localClaudeCodeAuthorize,
  },
];
const statuses = ref<Record<string, LocalCodexStatus>>({}),
  loading = ref(false),
  busy = ref(''),
  error = ref(''),
  message = ref('');
let installation = '',
  disposed = false;
async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const values = await Promise.all(definitions.map((source) => source.read()));
    if (!disposed)
      definitions.forEach((source, index) => {
        statuses.value[source.id] = values[index]!;
      });
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause);
  } finally {
    if (!disposed) loading.value = false;
  }
}
async function authorize(source: (typeof definitions)[number], authorized: boolean) {
  if (busy.value) return;
  busy.value = source.id;
  error.value = '';
  try {
    if (authorized) {
      const accepted = await prompts.ask(
        tr('使用{0}', source.name),
        tr(
          '允许平台启动{0} CLI，使用本机已有配置和登录状态处理已授权插件提供的模型消息。请求发送到 CLI 当前配置的服务，并按该账号或服务的规则计费。',
          source.name,
        ),
        undefined,
        owner,
      );
      if (!accepted || disposed) return;
    }
    await source.authorize(authorized);
    await refresh();
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause);
  } finally {
    if (!disposed) busy.value = '';
  }
}
async function install(source: (typeof definitions)[number]) {
  if (busy.value) return;
  busy.value = source.id;
  error.value = '';
  message.value = '';
  const request = crypto.randomUUID();
  installation = request;
  try {
    await aiApi.localToolInstall(source.id, request);
    if (!disposed) {
      await refresh();
      message.value = tr('下载完成，请检查登录状态并授权使用。');
    }
  } catch (cause) {
    if (!disposed) {
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === 'AI_INSTALL_CANCELLED'
      )
        message.value = tr('已取消下载');
      else error.value = errorMessage(cause);
    }
  } finally {
    if (installation === request) installation = '';
    if (!disposed) busy.value = '';
  }
}
async function cancel() {
  if (!installation) return;
  try {
    await aiApi.localToolInstallCancel(installation);
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause);
  }
}
onMounted(() => void refresh());
onBeforeUnmount(() => {
  disposed = true;
  prompts.cancelPrompt(owner);
  void cancel().catch((cause) =>
    console.error('Local model installation cancellation failed', errorMessage(cause)),
  );
});
</script>
<template>
  <section class="asset-panel local-model-sources" :aria-label="tr('本地模型来源')">
    <div class="toolbar">
      <h2>{{ tr('本地模型来源') }}</h2>
      <button class="button" :disabled="loading || !!busy" @click="refresh">
        {{ tr('刷新状态') }}
      </button>
    </div>
    <p class="subtle">
      {{ tr('所有插件共用平台配置。插件只能读取公开状态并调用模型，无法读取登录凭据。') }}
    </p>
    <p v-if="loading" role="status">{{ tr('正在检测本地工具…') }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <article v-for="source in definitions" :key="source.id" class="local-model-source">
      <div>
        <strong>{{ source.name }}</strong>
        <p>{{ tr(statuses[source.id]?.message || '等待状态检测') }}</p>
      </div>
      <button
        v-if="statuses[source.id]?.installed === false"
        class="button"
        :disabled="!!busy || statuses[source.id]?.installSupported === false"
        @click="install(source)"
      >
        {{ busy === source.id ? tr('正在下载…') : tr('下载安装') }}</button
      ><button
        v-else
        class="button"
        :disabled="!!busy || loading || !statuses[source.id]"
        @click="authorize(source, !statuses[source.id]?.authorized)"
      >
        {{ statuses[source.id]?.authorized ? tr('撤销授权') : tr('授权使用') }}</button
      ><button v-if="installation && busy === source.id" class="button" @click="cancel">
        {{ tr(' 取消下载 ') }}
      </button>
    </article>
  </section>
</template>
<style scoped>
.local-model-sources {
  padding: 20px;
}
.local-model-source {
  display: flex;
  gap: 12px;
  align-items: center;
  border-top: 1px solid var(--line);
  padding: 14px 0;
}
.local-model-source > div {
  flex: 1;
}
.local-model-source p {
  margin: 6px 0;
  color: var(--muted);
}
h2 {
  font-size: 16px;
}
</style>
