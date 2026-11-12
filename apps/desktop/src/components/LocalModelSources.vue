<script setup lang="ts">
import { tr } from '../i18n/messages';

import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Download, LoaderCircle, ShieldCheck, ShieldOff, SquareTerminal, X } from '@lucide/vue';
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
function sourceState(id: string): string {
  if (installation && busy.value === id) return tr('下载中');
  const status = statuses.value[id];
  if (!status) return tr('等待状态检测');
  if (status.installed === false) return tr('未安装');
  if (!status.authorized) return tr('未授权');
  return status.model ? tr('已就绪') : tr('未就绪');
}
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
defineExpose({ refresh, loading, busy });
</script>
<template>
  <section class="local-model-sources" :aria-label="tr('本地CLI')">
    <p class="subtle local-sources-note">
      {{ tr('所有插件共用平台配置。插件只能读取公开状态并调用模型，无法读取登录凭据。') }}
    </p>
    <p v-if="loading" class="asset-feedback" role="status">{{ tr('正在检测本地工具…') }}</p>
    <p v-if="error" class="asset-feedback error-text" role="alert">{{ error }}</p>
    <p v-if="message" class="asset-feedback success" role="status">{{ message }}</p>
    <div class="local-source-list">
      <article v-for="source in definitions" :key="source.id" class="local-model-source">
        <header class="local-source-heading">
          <span class="local-source-icon"><SquareTerminal :size="22" aria-hidden="true" /></span>
          <div class="local-source-title">
            <h3>{{ source.name }}</h3>
            <span class="local-source-state" :class="{ ready: !!statuses[source.id]?.model }">
              {{ sourceState(source.id) }}
            </span>
          </div>
        </header>
        <p class="local-source-message">{{ tr(statuses[source.id]?.message || '等待状态检测') }}</p>
        <div class="local-source-actions">
          <button
            v-if="statuses[source.id]?.installed === false"
            class="button primary"
            :disabled="!!busy || statuses[source.id]?.installSupported === false"
            @click="install(source)"
          >
            <LoaderCircle
              v-if="installation && busy === source.id"
              :size="15"
              class="model-spin"
              aria-hidden="true"
            />
            <Download v-else :size="15" aria-hidden="true" />
            {{ busy === source.id ? tr('正在下载…') : tr('下载安装') }}
          </button>
          <button
            v-else
            class="button"
            :class="{ primary: !statuses[source.id]?.authorized }"
            :disabled="!!busy || loading || !statuses[source.id]"
            @click="authorize(source, !statuses[source.id]?.authorized)"
          >
            <ShieldOff v-if="statuses[source.id]?.authorized" :size="15" aria-hidden="true" />
            <ShieldCheck v-else :size="15" aria-hidden="true" />
            {{ statuses[source.id]?.authorized ? tr('撤销授权') : tr('授权使用') }}
          </button>
          <button v-if="installation && busy === source.id" class="button" @click="cancel">
            <X :size="15" aria-hidden="true" />{{ tr(' 取消下载 ') }}
          </button>
        </div>
      </article>
    </div>
  </section>
</template>
<style scoped>
.local-model-sources {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.local-sources-note {
  margin: 0;
  line-height: 1.65;
}
.local-model-sources > .asset-feedback {
  margin: 0;
}
.local-source-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.local-model-source {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}
.local-source-heading {
  display: flex;
  align-items: center;
  gap: 12px;
}
.local-source-icon {
  display: grid;
  place-items: center;
  flex: 0 0 40px;
  height: 40px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--accent-bg);
  color: var(--accent);
}
.local-source-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  min-width: 0;
}
.local-source-title h3 {
  margin: 0;
  font-size: var(--font-size-section);
  overflow-wrap: anywhere;
}
.local-source-state {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--muted);
  font-size: var(--font-size-caption);
  line-height: 1.5;
}
.local-source-state.ready {
  border-color: transparent;
  background: var(--accent-bg);
  color: var(--accent);
}
.local-source-message {
  flex: 1;
  margin: 0;
  color: var(--muted);
  font-size: var(--font-size-body);
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.local-source-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
@container workspace (max-width: 740px) {
  .local-source-list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
