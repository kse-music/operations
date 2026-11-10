<script setup lang="ts">
import { defineAsyncComponent, onErrorCaptured, ref } from 'vue';
import type { TextDocument } from '../types/files';
import { editorApi } from '../services/editor';
import { errorMessage } from '../services/ipc';
const props = defineProps<{ document: TextDocument }>();
const instance = ref<{ requestClose: () => void }>();
const error = ref<string | null>(null);
const ready = ref(false),
  failed = ref(false);
const Editor = defineAsyncComponent({ loader: () => import('./RemoteEditor.vue'), timeout: 15000 });
onErrorCaptured(() => {
  if (ready.value) {
    error.value = '文本编辑器操作失败，请保留窗口并复制未保存内容后重试。';
    return false;
  }
  if (!failed.value) {
    failed.value = true;
    error.value = '内置编辑器加载失败。请关闭此窗口后重试，或使用系统应用编辑。';
  }
  return false;
});
async function requestClose(): Promise<void> {
  if (ready.value) instance.value?.requestClose();
  else {
    try {
      await editorApi.close(false);
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }
}
defineExpose({ requestClose });
</script>
<template>
  <p v-if="error" class="editor-feedback" role="alert">{{ error }}</p>
  <Editor v-if="!failed" ref="instance" :initial-document="props.document" @ready="ready = true" />
  <div v-if="!ready" class="editor-window-message">
    <p v-if="!failed" role="status">正在加载 {{ props.document.path }}…</p>
    <button v-if="failed" class="button" @click="requestClose">关闭编辑器</button>
  </div>
</template>
