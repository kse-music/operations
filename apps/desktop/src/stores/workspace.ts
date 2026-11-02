import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { hostViews, type WorkspaceView } from '../types/product';
export interface WorkspaceTab {
  key: string;
  view: WorkspaceView;
  hostId: string;
  section?: 'containers' | 'images' | 'processes' | 'ports' | 'services' | 'logs';
}
export type WorkspaceCloseScope = 'current' | 'right' | 'others' | 'all';
export const useWorkspaceStore = defineStore('workspace', () => {
  const tabs = ref<WorkspaceTab[]>([]),
    active = ref(''),
    hostId = ref('');
  const current = computed(() => tabs.value.find((t) => t.key === active.value));
  function selectHost(id: string): void {
    const tab = tabs.value.find((t) => hostViews.has(t.view) && t.hostId === id);
    if (tab) activate(tab.key);
    else navigate('terminals', id);
  }
  function activate(key: string): void {
    const tab = tabs.value.find((t) => t.key === key);
    if (!tab) return;
    active.value = key;
    if (hostViews.has(tab.view)) hostId.value = tab.hostId;
  }
  function navigate(
    view: WorkspaceView,
    target = hostId.value,
    section?: WorkspaceTab['section'],
  ): void {
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
  function close(key: string, scope: WorkspaceCloseScope = 'current'): void {
    const index = tabs.value.findIndex((t) => t.key === key);
    if (index < 0) return;
    tabs.value = tabs.value.filter((tab, i) => {
      switch (scope) {
        case 'current':
          return tab.key !== key;
        case 'right':
          return i <= index;
        case 'others':
          return tab.key === key;
        case 'all':
          return false;
      }
    });
    if (!tabs.value.length) active.value = '';
    else if (!tabs.value.some((tab) => tab.key === active.value))
      activate(tabs.value[Math.min(index, tabs.value.length - 1)]!.key);
  }
  return { tabs, active, hostId, current, selectHost, activate, navigate, close };
});
