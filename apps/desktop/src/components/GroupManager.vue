<script setup lang="ts">
import { tr } from '../i18n/messages';

import { ref } from 'vue';
import Modal from './Modal.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import { folderPath } from '../services/host-tree';
import type { HostGroup } from '../types/hosts';
const props = defineProps<{ parentId: string | null; group?: HostGroup }>();
const emit = defineEmits<{ close: []; saved: [group: HostGroup] }>();
const store = useHostsStore();
const name = ref(props.group?.name ?? '');
async function save(): Promise<void> {
  const result = await store.run(
    () =>
      hostsApi.groupSave(props.group?.id ?? null, {
        name: name.value,
        sortOrder: props.group?.sortOrder ?? 0,
        parentId: props.parentId,
      }),
    tr('文件夹已保存。'),
  );
  if (result.ok) {
    emit('saved', result.value);
    emit('close');
  }
}
</script>
<template>
  <Modal
    :title="group ? tr('重命名文件夹') : tr('新建文件夹')"
    :busy="store.busy"
    @close="emit('close')"
  >
    <p class="subtle">
      {{ tr('父目录：') }}{{ folderPath(store.catalog?.groups ?? [], parentId) }}
    </p>
    <p class="subtle">{{ tr('文件夹名称不可与已有文件夹重名。') }}</p>
    <form class="editor-form" @submit.prevent="save">
      <fieldset :disabled="store.busy">
        <label
          >{{ tr('文件夹名称') }}<input v-model="name" autofocus required maxlength="128"
        /></label>
      </fieldset>
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="store.busy" @click="emit('close')">
          {{ tr(' 取消 ') }}
        </button>
        <button class="button primary" :disabled="store.busy" type="submit">
          {{ group ? tr('保存文件夹') : tr('新建文件夹') }}
        </button>
      </footer>
    </form>
  </Modal>
</template>
