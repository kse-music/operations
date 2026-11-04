import { defineStore } from 'pinia';
import { ref } from 'vue';
export const useApplicationStore = defineStore('sdk-application', () => {
  const state = ref<{ config: { monitorIntervalSecs: number } } | null>(null);
  return { state };
});
