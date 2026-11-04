import { ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { hostsApi } from '../services/hosts';
import { errorMessage } from '../services/ipc';
import type { Catalog } from '../types/hosts';
export const useHostsStore = defineStore('sdk-hosts', () => {
  const catalog = shallowRef<Catalog | null>(null),
    selectedId = ref(''),
    busy = ref(false),
    error = ref('');
  async function load() {
    busy.value = true;
    error.value = '';
    try {
      catalog.value = await hostsApi.list();
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      busy.value = false;
    }
  }
  return { catalog, selectedId, busy, error, load };
});
