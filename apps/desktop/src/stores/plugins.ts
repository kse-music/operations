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
  PluginValues,
  PluginUi,
} from '../types/plugins';

export interface PluginDraft {
  values: PluginValues;
  output: unknown;
  dirty: boolean;
  revision: string;
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
  const drafts = ref<Record<string, PluginDraft>>({});
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
  const dirtyCount = computed(() => Object.values(drafts.value).filter((d) => d.dirty).length);
  const t = (zh: string, en: string) => (locale.value === 'en-US' ? en : zh);
  const label = (value: PluginLabel) => (typeof value === 'string' ? value : value[locale.value]);
  let timer: ReturnType<typeof setInterval> | undefined;
  const bindings = new Map<string, Promise<void>>();
  const contexts = new Map<string, string>();
  const contextVersions = new Map<string, number>();
  const contextVersion = (id: string) => contextVersions.get(id) ?? 0;
  function bind(
    id: string,
    input: import('../types/plugins').PluginContextInput | null,
  ): Promise<void> {
    contextVersions.set(id, contextVersion(id) + 1);
    const prior = bindings.get(id) ?? Promise.resolve();
    const work = async () => {
      const signature = JSON.stringify(input);
      if (input !== null && contexts.get(id) === signature) return;
      await pluginsApi.context(id, input);
      contexts.set(id, signature);
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
  function ask(title: string, message: string, confirmationText?: string | null): Promise<boolean> {
    if (prompt.value) return Promise.resolve(false);
    return new Promise((resolve) => {
      prompt.value = { title, message, confirmationText, resolve };
    });
  }
  function decide(accepted: boolean) {
    const current = prompt.value;
    prompt.value = null;
    current?.resolve(accepted);
  }
  async function discard(key: string): Promise<boolean> {
    if (!drafts.value[key]?.dirty) return true;
    return ask(
      t('放弃未保存的插件编辑？', 'Discard plugin edits?'),
      t('此页面的未保存内容将被放弃。', 'Unsaved changes in this page will be discarded.'),
    );
  }
  function forget(key: string) {
    delete drafts.value[key];
  }
  function clearPlugin(id: string) {
    contextVersions.set(id, contextVersion(id) + 1);
    delete schemas.value[id];
    contexts.delete(id);
    for (const key of Object.keys(drafts.value))
      if (key.startsWith(`extension:${id}:`)) delete drafts.value[key];
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
    drafts,
    schemas,
    schema,
    prompt,
    extensions,
    dirtyCount,
    t,
    label,
    refresh,
    start,
    stop,
    mutate,
    ask,
    decide,
    discard,
    forget,
    clearPlugin,
    bind,
    contextVersion,
  };
});
