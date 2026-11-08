import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { pluginsApi } from '../services/plugins';
import { isBuiltinAssistant } from '../services/plugin-pages';
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

export interface ImageRemovalReview {
  imageId: string;
  hostName: string;
  hostAddress: string;
  pluginName: string;
  pluginVersion: string;
}
export const usePluginsStore = defineStore('plugins', () => {
  const application = useApplicationStore();
  const installed = ref<InstalledPlugin[]>([]),
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
    imageRemoval?: ImageRemovalReview;
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
  const owners = new Map<string, string>();
  const assistantOwners = new Map<string, Set<string>>();
  const contextVersion = (id: string) => contextVersions.get(id) ?? 0;
  function bind(
    id: string,
    input: import('../types/plugins').PluginContextInput | null,
    owner = '',
  ): Promise<void> {
    const shared =
      !!owner && isBuiltinAssistant(installed.value.find((plugin) => plugin.manifest.id === id));
    if (shared) {
      const scopes = assistantOwners.get(id) ?? new Set<string>();
      scopes.add(owner);
      assistantOwners.set(id, scopes);
      owners.delete(id);
    } else {
      owners.set(id, owner);
      contextVersions.set(id, contextVersion(id) + 1);
    }
    const prior = bindings.get(id) ?? Promise.resolve();
    const work = async () => {
      const signature = shared ? 'builtin-assistant' : JSON.stringify(input);
      try {
        if (shared && !owns(id, owner)) return;
        if ((!shared && input === null) || contexts.get(id) !== signature) {
          if (shared) contextVersions.set(id, contextVersion(id) + 1);
          await pluginsApi.context(id, shared ? null : input);
          contexts.set(id, signature);
        }
        if (
          owner &&
          owns(id, owner) &&
          installed.value.find((plugin) => plugin.manifest.id === id)?.manifest.entry?.backend &&
          statuses.value.find((status) => status.id === id)?.state !== 'crashed'
        )
          await pluginsApi.activate(id);
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
    const scopes = assistantOwners.get(id);
    if (scopes?.has(owner)) {
      scopes.delete(owner);
      if (scopes.size) return Promise.resolve();
      assistantOwners.delete(id);
      return bind(id, null).catch((cause) => {
        assistantOwners.set(id, new Set([owner]));
        throw cause;
      });
    }
    if (owners.get(id) !== owner) return Promise.resolve();
    return bind(id, null).catch((cause) => {
      if (owners.get(id) === '') owners.set(id, owner);
      throw cause;
    });
  }
  function owns(id: string, owner: string): boolean {
    return assistantOwners.get(id)?.has(owner) || owners.get(id) === owner;
  }
  async function refresh(quiet = false): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    try {
      const list = await pluginsApi.list();
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
    try {
      await operation();
      ok = true;
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      busy.value = false;
      await refresh();
    }
    return ok;
  }
  function ask(
    title: string,
    message: string,
    confirmationText?: string | null,
    imageRemoval?: ImageRemovalReview,
  ): Promise<boolean> {
    if (prompt.value) return Promise.resolve(false);
    return new Promise((resolve) => {
      prompt.value = { title, message, confirmationText, imageRemoval, resolve };
    });
  }
  function decide(accepted: boolean) {
    const current = prompt.value;
    prompt.value = null;
    current?.resolve(accepted);
  }
  function clearPlugin(id: string) {
    owners.delete(id);
    assistantOwners.delete(id);
    contextVersions.set(id, contextVersion(id) + 1);
    delete schemas.value[id];
    contexts.delete(id);
  }
  useErrorNotifications(error);
  onScopeDispose(stop);
  return {
    installed,
    grants,
    statuses,
    loading,
    busy,
    loaded,
    error,
    schemas,
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
    clearPlugin,
    bind,
    contextVersion,
    release,
    owns,
  };
});
