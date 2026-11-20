import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';
import { batchApi } from '../services/batch';
import { errorMessage } from '../services/ipc';
import type { BatchCommand, BatchPreview, BatchRun } from '../types/batch';

interface TargetSelection {
  hostIds: string[];
  folder: string;
  environment: string;
  concurrency: number;
}

interface Editor {
  previous: BatchCommand | null;
  name: string;
  command: string;
}

export function useBatchCommands() {
  const commands = shallowRef<BatchCommand[] | null>(null);
  const activeId = ref<string | null>(null);
  const current = computed(() => commands.value?.find((command) => command.id === activeId.value));
  const selections = reactive(new Map<string, TargetSelection>());
  const selection = computed(() => (activeId.value ? selections.get(activeId.value) : undefined));
  const editor = ref<Editor | null>(null);
  const preview = shallowRef<BatchPreview | null>(null);
  const retryBase = shallowRef<BatchRun | null>(null);
  const latest = shallowRef<BatchRun | null>(null);
  const runs = shallowRef(new Map<string, BatchRun>());
  const result = computed(() => (activeId.value ? runs.value.get(activeId.value) : undefined));
  const showingTargets = ref(false);
  const visibleResult = computed(() => (showingTargets.value ? undefined : result.value));
  const running = computed(() => Boolean(latest.value && !latest.value.finished));
  const dirty = computed(() => {
    const draft = editor.value;
    return Boolean(
      draft &&
      (draft.name !== (draft.previous?.name ?? '') ||
        draft.command !== (draft.previous?.command ?? '')),
    );
  });
  const loading = ref(false);
  const busy = ref(false);
  const cancelling = ref(false);
  const listError = ref<string | null>(null);
  const actionError = ref<string | null>(null);
  const statusError = ref<string | null>(null);
  let retry: { runId: string; previous: BatchRun } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let polling = false;

  function activate(id: string): void {
    if (activeId.value === id) return;
    if (!selections.has(id))
      selections.set(id, { hostIds: [], folder: '', environment: '', concurrency: 3 });
    activeId.value = id;
    preview.value = null;
    retryBase.value = null;
    showingTargets.value = false;
    actionError.value = null;
  }

  function accept(run: BatchRun): void {
    latest.value = run;
    const previous = retry?.runId === run.id ? retry.previous : undefined;
    const updated = new Map(runs.value);
    updated.delete(run.command.id);
    const rows = new Map(run.results.map((row) => [row.target.id, row]));
    updated.set(
      run.command.id,
      previous
        ? { ...run, results: previous.results.map((row) => rows.get(row.target.id) ?? row) }
        : run,
    );
    if (updated.size > 8) {
      const oldest = updated.keys().next().value;
      if (oldest) updated.delete(oldest);
    }
    runs.value = updated;
  }

  function schedule(): void {
    clearTimeout(timer);
    if (!disposed && running.value) timer = setTimeout(() => void refreshStatus(), 500);
  }

  async function refreshStatus(): Promise<void> {
    if (polling || disposed) return;
    polling = true;
    const known = latest.value;
    try {
      const next = await batchApi.status(known);
      if (latest.value === known && next) accept(next);
      statusError.value = null;
    } catch (cause) {
      statusError.value = errorMessage(cause);
    } finally {
      polling = false;
      schedule();
    }
  }

  async function load(): Promise<void> {
    if (loading.value || busy.value) return;
    loading.value = true;
    listError.value = null;
    try {
      commands.value = await batchApi.list();
      if (!commands.value.some((command) => command.id === activeId.value)) {
        activeId.value = null;
        const first = commands.value[0];
        if (first) activate(first.id);
      }
    } catch (cause) {
      listError.value = errorMessage(cause);
    } finally {
      loading.value = false;
    }
  }

  async function change(operation: () => Promise<void>): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    actionError.value = null;
    try {
      await operation();
    } catch (cause) {
      actionError.value = errorMessage(cause);
    } finally {
      busy.value = false;
    }
  }

  function edit(previous: BatchCommand | null): void {
    editor.value = { previous, name: previous?.name ?? '', command: previous?.command ?? '' };
    actionError.value = null;
  }

  async function save(): Promise<void> {
    const draft = editor.value;
    if (!draft) return;
    await change(async () => {
      const saved = await batchApi.save(
        { name: draft.name, command: draft.command },
        draft.previous,
      );
      commands.value = draft.previous
        ? commands.value!.map((command) => (command.id === saved.id ? saved : command))
        : [...(commands.value ?? []), saved];
      editor.value = null;
      activate(saved.id);
      showingTargets.value = true;
    });
  }

  async function remove(command: BatchCommand): Promise<void> {
    await change(async () => {
      await batchApi.remove(command);
      commands.value = commands.value?.filter((entry) => entry.id !== command.id) ?? [];
      selections.delete(command.id);
      const remainingRuns = new Map(runs.value);
      remainingRuns.delete(command.id);
      runs.value = remainingRuns;
      activeId.value = null;
      const first = commands.value[0];
      if (first) activate(first.id);
    });
  }

  async function prepare(hostIds: string[], previous?: BatchRun): Promise<void> {
    const command = current.value;
    if (!command || !selection.value) return;
    const concurrency = selection.value.concurrency;
    await change(async () => {
      preview.value = await batchApi.prepare({
        commandId: command.id,
        revision: command.revision,
        hostIds,
        concurrency,
      });
      retryBase.value = previous ?? null;
    });
  }

  async function start(productionConfirmed: boolean): Promise<void> {
    const prepared = preview.value;
    if (!prepared) return;
    await change(async () => {
      try {
        const run = await batchApi.start(prepared.token, productionConfirmed);
        retry = retryBase.value ? { runId: run.id, previous: retryBase.value } : undefined;
        accept(run);
        showingTargets.value = false;
        statusError.value = null;
        schedule();
      } catch (cause) {
        // A lost response can leave an accepted run on the native side. Refresh before
        // allowing a fresh preview, without resending the original request.
        await refreshStatus();
        if (latest.value?.command.id === prepared.command.id && running.value)
          showingTargets.value = false;
        throw cause;
      } finally {
        preview.value = null;
        retryBase.value = null;
      }
    });
  }

  async function stop(run: BatchRun): Promise<void> {
    if (cancelling.value) return;
    cancelling.value = true;
    actionError.value = null;
    try {
      await batchApi.cancel(run.id);
      await refreshStatus();
    } catch (cause) {
      actionError.value = errorMessage(cause);
    } finally {
      cancelling.value = false;
    }
  }

  onMounted(() => {
    void load().then(() => {
      if (commands.value) void refreshStatus();
    });
  });
  onBeforeUnmount(() => {
    disposed = true;
    clearTimeout(timer);
  });

  return {
    commands,
    current,
    selection,
    selections,
    editor,
    preview,
    visibleResult,
    showingTargets,
    running,
    dirty,
    loading,
    busy,
    cancelling,
    listError,
    actionError,
    statusError,
    load,
    activate,
    edit,
    save,
    remove,
    prepare,
    start,
    stop,
    refreshStatus,
  };
}
