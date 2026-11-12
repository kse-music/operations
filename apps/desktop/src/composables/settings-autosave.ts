import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useApplicationStore } from '../stores/application';
import type { AppConfig } from '../types/ipc';

const clone = (config: AppConfig): AppConfig => JSON.parse(JSON.stringify(config)) as AppConfig;

// Keep edits made during a write, while accepting changes from other settings consumers.
function mergeUnchanged<T extends object>(draft: T, previous: T, saved: T): T {
  const result = { ...draft };
  for (const key of Object.keys(saved) as (keyof T)[]) {
    if (JSON.stringify(draft[key]) === JSON.stringify(previous[key])) result[key] = saved[key];
  }
  return result;
}

export function useSettingsAutosave(valid: () => boolean, blocked: () => boolean) {
  const application = useApplicationStore();
  const draft = ref<AppConfig | null>(null);
  const baseline = ref<AppConfig | null>(null);
  let writeSnapshot: AppConfig | undefined;
  watch(
    () => application.state?.config,
    (config) => {
      const saved = config ? clone(config) : null;
      const current = draft.value;
      const previous = writeSnapshot ?? baseline.value;
      draft.value =
        saved && current && previous
          ? {
              ...mergeUnchanged(current, previous, saved),
              terminal: mergeUnchanged(current.terminal, previous.terminal, saved.terminal),
              product: mergeUnchanged(current.product, previous.product, saved.product),
            }
          : saved;
      baseline.value = saved ? clone(saved) : null;
    },
    { immediate: true },
  );
  const pending = computed(() => JSON.stringify(draft.value) !== JSON.stringify(baseline.value));
  const failed = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeSave: Promise<void> | undefined;
  let disposed = false;
  function cancelTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }
  function schedule(): void {
    cancelTimer();
    if (!disposed && pending.value) timer = setTimeout(() => void flush(), 300);
  }
  async function flush(): Promise<void> {
    cancelTimer();
    if (activeSave) return activeSave;
    if (
      disposed ||
      !pending.value ||
      !draft.value ||
      application.saving ||
      application.loading ||
      blocked() ||
      !valid()
    )
      return;
    const config = clone(draft.value);
    failed.value = false;
    writeSnapshot = config;
    activeSave = application.save(config);
    try {
      await activeSave;
      failed.value = !!application.error;
    } finally {
      activeSave = undefined;
      writeSnapshot = undefined;
      // A newer edit is queued once; a failed unchanged value is retried explicitly.
      if (JSON.stringify(draft.value) !== JSON.stringify(config)) schedule();
    }
  }
  watch(() => JSON.stringify(draft.value), schedule);
  watch(
    () => application.saving || application.loading || blocked(),
    (busy) => {
      if (!busy && !activeSave && !failed.value) schedule();
    },
  );
  onBeforeUnmount(() => {
    disposed = true;
    cancelTimer();
  });
  return { draft, pending, failed, flush };
}
