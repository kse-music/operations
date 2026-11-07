<script setup lang="ts">
import { Download, Info, LoaderCircle, RefreshCw } from '@lucide/vue';
defineProps<{
  name: string;
  modelId: string;
  installing: boolean;
  supported: boolean;
  disabled?: boolean;
}>();
defineEmits<{ install: []; cancel: []; refresh: [] }>();
</script>
<template>
  <aside class="local-install-notice" aria-label="安装本地工具">
    <Info :size="18" class="local-install-icon" aria-hidden="true" />
    <div class="local-install-body">
      <strong>{{ installing ? `正在安装${name}` : `需要安装${name}` }}</strong>
      <p v-if="installing" role="status">正在从官方源下载并校验，请稍候…</p>
      <p v-else>使用此工具前需要安装 CLI。已有配置与登录信息会保留。</p>
      <p v-if="!supported" class="local-install-manual">
        当前平台请在终端安装后重新检测：<code>{{
          modelId === 'local-codex'
            ? 'npm install -g @openai/codex'
            : 'npm install -g @anthropic-ai/claude-code'
        }}</code>
      </p>
      <div class="local-install-actions">
        <button v-if="installing" type="button" class="button" @click="$emit('cancel')">
          取消下载
        </button>
        <template v-else>
          <button
            v-if="supported"
            type="button"
            class="button primary"
            :disabled="disabled"
            @click="$emit('install')"
          >
            <Download :size="14" aria-hidden="true" />下载并安装
          </button>
          <button type="button" class="button" :disabled="disabled" @click="$emit('refresh')">
            <RefreshCw :size="14" aria-hidden="true" />重新检测
          </button>
        </template>
        <LoaderCircle
          v-if="installing"
          :size="16"
          class="local-install-spinner"
          aria-hidden="true"
        />
      </div>
    </div>
  </aside>
</template>
<style scoped>
.local-install-notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--hover);
}
.local-install-icon {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}
.local-install-body {
  min-width: 0;
  flex: 1;
}
.local-install-body strong {
  font-size: var(--font-size-body);
  font-weight: 500;
}
.local-install-body p {
  color: var(--muted);
  font-size: var(--font-size-caption);
  line-height: 1.6;
  margin: 5px 0 0;
}
.local-install-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.local-install-actions .button {
  font-size: var(--font-size-caption);
}
.local-install-manual code {
  display: block;
  overflow-wrap: anywhere;
}
.local-install-spinner {
  color: var(--accent);
  animation: install-spin 1s linear infinite;
}
@keyframes install-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .local-install-spinner {
    animation: none;
  }
}
</style>
