<script setup lang="ts">
import { tr } from '../i18n/messages';

import { ref } from 'vue';
import { KeyRound, LoaderCircle } from '@lucide/vue';
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
  <Modal
    :title="model ? tr('编辑模型') : tr('注册模型')"
    :busy="saving"
    wide
    @close="emit('close')"
  >
    <form ref="form" class="model-form" @submit.prevent="save">
      <p class="model-form-intro">{{ tr('连接你的模型服务，供 AI 运维助手使用。') }}</p>
      <fieldset :disabled="store.busy || store.loading || saving || testing">
        <div class="model-fields">
          <label
            >{{ tr('模型名称')
            }}<input
              v-model.trim="name"
              required
              maxlength="120"
              autofocus
              :placeholder="tr('例如：内网诊断模型')"
          /></label>
          <label
            >{{ tr('提供商')
            }}<select v-model="config.provider">
              <option value="openai_compatible">{{ tr('OpenAI 兼容 API') }}</option>
            </select></label
          >
          <label class="model-field-wide"
            >{{ tr('Base URL（含服务要求的 /v1）')
            }}<input
              v-model.trim="config.baseUrl"
              type="url"
              required
              autocomplete="off"
              placeholder="https://api.example.com/v1"
          /></label>
          <label class="model-field-wide"
            >{{ tr('模型 ID')
            }}<input
              v-model.trim="config.model"
              required
              maxlength="200"
              autocomplete="off"
              :placeholder="tr('填写服务实际提供的模型 ID')"
          /></label>
          <label class="model-field-wide"
            >{{ tr('API Key（留空保留已有 Key）')
            }}<input
              v-model="apiKey"
              type="password"
              autocomplete="new-password"
              :disabled="clearKey"
              maxlength="4096"
              :placeholder="model?.hasKey ? tr('已安全保存，留空保留') : tr('输入 API Key')"
          /></label>
        </div>
        <div class="model-key-note">
          <KeyRound :size="14" aria-hidden="true" /><span>{{
            tr('仅存系统凭据库，不写入配置、不回显。更换地址须重新填写 Key。')
          }}</span>
        </div>
        <label v-if="model?.hasKey" class="model-check"
          ><input v-model="clearKey" type="checkbox" @change="apiKey = ''" />{{
            tr('清除已保存的 Key')
          }}</label
        >
        <label class="model-check"
          ><input v-model="config.allowInsecureHttp" type="checkbox" />{{
            tr('明确允许 HTTP 明文传输（仅用于可信网络）')
          }}</label
        >
        <p v-if="config.baseUrl.startsWith('http:')" class="warning-text model-http-note">
          {{ tr(' HTTP 会明文传输 Key 和授权上下文。 ') }}
        </p>
        <div class="model-fields model-token-fields">
          <label
            >{{ tr('上下文窗口（Token）')
            }}<input
              v-model.number="config.contextWindowTokens"
              type="number"
              min="1024"
              max="10000000"
              required
          /></label>
          <label
            >{{ tr('最大输出 Token')
            }}<input
              v-model.number="config.maxOutputTokens"
              type="number"
              min="256"
              :max="Math.min(8192, config.contextWindowTokens - 1)"
              required
          /></label>
        </div>
      </fieldset>
      <p v-if="store.error" role="alert" class="model-save-error error-text">{{ store.error }}</p>
      <footer class="model-form-footer">
        <div class="model-form-status" :class="{ success: receipt }" :aria-busy="testing">
          <p v-if="testError" role="alert" class="error-text">{{ testError }}</p>
          <p v-else-if="testing" role="status">{{ tr('正在验证地址、模型 ID 和 Key，请稍候…') }}</p>
          <p v-else-if="testMessage" role="status">{{ testMessage }}</p>
          <p v-else>
            {{ needsTest ? tr('请先完成连接测试') : tr('当前连接配置未变更，可直接保存。') }}
          </p>
        </div>
        <div class="model-form-actions">
          <button
            class="button"
            type="button"
            :disabled="testing || saving || store.busy || store.loading || clearKey"
            @click="testConnection"
          >
            <LoaderCircle v-if="testing" class="model-spin" :size="14" aria-hidden="true" />{{
              testing ? tr('测试中…') : receipt ? tr('重新测试') : tr('测试连接')
            }}
          </button>
          <button class="button" type="button" :disabled="saving" @click="emit('close')">
            {{ tr(' 取消') }}</button
          ><button class="button primary" type="submit" :disabled="!canSave">
            {{ saving ? tr('保存中…') : tr('保存模型') }}
          </button>
        </div>
      </footer>
    </form>
  </Modal>
</template>
