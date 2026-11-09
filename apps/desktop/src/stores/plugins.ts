import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { pluginsApi } from '../services/plugins';
import { errorMessage } from '../services/ipc';
import { useErrorNotifications } from '../composables/error-notifications';
import { useApplicationStore } from './application';
import type {
  InstalledPlugin,
  PluginGrant,
  PluginRuntimeStatus,
  PluginLocale,
  PluginLabel,
  PluginUi,
} from '../types/plugins';

export const usePluginsStore = defineStore('plugins', () => {
  const application = useApplicationStore();
  const installed = ref<InstalledPlugin[]>([]),
    problems = ref<import('../types/plugins').PluginProblem[]>([]),
    grants = ref<Record<string, PluginGrant | null>>({}),
    statuses = ref<PluginRuntimeStatus[]>([]);
  const loading = ref(false),
    busy = ref(false),
    loaded = ref(false),
    error = ref<string | null>(null);
  const locale = computed<PluginLocale>(
    () => application.state?.config.product?.language ?? 'zh-CN',
  );
  const schemas = ref<Record<string, { revision: string; ui: PluginUi }>>({});
  const settingsRevisions = ref<Record<string, number>>({});
  const dirtyPages = ref<Record<string, string>>({});
  const dirty = computed(() => Object.keys(dirtyPages.value).length > 0);
  function setDraftDirty(key: string, id: string, value: boolean) {
    if (value) dirtyPages.value[key] = id;
    else delete dirtyPages.value[key];
  }
  async function schema(id: string): Promise<PluginUi> {
    const plugin = installed.value.find((p) => p.manifest.id === id);
    if (!plugin) throw new Error('插件已卸载');
    if (schemas.value[id]?.revision === plugin.revision) return schemas.value[id]!.ui;
    const ui = await pluginsApi.ui(id, plugin.revision);
    schemas.value[id] = { revision: plugin.revision, ui };
    return ui;
  }
  const prompt = shallowRef<{
    title: string;
    message: string;
    confirmationText?: string | null;
    owner?: string;
    resolve: (accepted: boolean) => void;
  } | null>(null);
  const extensions = computed(() =>
    installed.value.flatMap((p) => {
      const grant = grants.value[p.manifest.id];
      return p.enabled &&
        grant?.revision === p.revision &&
        grant.permissions.includes('ui.contribute') &&
        grant.operations.includes('ui.contribute')
        ? p.manifest.contributions.map((c) => ({
            ...c,
            pluginId: p.manifest.id,
            pluginName: p.manifest.name,
            source: p.source ?? 'user',
          }))
        : [];
    }),
  );
  const t = (zh: string, en: string) => (locale.value === 'en-US' ? en : zh);
  const label = (value: PluginLabel) => (typeof value === 'string' ? value : value[locale.value]);
  let timer: ReturnType<typeof setInterval> | undefined;
  const bindings = new Map<string, Promise<void>>();
  const contexts = new Map<string, string>();
  const contextVersions = new Map<string, number>();
  const scopeOwners = new Map<string, Set<string>>();
  const contextVersion = (id: string) => contextVersions.get(id) ?? 0;
  function owns(id: string, owner: string): boolean {
    return scopeOwners.get(id)?.has(owner) === true;
  }
  function bind(id: string, owner = ''): Promise<void> {
    if (owner) {
      const scopes = scopeOwners.get(id) ?? new Set<string>();
      scopes.add(owner);
      scopeOwners.set(id, scopes);
    }
    const prior = bindings.get(id) ?? Promise.resolve();
    const work = async () => {
      if (owner && !owns(id, owner)) return;
      try {
        if (!owner || !contexts.has(id)) {
          contextVersions.set(id, contextVersion(id) + 1);
          await pluginsApi.reset(id);
          if (owner) contexts.set(id, 'platform');
          else contexts.delete(id);
        }
        if (owner && owns(id, owner)) {
          await pluginsApi.scopeVisibility(id, owner, true);
          if (
            installed.value.find((p) => p.manifest.id === id)?.manifest.entry.backend &&
            statuses.value.find((status) => status.id === id)?.state !== 'crashed'
          )
            await pluginsApi.activate(id);
        }
      } catch (cause) {
        contexts.delete(id);
        throw cause;
      }
    };
    const job = prior.then(work, work);
    const observed = job.then(
      () => {},
      () => {},
    );
    bindings.set(id, observed);
    void observed.then(() => {
      if (bindings.get(id) === observed) bindings.delete(id);
    });
    return job;
  }
  function release(id: string, owner: string): Promise<void> {
    const work = async () => {
      await pluginsApi.closeScope(id, owner);
      const scopes = scopeOwners.get(id);
      if (!scopes?.has(owner)) return;
      if (scopes.size === 1) {
        await pluginsApi.reset(id);
        contextVersions.set(id, contextVersion(id) + 1);
        contexts.delete(id);
      }
      scopes.delete(owner);
      if (!scopes.size) scopeOwners.delete(id);
    };
    const prior = bindings.get(id) ?? Promise.resolve();
    const job = prior.then(work, work),
      observed = job.then(
        () => {},
        () => {},
      );
    bindings.set(id, observed);
    void observed.then(() => {
      if (bindings.get(id) === observed) bindings.delete(id);
    });
    return job;
  }
  async function refresh(quiet = false): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    try {
      const inventory = await pluginsApi.inventory();
      const list = inventory.installed;
      problems.value = inventory.problems;
      const next: Record<string, PluginGrant | null> = {};
      for (let start = 0; start < list.length; start += 8) {
        await Promise.all(
          list.slice(start, start + 8).map(async (p) => {
            next[p.manifest.id] = await pluginsApi.permissions(p.manifest.id);
          }),
        );
      }
      installed.value = list;
      grants.value = next;
      try {
        statuses.value = await pluginsApi.statuses();
      } catch (cause) {
        if (!(typeof cause === 'object' && cause && 'code' in cause && cause.code === 'BUSY'))
          throw cause;
      }
      loaded.value = true;
      error.value = null;
    } catch (cause) {
      if (!quiet) error.value = errorMessage(cause);
    } finally {
      loading.value = false;
    }
  }
  function start() {
    void refresh();
    if (!timer)
      timer = setInterval(() => {
        if (!busy.value) void refresh(true);
      }, 2000);
  }
  function stop() {
    clearInterval(timer);
    timer = undefined;
  }
  async function mutate(operation: () => Promise<unknown>): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    error.value = null;
    let ok = false;
    let failure: string | null = null;
    try {
      await operation();
      ok = true;
    } catch (cause) {
      failure = errorMessage(cause);
    } finally {
      busy.value = false;
      await refresh();
      if (failure)
        error.value = error.value ? `${failure}；刷新插件列表失败：${error.value}` : failure;
    }
    return ok;
  }
  function ask(
    title: string,
    message: string,
    confirmationText?: string | null,
    owner?: string,
  ): Promise<boolean> {
    if (prompt.value) return Promise.resolve(false);
    return new Promise((resolve) => {
      prompt.value = { title, message, confirmationText, owner, resolve };
    });
  }
  function decide(accepted: boolean) {
    const current = prompt.value;
    prompt.value = null;
    current?.resolve(accepted);
  }
  function cancelPrompt(owner: string) {
    if (prompt.value?.owner === owner) decide(false);
  }
  function clearPlugin(id: string) {
    for (const [key, owner] of Object.entries(dirtyPages.value))
      if (owner === id) delete dirtyPages.value[key];
    scopeOwners.delete(id);
    contextVersions.set(id, contextVersion(id) + 1);
    delete schemas.value[id];
    contexts.delete(id);
  }
  useErrorNotifications(error);
  onScopeDispose(stop);
  return {
    installed,
    problems,
    dirtyPages,
    dirty,
    setDraftDirty,
    grants,
    statuses,
    loading,
    busy,
    loaded,
    error,
    schemas,
    settingsRevisions,
    schema,
    prompt,
    extensions,
    t,
    label,
    refresh,
    start,
    stop,
    mutate,
    ask,
    decide,
    cancelPrompt,
    clearPlugin,
    bind,
    contextVersion,
    release,
    owns,
  };
});
