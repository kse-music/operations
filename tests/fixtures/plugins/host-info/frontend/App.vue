<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { invoke, errorMessage } from '@serverdeck/plugin-sdk';
import type { PluginUiPage, PluginUiResult } from '@serverdeck/plugin-sdk/types/plugins';
const props = defineProps<{ page: PluginUiPage }>();
const settings = computed(() => props.page.id === 'settings');
const note = ref(''),
  output = ref<unknown>(null),
  error = ref(''),
  busy = ref(false);
const label = (value: PluginUiPage['title']) =>
  typeof value === 'string' ? value : value['zh-CN'];
async function run(action: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await invoke<PluginUiResult>(action, { note: note.value });
    if (typeof result.values?.note === 'string') note.value = result.values.note;
    if (result.output !== undefined) output.value = result.output;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
onMounted(() => void run(settings.value ? 'settings_read' : 'host'));
</script>
<template>
  <section>
    <h2>{{ label(page.title) }}</h2>
    <label v-if="settings"
      >{{ label(page.fields[0]!.label) }}<input v-model="note" :disabled="busy" maxlength="32768"
    /></label>
    <div class="action-row">
      <button
        v-for="action in page.actions"
        :key="action.id"
        class="button"
        :disabled="busy"
        @click="run(action.id)"
      >
        {{ label(action.label) }}
      </button>
    </div>
    <p v-if="busy" role="status">正在读取…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <pre v-if="output !== null" class="plugin-output">{{
      typeof output === 'string' ? output : JSON.stringify(output, null, 2)
    }}</pre>
  </section>
</template>
