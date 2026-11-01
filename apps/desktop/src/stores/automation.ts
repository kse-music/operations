import { ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { automationApi } from '../services/automation';
import { errorMessage } from '../services/ipc';
import type { Status } from '../types/automation';
export const useAutomationStore = defineStore('automation', () => {
  const status = shallowRef<Status | null>(null),
    error = ref(''),
    dismissed = ref('');
  let timer: ReturnType<typeof setTimeout> | undefined,
    stopped = true;
  async function poll() {
    try {
      status.value = await automationApi.status();
      error.value = '';
    } catch (e) {
      error.value = errorMessage(e);
    } finally {
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    }
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    void poll();
  }
  function stop() {
    stopped = true;
    clearTimeout(timer);
  }
  return { status, error, dismissed, start, stop, poll };
});
