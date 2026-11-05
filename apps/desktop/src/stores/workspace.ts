import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { hostViews, type WorkspaceView } from '../types/product';
import { moduleForView, type NavigationModule } from '../types/navigation';
import { useTerminalsStore } from './terminals';
import type { ServerSection } from '../types/server';
import { usePluginsStore } from './plugins';
import { primaryPluginPage } from '../services/plugin-pages';
import { errorMessage } from '../services/ipc';
import { serverPluginFor } from '../services/server-plugins';
export interface WorkspaceTab {
  key: string;
  view: WorkspaceView;
  hostId: string;
  section?: ServerSection;
  pluginId?: string;
  contributionId?: string;
  logIntent?: { input: import('../types/ops').LogInput; title: string; sequence: number };
}
export function isHostTab(tab: WorkspaceTab): boolean {
  return hostViews.has(tab.view) || (tab.view === 'extension' && !!tab.hostId);
}
export function pluginPageKey(
  tab: Pick<WorkspaceTab, 'pluginId' | 'contributionId' | 'hostId'>,
): string {
  return `extension:${tab.pluginId}:${tab.contributionId}:${tab.hostId}`;
}
export type WorkspaceCloseScope = 'current' | 'right' | 'others' | 'all';
export const useWorkspaceStore = defineStore('workspace', () => {
  const tabs = ref<WorkspaceTab[]>([]),
    active = ref(''),
    hostId = ref(''),
    module = ref<NavigationModule>('hosts');
  const current = computed(() => tabs.value.find((t) => t.key === active.value));
  const pluginPages = ref<WorkspaceTab[]>([]);
  const activePluginKey = computed(() =>
    current.value?.view === 'extension' ? pluginPageKey(current.value) : '',
  );
  function selectModule(id: NavigationModule): void {
    module.value = id;
  }
  function selectHost(id: string): void {
    const tab = tabs.value.find((t) => isHostTab(t) && t.hostId === id);
    if (tab) activate(tab.key);
    else navigate('terminals', id);
  }
  function activate(key: string): void {
    const tab = tabs.value.find((t) => t.key === key);
    if (!tab) return;
    active.value = key;
    module.value = isHostTab(tab) ? 'hosts' : moduleForView(tab.view);
    if (isHostTab(tab)) hostId.value = tab.hostId;
  }
  function openPluginSettings(pluginId: string): void {
    if (!usePluginsStore().installed.some((plugin) => plugin.manifest.id === pluginId)) return;
    const key = `plugin-settings:${pluginId}`;
    let tab = tabs.value.find((tab) => tab.key === key);
    if (!tab) {
      tab = { key, view: 'pluginSettings', hostId: '', pluginId };
      tabs.value.push(tab);
    }
    activate(key);
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
    if (!contribution || contribution.kind === 'settings') return openPluginSettings(pluginId);
    const globalDiagnostic =
      !target &&
      section === 'diagnostics' &&
      installed.manifest.permissions.includes('network.run') &&
      (await plugins.schema(pluginId)).pages.some(
        (page) =>
          page.id === contributionId &&
          page.surface?.kind === 'operations' &&
          page.surface.sections.includes('diagnostics'),
      );
    if (!target && contribution.kind !== 'tool' && !globalDiagnostic) {
      plugins.error = '请先选择主机，再打开此工具。';
      return;
    }
    const key = pluginPageKey({ pluginId, contributionId, hostId: target });
    let page = pluginPages.value.find((page) => page.key === key);
    if (!page) {
      page = { key, view: 'extension', hostId: target, pluginId, contributionId };
      pluginPages.value.push(page);
    }
    if (section) page.section = section;
    if (logIntent) page.logIntent = logIntent;
    else if (section && section !== 'logs') page.logIntent = undefined;
    const tabKey = target ? `host:${target}` : key;
    let tab = tabs.value.find((tab) => tab.key === tabKey);
    if (!tab) {
      tab = { ...page, key: tabKey };
      const firstGlobal = tabs.value.findIndex((item) => !isHostTab(item));
      if (target && firstGlobal >= 0) tabs.value.splice(firstGlobal, 0, tab);
      else tabs.value.push(tab);
    } else Object.assign(tab, page, { key: tabKey });
    activate(tabKey);
  }
  function navigate(
    view: WorkspaceView,
    target = hostId.value,
    section?: WorkspaceTab['section'],
  ): void {
    if (['assistant', 'network'].includes(view)) {
      const plugins = usePluginsStore();
      const entry = plugins.extensions.find(
        (entry) => entry.kind === 'tool' && entry.tool === view,
      );
      if (!entry && view === 'network') {
        void serverPluginFor('', 'diagnostics')
          .then((found) => {
            if (!found) throw new Error('请先启用提供网络诊断的插件。');
            return openPlugin(found.pluginId, found.id, '', 'diagnostics');
          })
          .catch((cause) => {
            plugins.error = errorMessage(cause);
          });
        return;
      }
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
      const firstGlobal = tabs.value.findIndex((item) => !isHostTab(item));
      if (hostView && firstGlobal >= 0) tabs.value.splice(firstGlobal, 0, tab);
      else tabs.value.push(tab);
    } else {
      tab.view = view;
      delete tab.pluginId;
      delete tab.contributionId;
      delete tab.logIntent;
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
        const pages = pluginPages.value.filter((page) =>
          isHostTab(tab) ? page.hostId === tab.hostId : page.key === tab.key,
        );
        const settingsKeys =
          tab.view === 'pluginSettings'
            ? Object.keys(usePluginsStore().drafts).filter((key) => key.startsWith(`${tab.key}:`))
            : [];
        const draftKeys = [...pages.map((page) => page.key), ...settingsKeys];
        if (draftKeys.length) {
          const plugins = usePluginsStore();
          let accepted = true;
          for (const key of draftKeys)
            if (!(await plugins.discard(key))) {
              accepted = false;
              break;
            }
          if (!accepted) continue;
        }
        if (isHostTab(tab)) {
          const first = terminals.hostTabs(tab.hostId)[0];
          if (first) await terminals.closeAll(first.key);
          if (terminals.hostTabs(tab.hostId).length) continue;
        }
        if (pages.length) {
          const plugins = usePluginsStore();
          try {
            for (const page of pages) await plugins.release(page.pluginId!, page.key);
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
        }
        for (const key of settingsKeys) await usePluginsStore().release(tab.pluginId!, key);
        for (const key of draftKeys) usePluginsStore().forget(key);
        pluginPages.value = pluginPages.value.filter((page) => !pages.includes(page));
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
    openPluginSettings,
    pluginPages,
    activePluginKey,
  };
});
