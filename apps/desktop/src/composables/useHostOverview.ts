import { computed, ref, shallowRef, watch } from 'vue';
import { tr } from '../i18n/messages';
import { errorMessage } from '../services/ipc';
import { monitorApi } from '../services/monitor';
import { terminalApi } from '../services/terminal';
import { useNotificationsStore } from '../stores/notifications';
import type { MonitorSnapshot } from '../types/monitor';
import type { TerminalEvent } from '../types/terminal';

export function useHostOverview(hostId: () => string | undefined) {
  const notifications = useNotificationsStore();
  const snapshot = shallowRef<MonitorSnapshot>();
  const sessionId = ref('');
  const connection = ref('idle');
  const connectionError = ref<string>();
  const requestError = ref<string>();
  const fingerprint = shallowRef<Extract<TerminalEvent, { type: 'trust' }>>();
  const confirming = ref(false);
  const refreshAfter = ref<number>();
  const restart = ref(0);
  const ended = computed(
    () => ['closed', 'failed'].includes(connection.value) || snapshot.value?.state === 'failed',
  );
  const error = computed(
    () =>
      requestError.value ??
      connectionError.value ??
      (snapshot.value?.error ? tr(snapshot.value.error) : undefined),
  );
  const refreshing = computed(() => refreshAfter.value !== undefined);
  let lifecycle = Promise.resolve();

  watch(
    [hostId, restart],
    ([id], _, onCleanup) => {
      snapshot.value = undefined;
      sessionId.value = '';
      connection.value = id ? 'connecting' : 'idle';
      connectionError.value = undefined;
      requestError.value = undefined;
      fingerprint.value = undefined;
      confirming.value = false;
      refreshAfter.value = undefined;
      if (!id) return;

      let active = true;
      let openedSession: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        try {
          const next = await monitorApi.snapshot(id, snapshot.value?.revision);
          if (!active) return;
          if (next?.hostId === id && next.sessionId === openedSession) {
            snapshot.value = next;
            if (
              refreshAfter.value !== undefined &&
              next.revision > refreshAfter.value &&
              ['running', 'partial', 'error', 'failed'].includes(next.state)
            )
              refreshAfter.value = undefined;
          }
        } catch (cause) {
          if (!active) return;
          requestError.value = errorMessage(cause);
          refreshAfter.value = undefined;
          return;
        }
        if (active && !ended.value) timer = setTimeout(() => void poll(), 1000);
      };
      lifecycle = lifecycle.then(async () => {
        if (!active) return;
        try {
          const session = await monitorApi.open(id, (event) => {
            if (!active) return;
            if (event.type === 'trust') fingerprint.value = event;
            if (event.type !== 'state') return;
            connection.value = event.state;
            if (event.message) connectionError.value = tr(event.message);
            if (event.state !== 'awaiting_trust') fingerprint.value = undefined;
            if (ended.value) refreshAfter.value = undefined;
          });
          openedSession = session.id;
          if (!active) return;
          sessionId.value = session.id;
          void poll();
        } catch (cause) {
          if (!active) return;
          connection.value = 'failed';
          connectionError.value = errorMessage(cause);
        }
      });
      onCleanup(() => {
        active = false;
        clearTimeout(timer);
        // Close any late open before another visit can obtain a lease for this host.
        lifecycle = lifecycle.then(async () => {
          if (!openedSession) return;
          try {
            await monitorApi.stop(id);
          } catch (cause) {
            if ((cause as { code?: string } | null)?.code !== 'NOT_FOUND')
              notifications.push(errorMessage(cause), true);
          }
        });
      });
    },
    { immediate: true },
  );

  async function refresh() {
    const id = hostId();
    if (!id || refreshing.value) return;
    if (ended.value || requestError.value || snapshot.value?.state === 'paused') {
      restart.value++;
      return;
    }
    const session = sessionId.value;
    if (!session || connection.value !== 'connected') return;
    refreshAfter.value = snapshot.value?.revision ?? 0;
    try {
      await monitorApi.refresh(id);
    } catch (cause) {
      if (session !== sessionId.value) return;
      refreshAfter.value = undefined;
      requestError.value = errorMessage(cause);
    }
  }

  async function trust(accept: boolean) {
    const session = sessionId.value;
    if (!session || confirming.value) return;
    confirming.value = true;
    const pending = fingerprint.value;
    requestError.value = undefined;
    try {
      await terminalApi.trust(session, accept);
      if (session === sessionId.value && fingerprint.value === pending)
        fingerprint.value = undefined;
    } catch (cause) {
      if (session === sessionId.value) requestError.value = errorMessage(cause);
    } finally {
      if (session === sessionId.value) confirming.value = false;
    }
  }

  return {
    snapshot,
    sessionId,
    connection,
    ended,
    error,
    fingerprint,
    confirming,
    refreshing,
    refresh,
    trust,
  };
}
