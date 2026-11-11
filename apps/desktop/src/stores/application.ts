import { tr } from '../i18n/messages';
import { useErrorNotifications } from '../composables/error-notifications';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';
import * as ipc from '../services/ipc';
import type { AppConfig, Bootstrap } from '../types/ipc';
import type { InterfaceFontSize } from '../types/preferences';

export const useApplicationStore = defineStore('application', () => {
  const state = ref<Bootstrap | null>(null);
  watch(
    () => state.value?.config.product.language,
    (language) => setLocale(language ?? 'zh-CN'),
    { immediate: true, flush: 'sync' },
  );
  const interfaceFontSizePreview = ref<InterfaceFontSize>();
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
      const nextState = await ipc.bootstrap();
      if (nextState.storage) {
        // A failed commit must not expose an uncommitted candidate for new writes.
        nextState.storage = await ipc.storageReady();
        notice.value = nextState.storage.notice;
      }
      state.value = nextState;
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
      notice.value = tr('设置已保存。日志级别在下次启动时生效。');
    } catch (cause) {
      error.value = ipc.errorMessage(cause);
    } finally {
      saving.value = false;
    }
  }

  function reportUnexpectedError(): void {
    // Do not display/log raw component errors: future components may handle secrets.
    error.value = tr('界面发生异常，请重新启动应用并检查本地日志。');
  }

  useErrorNotifications(error);
  return {
    state,
    interfaceFontSizePreview,
    loading,
    saving,
    error,
    notice,
    ready,
    initialize,
    save,
    reportUnexpectedError,
  };
});
