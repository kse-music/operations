import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { hostViews, settingsCategories, type WorkspaceView } from '../types/product';
import { moduleForView, type NavigationModule } from '../types/navigation';
import { useTerminalsStore } from './terminals';
import { useFilesStore } from './files';
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
export const allHostsTabKey = 'all-hosts';
export const useWorkspaceStore = defineStore('workspace', () => {
  const tabs = ref<WorkspaceTab[]>([]),
    active = ref(''),
    hostId = ref(''),
    module = ref<NavigationModule>('hosts');
  const current = computed(() => tabs.value.find((t) => t.key === active.value));
  const pluginPages = ref<WorkspaceTab[]>([]);
  const pluginConfiguration = ref<{ pluginId: string; contributionId: string | null }>();
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
  function openPluginSettings(pluginId: string, contributionId?: string): void {
    const plugins = usePluginsStore();
    if (pluginConfiguration.value || !plugins.installed.some((p) => p.manifest.id === pluginId))
      return;
    const settings = plugins.extensions.find(
      (entry) =>
        entry.pluginId === pluginId &&
        entry.kind === 'settings' &&
        (!contributionId || entry.id === contributionId),
    );
    pluginConfiguration.value = { pluginId, contributionId: settings?.id ?? null };
  }
  async function openPlugin(
    pluginId: string,
    contributionId: string,
    target = hostId.value,
    section?: ServerSection,
  ): Promise<void> {
    const plugins = usePluginsStore();
    const installed = plugins.installed.find((p) => p.manifest.id === pluginId);
    if (!installed) return;
    if (!installed.manifest.contributions.some((entry) => entry.id === contributionId))
      contributionId = primaryPluginPage(installed);
    const contribution = installed.manifest.contributions.find(
      (entry) => entry.id === contributionId,
    );
    if (!contribution) return openPluginSettings(pluginId);
    if (contribution.kind === 'settings') return openPluginSettings(pluginId, contribution.id);
    if (!target && contribution.kind !== 'tool') {
      plugins.error = '请先选择主机，再打开此工具。';
      return;
    }
    const key = pluginPageKey({ pluginId, contributionId, hostId: target });
    if (closing.value.includes(target ? `host:${target}` : key)) return;
    let page = pluginPages.value.find((page) => page.key === key);
    if (!page) {
      page = { key, view: 'extension', hostId: target, pluginId, contributionId };
      pluginPages.value.push(page);
    }
    if (section) page.section = section;
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
    if (view === 'assistant') {
      const plugins = usePluginsStore();
      const entry = plugins.extensions.find(
        (entry) => entry.kind === 'tool' && entry.tool === view,
      );
      if (!entry) {
        plugins.error = '此运维工具未安装、未启用或未授权，请在“插件 → 插件管理”中检查。';
        return;
      }
      void openPlugin(entry.pluginId, entry.id, '').catch((cause) => {
        plugins.error = errorMessage(cause);
      });
      return;
    }
    const hostView = hostViews.has(view);
    const key = hostView ? `host:${target}` : `${view}:`;
    if (closing.value.includes(key)) return;
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
      if (section) tab.section = section;
    }
    activate(key);
  }
  const closing = ref<string[]>([]);
  const settingsCloseGuard = shallowRef<() => Promise<boolean>>();
  async function close(key: string, scope: WorkspaceCloseScope = 'current'): Promise<void> {
    const hostGroup = key === allHostsTabKey;
    const index = hostGroup
      ? tabs.value.findIndex(isHostTab)
      : tabs.value.findIndex((t) => t.key === key);
    if (index < 0) return;
    const targetIsHost = isHostTab(tabs.value[index]!);
    const targets = tabs.value.filter((tab, i) => {
      if (hostGroup) return scope === 'all' || isHostTab(tab) === (scope === 'current');
      switch (scope) {
        case 'current':
          return tab.key === key;
        case 'right':
          return i > index && isHostTab(tab) === targetIsHost;
        case 'others':
          return tab.key !== key;
        case 'all':
          return true;
      }
    });
    const settingsTabs = tabs.value.filter((tab) =>
      settingsCategories.some((category) => category.view === tab.view),
    );
    if (
      settingsTabs.length &&
      settingsTabs.every((tab) => targets.includes(tab)) &&
      settingsCloseGuard.value &&
      !(await settingsCloseGuard.value())
    )
      return;
    const removed = new Set<WorkspaceTab>();
    const terminals = useTerminalsStore();
    const files = useFilesStore();
    for (const tab of targets) {
      if (closing.value.includes(tab.key)) continue;
      closing.value.push(tab.key);
      if (isHostTab(tab) && tab.hostId) files.closingHosts.push(tab.hostId);
      try {
        const pages = pluginPages.value.filter((page) =>
          isHostTab(tab) ? page.hostId === tab.hostId : page.key === tab.key,
        );
        const draftKeys = pages.map((page) => page.key);
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
          if (tab.hostId && !(await files.prepareHostClose(tab.hostId))) continue;
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
        if (isHostTab(tab) && tab.hostId && !(await files.clearHostTransfers(tab.hostId))) continue;
        for (const key of draftKeys) usePluginsStore().forget(key);
        pluginPages.value = pluginPages.value.filter((page) => !pages.includes(page));
        removed.add(tab);
        tabs.value = tabs.value.filter((item) => item !== tab);
      } finally {
        if (isHostTab(tab))
          files.closingHosts = files.closingHosts.filter((id) => id !== tab.hostId);
        closing.value = closing.value.filter((key) => key !== tab.key);
      }
    }
    if (!removed.size) return;
    tabs.value = tabs.value.filter((tab) => !removed.has(tab));
    if (!tabs.value.length) {
      active.value = '';
      module.value = 'hosts';
    } else if (active.value && !tabs.value.some((tab) => tab.key === active.value)) {
      const rememberedHost =
        hostGroup && (scope === 'right' || scope === 'others')
          ? tabs.value.find((tab) => isHostTab(tab) && tab.hostId === hostId.value)
          : undefined;
      activate((rememberedHost ?? tabs.value[Math.min(index, tabs.value.length - 1)])!.key);
    }
  }
  return {
    tabs,
    active,
    hostId,
    current,
    module,
    closing,
    settingsCloseGuard,
    selectModule,
    selectHost,
    activate,
    navigate,
    close,
    openPlugin,
    openPluginSettings,
    pluginConfiguration,
    pluginPages,
    activePluginKey,
  };
});
