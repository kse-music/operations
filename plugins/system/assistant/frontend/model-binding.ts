import { computed, onScopeDispose, reactive, ref, watch } from 'vue';
import { call } from '@serverdeck/plugin-sdk/platform';
import { request } from '@serverdeck/plugin-sdk/transport';
import { usePluginVisibility } from '@serverdeck/plugin-sdk/visibility';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import { usePlatformContext } from '@serverdeck/plugin-sdk/context';
import type { AiModel, LocalCodexStatus } from './types';
export function useModelBinding() {
  const visible = usePluginVisibility(),
    context = usePlatformContext();
  const modelId = ref(''),
    loaded = ref(false),
    loading = ref(false),
    saving = ref(false),
    error = ref(''),
    message = ref('');
  const localSources = ref<
    { id: string; name: string; description: string; status: LocalCodexStatus }[]
  >([]);
  const models = reactive({
    models: [] as AiModel[],
    loaded: false,
    loading: false,
    error: '',
    async refresh() {
      models.loading = true;
      models.error = '';
      try {
        const catalog = await call<{
          models: AiModel[];
          sources: { id: string; name: string; status: LocalCodexStatus }[];
        }>({ kind: 'models' });
        models.models = catalog.models;
        localSources.value = catalog.sources.map((source) => ({
          ...source,
          description: '使用平台管理的本地模型配置和登录状态',
        }));
        models.loaded = true;
      } catch (cause) {
        models.error = errorMessage(cause);
        throw cause;
      } finally {
        models.loading = false;
      }
    },
  });
  const selected = computed(() => models.models.find((model) => model.id === modelId.value));
  const localSelected = computed(() =>
    localSources.value.find((source) => source.id === modelId.value),
  );
  let settings: Record<string, import('@serverdeck/plugin-sdk/types/platform').JsonValue> = {},
    version = 0;
  async function load() {
    const current = ++version;
    loading.value = true;
    error.value = '';
    try {
      const [value] = await Promise.all([
        call<unknown>({ kind: 'settings_read' }),
        models.refresh(),
      ]);
      if (current !== version || !visible.value) return;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('插件设置无效');
      settings = value as typeof settings;
      if (settings.modelId != null && typeof settings.modelId !== 'string')
        throw new Error('模型绑定无效');
      modelId.value = typeof settings.modelId === 'string' ? settings.modelId : '';
      loaded.value = true;
    } catch (cause) {
      if (current === version) error.value = errorMessage(cause);
    } finally {
      if (current === version) loading.value = false;
    }
  }
  async function save(id: string) {
    if (!loaded.value || loading.value || saving.value || !visible.value) return false;
    if (id && !models.models.some((model) => model.id === id && model.hasKey)) {
      error.value = '模型未就绪，请在平台模型设置中检查';
      return false;
    }
    saving.value = true;
    error.value = '';
    try {
      const value = { ...settings, modelId: id || null };
      await call({ kind: 'settings_write', value });
      settings = value;
      modelId.value = id;
      message.value = id ? '模型绑定已保存' : '已解除模型绑定';
      return true;
    } catch (cause) {
      error.value = errorMessage(cause);
      return false;
    } finally {
      saving.value = false;
    }
  }
  const manageModels = () => request<void>('workspace.navigate', { view: 'models' });
  watch(
    visible,
    (active) => {
      if (active) void load();
      else ++version;
    },
    { immediate: true },
  );
  watch(
    () => context.models.map((model) => model.id + ':' + model.revision).join(','),
    () => {
      if (visible.value) void load();
    },
  );
  onScopeDispose(() => {
    ++version;
  });
  return {
    models,
    modelId,
    selected,
    loaded,
    loading,
    saving,
    error,
    message,
    localSources,
    localSelected,
    load,
    save,
    manageModels,
  };
}
