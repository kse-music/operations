<script setup lang="ts">
import { reactive, ref } from 'vue';
import Modal from './Modal.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import type { HostGroup } from '../types/hosts';
const emit = defineEmits<{ close: [] }>();
const store = useHostsStore();
const editingId = ref<string | null>(null);
const draft = reactive({ name: '', sortOrder: 0 });
const deleting = ref<HostGroup | null>(null);
function edit(group: HostGroup): void {
  editingId.value = group.id;
  draft.name = group.name;
  draft.sortOrder = group.sortOrder;
}
function reset(): void {
  editingId.value = null;
  draft.name = '';
  draft.sortOrder = 0;
}
async function save(): Promise<void> {
  const creating = editingId.value === null;
  const result = await store.run(
    () => hostsApi.groupSave(editingId.value, { ...draft }),
    '分组已保存。',
  );
  if (result.ok) {
    reset();
    if (creating) emit('close');
  }
}
async function remove(): Promise<void> {
  if (!deleting.value) return;
  const id = deleting.value.id;
  const result = await store.run(() => hostsApi.groupRemove(id), '分组已删除，主机已移到未分组。');
  if (result.ok) {
    deleting.value = null;
    if (editingId.value === id) reset();
  }
}
</script>
<template>
  <Modal title="管理主机分组" :busy="store.busy" @close="emit('close')">
    <p class="subtle">仅支持单层分组。排序值越小越靠前，同值按名称排序。</p>

    <ul class="management-list">
      <li v-for="group in store.catalog?.groups" :key="group.id">
        <span
          >{{ group.name }} <small class="subtle">排序 {{ group.sortOrder }}</small></span
        >
        <div>
          <button class="text-button" :disabled="store.busy" @click="edit(group)">编辑</button
          ><button class="text-button danger" :disabled="store.busy" @click="deleting = group">
            删除
          </button>
        </div>
      </li>
    </ul>
    <form class="editor-form" @submit.prevent="save">
      <fieldset class="form-grid" :disabled="store.busy">
        <label>分组名称<input v-model="draft.name" autofocus required maxlength="128" /></label
        ><label
          >排序值<input
            v-model.number="draft.sortOrder"
            type="number"
            min="-2147483648"
            max="2147483647"
            step="1"
            required
        /></label>
      </fieldset>
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="store.busy" @click="reset">清空</button
        ><button class="button primary" :disabled="store.busy" type="submit">
          {{ editingId ? '保存分组' : '新建分组' }}
        </button>
      </footer>
    </form>
  </Modal>
  <Modal v-if="deleting" title="确认删除分组" :busy="store.busy" @close="deleting = null"
    ><p>删除“{{ deleting.name }}”？组内主机会保留并移至未分组。</p>
    <footer class="dialog-actions">
      <button class="button" :disabled="store.busy" @click="deleting = null">取消</button
      ><button class="button danger" :disabled="store.busy" @click="remove">确认删除分组</button>
    </footer></Modal
  >
</template>
