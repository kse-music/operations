<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Plus } from '@lucide/vue';
import EnvironmentTagBadge from '../components/EnvironmentTagBadge.vue';
import Modal from '../components/Modal.vue';
import { tr } from '../i18n/messages';
import { useHostsStore } from '../stores/hosts';
import {
  environmentTagColors,
  type EnvironmentTag,
  type EnvironmentTagInput,
} from '../types/hosts';
import { viewLabels } from '../types/product';

const store = useHostsStore();
const tags = computed(() => store.catalog?.environmentTags?.tags ?? []);
const counts = computed(() => {
  const counts = new Map<string, number>();
  for (const id of Object.values(store.catalog?.environmentTags?.assignments ?? {}))
    counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
});
const colorLabels = computed(() => ({
  red: tr('红色'),
  amber: tr('琥珀色'),
  blue: tr('蓝色'),
  green: tr('绿色'),
  violet: tr('紫色'),
  gray: tr('灰色'),
}));
const draft = ref<(EnvironmentTagInput & { id: string | null }) | null>(null);
const deleting = ref<EnvironmentTag | null>(null);
onMounted(() => {
  if (!store.catalog && !store.busy) void store.load();
});

function edit(tag?: EnvironmentTag): void {
  store.error = null;
  draft.value = tag ? { ...tag } : { id: null, name: '', color: 'gray' };
}

async function save(): Promise<void> {
  if (!draft.value || store.busy) return;
  const { id, name, color } = draft.value;
  if (await store.saveEnvironmentTag(id, { name, color })) draft.value = null;
}

function confirmDelete(tag: EnvironmentTag): void {
  store.error = null;
  deleting.value = tag;
}

async function remove(): Promise<void> {
  if (deleting.value && !store.busy && (await store.deleteEnvironmentTag(deleting.value.id)))
    deleting.value = null;
}
</script>

<template>
  <section class="page-view environment-settings" :aria-label="viewLabels.settingsEnvironmentTags">
    <header class="environment-settings-header">
      <div>
        <h2>{{ viewLabels.settingsEnvironmentTags }}</h2>
        <p class="subtle">{{ tr('修改名称或颜色后，所有使用该标签的主机会同步更新。') }}</p>
      </div>
      <button class="button primary" :disabled="!store.catalog || store.busy" @click="edit()">
        <Plus :size="16" aria-hidden="true" />{{ tr('新建标签') }}
      </button>
    </header>
    <div v-if="!store.catalog" class="environment-settings-state">
      <p v-if="store.busy" role="status">{{ tr('正在加载主机目录…') }}</p>
      <template v-else>
        <p v-if="store.error" class="error-text" role="alert">{{ store.error }}</p>
        <button class="button" @click="store.load()">{{ tr('刷新') }}</button>
      </template>
    </div>
    <p v-else-if="!tags.length" class="environment-settings-state subtle" role="status">
      {{ tr('暂无标签') }}
    </p>
    <div v-else class="environment-settings-table">
      <table :aria-label="viewLabels.settingsEnvironmentTags">
        <thead>
          <tr>
            <th scope="col">{{ tr('标签') }}</th>
            <th scope="col">{{ tr('已分配') }}</th>
            <th scope="col">{{ tr('操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tag in tags" :key="tag.id">
            <td><EnvironmentTagBadge :tag="tag" /></td>
            <td>{{ tr('{0} 台主机', counts.get(tag.id) ?? 0) }}</td>
            <td>
              <div class="environment-settings-actions">
                <button
                  class="button"
                  :aria-label="tr('编辑标签 {0}', tag.name)"
                  :disabled="store.busy"
                  @click="edit(tag)"
                >
                  {{ tr('编辑') }}
                </button>
                <button
                  class="button danger"
                  :aria-label="tr('删除标签 {0}', tag.name)"
                  :disabled="store.busy"
                  @click="confirmDelete(tag)"
                >
                  {{ tr('删除') }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <Modal
      v-if="draft"
      :title="draft.id ? tr('编辑标签') : tr('新建标签')"
      :busy="store.busy"
      @close="draft = null"
    >
      <form class="editor-form" @submit.prevent="save">
        <label
          >{{ tr('名称') }}<input v-model="draft.name" required autofocus :disabled="store.busy"
        /></label>
        <fieldset class="environment-tag-colors" :disabled="store.busy">
          <legend>{{ tr('颜色') }}</legend>
          <label v-for="color in environmentTagColors" :key="color" class="checkbox-label">
            <input v-model="draft.color" type="radio" name="environment-tag-color" :value="color" />
            <EnvironmentTagBadge :tag="{ name: colorLabels[color], color }" />
          </label>
        </fieldset>
        <div class="environment-settings-actions">
          <span class="subtle">{{ tr('标签预览') }}</span>
          <EnvironmentTagBadge
            :tag="{ name: draft.name.trim() || tr('标签'), color: draft.color }"
          />
        </div>
        <p v-if="store.error" class="error-text" role="alert">{{ store.error }}</p>
        <footer class="dialog-actions">
          <button type="button" class="button" :disabled="store.busy" @click="draft = null">
            {{ tr('取消') }}
          </button>
          <button class="button primary" :disabled="store.busy">{{ tr('保存') }}</button>
        </footer>
      </form>
    </Modal>
    <Modal v-if="deleting" :title="tr('删除标签？')" :busy="store.busy" @close="deleting = null">
      <p>{{ tr('确定删除「{0}」吗？', deleting.name) }}</p>
      <p v-if="counts.get(deleting.id)">
        {{ tr('删除后，使用此标签的 {0} 台主机将清除该标签。', counts.get(deleting.id) ?? 0) }}
      </p>
      <p v-if="store.error" class="error-text" role="alert">{{ store.error }}</p>
      <footer class="dialog-actions">
        <button
          type="button"
          class="button"
          autofocus
          :disabled="store.busy"
          @click="deleting = null"
        >
          {{ tr('取消') }}
        </button>
        <button type="button" class="button danger" :disabled="store.busy" @click="remove">
          {{ tr('删除') }}
        </button>
      </footer>
    </Modal>
  </section>
</template>

<style scoped>
.environment-settings-header,
.environment-settings-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.environment-settings-header {
  justify-content: space-between;
  margin-bottom: 16px;
}
.environment-settings-header h2,
.environment-settings-header p {
  margin: 0;
}
.environment-settings-header p {
  margin-top: 4px;
}
.environment-settings-table,
.environment-settings-state {
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: auto;
}
.environment-settings-state {
  padding: 16px;
}
.environment-settings-table table {
  width: 100%;
  border-collapse: collapse;
}
.environment-settings-table :is(th, td) {
  padding: 8px 12px;
  text-align: left;
}
.environment-settings-table th {
  background: var(--panel);
  color: var(--muted);
  font-weight: 500;
}
.environment-settings-table td {
  border-top: 1px solid var(--border);
}
.environment-tag-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  min-width: 0;
}
</style>
