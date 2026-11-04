import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { hostViews, type WorkspaceView } from '../types/product';
import { moduleForView, type NavigationModule } from '../types/navigation';
import { useTerminalsStore } from './terminals';
import type { ServerSection } from '../types/server';
import { usePluginsStore } from './plugins';
import { primaryPluginPage } from '../services/plugin-pages';
import { errorMessage } from '../services/ipc';
export interface WorkspaceTab {
  key: string;
  view: WorkspaceView;
  hostId: string;
  section?: ServerSection;
  pluginId?: string;
  contributionId?: string;
  logIntent?: { input: import('../types/ops').LogInput; title: string; sequence: number };
}
export type WorkspaceCloseScope = 'current' | 'right' | 'others' | 'all';
export const useWorkspaceStore = defineStore('workspace', () => {
  const tabs = ref<WorkspaceTab[]>([]),
    active = ref(''),
    hostId = ref(''),
    module = ref<NavigationModule>('hosts');
  const current = computed(() => tabs.value.find((t) => t.key === active.value));
  function selectModule(id: NavigationModule): void {
    module.value = id;
  }
  function selectHost(id: string): void {
    const tab = tabs.value.find((t) => hostViews.has(t.view) && t.hostId === id);
    if (tab) activate(tab.key);
    else navigate('terminals', id);
  }
  function activate(key: string): void {
    const tab = tabs.value.find((t) => t.key === key);
    if (!tab) return;
    active.value = key;
    module.value = moduleForView(tab.view);
    if (hostViews.has(tab.view) || (tab.view === 'extension' && tab.hostId))
      hostId.value = tab.hostId;
  }
  async function openPlugin(
    pluginId: string,
    contributionId: string,
    target = hostId.value,
    section?: ServerSection,
    logIntent?: WorkspaceTab['logIntent'],
  ): Promise<void> {
    const plugins = usePluginsStore();
    const installed = plugins.installed.find((p) => p.manifest.id === pluginId);
    if (!installed) return;
    if (!installed.manifest.contributions.some((entry) => entry.id === contributionId))
      contributionId = primaryPluginPage(installed);
    const contribution = installed.manifest.contributions.find(
      (entry) => entry.id === contributionId,
    );
    if (contribution?.kind === 'tool' || contribution?.kind === 'settings') target = '';
    const key = `extension:${pluginId}:${contributionId}:${target}`;
    const existing = tabs.value.find((t) => t.pluginId === pluginId);
    if (existing && existing.key !== key) {
      await close(existing.key);
      if (tabs.value.includes(existing)) return;
    }
    if (!tabs.value.some((t) => t.key === key))
      tabs.value.push({ key, view: 'extension', hostId: target, pluginId, contributionId });
    const tab = tabs.value.find((t) => t.key === key)!;
    if (section) tab.section = section;
    if (logIntent) tab.logIntent = logIntent;
    else if (section && section !== 'logs') tab.logIntent = undefined;
    activate(key);
  }
  function navigate(
    view: WorkspaceView,
    target = hostId.value,
    section?: WorkspaceTab['section'],
  ): void {
    if (['assistant', 'batch', 'automation', 'network'].includes(view)) {
      const plugins = usePluginsStore();
      const entry = plugins.extensions.find(
        (entry) => entry.kind === 'tool' && entry.tool === view,
      );
      if (!entry) {
        plugins.error = '此运维工具未安装、未启用或未授权，请在设置中的插件管理检查。';
        return;
      }
      void openPlugin(entry.pluginId, entry.id, '').catch((cause) => {
        plugins.error = errorMessage(cause);
      });
      return;
    }
    const hostView = hostViews.has(view);
    const key = hostView ? `host:${target}` : `${view}:`;
    let tab = tabs.value.find((t) => t.key === key);
    if (!tab) {
      tab = { key, view, hostId: hostView ? target : '', section };
      const firstGlobal = tabs.value.findIndex((item) => !hostViews.has(item.view));
      if (hostView && firstGlobal >= 0) tabs.value.splice(firstGlobal, 0, tab);
      else tabs.value.push(tab);
    } else {
      tab.view = view;
      if (section) tab.section = section;
    }
    activate(key);
  }
  const closing = ref<string[]>([]);
  async function close(key: string, scope: WorkspaceCloseScope = 'current'): Promise<void> {
    const index = tabs.value.findIndex((t) => t.key === key);
    if (index < 0) return;
    const targets = tabs.value.filter((tab, i) => {
      switch (scope) {
        case 'current':
          return tab.key === key;
        case 'right':
          return i > index;
        case 'others':
          return tab.key !== key;
        case 'all':
          return true;
      }
    });
    const removed = new Set<WorkspaceTab>();
    const terminals = useTerminalsStore();
    for (const tab of targets) {
      if (closing.value.includes(tab.key)) continue;
      closing.value.push(tab.key);
      try {
        if (tab.pluginId) {
          const plugins = usePluginsStore();
          if (!(await plugins.discard(tab.key))) continue;
          try {
            await plugins.bind(tab.pluginId, null);
          } catch (cause) {
            if (
              !['NOT_FOUND', 'PLUGIN_PERMISSION_DENIED'].includes(
                String((cause as { code?: string })?.code),
              )
            ) {
              plugins.error = String((cause as { message?: string })?.message ?? cause);
              continue;
            }
          }
          plugins.forget(tab.key);
        }
        if (hostViews.has(tab.view)) {
          const first = terminals.hostTabs(tab.hostId)[0];
          if (first) await terminals.closeAll(first.key);
          if (terminals.hostTabs(tab.hostId).length) continue;
        }
        removed.add(tab);
      } finally {
        closing.value = closing.value.filter((key) => key !== tab.key);
      }
    }
    if (!removed.size) return;
    tabs.value = tabs.value.filter((tab) => !removed.has(tab));
    if (!tabs.value.length) {
      active.value = '';
      module.value = 'hosts';
    } else if (active.value && !tabs.value.some((tab) => tab.key === active.value))
      activate(tabs.value[Math.min(index, tabs.value.length - 1)]!.key);
  }
  return {
    tabs,
    active,
    hostId,
    current,
    module,
    closing,
    selectModule,
    selectHost,
    activate,
    navigate,
    close,
    openPlugin,
  };
});
