import { useErrorNotifications } from '../composables/error-notifications';
import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import { productApi } from '../services/product';
import { useOpsStore } from './ops';
import { errorMessage } from '../services/ipc';
import type { ConnectionStatus } from '../types/product';
export const useBackgroundStore = defineStore('background', () => {
  const connections = shallowRef<ConnectionStatus[] | null>(null),
    error = ref('');
  let timer: ReturnType<typeof setTimeout> | undefined,
    stopped = true;
  async function poll() {
    const results = await Promise.allSettled([productApi.tasks(), useOpsStore().sync()]);
    if (stopped) return;
    const data = results[0];
    if (data.status === 'fulfilled') {
      connections.value = data.value.connections;
    }
    const failure = results.find((r) => r.status === 'rejected');
    error.value = failure?.status === 'rejected' ? errorMessage(failure.reason) : '';
    timer = setTimeout(() => void poll(), 2000);
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    void poll();
  }
  function stop() {
    stopped = true;
    clearTimeout(timer);
  }
  function hostState(id: string) {
    const rows =
      connections.value?.filter((c) => c.hostId === id || c.routeHostIds.includes(id)) ?? [];
    return rows.some((c) => c.state === 'connected') ? '已连接' : rows.length ? '连接中' : '未连接';
  }
  useErrorNotifications(error);
  return { connections, hostState, error, start, stop };
});
