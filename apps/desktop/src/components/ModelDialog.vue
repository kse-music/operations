<script setup lang="ts">
import { ref } from 'vue';
import { CheckCircle2, FlaskConical, KeyRound, LoaderCircle, PlugZap } from '@lucide/vue';
import { useModelForm } from '../composables/model-form';
import type { AiModel } from '../types/ai';
import Modal from './Modal.vue';
const props = defineProps<{ model?: AiModel }>();
const emit = defineEmits<{ saved: []; close: [] }>();
const {
  store,
  config,
  name,
  apiKey,
  clearKey,
  saving,
  testing,
  testError,
  testMessage,
  receipt,
  needsTest,
  canSave,
  test,
  save,
} = useModelForm(props.model, () => emit('saved'));
const form = ref<HTMLFormElement>();
function testConnection() {
  if (form.value?.reportValidity()) void test();
}
</script>
<template>
  <Modal :title="model ? '编辑模型' : '注册模型'" :busy="saving" wide @close="emit('close')">
    <form ref="form" class="model-form" @submit.prevent="save">
      <p class="model-form-intro">连接你的模型服务，供 AI 运维助手使用。</p>
      <fieldset :disabled="store.busy || store.loading || saving || testing">
        <section class="model-form-section" aria-label="模型连接">
          <div class="model-section-title">
            <PlugZap :size="16" aria-hidden="true" />
            <h3>模型连接</h3>
            <span>必填</span>
          </div>
          <div class="model-fields">
            <label
              >模型名称<input
                v-model.trim="name"
                required
                maxlength="120"
                autofocus
                placeholder="例如：内网诊断模型"
            /></label>
            <label
              >提供商<select v-model="config.provider">
                <option value="openai_compatible">OpenAI 兼容 API</option>
              </select></label
            >
            <label class="model-field-wide"
              >Base URL（含服务要求的 /v1）<input
                v-model.trim="config.baseUrl"
                type="url"
                required
                autocomplete="off"
                placeholder="https://api.example.com/v1"
            /></label>
            <label class="model-field-wide"
              >模型 ID<input
                v-model.trim="config.model"
                required
                maxlength="200"
                autocomplete="off"
                placeholder="填写服务实际提供的模型 ID"
            /></label>
            <label class="model-field-wide"
              >API Key（留空保留已有 Key）<input
                v-model="apiKey"
                type="password"
                autocomplete="new-password"
                :disabled="clearKey"
                maxlength="4096"
                :placeholder="model?.hasKey ? '已安全保存，留空保留' : '输入 API Key'"
            /></label>
          </div>
          <div class="model-key-note">
            <KeyRound :size="14" aria-hidden="true" /><span
              >仅存系统凭据库，不写入配置、不回显。更换地址须重新填写 Key。</span
            >
          </div>
          <label v-if="model?.hasKey" class="model-check"
            ><input v-model="clearKey" type="checkbox" @change="apiKey = ''" />清除已保存的
            Key</label
          >
          <label class="model-check"
            ><input v-model="config.allowInsecureHttp" type="checkbox" />明确允许 HTTP
            明文传输（仅用于可信网络）</label
          >
          <p v-if="config.baseUrl.startsWith('http:')" class="warning-text model-http-note">
            HTTP 会明文传输 Key 和授权上下文。
          </p>
        </section>
        <details class="model-advanced">
          <summary>上下文与输出<span>Token 限制</span></summary>
          <div class="model-fields">
            <label
              >上下文窗口（Token）<input
                v-model.number="config.contextWindowTokens"
                type="number"
                min="1024"
                max="10000000"
                required
            /></label>
            <label
              >最大输出 Token<input
                v-model.number="config.maxOutputTokens"
                type="number"
                min="256"
                :max="Math.min(8192, config.contextWindowTokens - 1)"
                required
            /></label>
          </div>
          <p class="muted">
            填写模型支持的输入与输出 Token 总量。应用会为最大输出预留空间，再估算可发送的上下文。
          </p>
        </details>
      </fieldset>
      <div
        class="model-test-panel"
        :class="{ success: receipt, failed: testError }"
        :aria-busy="testing"
      >
        <div class="model-test-heading">
          <div>
            <CheckCircle2 v-if="receipt" :size="18" aria-hidden="true" /><FlaskConical
              v-else
              :size="18"
              aria-hidden="true"
            /><strong>连接测试</strong>
          </div>
          <button
            class="button"
            type="button"
            :disabled="testing || saving || store.busy || store.loading || clearKey"
            @click="testConnection"
          >
            <LoaderCircle v-if="testing" class="model-spin" :size="14" aria-hidden="true" />{{
              testing ? '测试中…' : receipt ? '重新测试' : '测试连接'
            }}
          </button>
        </div>
        <p v-if="testError" role="alert" class="error-text">{{ testError }}</p>
        <p v-else-if="testing" role="status">正在验证地址、模型 ID 和 Key，请稍候…</p>
        <p v-else-if="testMessage" role="status">{{ testMessage }}</p>
        <p v-else>
          {{
            needsTest
              ? '测试通过后才可保存，修改配置后需重新测试。'
              : '当前连接配置未变更，可直接保存。'
          }}
        </p>
        <small>仅发送固定测试消息，不包含服务器数据；最多输出 256 Token，可能产生少量费用。</small>
      </div>
      <p v-if="store.error" role="alert" class="model-save-error error-text">{{ store.error }}</p>
      <footer class="model-form-footer">
        <span>{{ needsTest && !receipt ? '请先完成连接测试' : 'Key 将安全保存至系统凭据库' }}</span>
        <div>
          <button class="button" type="button" :disabled="saving" @click="emit('close')">
            取消</button
          ><button class="button primary" type="submit" :disabled="!canSave">
            {{ saving ? '保存中…' : '保存模型' }}
          </button>
        </div>
      </footer>
    </form>
  </Modal>
</template>
