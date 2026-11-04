import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { aiApi } from '../services/ai';
import { errorMessage } from '../services/ipc';
import type { AiModel } from '../types/ai';

export const useModelsStore = defineStore('models', () => {
  const models = ref<AiModel[]>([]),
    selectedId = ref(''),
    loading = ref(false),
    loaded = ref(false),
    busy = ref(false),
    error = ref(''),
    message = ref('');
  const selected = computed(() => models.value.find((m) => m.id === selectedId.value));
  let pending: Promise<void> | null = null;
  function refresh(): Promise<void> {
    if (pending) return pending;
    loading.value = true;
    error.value = '';
    pending = Promise.resolve().then(async () => {
      try {
        const result = await aiApi.models();
        const firstLoad = !loaded.value;
        models.value = result;
        loaded.value = true;
        if (selectedId.value && !result.some((m) => m.id === selectedId.value))
          selectedId.value = '';
        if (firstLoad && result.length === 1) selectedId.value = result[0]!.id;
      } catch (e) {
        error.value = errorMessage(e);
      } finally {
        loading.value = false;
        pending = null;
      }
    });
    return pending;
  }
  return {
    models,
    selectedId,
    selected,
    loading,
    loaded,
    busy,
    error,
    message,
    refresh,
  };
});
