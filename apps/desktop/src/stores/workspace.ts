import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { hostViews, type WorkspaceView } from '../types/product';
export interface WorkspaceTab {
  key: string;
  view: WorkspaceView;
  hostId: string;
  section?: 'containers' | 'images' | 'processes' | 'ports' | 'services' | 'logs';
}
export const useWorkspaceStore = defineStore('workspace', () => {
  const tabs = ref<WorkspaceTab[]>([{ key: 'hosts:', view: 'hosts', hostId: '' }]),
    active = ref('hosts:');
  const current = computed(() => tabs.value.find((t) => t.key === active.value)!);
  function navigate(view: WorkspaceView, hostId = '', section?: WorkspaceTab['section']): void {
    if (!hostViews.has(view)) hostId = '';
    const key = `${view}:${hostId}`;
    let tab = tabs.value.find((t) => t.key === key);
    if (!tab) {
      if (tabs.value.length >= 24)
        tabs.value.splice(
          tabs.value.findIndex((t) => t.key !== active.value),
          1,
        );
      tab = { key, view, hostId, section };
      tabs.value.push(tab);
    } else if (section) tab.section = section;
    active.value = key;
  }
  function close(key: string): void {
    const index = tabs.value.findIndex((t) => t.key === key);
    if (index < 0) return;
    tabs.value.splice(index, 1);
    if (!tabs.value.length) navigate('hosts');
    else if (active.value === key)
      active.value = tabs.value[Math.min(index, tabs.value.length - 1)]!.key;
  }
  return { tabs, active, current, navigate, close };
});
