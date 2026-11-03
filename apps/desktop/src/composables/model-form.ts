import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { aiApi } from '../services/ai';
import { errorMessage } from '../services/ipc';
import { useModelsStore } from '../stores/models';
import { defaultAiConfig, type AiModel, type AiModelInput, type AiModelTest } from '../types/ai';

export function useModelForm(model: AiModel | undefined, saved: () => void) {
  const store = useModelsStore();
  const config = ref(model ? { ...model.config } : defaultAiConfig());
  const name = ref(model?.name ?? ''),
    apiKey = ref(''),
    clearKey = ref(false);
  const saving = ref(false),
    testing = ref(false),
    testError = ref(''),
    testMessage = ref('');
  const receipt = ref<AiModelTest | null>(null);
  const needsTest = computed(
    () => !model || JSON.stringify(config.value) !== JSON.stringify(model.config) || !!apiKey.value,
  );
  const canSave = computed(
    () =>
      !testing.value &&
      !saving.value &&
      !store.busy &&
      !store.loading &&
      (!needsTest.value || !!receipt.value),
  );
  let version = 0,
    disposed = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  function invalidate() {
    version++;
    receipt.value = null;
    testError.value = '';
    testMessage.value = '';
    clearTimeout(expiry);
  }
  watch([config, apiKey, clearKey], invalidate, { deep: true, flush: 'sync' });
  function input(): AiModelInput {
    return {
      id: model?.id ?? null,
      expectedRevision: model?.revision ?? null,
      name: name.value,
      config: { ...config.value },
      apiKey: apiKey.value || null,
      clearKey: clearKey.value,
      testId: receipt.value?.id ?? null,
    };
  }
  async function test() {
    if (testing.value || saving.value || store.busy || store.loading) return;
    invalidate();
    const current = version,
      payload = input();
    testing.value = true;
    store.error = '';
    try {
      const result = await aiApi.modelTest(payload);
      if (disposed || current !== version) return;
      receipt.value = result;
      testMessage.value = `连接成功 · ${result.elapsedMs} ms · 当前配置可保存`;
      expiry = setTimeout(() => {
        invalidate();
        testMessage.value = '测试结果已过期，请重新测试。';
      }, result.expiresInSeconds * 1000);
    } catch (e) {
      if (!disposed && current === version) testError.value = errorMessage(e);
    } finally {
      payload.apiKey = null;
      testing.value = false;
    }
  }
  async function save() {
    if (!canSave.value) return;
    saving.value = true;
    const payload = input();
    try {
      if (await store.save(payload)) saved();
    } finally {
      apiKey.value = '';
      payload.apiKey = null;
      clearKey.value = false;
      invalidate();
      saving.value = false;
    }
  }
  onBeforeUnmount(() => {
    disposed = true;
    invalidate();
    apiKey.value = '';
  });
  return {
    store,
    config,
    name,
    apiKey,
    clearKey,
    saving,
    testing,
    testError,
    testMessage,
    receipt,
    needsTest,
    canSave,
    test,
    save,
  };
}
