<script setup lang="ts">
import { ref, watch } from 'vue';
import { request } from '@serverdeck/plugin-sdk/transport';
import { useModelBinding } from './model-binding';
defineProps<{ settingsDialog?: boolean }>();
const binding = useModelBinding();
const { modelId, models, loading, saving, error, message, loaded, localSources } = binding;
const draft = ref('');
watch(
  modelId,
  (id) => {
    draft.value = id;
  },
  { immediate: true },
);
async function close() {
  await request('settings.close');
}
</script>
<template>
  <section class="binding-view" aria-label="助手模型绑定">
    <div class="binding-heading">
      <h2>助手模型绑定</h2>
      <p>选择平台已配置的模型。模型凭据、CLI 安装与授权统一在平台模型设置中管理。</p>
    </div>
    <div class="binding-content">
      <p v-if="loading" role="status">正在读取模型配置…</p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <p v-if="message" role="status">{{ message }}</p>
      <label
        >当前模型<select v-model="draft" :disabled="loading || saving">
          <option value="">不绑定模型</option>
          <option
            v-for="model in models.models"
            :key="model.id"
            :value="model.id"
            :disabled="!model.hasKey"
          >
            {{ model.name }} · {{ model.config.model }}
          </option>
        </select></label
      >
      <p v-if="loaded && !models.models.length" class="host-empty">
        暂无可用模型，请先完成平台配置。
      </p>
      <p v-for="source in localSources" :key="source.id">
        {{ source.name }}：{{ source.status.message }}
      </p>
      <button class="button" @click="binding.manageModels">打开平台模型设置</button
      ><button class="button" :disabled="loading || saving" @click="binding.load">刷新</button>
    </div>
    <footer>
      <button v-if="settingsDialog" class="button" :disabled="saving" @click="close">关闭</button
      ><button
        class="button primary"
        :disabled="!loaded || loading || saving"
        @click="binding.save(draft)"
      >
        {{ saving ? '正在保存…' : '保存绑定' }}
      </button>
    </footer>
  </section>
</template>
<style scoped>
.assistant-model-settings {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  background: var(--panel);
}
.binding-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  padding: 16px 24px 12px;
}
.binding-heading-icon,
.binding-source-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--hover);
  color: var(--muted);
}
.binding-heading-icon {
  background: var(--accent-bg);
  color: var(--accent);
}
.binding-intro {
  flex: 1;
  min-width: 0;
}
h2 {
  margin: 0;
  font-size: var(--font-size-section);
  font-weight: 600;
}
.binding-intro p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.binding-refresh.button {
  width: 36px;
  padding: 0;
  background: transparent;
  border-color: transparent;
}
.binding-refresh.button:hover:not(:disabled) {
  background: var(--hover);
}
form {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.binding-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 2px 24px 16px;
  scrollbar-width: thin;
}
fieldset {
  display: grid;
  gap: 16px;
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.binding-group {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.binding-group-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 24px;
}
h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--font-size-caption);
  font-weight: 500;
  color: var(--muted);
}
.binding-group-heading > span {
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.binding-count {
  display: grid;
  place-items: center;
  min-width: 19px;
  height: 19px;
  padding: 0 4px;
  border-radius: 5px;
  background: var(--hover);
}
.binding-local-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.binding-option {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  cursor: pointer;
}
.binding-source {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
}
.binding-source:hover {
  background: var(--hover);
}
.binding-source:has(input:checked) {
  background: var(--accent-bg);
  border-color: var(--accent);
}
.binding-source:has(input:checked) .binding-source-icon {
  color: var(--accent);
  background: var(--panel);
}
.binding-option:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.binding-option:has(input:disabled) {
  cursor: default;
  opacity: 0.65;
}
.binding-option-label {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.binding-option-label strong {
  font-size: var(--font-size-body);
  font-weight: 500;
}
.binding-option-label small {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.binding-option-label i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--muted);
}
.binding-option-label i.ready {
  background: var(--accent);
}
.binding-choice {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: 1px solid var(--muted);
  border-radius: 50%;
  flex-shrink: 0;
}
.binding-option:has(input:checked) .binding-choice {
  border-color: var(--accent);
}
.binding-option:has(input:checked) .binding-choice::after {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}
.binding-local {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--hover);
}
.binding-connection {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  min-width: 0;
}
.binding-connection > svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--muted);
}
.binding-local[data-state='ready'] .binding-connection > svg {
  color: var(--accent);
}
.binding-connection strong {
  font-size: var(--font-size-caption);
  font-weight: 500;
}
.binding-connection p {
  margin: 3px 0 0;
  font-size: var(--font-size-caption);
  color: var(--muted);
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.binding-link.button {
  padding: 2px 0;
  min-height: 28px;
  background: transparent;
  border-color: transparent;
  color: var(--muted);
  font-size: var(--font-size-caption);
  flex-shrink: 0;
}
.binding-link.button:hover:not(:disabled) {
  color: var(--accent);
  background: transparent;
}
.binding-authorize.button {
  font-size: var(--font-size-caption);
  flex-shrink: 0;
}
.binding-registered {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.binding-model {
  padding: 8px 12px;
}
.binding-model .binding-option-label {
  gap: 2px;
  line-height: 1.35;
}
.binding-model + .binding-model {
  border-top: 1px solid var(--border);
}
.binding-model:hover {
  background: var(--hover);
}
.binding-model:has(input:checked) {
  background: var(--accent-bg);
}
.binding-key {
  color: var(--muted);
  font-size: var(--font-size-caption);
  white-space: nowrap;
}
.binding-key.missing,
.warning-text {
  color: var(--error);
}
.binding-empty {
  margin: 0;
  padding: 12px 14px;
  background: var(--hover);
  border-radius: 8px;
  color: var(--muted);
  font-size: var(--font-size-caption);
  line-height: 1.6;
}
.binding-none {
  border-top: 1px solid var(--border);
  padding: 14px 2px 0;
}
.binding-none .binding-option-label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
}
.binding-none .binding-option-label strong {
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.binding-feedback {
  margin: 12px 0 0;
  font-size: var(--font-size-caption);
  line-height: 1.6;
}
footer {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 12px 24px;
  border-top: 1px solid var(--border);
}
.binding-current {
  display: grid;
  gap: 3px;
  flex: 1;
  min-width: 0;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.binding-current > span {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.binding-current strong {
  color: var(--text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.binding-current small {
  font-size: var(--font-size-caption);
}
.binding-current .binding-pending {
  color: var(--accent);
}
.binding-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
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
@media (max-width: 520px) {
  .binding-heading {
    padding: 16px 16px 12px;
  }
  .binding-content {
    padding: 2px 16px 14px;
  }
  .binding-source {
    padding: 12px;
    gap: 8px;
  }
  .binding-source-icon {
    display: none;
  }
  .binding-local {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
  .binding-local > button {
    align-self: flex-end;
  }
  .binding-group-heading > span {
    display: none;
  }
  footer {
    padding: 12px 16px;
    flex-wrap: wrap;
  }
  .binding-current {
    flex-basis: 100%;
    margin-bottom: 4px;
  }
  footer > button:first-of-type {
    margin-left: auto;
  }
}
</style>
