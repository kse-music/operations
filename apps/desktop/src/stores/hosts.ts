import { locale } from '@serverdeck/plugin-sdk/i18n';
import { tr } from '../i18n/messages';
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
      const value = hostDisplayName(a).localeCompare(hostDisplayName(b), locale.value);
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
          error.value = tr('操作已完成，但列表刷新失败，请点击刷新。');
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
    await run(() => hostsApi.update(id, { ...hostInput(host), groupId }), tr('主机分组已更新。'));
  }
  async function renameHost(id: string, name: string): Promise<boolean> {
    const host = catalog.value?.hosts.find((host) => host.id === id);
    if (!host) {
      error.value = tr('目标主机已不存在，请刷新后重试。');
      return false;
    }
    const result = await run(() => hostsApi.update(id, { ...hostInput(host), name }));
    if (!result.ok) return false;
    const index = catalog.value?.hosts.findIndex((host) => host.id === id) ?? -1;
    if (catalog.value && index >= 0) catalog.value.hosts[index] = result.value;
    notice.value = tr('主机已重命名。');
    return true;
  }
  async function setFavorite(id: string, favorite: boolean): Promise<boolean> {
    const host = catalog.value?.hosts.find((host) => host.id === id);
    if (!host) return false;
    const result = await run(() => hostsApi.setFavorite(id, favorite));
    if (result.ok) host.favorite = favorite;
    return result.ok;
  }
  async function renameGroup(id: string, name: string): Promise<boolean> {
    const group = catalog.value?.groups.find((group) => group.id === id);
    if (!group) {
      error.value = tr('目标文件夹已不存在，请刷新后重试。');
      return false;
    }
    const result = await run(() =>
      hostsApi.groupSave(id, { name, sortOrder: group.sortOrder, parentId: group.parentId }),
    );
    if (!result.ok) return false;
    const index = catalog.value?.groups.findIndex((group) => group.id === id) ?? -1;
    if (catalog.value && index >= 0) catalog.value.groups[index] = result.value;
    notice.value = tr('文件夹已保存。');
    return true;
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
    setFavorite,
    renameHost,
    renameGroup,
  };
});
