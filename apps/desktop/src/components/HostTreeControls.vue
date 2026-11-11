<script setup lang="ts">
import { tr } from '../i18n/messages';

import { ref } from 'vue';
import HostDialog from './HostDialog.vue';
import Modal from './Modal.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import { hostDisplayName, type Host } from '../types/hosts';

const props = defineProps<{ host: Host }>();
const emit = defineEmits<{ saved: [host: Host] }>();
const store = useHostsStore();
const editing = ref<Host>(),
  deleting = ref<Host>();
function edit() {
  store.error = null;
  editing.value = { ...props.host };
}
function confirmDelete() {
  store.error = null;
  deleting.value = { ...props.host };
}
async function remove() {
  const host = deleting.value;
  if (!host) return;
  const result = await store.run(() => hostsApi.remove(host.id), tr('主机已删除。'));
  if (result.ok) deleting.value = undefined;
}
defineExpose({ edit, confirmDelete });
</script>

<template>
  <HostDialog
    v-if="editing"
    :host="editing"
    @saved="emit('saved', $event)"
    @close="editing = undefined"
  />
  <Modal
    v-if="deleting"
    :title="tr('确认删除主机')"
    :busy="store.busy"
    @close="deleting = undefined"
  >
    <p>
      {{ tr(' 确认删除 ') }}{{ hostDisplayName(deleting) }}（{{ deleting.username }}@{{
        deleting.hostname
      }}:{{ deleting.port }}）？
    </p>
    <p class="subtle">
      {{ tr('在主机表单中保存且没有其他引用的密码或私钥会一并清理。已建立的连接会保留。') }}
    </p>

    <footer class="dialog-actions">
      <button class="button" :disabled="store.busy" @click="deleting = undefined">
        {{ tr('取消') }}
      </button>
      <button class="button danger" :disabled="store.busy" @click="remove">
        {{ tr('确认删除主机') }}
      </button>
    </footer>
  </Modal>
</template>
