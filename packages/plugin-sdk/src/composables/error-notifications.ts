import { watch, type WatchSource } from 'vue';
import { useNotificationsStore } from '../stores/notifications';

type Message = string | null | undefined;

export function useErrorNotifications(source: WatchSource<Message | readonly Message[]>): void {
  const notifications = useNotificationsStore();
  watch(
    source,
    (value, previous) => {
      const messages = Array.isArray(value) ? value : [value];
      const before = new Set(Array.isArray(previous) ? previous : [previous]);
      for (const message of messages) {
        if (message && !before.has(message)) notifications.push(message, true);
      }
    },
    { immediate: true, flush: 'sync' },
  );
}
