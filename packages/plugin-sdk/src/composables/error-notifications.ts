import { watch, type WatchSource } from 'vue';
import { request } from '../transport';

type Message = string | null | undefined;

export function useErrorNotifications(source: WatchSource<Message | readonly Message[]>): void {
  watch(
    source,
    (value, previous) => {
      const messages = Array.isArray(value) ? value : [value];
      const before = new Set(Array.isArray(previous) ? previous : [previous]);
      for (const message of messages) {
        if (message && !before.has(message))
          void request('ui.notify', { message, error: true }).catch((cause) =>
            console.warn(
              'Plugin notification delivery failed',
              typeof cause === 'object' && cause && 'code' in cause
                ? String(cause.code)
                : 'UNKNOWN',
            ),
          );
      }
    },
    { immediate: true, flush: 'sync' },
  );
}
