import { isTauri } from '@tauri-apps/api/core';
import { computed, onScopeDispose, ref } from 'vue';
import { defineStore } from 'pinia';
import { updatesApi, type UpdateStatus } from '../services/updates';
import { errorMessage } from '../services/ipc';
import { useNotificationsStore } from './notifications';
import { tr } from '../i18n/messages';

function cancelled(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    cause.code === 'UPDATE_CANCELLED'
  );
}

export const useUpdatesStore = defineStore('updates', () => {
  const state = ref<UpdateStatus | null>(null);
  const error = ref<string | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const checking = ref(false);
  const downloading = ref(false);
  const installing = ref(false);
  const installRequested = ref(false);
  const available = computed(() => !!state.value?.release);
  const busy = computed(
    () => loading.value || checking.value || downloading.value || installing.value,
  );
  let initialized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onScopeDispose(() => clearTimeout(timer));

  function applyStatus(next: UpdateStatus): void {
    state.value = next;
    error.value = next.error ? tr(next.error) : null;
  }

  async function initialize(): Promise<void> {
    if (initialized || !isTauri()) return;
    initialized = true;
    loading.value = true;
    try {
      const next = await updatesApi.status();
      applyStatus(next);
      if (next.supported) timer = setTimeout(() => void check(true), 3000);
    } catch (cause) {
      error.value = errorMessage(cause);
      initialized = false;
    } finally {
      loading.value = false;
    }
  }

  async function check(automatic = false): Promise<void> {
    if (busy.value || saving.value) return;
    checking.value = true;
    error.value = null;
    try {
      applyStatus(await updatesApi.check(automatic));
    } catch (cause) {
      if (!cancelled(cause)) {
        error.value = errorMessage(cause);
        if (!automatic) useNotificationsStore().push(error.value, true);
      }
    } finally {
      checking.value = false;
    }
  }

  async function setAutoCheck(enabled: boolean): Promise<void> {
    if (saving.value || busy.value) return;
    saving.value = true;
    try {
      applyStatus(await updatesApi.autoCheck(enabled));
      if (!enabled) clearTimeout(timer);
    } catch (cause) {
      if (!cancelled(cause)) {
        error.value = errorMessage(cause);
        useNotificationsStore().push(error.value, true);
      }
    } finally {
      saving.value = false;
    }
  }

  async function download(): Promise<void> {
    if (busy.value || !state.value?.release) return;
    downloading.value = true;
    error.value = null;
    try {
      applyStatus(
        await updatesApi.download((progress) => {
          if (state.value) Object.assign(state.value, progress);
        }),
      );
    } catch (cause) {
      if (!cancelled(cause)) {
        error.value = errorMessage(cause);
        useNotificationsStore().push(error.value, true);
      }
    } finally {
      downloading.value = false;
    }
  }

  async function cancel(): Promise<void> {
    try {
      await updatesApi.cancel();
    } catch (cause) {
      error.value = errorMessage(cause);
      useNotificationsStore().push(error.value, true);
    }
  }

  function requestInstall(): void {
    if (state.value?.phase === 'ready' && !busy.value) installRequested.value = true;
  }

  async function install(): Promise<void> {
    if (!installRequested.value || state.value?.phase !== 'ready') {
      throw new Error(tr('请先完成更新包下载和验证'));
    }
    installing.value = true;
    try {
      await updatesApi.install();
    } catch (cause) {
      installing.value = false;
      throw cause;
    }
  }

  return {
    state,
    error,
    loading,
    saving,
    checking,
    downloading,
    installing,
    installRequested,
    available,
    busy,
    initialize,
    check,
    setAutoCheck,
    download,
    cancel,
    requestInstall,
    install,
  };
});
