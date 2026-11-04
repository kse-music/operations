import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { request } from '../transport';
import type { Host } from '../types/hosts';
import type { TerminalEvent } from '../types/terminal';
export interface FileConnection {
  host: Host;
  id?: string;
  state: string;
  error: string | null;
  trust: Extract<TerminalEvent, { type: 'trust' }> | null;
}
export const useFilesStore = defineStore('sdk-files', () => {
  const connections = ref<Record<string, FileConnection>>({}),
    active = ref('');
  const current = computed(() => connections.value[active.value]);
  async function open(host: Host) {
    active.value = host.id;
    connections.value[host.id] = await request<FileConnection>('connections.fileOpen', {
      hostId: host.id,
    });
  }
  async function trust(accept: boolean) {
    const id = current.value?.id;
    if (id) await request('connections.trust', { id, accept });
  }
  return { connections, active, current, open, trust };
});
