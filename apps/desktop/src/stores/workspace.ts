import { tr } from '../i18n/messages';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { hostViews, type WorkspaceView } from '../types/product';
import { isSettingsView, type SettingsView } from '../types/navigation';
import { useTerminalsStore } from './terminals';
import { useFilesStore } from './files';
import type { ServerSection } from '../types/server';
import { usePluginsStore } from './plugins';
import { primaryPluginPage } from '../services/plugin-pages';
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
export type WorkspaceArea = 'home' | 'local' | 'settings';
export const useWorkspaceStore = defineStore('workspace', () => {
  const tabs = ref<WorkspaceTab[]>([]),
    active = ref(''),
    hostId = ref('');
  const settingsView = ref<SettingsView | null>(null);
  const area = ref<WorkspaceArea>('home');
  const settingsBusy = ref(false);
  const settingsDirty = ref(false);
  const navigationBlocked = computed(
    () =>
      area.value === 'settings' &&
      (settingsBusy.value || pluginSettingsBusy.value || usePluginsStore().busy),
  );
  let homeKey = '';
  const pluginSettingsBusy = ref(false);
  const current = computed(() => tabs.value.find((t) => t.key === active.value));
  const pluginPages = ref<WorkspaceTab[]>([]);
  const pluginConfiguration = ref<{ pluginId: string; contributionId: string | null }>();
  const activePluginKey = computed(() =>
    current.value?.view === 'extension' ? pluginPageKey(current.value) : '',
  );
  function selectHost(id: string): void {
    const tab = tabs.value.find((t) => isHostTab(t) && t.hostId === id);
    if (tab) activate(tab.key);
    else navigate('terminals', id);
  }
  function activate(key: string): void {
    if (navigationBlocked.value) return;
    const tab = tabs.value.find((t) => t.key === key);
    if (!tab) return;
    active.value = key;
    area.value = isHostTab(tab) && !tab.hostId ? 'local' : 'home';
    if (area.value === 'home') homeKey = key;
    if (isHostTab(tab)) hostId.value = tab.hostId;
    if (tab.view === 'terminals') useTerminalsStore().activateHost(tab.hostId);
  }
  function showHome(welcome = false): void {
    if (navigationBlocked.value) return;
    if (welcome) homeKey = '';
    const tab = tabs.value.find((tab) => tab.key === homeKey);
    if (tab) activate(tab.key);
    else {
      active.value = '';
      area.value = 'home';
    }
  }
  function showSettings(): void {
    if (navigationBlocked.value) return;
    settingsView.value ??= 'settings';
    area.value = 'settings';
  }
  function openPluginSettings(pluginId: string, contributionId?: string): void {
    const plugins = usePluginsStore();
    if (
      settingsBusy.value ||
      pluginSettingsBusy.value ||
      plugins.busy ||
      !plugins.installed.some((p) => p.manifest.id === pluginId)
    )
      return;
    if (pluginConfiguration.value) {
      if (pluginConfiguration.value.pluginId !== pluginId)
        plugins.error = tr('请先返回插件列表，再打开其他插件配置。');
      settingsView.value = 'plugins';
      area.value = 'settings';
      return;
    }
    const settings = plugins.extensions.find(
      (entry) =>
        entry.pluginId === pluginId &&
        entry.kind === 'settings' &&
        (!contributionId || entry.id === contributionId),
    );
    settingsView.value = 'plugins';
    area.value = 'settings';
    pluginConfiguration.value = { pluginId, contributionId: settings?.id ?? null };
  }
  function closePluginSettings(): void {
    if (pluginSettingsBusy.value || usePluginsStore().busy) return;
    pluginConfiguration.value = undefined;
  }
  async function openPlugin(
    pluginId: string,
    contributionId: string,
    target = '',
    section?: ServerSection,
  ): Promise<void> {
    if (navigationBlocked.value) return;
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
    if (!target && ['server', 'host_menu'].includes(contribution.kind)) target = hostId.value;
    if (!target && ['server', 'host_menu'].includes(contribution.kind)) {
      plugins.error = tr('请先选择主机，再打开此工具。');
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
      tabs.value.push(tab);
    } else Object.assign(tab, page, { key: tabKey });
    activate(tabKey);
  }
  function navigate(
    view: WorkspaceView,
    target = hostId.value,
    section?: WorkspaceTab['section'],
  ): void {
    if (navigationBlocked.value) return;
    if (isSettingsView(view)) {
      if (pluginSettingsBusy.value || usePluginsStore().busy) return;
      pluginConfiguration.value = undefined;
      settingsView.value = view;
      area.value = 'settings';
      return;
    }
    const hostView = hostViews.has(view);
    const key = hostView ? `host:${target}` : `${view}:`;
    if (closing.value.includes(key)) return;
    let tab = tabs.value.find((t) => t.key === key);
    if (!tab) {
      tab = { key, view, hostId: hostView ? target : '', section };
      tabs.value.push(tab);
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
  async function closeSettings(): Promise<void> {
    if (!settingsView.value || navigationBlocked.value) return;
    if (settingsCloseGuard.value && !(await settingsCloseGuard.value())) return;
    if (pluginSettingsBusy.value || usePluginsStore().busy) return;
    pluginConfiguration.value = undefined;
    settingsView.value = null;
    area.value =
      current.value && isHostTab(current.value) && !current.value.hostId ? 'local' : 'home';
  }
  async function close(key: string, scope: WorkspaceCloseScope = 'current'): Promise<void> {
    if (navigationBlocked.value) return;
    const previousArea = area.value;
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
    const files = useFilesStore();
    for (const tab of targets) {
      if (closing.value.includes(tab.key)) continue;
      closing.value.push(tab.key);
      if (isHostTab(tab) && tab.hostId) files.closingHosts.push(tab.hostId);
      try {
        const pages = pluginPages.value.filter((page) =>
          isHostTab(tab) ? page.hostId === tab.hostId : page.key === tab.key,
        );
        const plugins = usePluginsStore();
        if (
          pages.some((page) => plugins.dirtyPages[page.key]) &&
          !(await plugins.ask(
            tr('插件配置尚未保存'),
            tr('关闭工作区会放弃插件中未保存的文本。是否继续关闭？'),
          ))
        )
          continue;
        if (isHostTab(tab)) {
          const decision = terminals.confirmHostUploadClose(tab.hostId);
          if (decision !== true && !(await decision)) continue;
          if (tab.hostId && !(await files.prepareHostClose(tab.hostId))) continue;
          const first = terminals.hostTabs(tab.hostId)[0];
          if (first) await terminals.closeAll(first.key, true);
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
        pluginPages.value = pluginPages.value.filter((page) => !pages.includes(page));
        for (const page of pages) plugins.setDraftDirty(page.key, page.pluginId!, false);
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
    } else if (active.value && !tabs.value.some((tab) => tab.key === active.value)) {
      activate(tabs.value[Math.min(index, tabs.value.length - 1)]!.key);
    }
    if (previousArea === 'settings') area.value = 'settings';
  }
  return {
    tabs,
    active,
    hostId,
    current,
    closing,
    settingsCloseGuard,
    settingsView,
    area,
    settingsBusy,
    settingsDirty,
    navigationBlocked,
    showHome,
    showSettings,
    pluginSettingsBusy,
    closeSettings,
    selectHost,
    activate,
    navigate,
    close,
    openPlugin,
    openPluginSettings,
    closePluginSettings,
    pluginConfiguration,
    pluginPages,
    activePluginKey,
  };
});
