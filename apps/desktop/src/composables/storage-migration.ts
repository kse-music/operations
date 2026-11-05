import { computed, ref, watch } from 'vue';
import { useApplicationStore } from '../stores/application';
import { filesApi } from '../services/files';
import * as ipc from '../services/ipc';
import type { AppConfig, StoragePreview } from '../types/ipc';

export function useStorageMigration() {
  const application = useApplicationStore();
  const target = ref('');
  const preview = ref<StoragePreview | null>(null);
  const discardDocuments = ref(false);
  const busy = ref(false);
  let config: AppConfig | null = null;
  watch(
    () => application.state?.storage?.rootDirectory,
    (root) => {
      target.value = root ?? '';
    },
    { immediate: true },
  );
  const changed = computed(
    () =>
      !!application.state?.storage &&
      target.value.trim() !== application.state.storage.rootDirectory,
  );
  async function browse() {
    try {
      const paths = await filesApi.pick('folder');
      if (paths[0]) target.value = paths[0];
    } catch (cause) {
      application.error = ipc.errorMessage(cause);
    }
  }
  async function review(draft: AppConfig) {
    busy.value = true;
    application.error = null;
    try {
      preview.value = await ipc.storagePreview(target.value.trim());
      config = JSON.parse(JSON.stringify(draft)) as AppConfig;
      discardDocuments.value = false;
    } catch (cause) {
      application.error = ipc.errorMessage(cause);
    } finally {
      busy.value = false;
    }
  }
  async function confirm() {
    if (!preview.value || !config || busy.value) return;
    busy.value = true;
    application.saving = true;
    application.error = null;
    try {
      const restarting = await ipc.storageMigrate(
        config,
        preview.value.targetDirectory,
        discardDocuments.value,
      );
      application.notice = restarting
        ? '设置已保存，正在安全结束任务并重启以迁移数据…'
        : '设置已保存，数据目录未变化，无需重启。';
      if (!restarting && application.state) {
        application.state.config = config;
        target.value = application.state.storage?.rootDirectory ?? target.value;
      }
      preview.value = null;
    } catch (cause) {
      application.error = ipc.errorMessage(cause);
    } finally {
      busy.value = false;
      application.saving = false;
    }
  }
  return { target, preview, discardDocuments, busy, changed, browse, review, confirm };
}
