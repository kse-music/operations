<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useModelsStore } from '../stores/models';
import type { AiModel } from '../types/ai';
import ModelDialog from '../components/ModelDialog.vue';
import Modal from '../components/Modal.vue';
import LocalModelSources from '../components/LocalModelSources.vue';
import { Boxes, Plus, RefreshCw, Pencil, Trash2, ShieldCheck, KeyRound } from '@lucide/vue';
import '../styles/models.css';
const store = useModelsStore();
const tabs = [
  { id: 'local', label: '本地来源' },
  { id: 'remote', label: '远程模型' },
] as const;
const activeTab = ref<(typeof tabs)[number]['id']>('remote');
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
function navigateTabs(event: KeyboardEvent) {
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight':
      activeTab.value = activeTab.value === 'local' ? 'remote' : 'local';
      break;
    case 'Home':
      activeTab.value = 'local';
      break;
    case 'End':
      activeTab.value = 'remote';
      break;
    default:
      return;
  }
  event.preventDefault();
  (event.currentTarget as HTMLElement)
    .querySelector<HTMLButtonElement>(`#model-tab-${activeTab.value}`)
    ?.focus();
}
onMounted(() => void store.refresh());
</script>
<template>
  <section class="asset-view page-view models-view" aria-label="模型管理">
    <div class="section-heading">
      <div>
        <h1 class="asset-title">模型管理</h1>
        <p class="section-description">
          管理平台模型服务、API Key 与本地模型来源，供已授权插件调用。
        </p>
      </div>
    </div>
    <div class="model-tabs" role="tablist" aria-label="模型来源" @keydown="navigateTabs">
      <button
        v-for="tab in tabs"
        :id="`model-tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.id"
        :aria-controls="`model-panel-${tab.id}`"
        :tabindex="activeTab === tab.id ? 0 : -1"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
        <span v-if="tab.id === 'remote' && store.loaded" class="asset-count">{{
          store.models.length
        }}</span>
      </button>
    </div>
    <div
      v-show="activeTab === 'local'"
      id="model-panel-local"
      class="model-tab-panel"
      role="tabpanel"
      aria-labelledby="model-tab-local"
    >
      <LocalModelSources />
    </div>
    <div
      v-show="activeTab === 'remote'"
      id="model-panel-remote"
      class="model-tab-panel"
      role="tabpanel"
      aria-labelledby="model-tab-remote"
    >
      <div class="toolbar model-toolbar">
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
      <p v-if="store.loading" class="asset-feedback" role="status">正在读取模型列表…</p>
      <p v-if="store.error && !dialog && !deleting" class="asset-feedback error-text" role="alert">
        {{ store.error }}
      </p>
      <p v-if="store.message" class="asset-feedback success" role="status">{{ store.message }}</p>
      <div v-if="store.loaded && !store.loading && !store.models.length" class="asset-panel">
        <div class="asset-empty">
          <span class="asset-icon"><Boxes :size="18" aria-hidden="true" /></span>
          <div>
            <h2>尚未注册模型</h2>
            <p class="subtle">点击“注册模型”填写 API 地址、模型 ID 和 Key，测试通过后即可添加。</p>
          </div>
        </div>
      </div>
      <div v-if="store.models.length" class="model-catalog">
        <div class="model-list-heading">
          <span>模型 / 提供商</span><span>连接地址</span><span>Token 限制</span><span>操作</span>
        </div>
        <ul class="model-list">
          <li v-for="model in store.models" :key="model.id">
            <div class="model-identity asset-identity">
              <span class="asset-icon"><Boxes :size="18" aria-hidden="true" /></span>
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
              <strong>{{ model.config.contextWindowTokens.toLocaleString() }}</strong>
              <span>上下文窗口</span>
              <span>输出 ≤ {{ model.config.maxOutputTokens.toLocaleString() }}</span>
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
      <p class="asset-feedback model-page-note">
        <ShieldCheck :size="14" aria-hidden="true" />Key 保存于系统凭据库。注册后，可在 AI
        运维助手的插件设置中绑定模型。
      </p>
    </div>
    <ModelDialog v-if="dialog" :model="editing" @close="dialog = false" @saved="dialog = false" />
    <Modal v-if="deleting" title="确认删除模型" :busy="store.busy" @close="deleting = null">
      <p v-if="store.error" class="error-text" role="alert">{{ store.error }}</p>
      <p>删除“{{ deleting.name }}”（{{ deleting.config.model }}）及其系统保存的 Key？</p>
      <p class="path">{{ deleting.config.baseUrl }}</p>
      <p class="muted">该模型的旧发送预览和命令建议会失效。</p>
      <div class="dialog-actions">
        <button class="button" :disabled="store.busy" @click="deleting = null">取消</button
        ><button class="button danger" :disabled="store.busy" @click="remove">确认删除模型</button>
      </div>
    </Modal>
  </section>
</template>
