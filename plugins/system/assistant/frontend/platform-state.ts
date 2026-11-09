import { computed, ref } from 'vue';
import { usePlatformContext, type HostMetadata } from '@serverdeck/plugin-sdk/context';
import { call } from '@serverdeck/plugin-sdk/platform';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
export type Host = HostMetadata;
export const hostDisplayName = (host: Pick<Host, 'name' | 'hostname'> | undefined) =>
  host?.name || host?.hostname || '';
export function useHostCatalog() {
  const context = usePlatformContext(),
    current = ref<Host[]>(),
    busy = ref(false),
    error = ref<string | null>(null);
  const catalog = computed(() => ({ hosts: current.value ?? context.hosts }));
  async function load() {
    busy.value = true;
    error.value = null;
    try {
      current.value = (await call<{ hosts: Host[] }>({ kind: 'hosts' })).hosts;
    } catch (cause) {
      error.value = errorMessage(cause);
      throw cause;
    } finally {
      busy.value = false;
    }
  }
  return {
    get catalog() {
      return catalog.value;
    },
    get busy() {
      return busy.value;
    },
    get error() {
      return error.value;
    },
    load,
  };
}
export function useConnections() {
  const context = usePlatformContext();
  return {
    get connections() {
      return context.connections;
    },
  };
}
