import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { hostsApi } from '../services/hosts';
import { errorMessage } from '../services/ipc';
import type { Catalog, Host } from '../types/hosts';
import { hostInput } from '../types/hosts';

export type HostSort = 'name' | 'hostname' | 'updated';
export function filterHosts(
  hosts: Host[],
  search: string,
  favorites: boolean,
  tag: string,
  sort: HostSort,
): Host[] {
  const query = search.trim().toLocaleLowerCase();
  return hosts
    .filter(
      (h) =>
        (!favorites || h.favorite) &&
        (!tag || h.tags.includes(tag)) &&
        (!query ||
          [h.name, h.hostname, h.username, h.description, ...h.tags].some((s) =>
            s.toLocaleLowerCase().includes(query),
          )),
    )
    .sort((a, b) => {
      const value =
        sort === 'updated'
          ? b.updatedAt.localeCompare(a.updatedAt)
          : sort === 'hostname'
            ? a.hostname.localeCompare(b.hostname)
            : a.name.localeCompare(b.name, 'zh-CN');
      return value || a.id.localeCompare(b.id);
    });
}
export const useHostsStore = defineStore('hosts', () => {
  const catalog = ref<Catalog | null>(null);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const search = ref('');
  const favorites = ref(false);
  const tag = ref('');
  const sort = ref<HostSort>('name');
  const selectedId = ref<string | null>(null);
  const visible = computed(() =>
    filterHosts(catalog.value?.hosts ?? [], search.value, favorites.value, tag.value, sort.value),
  );
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
  return {
    catalog,
    busy,
    error,
    notice,
    search,
    favorites,
    tag,
    sort,
    selectedId,
    visible,
    selected,
    load,
    run,
    move,
  };
});
