<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Activity, ListTree, Settings2, ScrollText, Server } from '@lucide/vue';
import Monitor from './monitor/App.vue';
import Processes from './processes/App.vue';
import Logs from './logs/App.vue';
import Units from './ServiceUnits.vue';
import { useHostsStore } from '@serverdeck/plugin-sdk/stores/hosts';
import { hostDisplayName } from '@serverdeck/plugin-sdk/types/hosts';
import type { ServerSection } from '@serverdeck/plugin-sdk/types/server';
import type { PluginUiPage } from '@serverdeck/plugin-sdk/types/plugins';
import type { LogInput } from '@serverdeck/plugin-sdk/types/ops';
import './system.css';
const props = defineProps<{
  hostId?: string;
  initialSection?: ServerSection;
  page?: PluginUiPage;
  logIntent?: { input: LogInput; title: string; sequence: number };
}>();
const emit = defineEmits<{ section: [value: ServerSection] }>();
const hosts = useHostsStore();
const legacyMonitor = props.page?.surface?.kind === 'monitor';
const tabs = [
  {
    id: 'overview',
    label: '资源监控',
    description: 'CPU、内存、磁盘与网络',
    icon: Activity,
    component: Monitor,
  },
  {
    id: 'processes',
    label: '进程与端口',
    description: '进程详情与监听端口',
    icon: ListTree,
    component: Processes,
  },
  {
    id: 'services',
    label: 'systemd 服务',
    description: '服务状态与运行管理',
    icon: Settings2,
    component: Units,
  },
  {
    id: 'logs',
    label: '日志查看',
    description: '文件与服务实时日志',
    icon: ScrollText,
    component: Logs,
  },
] as const;
type TabId = (typeof tabs)[number]['id'];
function group(section?: ServerSection): TabId {
  if (section === 'disks' || section === 'network') return 'overview';
  if (section === 'ports') return 'processes';
  return tabs.find((tab) => tab.id === section)?.id ?? 'overview';
}
const selected = ref<TabId>(group(props.initialSection));
const sections = ref<Partial<Record<TabId, ServerSection>>>({
  [selected.value]: props.initialSection,
});
const current = computed(() => tabs.find((tab) => tab.id === selected.value)!);
const host = computed(() => hosts.catalog?.hosts.find((host) => host.id === props.hostId));
watch(
  () => props.initialSection,
  (section) => {
    if (!section) return;
    selected.value = group(section);
    sections.value[selected.value] = section;
  },
);
function select(id: TabId) {
  selected.value = id;
  emit('section', sections.value[id] ?? id);
}
function section(value: ServerSection) {
  sections.value[selected.value] = value;
  emit('section', value);
}
const localLog = ref(props.logIntent);
watch(
  () => props.logIntent,
  (value) => {
    if (value) {
      localLog.value = value;
      select('logs');
    }
  },
);
function openLog(input: LogInput, title: string) {
  localLog.value = { input, title, sequence: (localLog.value?.sequence ?? 0) + 1 };
  select('logs');
}
function navigate(value: ServerSection) {
  sections.value[group(value)] = value;
  select(group(value));
}
const navigation = ref<HTMLElement>();
async function keys(event: KeyboardEvent) {
  const index = tabs.findIndex((tab) => tab.id === selected.value);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : event.key === 'ArrowRight'
          ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (index + tabs.length - 1) % tabs.length
            : -1;
  if (next < 0) return;
  event.preventDefault();
  select(tabs[next]!.id);
  await nextTick();
  navigation.value?.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus();
}
</script>
<template>
  <main class="system-workbench" :class="{ 'legacy-monitor': legacyMonitor }">
    <header v-if="!legacyMonitor" class="system-host-strip">
      <span class="system-host-icon"><Server :size="17" /></span>
      <div>
        <strong>{{ hostDisplayName(host) || '系统服务' }}</strong
        ><span>{{ host ? `${host.username}@${host.hostname}:${host.port}` : '请先选择主机' }}</span>
      </div>
      <span class="system-host-note">{{ host ? '当前主机' : '未选择主机' }}</span>
    </header>
    <div
      v-if="!legacyMonitor"
      ref="navigation"
      class="system-navigation"
      role="tablist"
      aria-label="系统服务功能"
      @keydown="keys"
    >
      <button
        v-for="tab in tabs"
        :id="`system-tab-${tab.id}`"
        :key="tab.id"
        role="tab"
        :tabindex="selected === tab.id ? 0 : -1"
        :aria-label="tab.label"
        :disabled="!hostId"
        :aria-selected="selected === tab.id"
        aria-controls="system-panel"
        @click="select(tab.id)"
      >
        <component :is="tab.icon" :size="18" aria-hidden="true" /><span
          ><strong>{{ tab.label }}</strong
          ><small>{{ tab.description }}</small></span
        >
      </button>
    </div>
    <section
      id="system-panel"
      class="system-panel"
      role="tabpanel"
      :aria-labelledby="`system-tab-${selected}`"
    >
      <KeepAlive :max="4">
        <component
          :is="legacyMonitor ? Monitor : current.component"
          :key="legacyMonitor ? 'legacy' : selected"
          :host-id="hostId"
          :initial-section="sections[selected]"
          :page="legacyMonitor ? page : undefined"
          :log-intent="localLog"
          @section="section"
          @navigate="navigate"
          @log="openLog"
        />
      </KeepAlive>
    </section>
  </main>
</template>
