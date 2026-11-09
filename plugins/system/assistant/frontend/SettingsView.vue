<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Bot, Boxes, Check, RefreshCw, ShieldCheck } from '@lucide/vue';
import { request } from '@serverdeck/plugin-sdk/transport';
import { useModelBinding } from './model-binding';
import { isLocalModel } from './types';
defineProps<{ settingsDialog?: boolean }>();
const binding = useModelBinding();
const { modelId, models, loading, saving, error, message, loaded, localSources } = binding;
const draft = ref('');
const remoteModels = computed(() => models.models.filter((model) => !isLocalModel(model.id)));
const current = computed(() => models.models.find((model) => model.id === modelId.value));
const pending = computed(() => draft.value !== modelId.value);
const canSave = computed(
  () =>
    loaded.value &&
    !loading.value &&
    !saving.value &&
    models.models.some((model) => model.id === draft.value && model.hasKey),
);
const sourceReady = (id: string) => models.models.some((model) => model.id === id && model.hasKey);
watch(modelId, (id) => (draft.value = id), { immediate: true });
async function close() {
  await request('settings.close');
}
</script>
<template>
  <section class="binding-view" aria-label="助手模型绑定">
    <header class="binding-heading">
      <span class="binding-emblem"><Bot :size="21" aria-hidden="true" /></span>
      <div class="binding-intro">
        <h2>助手模型绑定</h2>
        <p>为所有主机共用的助手选择模型，保存后生效。</p>
      </div>
      <div class="binding-heading-actions">
        <button class="button" :disabled="loading || saving" @click="binding.load">
          <RefreshCw :size="14" :class="{ 'binding-spinning': loading }" aria-hidden="true" />刷新
        </button>
      </div>
    </header>
    <form class="binding-form" @submit.prevent="binding.save(draft)">
      <div class="binding-content">
        <p v-if="loading" class="binding-feedback" role="status">正在读取模型配置…</p>
        <p v-if="error" class="binding-feedback error-text" role="alert">{{ error }}</p>
        <p v-if="message" class="binding-feedback binding-success" role="status">{{ message }}</p>
        <fieldset :disabled="!loaded || loading || saving" aria-label="使用模型">
          <section
            v-if="localSources.length"
            class="binding-group"
            aria-labelledby="binding-local-title"
          >
            <div class="binding-group-heading">
              <h3 id="binding-local-title">本地来源</h3>
              <span>沿用本机工具配置与登录</span>
            </div>
            <div class="binding-local-options">
              <label
                v-for="source in localSources"
                :key="source.id"
                class="binding-option binding-source"
                :class="{ unavailable: !sourceReady(source.id) }"
              >
                <input
                  v-model="draft"
                  type="radio"
                  name="assistant-model"
                  :value="source.id"
                  :disabled="!sourceReady(source.id)"
                />
                <span class="binding-option-label"
                  ><strong>{{ source.name }}</strong
                  ><small>{{ source.status.message }}</small></span
                >
                <span class="binding-state" :class="{ ready: sourceReady(source.id) }">{{
                  sourceReady(source.id) ? '已就绪' : '未就绪'
                }}</span>
              </label>
            </div>
          </section>
          <section class="binding-group" aria-labelledby="binding-remote-title">
            <div class="binding-group-heading">
              <h3 id="binding-remote-title">
                远程模型 <span class="binding-count">{{ remoteModels.length }}</span>
              </h3>
              <span>由平台统一管理凭据</span>
            </div>
            <div v-if="remoteModels.length" class="binding-registered">
              <label
                v-for="model in remoteModels"
                :key="model.id"
                class="binding-option binding-model"
                :class="{ unavailable: !model.hasKey }"
              >
                <input
                  v-model="draft"
                  type="radio"
                  name="assistant-model"
                  :value="model.id"
                  :disabled="!model.hasKey"
                />
                <span class="binding-model-icon"><Boxes :size="17" aria-hidden="true" /></span>
                <span class="binding-option-label"
                  ><strong>{{ model.name }}</strong
                  ><small>{{ model.config.model }}</small></span
                >
                <span class="binding-state" :class="{ ready: model.hasKey }">{{
                  model.hasKey ? '已就绪' : '缺少 Key'
                }}</span>
                <Check
                  v-if="draft === model.id"
                  :size="16"
                  class="binding-selected"
                  aria-hidden="true"
                />
              </label>
            </div>
            <p v-else-if="loaded && !loading" class="binding-empty">
              尚未注册远程模型，可前往平台模型设置添加。
            </p>
          </section>
        </fieldset>
        <div class="binding-platform-note">
          <ShieldCheck :size="17" aria-hidden="true" />
          <p>模型凭据、CLI 安装与授权统一在平台管理，插件无法读取登录凭据。</p>
        </div>
      </div>
      <footer class="binding-footer">
        <div class="binding-current">
          <span
            >当前绑定
            <strong>{{ current?.name ?? (modelId ? '模型已不可用' : '未绑定') }}</strong></span
          ><small :class="{ pending }">{{
            saving ? '正在保存…' : pending ? '有未保存的选择' : '选择后点击保存绑定'
          }}</small>
        </div>
        <button
          v-if="settingsDialog"
          class="button"
          type="button"
          :disabled="saving"
          @click="close"
        >
          取消
        </button>
        <button class="button primary" type="submit" :disabled="!canSave">
          {{ saving ? '正在保存…' : '保存绑定' }}
        </button>
      </footer>
    </form>
  </section>
</template>
<style scoped>
.binding-view {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  color: var(--text);
  background: var(--bg);
}
.binding-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 24px 28px 20px;
  flex-shrink: 0;
}
.binding-emblem,
.binding-model-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  color: var(--accent);
  background: var(--accent-bg);
  border-radius: 9px;
  width: 40px;
  height: 40px;
}
.binding-intro {
  flex: 1;
  min-width: 0;
}
.binding-heading-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
  font-size: var(--font-size-caption);
}
h2 {
  font-size: var(--font-size-section);
  margin: 0;
}
.binding-heading p {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: var(--font-size-caption);
  line-height: 1.65;
}
.binding-form {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  margin: 0;
}
.binding-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 28px 24px;
  scrollbar-width: thin;
}
fieldset {
  display: grid;
  gap: 24px;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.binding-group {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.binding-group-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--font-size-body);
  font-weight: 600;
}
.binding-group-heading > span,
.binding-count {
  font-size: var(--font-size-caption);
  color: var(--muted);
}
.binding-count {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--hover);
  font-weight: 400;
}
.binding-local-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.binding-option {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  cursor: pointer;
}
.binding-option input {
  flex-shrink: 0;
  accent-color: var(--accent);
  margin: 0;
  width: 15px;
  height: 15px;
}
.binding-option-label {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 5px;
  overflow-wrap: anywhere;
}
.binding-option-label strong {
  font-size: var(--font-size-body);
  font-weight: 500;
}
.binding-option-label small {
  color: var(--muted);
  font-size: var(--font-size-caption);
  line-height: 1.6;
}
.binding-source {
  align-items: flex-start;
  flex-wrap: wrap;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
.binding-source input {
  margin-top: 4px;
}
.binding-source .binding-state {
  margin-left: 27px;
}
.binding-option.unavailable {
  cursor: default;
}
.binding-option.unavailable strong {
  color: var(--muted);
}
.binding-source:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-bg);
}
.binding-option:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.binding-registered {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
}
.binding-model {
  padding: 14px 16px;
}
.binding-model + .binding-model {
  border-top: 1px solid var(--border);
}
.binding-model:hover:not(.unavailable) {
  background: var(--hover);
}
.binding-model:has(input:checked) {
  background: var(--accent-bg);
}
.binding-model-icon {
  width: 32px;
  height: 32px;
  border-radius: 7px;
}
.binding-state {
  padding: 2px 7px;
  border-radius: 4px;
  font-size: var(--font-size-caption);
  color: var(--muted);
  background: var(--hover);
  white-space: nowrap;
}
.binding-state.ready {
  color: var(--accent);
  background: var(--accent-bg);
}
.binding-selected {
  color: var(--accent);
  flex-shrink: 0;
}
.binding-platform-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 20px;
  margin-top: 22px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.binding-platform-note > svg {
  flex-shrink: 0;
  margin-top: 3px;
}
.binding-platform-note p {
  flex: 1;
  min-width: 160px;
  margin: 0;
  line-height: 1.7;
}
.binding-empty,
.binding-feedback {
  margin: 0;
  padding: 12px 14px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--panel);
  font-size: var(--font-size-caption);
  color: var(--muted);
  line-height: 1.7;
}
.binding-feedback {
  margin-bottom: 16px;
}
.binding-feedback.error-text {
  color: var(--error);
  border-color: var(--error);
}
.binding-success {
  color: var(--accent);
}
.binding-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 16px 28px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}
.binding-current {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 5px;
  font-size: var(--font-size-caption);
  color: var(--muted);
}
.binding-current > span {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.binding-current strong {
  color: var(--text);
  font-weight: 500;
  overflow-wrap: anywhere;
}
.binding-current small {
  font-size: inherit;
}
.binding-current .pending {
  color: var(--accent);
}
.binding-spinning {
  animation: binding-spin 1s linear infinite;
}
@keyframes binding-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .binding-spinning {
    animation: none;
  }
}
@media (max-width: 640px) {
  .binding-heading {
    flex-wrap: wrap;
    padding: 20px 16px 16px;
  }
  .binding-heading-actions {
    justify-content: space-between;
    flex-basis: 100%;
  }
  .binding-content {
    padding: 0 16px 20px;
  }
  .binding-footer {
    padding: 12px 16px;
    flex-wrap: wrap;
  }
  .binding-local-options {
    grid-template-columns: minmax(0, 1fr);
  }
  .binding-group-heading > span {
    display: none;
  }
  .binding-current {
    flex-basis: 100%;
  }
  .binding-footer > button:first-of-type {
    margin-left: auto;
  }
  .binding-model-icon {
    display: none;
  }
  .binding-model {
    gap: 9px;
    padding: 12px;
  }
}
</style>
