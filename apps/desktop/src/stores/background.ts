import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { productApi } from '../services/product';
import { useOpsStore } from './ops';
import { useNotificationsStore } from './notifications';
import { errorMessage } from '../services/ipc';
import type { BackgroundTask, ConnectionStatus } from '../types/product';
export const useBackgroundStore = defineStore('background', () => {
  const tasks = shallowRef<BackgroundTask[]>([]),
    connections = shallowRef<ConnectionStatus[] | null>(null),
    error = ref('');
  const pending = computed(() => tasks.value.filter((t) => t.active).length);
  let timer: ReturnType<typeof setTimeout> | undefined,
    stopped = true;
  async function poll() {
    const results = await Promise.allSettled([productApi.tasks(), useOpsStore().sync()]);
    if (stopped) return;
    const data = results[0];
    if (data.status === 'fulfilled') {
      const previous = new Map(tasks.value.map((t) => [t.id, t.state]));
      for (const t of data.value.tasks)
        if (['failed', 'uncertain'].includes(t.state) && previous.get(t.id) !== t.state)
          useNotificationsStore().push(
            `${t.label}：${t.state === 'uncertain' ? '结果未确认' : '失败'}，请在后台任务查看目标和原因。`,
            true,
          );
      tasks.value = data.value.tasks;
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
  return { tasks, connections, hostState, pending, error, start, stop };
});
