import { useErrorNotifications } from '../composables/error-notifications';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as ipc from '../services/ipc';
import type { AppConfig, Bootstrap } from '../types/ipc';

export const useApplicationStore = defineStore('application', () => {
  const state = ref<Bootstrap | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const ready = computed(() => state.value !== null);

  async function initialize(): Promise<void> {
    if (loading.value || saving.value) return;
    loading.value = true;
    error.value = null;
    try {
      state.value = await ipc.bootstrap();
    } catch (cause) {
      state.value = null;
      error.value = ipc.errorMessage(cause);
    } finally {
      loading.value = false;
    }
  }

  async function save(config: AppConfig): Promise<void> {
    if (!state.value || saving.value || loading.value) return;
    saving.value = true;
    error.value = null;
    notice.value = null;
    try {
      state.value.config = await ipc.saveConfig({ ...config });
      notice.value = '设置已保存。日志级别在下次启动时生效。';
    } catch (cause) {
      error.value = ipc.errorMessage(cause);
    } finally {
      saving.value = false;
    }
  }

  function reportUnexpectedError(): void {
    // Do not display/log raw component errors: future components may handle secrets.
    error.value = '界面发生异常，请重新启动应用并检查本地日志。';
  }

  useErrorNotifications(error);
  return { state, loading, saving, error, notice, ready, initialize, save, reportUnexpectedError };
});
