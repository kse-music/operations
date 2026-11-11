import { tr } from '../i18n/messages';
import { useErrorNotifications } from '../composables/error-notifications';
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { opsApi } from '../services/ops';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import type { Host } from '../types/hosts';
import type { OpsConnection } from '../types/ops';
export const useOpsStore = defineStore('operations', () => {
  const connections = ref<Record<string, OpsConnection>>({}),
    active = ref('');
  const current = computed(() => connections.value[active.value]);
  async function open(host: Host, activate = true): Promise<void> {
    if (activate) active.value = host.id;
    const previous = connections.value[host.id];
    if (
      previous &&
      ['opening', 'connecting', 'awaiting_trust', 'authenticating', 'connected'].includes(
        previous.state,
      )
    )
      return;
    if (previous?.session) await opsApi.close(previous.session.id);
    const entry: OpsConnection = { host, state: 'opening', error: null, trust: null };
    connections.value[host.id] = entry;
    const connection = connections.value[host.id]!;
    try {
      connection.session = await opsApi.open(host.id, (event) => {
        if (event.type === 'state') {
          connection.state = event.state;
          connection.error = event.message;
          if (event.state !== 'awaiting_trust') connection.trust = null;
        } else if (event.type === 'trust') connection.trust = event;
      });
    } catch (cause) {
      connection.state = 'failed';
      connection.error = errorMessage(cause);
    }
  }
  async function trust(accept: boolean, hostId = active.value): Promise<void> {
    const c = connections.value[hostId];
    if (!c?.session) return;
    await terminalApi.trust(c.session.id, accept);
    c.trust = null;
  }
  async function close(hostId = active.value): Promise<void> {
    const c = connections.value[hostId];
    if (!c?.session) return;
    await opsApi.close(c.session.id);
    c.state = 'closed';
    c.trust = null;
  }
  function hostState(id: string): string {
    const c = Object.values(connections.value).filter(
      (c) => c.host.id === id || c.session?.routeHostIds.includes(id),
    );
    return c.some((c) => c.state === 'connected')
      ? tr('已连接')
      : c.some((c) =>
            ['opening', 'connecting', 'authenticating', 'awaiting_trust'].includes(c.state),
          )
        ? tr('连接中')
        : tr('未连接');
  }
  async function sync(): Promise<void> {
    const live = await opsApi.connections();
    for (const c of Object.values(connections.value)) {
      if (c.state === 'connected' && c.session && !live.some((s) => s.id === c.session?.id)) {
        c.state = 'failed';
        c.error = tr('运维连接已结束，请重新连接');
      }
    }
  }
  useErrorNotifications(() =>
    Object.values(connections.value).map((connection) => connection.error),
  );
  return { connections, active, current, open, trust, close, hostState, sync };
});
