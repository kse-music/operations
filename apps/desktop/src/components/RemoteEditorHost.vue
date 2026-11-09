<script setup lang="ts">
import { defineAsyncComponent, onErrorCaptured, ref } from 'vue';
import { useFilesStore } from '../stores/files';
import Modal from './Modal.vue';
const store = useFilesStore();
const ready = ref(false),
  failed = ref(false);
const Editor = defineAsyncComponent({ loader: () => import('./RemoteEditor.vue'), timeout: 15000 });
onErrorCaptured(() => {
  if (ready.value) {
    store.error = '文本编辑器操作失败，请保留窗口并复制未保存内容后重试。';
    return false;
  }
  if (!failed.value) {
    failed.value = true;
    void store.editorFailed();
  }
  return false;
});
</script>
<template>
  <Editor v-if="!failed" @ready="ready = true" />
  <Modal v-if="!ready && !failed" title="正在打开文本编辑器" busy>
    <p role="status">正在加载 {{ store.document?.path }}…</p>
  </Modal>
</template>
