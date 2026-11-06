<script setup lang="ts">
import { ref, watch } from 'vue';
import { Bot, CircleCheck, Link2, RefreshCw, Settings2 } from '@lucide/vue';
import { useWorkspaceStore } from '@serverdeck/plugin-sdk/stores/workspace';
import { request } from '@serverdeck/plugin-sdk/transport';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import { useModelBinding } from './model-binding';
const props = defineProps<{ settingsDialog?: boolean }>();
const binding = useModelBinding();
const { models, modelId, selected, loaded, loading, saving, error, message } = binding;
const workspace = useWorkspaceStore();
const draft = ref('');
watch([modelId, loaded], () => {
  if (loaded.value) draft.value = modelId.value;
});
async function close() {
  try {
    await request<void>('settings.close');
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
async function submit() {
  if ((await binding.save(draft.value)) && props.settingsDialog) await close();
}
</script>
<template>
  <section class="assistant-model-settings" aria-label="助手模型绑定">
    <header>
      <div>
        <h2><Link2 :size="17" aria-hidden="true" />绑定模型</h2>
        <p>助手对话统一使用此模型，适用于所有主机。</p>
      </div>
      <div class="binding-tools">
        <button class="button" :disabled="loading || saving" @click="binding.load">
          <RefreshCw :size="13" aria-hidden="true" />刷新模型列表
        </button>
        <button class="button" :disabled="saving" @click="workspace.navigate('models')">
          <Settings2 :size="14" aria-hidden="true" />管理模型
        </button>
      </div>
    </header>
    <form @submit.prevent="submit">
      <div class="binding-content">
        <div class="binding-current">
          <span>当前绑定</span>
          <strong>{{ selected?.name ?? (modelId ? '原模型已删除' : '尚未绑定') }}</strong>
          <span v-if="selected" class="binding-model-id">{{ selected.config.model }}</span>
        </div>
        <fieldset :disabled="loading || saving || models.loading || !loaded">
          <legend>
            使用模型 <span>{{ models.models.length }} 个已注册</span>
          </legend>
          <div class="binding-options">
            <label v-for="model in models.models" :key="model.id" class="binding-option">
              <input v-model="draft" type="radio" name="assistant-model" :value="model.id" />
              <Bot :size="18" class="binding-option-icon" aria-hidden="true" />
              <span class="binding-option-label">
                <strong>{{ model.name }}</strong
                ><small>{{ model.config.model }}</small>
              </span>
              <span class="binding-key" :class="{ missing: !model.hasKey }">{{
                model.hasKey ? 'Key 已配置' : '未设置 Key'
              }}</span>
              <CircleCheck
                v-if="draft === model.id"
                :size="16"
                class="binding-selected"
                aria-hidden="true"
              />
            </label>
            <label class="binding-option binding-none">
              <input v-model="draft" type="radio" name="assistant-model" value="" />
              <span class="binding-option-label"
                ><strong>未绑定模型</strong><small>暂停使用助手，保留已注册的模型</small></span
              >
            </label>
          </div>
        </fieldset>
        <p v-if="loading" role="status">正在读取模型绑定…</p>
        <p v-else-if="error || models.error" class="error-text" role="alert">
          {{ error || models.error }}
        </p>
        <p v-else-if="loaded && !models.models.length" class="subtle">
          尚未注册模型，请先在模型管理中添加。
        </p>
        <p v-else-if="modelId && !selected" class="warning-text" role="alert">
          绑定模型已删除，请选择其他模型后保存。
        </p>
        <p v-else-if="selected && !selected.hasKey" class="warning-text">
          绑定模型未设置 Key，请在模型管理中补充。
        </p>
        <p v-if="message" class="binding-saved" role="status">
          <CircleCheck :size="14" aria-hidden="true" />{{ message }}
        </p>
      </div>
      <footer>
        <span class="subtle">{{ draft !== modelId ? '有未保存的更改' : '适用于所有主机' }}</span>
        <button
          v-if="settingsDialog"
          type="button"
          class="button"
          :disabled="saving"
          @click="close"
        >
          取消
        </button>
        <button
          class="button primary"
          :disabled="!loaded || loading || saving || !!models.error || draft === modelId"
        >
          {{ saving ? '保存中…' : '保存模型绑定' }}
        </button>
      </footer>
    </form>
  </section>
</template>
<style scoped>
.assistant-model-settings {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100dvh;
  min-height: 0;
  background: var(--panel);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}
.binding-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
h2 {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 15px;
  margin: 0;
}
header p {
  color: var(--muted);
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
form {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 8px;
  min-width: 0;
  min-height: 0;
}
.binding-content {
  display: grid;
  align-content: start;
  flex: 1;
  gap: 12px;
  min-height: 0;
  overflow: auto;
  padding: 3px;
  margin: -3px;
  scrollbar-width: thin;
}
.binding-current {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--hover);
  font-size: 12px;
  flex-shrink: 0;
}
.binding-current > span {
  color: var(--muted);
}
.binding-current strong {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.binding-model-id {
  font:
    11px/1.5 Consolas,
    monospace;
  overflow-wrap: anywhere;
}
fieldset {
  display: flex;
  flex-direction: column;
  flex: 1;
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
  min-height: 0;
}
legend {
  padding: 0;
  margin-bottom: 9px;
  font-size: 12px;
  font-weight: 500;
}
legend span {
  margin-left: 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
}
.binding-options {
  display: grid;
  align-content: start;
  gap: 6px;
}
.binding-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  min-width: 0;
}
.binding-option:hover {
  background: var(--hover);
}
.binding-option:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-bg);
}
.binding-option:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.binding-option input {
  accent-color: var(--accent);
  margin: 0;
  flex-shrink: 0;
}
.binding-option-icon {
  color: var(--muted);
  flex-shrink: 0;
}
.binding-option-label {
  display: grid;
  gap: 3px;
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.binding-option-label strong {
  font-size: 12px;
  font-weight: 500;
}
.binding-option-label small {
  color: var(--muted);
  font-size: 11px;
}
.binding-key {
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
}
.binding-key.missing,
.warning-text {
  color: var(--error);
}
.binding-selected,
.binding-saved {
  color: var(--accent);
  flex-shrink: 0;
}
.binding-none {
  border-style: dashed;
}
.binding-content > p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}
.binding-saved {
  display: flex;
  gap: 6px;
  align-items: center;
}
footer {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
  margin-top: auto;
  flex-shrink: 0;
}
footer > span {
  margin-right: auto;
  align-self: center;
}
@media (max-width: 520px) {
  .assistant-model-settings {
    padding: 16px;
    gap: 14px;
  }
  form {
    gap: 12px;
  }
  footer {
    padding-top: 12px;
  }
  header {
    flex-wrap: wrap;
    gap: 10px;
  }
  .binding-option-icon,
  .binding-selected {
    display: none;
  }
  footer > span {
    flex-basis: 100%;
  }
}
</style>
