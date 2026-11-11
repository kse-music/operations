import { tr } from '../i18n/messages';
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { aiApi } from '../services/ai';
import { errorMessage } from '../services/ipc';
import type { AiModel, AiModelInput } from '../types/ai';

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
  async function save(input: AiModelInput): Promise<boolean> {
    if (busy.value || loading.value) return false;
    busy.value = true;
    error.value = '';
    message.value = '';
    try {
      const result = await aiApi.modelSave(input);
      models.value = [...models.value.filter((m) => m.id !== result.value.id), result.value];
      loaded.value = true;
      message.value = [tr('模型已保存'), ...result.warnings].join('；');
      return true;
    } catch (e) {
      error.value = errorMessage(e);
      return false;
    } finally {
      busy.value = false;
    }
  }
  async function remove(model: AiModel): Promise<boolean> {
    if (busy.value || loading.value) return false;
    busy.value = true;
    error.value = '';
    message.value = '';
    try {
      const result = await aiApi.modelDelete(model.id, model.revision, true);
      models.value = models.value.filter((m) => m.id !== model.id);
      if (selectedId.value === model.id) selectedId.value = '';
      message.value = [tr('模型已删除'), ...result.warnings].join('；');
      return true;
    } catch (e) {
      error.value = errorMessage(e);
      return false;
    } finally {
      busy.value = false;
    }
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
    save,
    remove,
  };
});
