import { computed, ref, shallowReactive, shallowRef, watch } from 'vue';
import { tr } from '../i18n/messages';
import { errorMessage } from '../services/ipc';
import { monitorApi } from '../services/monitor';
import { sameHostConnection } from '../services/product-links';
import { terminalApi } from '../services/terminal';
import { useNotificationsStore } from '../stores/notifications';
import type { Host } from '../types/hosts';
import type { MonitorSnapshot, Sample } from '../types/monitor';
import type { TerminalEvent } from '../types/terminal';

interface OverviewSample {
  host: Host;
  sample: Sample;
  cpu?: { usage: number; sampledAt: number };
}

export function useHostOverview(
  host: () => Host | undefined,
  workspaceHosts: () => readonly string[],
) {
  const notifications = useNotificationsStore();
  const retainedHost = shallowRef<Host>();
  const samples = shallowReactive(new Map<string, OverviewSample>());
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
  const savedSample = computed(() => {
    const target = host();
    const saved = target && samples.get(target.id);
    return saved && target && sameHostConnection(saved.host, target) ? saved : undefined;
  });
  const sample = computed(() => savedSample.value?.sample);
  const cpuReading = computed(() => savedSample.value?.cpu);
  const previousSample = computed(
    () => sample.value !== snapshot.value?.sample || snapshot.value?.state === 'paused',
  );
  let lifecycle = Promise.resolve();

  watch(
    [host, workspaceHosts],
    ([target, owned], [previous]) => {
      for (const id of samples.keys()) if (!owned.includes(id)) samples.delete(id);
      const retained = retainedHost.value;
      if (target) {
        if (retained?.id !== target.id || !sameHostConnection(retained, target))
          retainedHost.value = target;
        else if (!previous && (ended.value || requestError.value)) restart.value++;
      } else if (
        retained &&
        (!owned.includes(retained.id) || connection.value !== 'connected' || ended.value)
      ) {
        retainedHost.value = undefined;
      }
    },
    { immediate: true },
  );

  watch(
    [retainedHost, restart],
    ([target], _, onCleanup) => {
      snapshot.value = undefined;
      sessionId.value = '';
      connection.value = target ? 'connecting' : 'idle';
      connectionError.value = undefined;
      requestError.value = undefined;
      fingerprint.value = undefined;
      confirming.value = false;
      refreshAfter.value = undefined;
      if (!target) return;
      const { id } = target;

      let active = true;
      let openedSession: string | undefined;
      let sampling = true;
      let visibilityRevision = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const visible = () => host()?.id === id;
      const poll = async (revision: number) => {
        const current = () => active && visible() && revision === visibilityRevision;
        try {
          const next = await monitorApi.snapshot(id, snapshot.value?.revision);
          if (!current()) return;
          if (next?.hostId === id && next.sessionId === openedSession) {
            snapshot.value = next;
            if (next.sample) {
              const usage = next.sample.cpus.find((row) => row.name === 'cpu')?.usage;
              const previous = samples.get(id);
              let cpu =
                previous && sameHostConnection(previous.host, target) ? previous.cpu : undefined;
              if (usage != null) cpu = { usage, sampledAt: next.sample.sampledAt };
              samples.set(id, { host: target, sample: next.sample, cpu });
            }
            if (
              refreshAfter.value !== undefined &&
              next.revision > refreshAfter.value &&
              ['running', 'partial', 'error', 'failed'].includes(next.state)
            )
              refreshAfter.value = undefined;
          }
        } catch (cause) {
          if (!current()) return;
          requestError.value = errorMessage(cause);
          refreshAfter.value = undefined;
          return;
        }
        if (current() && !ended.value) timer = setTimeout(() => void poll(revision), 1000);
      };
      function syncVisibility(shown: boolean) {
        const revision = ++visibilityRevision;
        clearTimeout(timer);
        lifecycle = lifecycle.then(async () => {
          if (!active || revision !== visibilityRevision || !openedSession || ended.value) return;
          try {
            if (shown !== sampling) {
              await monitorApi.visible(id, shown);
              sampling = shown;
            }
            if (active && shown && revision === visibilityRevision) void poll(revision);
          } catch (cause) {
            if (!active || revision !== visibilityRevision) return;
            const message = errorMessage(cause);
            if (!shown) {
              notifications.push(message, true);
              retainedHost.value = undefined;
              return;
            }
            requestError.value = message;
            refreshAfter.value = undefined;
          }
        });
      }
      const stopVisibilityWatch = watch(visible, syncVisibility);
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
          syncVisibility(visible());
        } catch (cause) {
          if (!active) return;
          connection.value = 'failed';
          connectionError.value = errorMessage(cause);
        }
      });
      onCleanup(() => {
        active = false;
        stopVisibilityWatch();
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
    const id = host()?.id;
    if (!id || refreshing.value) return;
    if (ended.value || requestError.value) {
      restart.value++;
      return;
    }
    const session = sessionId.value;
    if (!session || connection.value !== 'connected') return;
    refreshAfter.value = snapshot.value?.revision ?? 0;
    try {
      await lifecycle;
      if (id !== host()?.id || session !== sessionId.value || ended.value) {
        if (session === sessionId.value) refreshAfter.value = undefined;
        return;
      }
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
    sample,
    cpuReading,
    previousSample,
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
