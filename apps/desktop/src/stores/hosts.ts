import { useErrorNotifications } from '../composables/error-notifications';
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { hostsApi } from '../services/hosts';
import { errorMessage } from '../services/ipc';
import type { Catalog, Host } from '../types/hosts';
import { hostDisplayName, hostInput } from '../types/hosts';

export function filterHosts(hosts: Host[], search: string): Host[] {
  const query = search.trim().toLocaleLowerCase();
  return hosts
    .filter(
      (h) =>
        !query ||
        [hostDisplayName(h), h.hostname, h.username].some((s) =>
          s.toLocaleLowerCase().includes(query),
        ),
    )
    .sort((a, b) => {
      const value = hostDisplayName(a).localeCompare(hostDisplayName(b), 'zh-CN');
      return value || a.id.localeCompare(b.id);
    });
}
export const useHostsStore = defineStore('hosts', () => {
  const catalog = ref<Catalog | null>(null);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const search = ref('');
  const selectedId = ref<string | null>(null);
  const visible = computed(() => filterHosts(catalog.value?.hosts ?? [], search.value));
  const selected = computed(() => catalog.value?.hosts.find((h) => h.id === selectedId.value));
  async function reload(): Promise<void> {
    const data = await hostsApi.list();
    catalog.value = data;
    if (!data.hosts.some((h) => h.id === selectedId.value)) selectedId.value = null;
  }
  async function load(): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      await reload();
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      busy.value = false;
    }
  }
  async function run<T>(
    operation: () => Promise<T>,
    success?: string,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    if (busy.value) return { ok: false };
    busy.value = true;
    error.value = null;
    notice.value = null;
    try {
      const value = await operation();
      if (success) {
        notice.value = success;
        if (
          value &&
          typeof value === 'object' &&
          'warnings' in value &&
          Array.isArray(value.warnings) &&
          value.warnings.length
        )
          notice.value += ` ${value.warnings.join('；')}`;
        try {
          await reload();
        } catch {
          error.value = '操作已完成，但列表刷新失败，请点击刷新。';
        }
      }
      return { ok: true, value };
    } catch (cause) {
      error.value = errorMessage(cause);
      return { ok: false };
    } finally {
      busy.value = false;
    }
  }
  async function move(id: string, groupId: string | null): Promise<void> {
    const host = catalog.value?.hosts.find((host) => host.id === id);
    if (
      !host ||
      host.groupId === groupId ||
      (groupId !== null && !catalog.value?.groups.some((group) => group.id === groupId))
    )
      return;
    await run(() => hostsApi.update(id, { ...hostInput(host), groupId }), '主机分组已更新。');
  }
  useErrorNotifications(error);
  return {
    catalog,
    busy,
    error,
    notice,
    search,
    selectedId,
    visible,
    selected,
    load,
    run,
    move,
  };
});
