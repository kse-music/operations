<script setup lang="ts">
import { ref } from 'vue';
import { Copy, Pencil, Trash2 } from '@lucide/vue';
import HostDialog from './HostDialog.vue';
import Modal from './Modal.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import type { Host } from '../types/hosts';

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
async function copy() {
  const result = await store.run(
    () => hostsApi.copy(props.host.id),
    '主机配置已复制，共享原安全凭据引用。',
  );
  if (result.ok) emit('saved', result.value);
}
async function remove() {
  const host = deleting.value;
  if (!host) return;
  const result = await store.run(
    () => hostsApi.remove(host.id),
    '主机已删除，安全凭据保留供其他主机使用。',
  );
  if (result.ok) deleting.value = undefined;
}
</script>

<template>
  <div class="tree-host-actions" role="group" :aria-label="`${host.name} 的主机操作`">
    <button
      class="shell-icon-button"
      :aria-label="`编辑主机 ${host.name}`"
      title="编辑主机"
      :disabled="store.busy"
      @click="edit"
    >
      <Pencil :size="13" aria-hidden="true" />
    </button>
    <button
      class="shell-icon-button"
      :aria-label="`复制主机 ${host.name}`"
      title="复制主机配置"
      :disabled="store.busy"
      @click="copy"
    >
      <Copy :size="13" aria-hidden="true" />
    </button>
    <button
      class="shell-icon-button"
      :aria-label="`删除主机 ${host.name}`"
      title="删除主机"
      :disabled="store.busy"
      @click="confirmDelete"
    >
      <Trash2 :size="13" aria-hidden="true" />
    </button>
  </div>
  <HostDialog
    v-if="editing"
    :host="editing"
    @saved="emit('saved', $event)"
    @close="editing = undefined"
  />
  <Modal v-if="deleting" title="确认删除主机" :busy="store.busy" @close="deleting = undefined">
    <p>
      确认删除 {{ deleting.name }}（{{ deleting.username }}@{{ deleting.hostname }}:{{
        deleting.port
      }}）？
    </p>
    <p class="subtle">仅删除主机配置，安全凭据与已建立的连接保留。</p>
    <p v-if="store.error" class="banner error" role="alert">{{ store.error }}</p>
    <footer class="dialog-actions">
      <button class="button" :disabled="store.busy" @click="deleting = undefined">取消</button>
      <button class="button danger" :disabled="store.busy" @click="remove">确认删除主机</button>
    </footer>
  </Modal>
</template>
