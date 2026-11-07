<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Bot,
  CircleCheck,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
} from '@lucide/vue';
import { useWorkspaceStore } from '@serverdeck/plugin-sdk/stores/workspace';
import { request } from '@serverdeck/plugin-sdk/transport';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import { isLocalModel } from '@serverdeck/plugin-sdk/types/ai';
import { useModelBinding } from './model-binding';
import LocalToolInstallNotice from './LocalToolInstallNotice.vue';

const props = defineProps<{ settingsDialog?: boolean }>();
const binding = useModelBinding();
const {
  models,
  modelId,
  selected,
  loaded,
  loading,
  saving,
  installing,
  error,
  message,
  localSources,
  localSelected,
} = binding;
const workspace = useWorkspaceStore();
const draft = ref('');
const localDraft = computed(() => localSources.value.find((source) => source.id === draft.value));
const localState = computed(() =>
  localDraft.value?.status.installed === false
    ? 'missing'
    : localDraft.value?.status.model
      ? 'ready'
      : localDraft.value?.status.authorized
        ? 'unavailable'
        : 'unauthorized',
);
const localModel = computed(() => {
  const model = localDraft.value?.status.model?.config.model;
  return model === 'default' ? '跟随本机默认模型' : model;
});
const currentName = computed(
  () =>
    localSelected.value?.name ??
    selected.value?.name ??
    (modelId.value ? '原模型已删除' : '尚未绑定'),
);
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
    <header class="binding-heading">
      <span class="binding-heading-icon"><Bot :size="20" aria-hidden="true" /></span>
      <div class="binding-intro">
        <h2>绑定模型</h2>
        <p>选择助手使用的模型来源。</p>
      </div>
      <button
        type="button"
        class="button binding-refresh"
        aria-label="刷新模型列表"
        title="刷新模型列表"
        :disabled="loading || saving || !!installing"
        @click="binding.load"
      >
        <RefreshCw :size="16" :class="{ 'binding-spinning': loading }" aria-hidden="true" />
      </button>
    </header>
    <form @submit.prevent="submit">
      <div class="binding-content">
        <fieldset :disabled="loading || saving || models.loading || !loaded">
          <legend class="binding-sr-only">使用模型</legend>
          <section class="binding-group" aria-labelledby="binding-local-title">
            <div class="binding-group-heading">
              <h3 id="binding-local-title">本地服务</h3>
              <span>复用本机配置与登录</span>
            </div>
            <div class="binding-local-options">
              <label
                v-for="source in localSources"
                :key="source.id"
                class="binding-option binding-source"
              >
                <input
                  v-model="draft"
                  class="binding-sr-only"
                  type="radio"
                  name="assistant-model"
                  :value="source.id"
                  :disabled="!!installing"
                />
                <span class="binding-source-icon"
                  ><component
                    :is="source.id === 'local-codex' ? Terminal : Sparkles"
                    :size="19"
                    aria-hidden="true"
                /></span>
                <span class="binding-option-label"
                  ><strong>{{ source.name }}</strong
                  ><small
                    ><i :class="{ ready: source.status.model }" aria-hidden="true" />{{
                      source.status.installed === false
                        ? '未安装'
                        : source.status.model
                          ? '已连接'
                          : source.status.authorized
                            ? '未就绪'
                            : '未授权'
                    }}</small
                  ></span
                >
                <span class="binding-choice" aria-hidden="true" />
              </label>
            </div>
            <LocalToolInstallNotice
              v-if="localDraft && localState === 'missing'"
              :name="localDraft.name"
              :model-id="localDraft.id"
              :installing="!!installing"
              :supported="localDraft.status.installSupported !== false"
              :disabled="loading || saving"
              @install="binding.installLocal(draft)"
              @cancel="binding.cancelInstall"
              @refresh="binding.refreshLocal(draft)"
            />
            <div v-else-if="localDraft" class="binding-local" :data-state="localState">
              <div class="binding-connection" role="status">
                <CircleCheck v-if="localState === 'ready'" :size="18" aria-hidden="true" />
                <ShieldCheck v-else :size="18" aria-hidden="true" />
                <div>
                  <strong>{{
                    localState === 'ready'
                      ? `已连接${localDraft.name}`
                      : localState === 'unavailable'
                        ? '连接未就绪'
                        : '授权本地访问'
                  }}</strong>
                  <p>
                    {{
                      localState === 'ready'
                        ? localModel
                        : localDraft.status.message || '授权后使用已有配置，无需重复登录。'
                    }}
                  </p>
                </div>
              </div>
              <button
                v-if="!localDraft.status.authorized"
                type="button"
                class="button binding-authorize"
                :disabled="loading || saving"
                @click="binding.authorizeLocal(draft, true)"
              >
                授权使用{{ localDraft.name }}
              </button>
              <button
                v-else
                type="button"
                class="button binding-link"
                :disabled="loading || saving"
                @click="binding.authorizeLocal(draft, false)"
              >
                撤销本地授权
              </button>
            </div>
          </section>
          <section class="binding-group" aria-labelledby="binding-managed-title">
            <div class="binding-group-heading">
              <h3 id="binding-managed-title">
                模型管理 <span class="binding-count">{{ models.models.length }}</span>
              </h3>
              <button
                type="button"
                class="button binding-link"
                :disabled="saving || !!installing"
                @click="workspace.navigate('models')"
              >
                <Settings2 :size="14" aria-hidden="true" />管理模型
              </button>
            </div>
            <div v-if="models.models.length" class="binding-registered">
              <label
                v-for="model in models.models"
                :key="model.id"
                class="binding-option binding-model"
              >
                <input
                  v-model="draft"
                  class="binding-sr-only"
                  type="radio"
                  name="assistant-model"
                  :value="model.id"
                  :disabled="!!installing"
                />
                <span class="binding-option-label"
                  ><strong>{{ model.name }}</strong
                  ><small>{{ model.config.model }}</small></span
                >
                <span class="binding-key" :class="{ missing: !model.hasKey }">{{
                  model.hasKey ? 'Key 已配置' : '未设置 Key'
                }}</span>
                <span class="binding-choice" aria-hidden="true" />
              </label>
            </div>
            <p v-else-if="!loading && !models.error" class="binding-empty">
              暂无已注册模型，可前往模型管理添加。
            </p>
          </section>
          <label class="binding-option binding-none">
            <input
              v-model="draft"
              class="binding-sr-only"
              type="radio"
              name="assistant-model"
              value=""
              :disabled="!!installing"
            />
            <span class="binding-option-label"
              ><strong>未绑定模型</strong><small>暂停助手，保留已有配置</small></span
            >
            <span class="binding-choice" aria-hidden="true" />
          </label>
        </fieldset>
        <p v-if="loading" class="binding-feedback" role="status">正在读取模型绑定…</p>
        <p
          v-else-if="error || (!isLocalModel(draft) && models.error)"
          class="binding-feedback error-text"
          role="alert"
        >
          {{ error || models.error }}
        </p>
        <p
          v-else-if="modelId && !isLocalModel(modelId) && !selected"
          class="binding-feedback warning-text"
          role="alert"
        >
          绑定模型已删除，请选择其他模型后保存。
        </p>
        <p v-else-if="selected && !selected.hasKey" class="binding-feedback warning-text">
          绑定模型未设置 Key，请在模型管理中补充。
        </p>
      </div>
      <footer>
        <div class="binding-current">
          <span
            >当前绑定 <strong :title="currentName">{{ currentName }}</strong></span
          ><small :class="{ 'binding-pending': draft !== modelId }" role="status">{{
            draft !== modelId ? '有未保存的更改' : message || '适用于所有主机'
          }}</small>
        </div>
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
          :disabled="
            !loaded ||
            loading ||
            saving ||
            !!installing ||
            (!isLocalModel(draft) && !!models.error) ||
            (localDraft && !localDraft.status.model) ||
            draft === modelId
          "
        >
          {{ saving ? '保存中…' : '保存模型绑定' }}
        </button>
      </footer>
    </form>
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
