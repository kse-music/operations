<script setup lang="ts">
import { locale } from '@serverdeck/plugin-sdk/i18n';
import { tr } from '../i18n/messages';

import { computed, onMounted, ref } from 'vue';
import { useModelsStore } from '../stores/models';
import type { AiModel } from '../types/ai';
import ModelDialog from '../components/ModelDialog.vue';
import Modal from '../components/Modal.vue';
import LocalModelSources from '../components/LocalModelSources.vue';
import { Boxes, Plus, RefreshCw, Pencil, Trash2, ShieldCheck, KeyRound, Search } from '@lucide/vue';
import '../styles/models.css';
const store = useModelsStore();
const tabs = [
  {
    id: 'local',
    get label() {
      return tr('本地CLI');
    },
  },
  {
    id: 'remote',
    get label() {
      return tr('远程模型');
    },
  },
] as const;
const activeTab = ref<(typeof tabs)[number]['id']>('remote');
const search = ref('');
const registrationTimeFormat = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }),
);
const filteredModels = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return store.models
    .filter(
      (model) =>
        !query ||
        [model.config.model, model.name, model.config.baseUrl].some((value) =>
          value.toLocaleLowerCase().includes(query),
        ),
    )
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
});
const localSources = ref<InstanceType<typeof LocalModelSources>>();
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
  <section class="asset-view page-view models-view" :aria-label="tr('模型')">
    <div class="section-heading">
      <h1 class="asset-title">{{ tr('模型') }}</h1>
      <div class="toolbar model-toolbar">
        <button
          v-if="activeTab === 'local'"
          class="button"
          :disabled="!localSources || localSources.loading || !!localSources.busy"
          @click="localSources?.refresh()"
        >
          <RefreshCw
            :size="15"
            :class="{ 'model-spin': localSources?.loading }"
            aria-hidden="true"
          />
          {{ tr('刷新 ') }}
        </button>
        <template v-else>
          <button class="button" :disabled="store.loading || store.busy" @click="store.refresh">
            <RefreshCw :size="14" :class="{ 'model-spin': store.loading }" aria-hidden="true" />{{
              tr('刷新 ')
            }}</button
          ><button
            class="button primary"
            :disabled="store.busy || store.loading || !store.loaded"
            @click="open()"
          >
            <Plus :size="15" aria-hidden="true" />{{ tr('注册模型 ') }}
          </button>
        </template>
      </div>
    </div>
    <div class="model-tabs" role="tablist" :aria-label="tr('模型来源')" @keydown="navigateTabs">
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
      <LocalModelSources ref="localSources" />
    </div>
    <div
      v-show="activeTab === 'remote'"
      id="model-panel-remote"
      class="model-tab-panel"
      role="tabpanel"
      aria-labelledby="model-tab-remote"
    >
      <div class="model-filterbar" role="search" :aria-label="tr('筛选远程模型')">
        <label class="model-search">
          <Search :size="16" aria-hidden="true" />
          <input
            v-model="search"
            type="search"
            :aria-label="tr('搜索模型')"
            :placeholder="tr('搜索模型 ID、名称或连接地址')"
          />
        </label>
        <p v-if="store.loaded" class="model-filter-summary" role="status">
          {{ tr('显示 {0} / {1} 个模型', filteredModels.length, store.models.length) }}
        </p>
      </div>
      <p v-if="store.loading" class="asset-feedback" role="status">{{ tr('正在读取模型列表…') }}</p>
      <p v-if="store.error && !dialog && !deleting" class="asset-feedback error-text" role="alert">
        {{ store.error }}
      </p>
      <p v-if="store.message" class="asset-feedback success" role="status">{{ store.message }}</p>
      <div v-if="store.loaded && !store.loading && !store.models.length" class="asset-panel">
        <div class="asset-empty">
          <span class="asset-icon"><Boxes :size="18" aria-hidden="true" /></span>
          <div>
            <h2>{{ tr('尚未注册模型') }}</h2>
            <p class="subtle">
              {{ tr('点击“注册模型”填写 API 地址、模型 ID 和 Key，测试通过后即可添加。') }}
            </p>
          </div>
        </div>
      </div>
      <div
        v-if="store.loaded && !store.loading && store.models.length && !filteredModels.length"
        class="asset-panel"
        role="status"
      >
        <div class="asset-empty">
          <span class="asset-icon"><Search :size="18" aria-hidden="true" /></span>
          <div>
            <h2>{{ tr('没有匹配的模型') }}</h2>
            <p class="subtle">{{ tr('试试其他关键词，或清空搜索。') }}</p>
          </div>
        </div>
        <div>
          <button class="button" @click="search = ''">{{ tr('清除搜索') }}</button>
        </div>
      </div>
      <div v-if="filteredModels.length" class="model-catalog">
        <div class="model-list-heading">
          <span>{{ tr('模型 ID') }}</span
          ><span>{{ tr('连接地址') }}</span
          ><span>{{ tr('上下文窗口') }}</span
          ><span>{{ tr('最大输出 Token') }}</span
          ><span>{{ tr('Key 状态') }}</span
          ><span>{{ tr('注册时间') }}</span
          ><span>{{ tr('操作') }}</span>
        </div>
        <ul class="model-list">
          <li v-for="model in filteredModels" :key="model.id">
            <div class="model-identity">
              <h2>
                <code class="model-id">{{ model.config.model }}</code>
              </h2>
              <p v-if="model.name !== model.config.model" class="model-name">{{ model.name }}</p>
            </div>
            <div class="model-connection">
              <p class="model-endpoint" :title="model.config.baseUrl">{{ model.config.baseUrl }}</p>
              <div v-if="model.config.baseUrl.startsWith('http:')" class="model-badges">
                <span class="model-badge">{{ tr('HTTP 明文') }}</span>
              </div>
            </div>
            <div class="model-limit">
              <strong>{{ model.config.contextWindowTokens.toLocaleString(locale) }}</strong>
              <span class="model-field-label">{{ tr('上下文窗口') }}</span>
            </div>
            <div class="model-limit model-output-limit">
              <strong>{{ model.config.maxOutputTokens.toLocaleString(locale) }}</strong>
              <span class="model-field-label">{{ tr('最大输出 Token') }}</span>
            </div>
            <div class="model-key-status">
              <span class="model-field-label">{{ tr('Key 状态') }}</span>
              <span
                class="model-badge"
                :class="{ ready: model.hasKey }"
                :title="model.hasKey ? tr('Key 已存系统凭据库') : tr('未设置 Key')"
              >
                <ShieldCheck v-if="model.hasKey" :size="12" aria-hidden="true" />
                <KeyRound v-else :size="12" aria-hidden="true" />
                {{ model.hasKey ? tr('已配置') : tr('未设置 Key') }}
              </span>
            </div>
            <div class="model-registration-time">
              <span class="model-field-label">{{ tr('注册时间') }}</span>
              <time v-if="model.createdAt" :datetime="model.createdAt">{{
                registrationTimeFormat.format(new Date(model.createdAt)).replaceAll('/', '-')
              }}</time>
              <span v-else>{{ tr('未知') }}</span>
            </div>
            <div class="model-row-actions">
              <button
                class="icon-button"
                :disabled="store.busy || store.loading"
                :aria-label="tr('编辑模型 {0}', model.name)"
                :title="tr('编辑模型')"
                @click="open(model)"
              >
                <Pencil :size="16" aria-hidden="true" /></button
              ><button
                class="icon-button danger"
                :disabled="store.busy || store.loading"
                :aria-label="tr('删除模型 {0}', model.name)"
                :title="tr('删除模型')"
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
    </div>
    <ModelDialog v-if="dialog" :model="editing" @close="dialog = false" @saved="dialog = false" />
    <Modal v-if="deleting" :title="tr('确认删除模型')" :busy="store.busy" @close="deleting = null">
      <p v-if="store.error" class="error-text" role="alert">{{ store.error }}</p>
      <p>
        {{ tr('删除“') }}{{ deleting.name }}”（{{ deleting.config.model
        }}{{ tr('）及其系统保存的 Key？') }}
      </p>
      <p class="path">{{ deleting.config.baseUrl }}</p>
      <p class="muted">{{ tr('该模型的旧发送预览和命令建议会失效。') }}</p>
      <div class="dialog-actions">
        <button class="button" :disabled="store.busy" @click="deleting = null">
          {{ tr('取消') }}</button
        ><button class="button danger" :disabled="store.busy" @click="remove">
          {{ tr('确认删除模型') }}
        </button>
      </div>
    </Modal>
  </section>
</template>
