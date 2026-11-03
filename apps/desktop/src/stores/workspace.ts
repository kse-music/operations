import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { hostViews, type WorkspaceView } from '../types/product';
import { moduleForView, type NavigationModule } from '../types/navigation';
import { useTerminalsStore } from './terminals';
import type { ServerSection } from '../types/server';
export interface WorkspaceTab {
  key: string;
  view: WorkspaceView;
  hostId: string;
  section?: ServerSection;
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
  };
});
