import { defineStore } from 'pinia';
import { ref } from 'vue';
export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<{ id: number; text: string; error: boolean }[]>([]);
  let next = 0;
  function dismiss(id: number) {
    items.value = items.value.filter((t) => t.id !== id);
  }
  function push(text: string | null, error = false) {
    if (!text || items.value.some((t) => t.text === text)) return;
    const id = ++next;
    items.value = [...items.value, { id, text, error }].slice(-5);
    if (!error) setTimeout(() => dismiss(id), 6000);
  }
  return { items, push, dismiss };
});
