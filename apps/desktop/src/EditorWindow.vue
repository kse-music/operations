<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import RemoteEditorHost from './components/RemoteEditorHost.vue';
import NotificationToasts from './components/NotificationToasts.vue';
import { editorApi, type EditorBootstrap } from './services/editor';
import { errorMessage } from './services/ipc';
import { useTheme } from './composables/theme';
import { interfaceFontSizes } from './types/preferences';
const data = ref<EditorBootstrap>(),
  error = ref<string | null>(null),
  loading = ref(false);
const editor = ref<InstanceType<typeof RemoteEditorHost>>();
let unlisten: UnlistenFn | undefined;
let disposed = false;
useTheme(computed(() => data.value?.theme));
async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  error.value = null;
  try {
    if (!unlisten) {
      const release = await listen('remote-editor-close-requested', () => void close());
      if (disposed) {
        release();
        return;
      }
      unlisten = release;
    }
    const value = await editorApi.load();
    if (disposed) return;
    data.value = value;
    const scale =
      interfaceFontSizes.find((size) => size.value === value.interfaceFontSize)?.scale ?? 1;
    document.documentElement.style.setProperty('--interface-font-scale', String(scale));
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}
async function close(): Promise<void> {
  if (editor.value) {
    await editor.value.requestClose();
    return;
  }
  try {
    await editorApi.close(false);
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
onMounted(() => void load());
onBeforeUnmount(() => {
  disposed = true;
  unlisten?.();
});
</script>
<template>
  <main class="editor-window-shell">
    <RemoteEditorHost v-if="data" ref="editor" :document="data.document" />
    <div v-else class="editor-window-message">
      <p v-if="loading" role="status">正在打开远程文本编辑器…</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="error">
        <button class="button" :disabled="loading" @click="load">重试</button>
        <button class="button" :disabled="loading" @click="close">关闭编辑器</button>
      </template>
    </div>
    <NotificationToasts />
  </main>
</template>
