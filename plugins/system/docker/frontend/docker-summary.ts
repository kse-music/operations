import { computed, onScopeDispose, reactive, ref, watch, type Ref } from 'vue';
import { invoke } from '@serverdeck/plugin-sdk';
import { usePlatformContext } from '@serverdeck/plugin-sdk/context';
import { usePluginVisibility } from '@serverdeck/plugin-sdk/visibility';
import { useErrorNotifications } from '@serverdeck/plugin-sdk/composables/error-notifications';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import { tr } from './i18n/messages';
import type { OpsResponse } from './types';

type Metric = { value: string | number | null; error: string | null; loaded: boolean };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function useDockerSummary(hostId: Readonly<Ref<string>>) {
  const platform = usePlatformContext();
  const visible = usePluginVisibility();
  const connected = computed(() => platform.connections[hostId.value]?.state === 'connected');
  const metrics = reactive<Record<'version' | 'images' | 'containers' | 'compose', Metric>>({
    version: { value: null, error: null, loaded: false },
    images: { value: null, error: null, loaded: false },
    containers: { value: null, error: null, loaded: false },
    compose: { value: null, error: null, loaded: false },
  });
  const loading = ref(false);
  let generation = 0;

  async function refresh() {
    const token = ++generation;
    for (const metric of Object.values(metrics)) {
      metric.value = null;
      metric.error = null;
      metric.loaded = false;
    }
    loading.value = false;
    if (!hostId.value || !connected.value || !visible.value) return;
    const id = hostId.value;
    loading.value = true;
    const queries = [
      {
        key: 'version',
        kind: 'capabilities',
        read: (response: OpsResponse) => {
          const version = record(record(response.detail?.dockerVersion).Server).Version;
          return typeof version === 'string' && version.trim() ? version.trim() : null;
        },
      },
      {
        key: 'images',
        kind: 'images',
        read: (response: OpsResponse) => new Set(response.records.map((row) => row.ID)).size,
      },
      {
        key: 'containers',
        kind: 'containers',
        read: (response: OpsResponse) =>
          response.records.filter((row) => String(row.State).toLowerCase() === 'running').length,
      },
      {
        key: 'compose',
        kind: 'compose_projects',
        read: (response: OpsResponse) => new Set(response.records.map((row) => row.Name)).size,
      },
    ] as const;
    await Promise.all(
      queries.map(async ({ key, kind, read }) => {
        try {
          const response = await invoke<OpsResponse>('query', { hostId: id, request: { kind } });
          if (!response.success)
            throw new Error(
              `${response.code ?? tr('操作失败')}：${response.message ?? tr('请刷新核对状态')}`,
            );
          if (token === generation) {
            metrics[key].value = read(response);
            metrics[key].loaded = true;
          }
        } catch (cause) {
          if (token === generation) metrics[key].error = errorMessage(cause);
        }
      }),
    );
    if (token === generation) loading.value = false;
  }

  watch([hostId, connected, visible], () => void refresh(), { immediate: true });
  onScopeDispose(() => ++generation);
  useErrorNotifications(() => Object.values(metrics).map((metric) => metric.error));
  return { metrics, loading, refresh };
}
