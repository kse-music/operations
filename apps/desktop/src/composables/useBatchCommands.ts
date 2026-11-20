import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';
import { batchApi } from '../services/batch';
import { errorMessage } from '../services/ipc';
import type { BatchCommand, BatchCommandInput, BatchPreview, BatchRun } from '../types/batch';

interface Editor extends BatchCommandInput {
  previous: BatchCommand | null;
  folder: string | null;
  environment: string;
}

function draftFor(previous: BatchCommand | null, filters?: Editor): Editor {
  return {
    previous,
    name: previous?.name ?? '',
    command: previous?.command ?? '',
    hostIds: [...(previous?.hostIds ?? [])],
    concurrency: previous?.concurrency ?? 3,
    folder: filters?.folder ?? null,
    environment: filters?.environment ?? '',
  };
}

function draftChanged(draft?: Editor | null): boolean {
  if (!draft) return false;
  const saved = draft.previous;
  const savedIds = new Set(saved?.hostIds);
  return (
    draft.name !== (saved?.name ?? '') ||
    draft.command !== (saved?.command ?? '') ||
    draft.concurrency !== (saved?.concurrency ?? 3) ||
    draft.hostIds.length !== savedIds.size ||
    draft.hostIds.some((id) => !savedIds.has(id))
  );
}

function countProductionTargets(prepared: BatchPreview): number {
  return prepared.targets.filter(({ environment }) =>
    ['生产', 'production'].includes(environment?.name.toLowerCase() ?? ''),
  ).length;
}

export function useBatchCommands() {
  const commands = shallowRef<BatchCommand[] | null>(null);
  const activeId = ref<string | null>(null);
  const current = computed(() => commands.value?.find((command) => command.id === activeId.value));
  const drafts = reactive(new Map<string, Editor>());
  const newDraft = ref<Editor | null>(null);
  let previousSelection: string | null = null;
  const editor = computed(() => (activeId.value ? drafts.get(activeId.value) : newDraft.value));
  const preview = shallowRef<BatchPreview | null>(null);
  const productionCount = computed(() =>
    preview.value ? countProductionTargets(preview.value) : 0,
  );
  const retryBase = shallowRef<BatchRun | null>(null);
  const latest = shallowRef<BatchRun | null>(null);
  const runs = shallowRef(new Map<string, BatchRun>());
  const result = computed(() => (activeId.value ? runs.value.get(activeId.value) : undefined));
  const showingResult = ref(false);
  const visibleResult = computed(() => (showingResult.value ? result.value : undefined));
  const running = computed(() => Boolean(latest.value && !latest.value.finished));
  const dirty = computed(
    () => draftChanged(newDraft.value) || [...drafts.values()].some(draftChanged),
  );
  const editorDirty = computed(() => draftChanged(editor.value));
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
    const command = commands.value?.find((entry) => entry.id === id);
    if (!command) return;
    if (!drafts.has(id)) drafts.set(id, draftFor(command));
    activeId.value = id;
    showEditor();
  }

  function showEditor(): void {
    preview.value = null;
    retryBase.value = null;
    showingResult.value = false;
    actionError.value = null;
  }

  function create(): void {
    if (activeId.value) previousSelection = activeId.value;
    newDraft.value ??= draftFor(null);
    activeId.value = null;
    showEditor();
  }

  function cancelNewDraft(): void {
    newDraft.value = null;
    const entry =
      commands.value?.find((item) => item.id === previousSelection) ?? commands.value?.[0];
    if (entry) activate(entry.id);
    actionError.value = null;
  }

  function restoreSaved(): void {
    const saved = current.value;
    const draft = editor.value;
    if (!saved || !draft) return;
    drafts.set(saved.id, draftFor(saved, draft));
    actionError.value = null;
  }

  function hasChanges(id: string): boolean {
    return draftChanged(drafts.get(id));
  }

  function isRunning(id: string): boolean {
    return running.value && latest.value?.command.id === id;
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
      for (const command of commands.value) {
        const draft = drafts.get(command.id);
        if (draft && !draftChanged(draft)) drafts.set(command.id, draftFor(command, draft));
      }
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

  async function save(): Promise<void> {
    const draft = editor.value;
    if (!draft) return;
    await change(async () => {
      const saved = await batchApi.save(
        {
          name: draft.name,
          command: draft.command,
          hostIds: [...draft.hostIds],
          concurrency: draft.concurrency,
        },
        draft.previous,
      );
      commands.value = draft.previous
        ? (commands.value ?? []).map((command) => (command.id === saved.id ? saved : command))
        : [...(commands.value ?? []), saved];
      if (!draft.previous) newDraft.value = null;
      drafts.set(saved.id, draftFor(saved, draft));
      activate(saved.id);
    });
  }

  async function remove(command: BatchCommand): Promise<void> {
    if (isRunning(command.id)) return;
    await change(async () => {
      await batchApi.remove(command);
      commands.value = commands.value?.filter((entry) => entry.id !== command.id) ?? [];
      drafts.delete(command.id);
      const remainingRuns = new Map(runs.value);
      remainingRuns.delete(command.id);
      runs.value = remainingRuns;
      if (activeId.value === command.id) {
        activeId.value = null;
        showEditor();
        const first = commands.value[0];
        if (first) activate(first.id);
      }
    });
  }

  async function runSaved(command: BatchCommand, previous?: BatchRun): Promise<void> {
    if (busy.value || running.value || hasChanges(command.id) || !command.hostIds.length) return;
    activate(command.id);
    if (previous) showingResult.value = true;
    const retryHostIds = previous?.results
      .filter((row) => row.status === 'connectionFailed')
      .map((row) => row.target.id);
    await change(async () => {
      const prepared = await batchApi.prepare({
        commandId: command.id,
        revision: command.revision,
        ...(retryHostIds ? { retryHostIds } : {}),
      });
      if (!previous && countProductionTargets(prepared) === 0) {
        await execute(prepared, false);
      } else {
        preview.value = prepared;
        retryBase.value = previous ?? null;
      }
    });
  }

  async function execute(prepared: BatchPreview, productionConfirmed: boolean): Promise<void> {
    try {
      const run = await batchApi.start(prepared.token, productionConfirmed);
      retry = retryBase.value ? { runId: run.id, previous: retryBase.value } : undefined;
      accept(run);
      showingResult.value = true;
      statusError.value = null;
      schedule();
    } catch (cause) {
      // A lost response can leave an accepted run on the native side. Refresh before
      // allowing a fresh preview, without resending the original request.
      await refreshStatus();
      if (latest.value?.command.id === prepared.command.id && running.value)
        showingResult.value = true;
      throw cause;
    } finally {
      preview.value = null;
      retryBase.value = null;
    }
  }

  async function start(productionConfirmed: boolean): Promise<void> {
    const prepared = preview.value;
    if (!prepared) return;
    await change(() => execute(prepared, productionConfirmed));
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
    editor,
    preview,
    productionCount,
    result,
    visibleResult,
    showingResult,
    running,
    dirty,
    editorDirty,
    loading,
    busy,
    cancelling,
    listError,
    actionError,
    statusError,
    load,
    activate,
    create,
    cancelNewDraft,
    restoreSaved,
    showEditor,
    hasChanges,
    isRunning,
    save,
    remove,
    runSaved,
    start,
    stop,
    refreshStatus,
  };
}
