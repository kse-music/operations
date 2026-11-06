import { computed, onScopeDispose, ref, watch } from 'vue';
import { usePluginVisibility } from '@serverdeck/plugin-sdk/visibility';
import { useModelsStore } from '@serverdeck/plugin-sdk/stores/models';
import { pluginServerRequest } from '@serverdeck/plugin-sdk/services/plugin-server';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';

export function useModelBinding() {
  const models = useModelsStore();
  const visible = usePluginVisibility();
  const modelId = ref(''),
    loaded = ref(false),
    loading = ref(false),
    saving = ref(false);
  const error = ref(''),
    message = ref('');
  const selected = computed(() => models.models.find((model) => model.id === modelId.value));
  let settings: Record<string, unknown> = {};
  let version = 0;
  async function load() {
    const current = ++version;
    loading.value = true;
    loaded.value = false;
    error.value = '';
    try {
      const [value] = await Promise.all([
        pluginServerRequest<unknown>('', { kind: 'settings_read' }),
        models.refresh(),
      ]);
      if (current !== version || !visible.value) return;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('插件模型绑定配置无效');
      const record = value as Record<string, unknown>;
      if (record.modelId != null && typeof record.modelId !== 'string')
        throw new Error('插件模型绑定配置无效');
      settings = record;
      modelId.value = typeof record.modelId === 'string' ? record.modelId : '';
      loaded.value = true;
    } catch (cause) {
      if (current === version) error.value = errorMessage(cause);
    } finally {
      if (current === version) loading.value = false;
    }
  }
  async function save(id: string) {
    if (!loaded.value || loading.value || saving.value || !visible.value) return;
    if (id && !models.models.some((model) => model.id === id)) {
      error.value = '所选模型已删除，请重新选择';
      return;
    }
    const current = version;
    saving.value = true;
    error.value = '';
    message.value = '';
    try {
      const value = { ...settings, modelId: id || null };
      await pluginServerRequest('', { kind: 'settings_write', value });
      if (current !== version || !visible.value) return;
      settings = value;
      modelId.value = id;
      message.value = id ? '模型绑定已保存' : '已解除模型绑定';
      return true;
    } catch (cause) {
      if (current === version) error.value = errorMessage(cause);
    } finally {
      saving.value = false;
    }
  }
  watch(
    visible,
    (active) => {
      if (active) void load();
      else {
        ++version;
        loading.value = false;
      }
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    ++version;
  });
  return { models, modelId, selected, loaded, loading, saving, error, message, load, save };
}
