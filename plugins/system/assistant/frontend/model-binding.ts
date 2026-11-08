import { computed, onScopeDispose, ref, watch } from 'vue';
import { usePluginVisibility } from '@serverdeck/plugin-sdk/visibility';
import { useModelsStore } from '@serverdeck/plugin-sdk/stores/models';
import { requestCapability } from '@serverdeck/plugin-sdk/services/capability';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import { aiApi } from '@serverdeck/plugin-sdk/services/ai';
import {
  LOCAL_CODEX_MODEL_ID,
  LOCAL_CLAUDE_CODE_MODEL_ID,
  isLocalModel,
  type LocalCodexStatus,
} from '@serverdeck/plugin-sdk/types/ai';

export function useModelBinding() {
  const models = useModelsStore();
  const visible = usePluginVisibility();
  const modelId = ref(''),
    loaded = ref(false),
    loading = ref(false),
    saving = ref(false);
  const error = ref(''),
    message = ref('');
  const installing = ref('');
  let installRequest = '';
  const sources = [
    {
      id: LOCAL_CODEX_MODEL_ID,
      name: '本地 Codex',
      description: '使用本机 Codex 已有的模型配置和登录信息',
      state: ref<LocalCodexStatus>({ authorized: false, model: null, message: '' }),
      read: () => aiApi.localCodexStatus(),
      authorize: (authorized: boolean) => aiApi.localCodexAuthorize(authorized),
    },
    {
      id: LOCAL_CLAUDE_CODE_MODEL_ID,
      name: '本地 Claude Code',
      description: '使用本机 Claude Code 已有的模型配置和登录信息',
      state: ref<LocalCodexStatus>({ authorized: false, model: null, message: '' }),
      read: () => aiApi.localClaudeCodeStatus(),
      authorize: (authorized: boolean) => aiApi.localClaudeCodeAuthorize(authorized),
    },
  ];
  const localSources = computed(() =>
    sources.map((source) => ({
      id: source.id,
      name: source.name,
      description: source.description,
      status: source.state.value,
    })),
  );
  const localSelected = computed(() =>
    localSources.value.find((source) => source.id === modelId.value),
  );
  const selected = computed(() =>
    isLocalModel(modelId.value)
      ? (localSelected.value?.status.model ?? undefined)
      : models.models.find((model) => model.id === modelId.value),
  );
  async function loadLocal(source: (typeof sources)[number]) {
    try {
      return await source.read();
    } catch (cause) {
      return {
        installed: source.state.value.installed,
        installSupported: source.state.value.installSupported,
        authorized: source.state.value.authorized,
        model: null,
        message: errorMessage(cause),
      };
    }
  }
  let settings: Record<string, unknown> = {};
  let version = 0;
  async function load() {
    const current = ++version;
    loading.value = true;
    loaded.value = false;
    error.value = '';
    try {
      const [value, , local] = await Promise.all([
        requestCapability<unknown>({ kind: 'settings_read' }),
        models.refresh(),
        Promise.all(sources.map(loadLocal)),
      ]);
      if (current !== version || !visible.value) return;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('插件模型绑定配置无效');
      const record = value as Record<string, unknown>;
      if (record.modelId != null && typeof record.modelId !== 'string')
        throw new Error('插件模型绑定配置无效');
      settings = record;
      sources.forEach((source, index) => {
        source.state.value = local[index]!;
      });
      modelId.value = typeof record.modelId === 'string' ? record.modelId : '';
      loaded.value = true;
    } catch (cause) {
      if (current === version) error.value = errorMessage(cause);
    } finally {
      if (current === version) loading.value = false;
    }
  }
  async function save(id: string) {
    if (!loaded.value || loading.value || saving.value || installing.value || !visible.value)
      return;
    const source = localSources.value.find((source) => source.id === id);
    if (source && !source.status.model) {
      error.value = source.status.message || `${source.name}尚未就绪`;
      return;
    }
    if (id && !isLocalModel(id) && !models.models.some((model) => model.id === id)) {
      error.value = '所选模型已删除，请重新选择';
      return;
    }
    const current = version;
    saving.value = true;
    error.value = '';
    message.value = '';
    try {
      const value = { ...settings, modelId: id || null };
      await requestCapability({ kind: 'settings_write', value });
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
  async function authorizeLocal(id: string, authorized: boolean) {
    if (loading.value || saving.value || installing.value || !visible.value) return;
    const source = sources.find((source) => source.id === id);
    if (!source) return;
    saving.value = true;
    error.value = '';
    const current = version;
    try {
      await source.authorize(authorized);
      const local = await loadLocal(source);
      if (current !== version || !visible.value) return;
      source.state.value = local;
      message.value = authorized ? `${source.name} 授权已保存` : `已撤销${source.name} 授权`;
    } catch (cause) {
      if (current === version) error.value = errorMessage(cause);
    } finally {
      saving.value = false;
    }
  }
  async function installLocal(id: string) {
    if (!loaded.value || loading.value || saving.value || installing.value || !visible.value)
      return;
    const source = sources.find((source) => source.id === id);
    if (!source || source.state.value.installed !== false) return;
    const requestId = crypto.randomUUID();
    installRequest = requestId;
    installing.value = id;
    error.value = '';
    message.value = '';
    const current = version;
    try {
      await aiApi.localToolInstall(id, requestId);
      const state = await loadLocal(source);
      if (current !== version || !visible.value) return;
      source.state.value = state;
      message.value = state.installed ? '安装完成，请继续授权或使用已有登录' : state.message;
    } catch (cause) {
      if (current !== version || !visible.value) return;
      if (
        typeof cause === 'object' &&
        cause &&
        'code' in cause &&
        cause.code === 'AI_INSTALL_CANCELLED'
      )
        message.value = '已取消下载';
      else error.value = errorMessage(cause);
    } finally {
      if (installRequest === requestId) {
        installRequest = '';
        installing.value = '';
      }
    }
  }
  async function refreshLocal(id: string) {
    if (loading.value || saving.value || installing.value || !visible.value) return;
    const source = sources.find((source) => source.id === id);
    if (!source) return;
    const current = version;
    loading.value = true;
    error.value = '';
    try {
      const state = await loadLocal(source);
      if (current === version && visible.value) source.state.value = state;
    } finally {
      if (current === version) loading.value = false;
    }
  }
  async function cancelInstall() {
    if (!installRequest) return;
    try {
      await aiApi.localToolInstallCancel(installRequest);
    } catch (cause) {
      error.value = errorMessage(cause);
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
  return {
    models,
    modelId,
    selected,
    loaded,
    loading,
    saving,
    installing,
    error,
    message,
    localSources,
    localSelected,
    authorizeLocal,
    installLocal,
    refreshLocal,
    cancelInstall,
    load,
    save,
  };
}
