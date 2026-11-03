<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useModelsStore } from '../stores/models';
import type { AiModel } from '../types/ai';
import ModelDialog from '../components/ModelDialog.vue';
import Modal from '../components/Modal.vue';
import { Boxes, Plus, RefreshCw, Pencil, Trash2, ShieldCheck, KeyRound } from '@lucide/vue';
import '../styles/models.css';
const store = useModelsStore();
const dialog = ref(false),
  editing = ref<AiModel>(),
  deleting = ref<AiModel | null>(null);
function open(model?: AiModel) {
  store.error = '';
  editing.value = model;
  dialog.value = true;
}
async function remove() {
  if (deleting.value && (await store.remove(deleting.value))) deleting.value = null;
}
onMounted(() => void store.refresh());
</script>
<template>
  <section class="page-view models-view" aria-label="模型管理">
    <div class="section-heading">
      <div>
        <h1>
          模型管理 <span class="model-count">{{ store.models.length }}</span>
        </h1>
        <p class="muted">管理 AI 助手使用的模型服务与连接凭据。</p>
      </div>
      <div class="toolbar">
        <button class="button" :disabled="store.loading || store.busy" @click="store.refresh">
          <RefreshCw
            :size="14"
            :class="{ 'model-spin': store.loading }"
            aria-hidden="true"
          />刷新模型</button
        ><button
          class="button primary"
          :disabled="store.busy || store.loading || !store.loaded"
          @click="open()"
        >
          <Plus :size="15" aria-hidden="true" />注册模型
        </button>
      </div>
    </div>
    <p v-if="store.loading" role="status">正在读取模型列表…</p>
    <p v-if="store.error && !dialog && !deleting" class="error-text" role="alert">
      {{ store.error }}
    </p>
    <p v-if="store.message" class="model-notice" role="status">{{ store.message }}</p>
    <div v-if="store.loaded && !store.loading && !store.models.length" class="model-empty">
      <div class="model-empty-icon"><Boxes :size="28" aria-hidden="true" /></div>
      <h2>尚未注册模型</h2>
      <p>添加模型服务，开始使用 AI 辅助诊断。</p>
      <p class="muted">点击“注册模型”填写 API 地址、模型 ID 和 Key，测试通过后即可添加。</p>
    </div>
    <div v-if="store.models.length" class="model-catalog">
      <div class="model-list-heading">
        <span>模型 / 提供商</span><span>连接地址</span><span>输出上限</span><span>操作</span>
      </div>
      <ul class="model-list">
        <li v-for="model in store.models" :key="model.id">
          <div class="model-identity">
            <div class="model-avatar"><Boxes :size="20" aria-hidden="true" /></div>
            <div>
              <h2>{{ model.name }}</h2>
              <code class="model-id">{{ model.config.model }}</code>
              <p class="muted model-provider">OpenAI 兼容 API</p>
            </div>
          </div>
          <div class="model-connection">
            <p class="model-endpoint" :title="model.config.baseUrl">{{ model.config.baseUrl }}</p>
            <div class="model-badges">
              <span class="model-badge" :class="{ ready: model.hasKey }"
                ><ShieldCheck v-if="model.hasKey" :size="12" aria-hidden="true" /><KeyRound
                  v-else
                  :size="12"
                  aria-hidden="true"
                />{{ model.hasKey ? 'Key 已存系统凭据库' : '未设置 Key' }}</span
              ><span v-if="model.config.baseUrl.startsWith('http:')" class="model-badge"
                >HTTP 明文</span
              >
            </div>
          </div>
          <div class="model-limit">
            <strong>{{ model.config.maxOutputTokens.toLocaleString() }}</strong
            ><span>Token / 次</span>
          </div>
          <div class="model-row-actions">
            <button
              class="icon-button"
              :disabled="store.busy || store.loading"
              :aria-label="`编辑模型 ${model.name}`"
              title="编辑模型"
              @click="open(model)"
            >
              <Pencil :size="16" aria-hidden="true" /></button
            ><button
              class="icon-button danger"
              :disabled="store.busy || store.loading"
              :aria-label="`删除模型 ${model.name}`"
              title="删除模型"
              @click="
                store.error = '';
                deleting = model;
              "
            >
              <Trash2 :size="16" aria-hidden="true" />
            </button>
          </div>
        </li>
      </ul>
    </div>
    <p class="model-page-note">
      <ShieldCheck :size="14" aria-hidden="true" />Key 安全存储于系统凭据库。注册后，在 AI
      运维助手中选择模型即可使用。
    </p>
    <ModelDialog v-if="dialog" :model="editing" @close="dialog = false" @saved="dialog = false" />
    <Modal v-if="deleting" title="确认删除模型" :busy="store.busy" @close="deleting = null">
      <p v-if="store.error" class="error-text" role="alert">{{ store.error }}</p>
      <p>删除“{{ deleting.name }}”（{{ deleting.config.model }}）及其系统保存的 Key？</p>
      <p class="path">{{ deleting.config.baseUrl }}</p>
      <p class="muted">
        该模型的旧发送预览和命令建议会失效。凭据清理失败会明确提示，可在安全凭据页重试清理。
      </p>
      <div class="dialog-actions">
        <button class="button" :disabled="store.busy" @click="deleting = null">取消</button
        ><button class="button danger" :disabled="store.busy" @click="remove">确认删除模型</button>
      </div>
    </Modal>
  </section>
</template>
