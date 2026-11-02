<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { Columns2, Rows2, Pencil, Plus, Save, X } from '@lucide/vue';
import { useTerminalsStore, type TerminalTab } from '../stores/terminals';
import { useApplicationStore } from '../stores/application';
import { useHostsStore } from '../stores/hosts';
import { stateLabels } from '../types/terminal';
import { geometry, type Divider } from '../services/layout';
import TerminalPane from '../components/TerminalPane.vue';
import Modal from '../components/Modal.vue';
const emit = defineEmits<{
  operations: [host: import('../types/hosts').Host];
  network: [host: import('../types/hosts').Host];
  automation: [host: import('../types/hosts').Host];
  monitor: [host: import('../types/hosts').Host];
  files: [host: import('../types/hosts').Host, path: string | undefined, pane: string];
}>();
const store = useTerminalsStore(),
  application = useApplicationStore();
const props = withDefaults(defineProps<{ visible?: boolean; hostId?: string }>(), {
  visible: true,
  hostId: '',
});
const hosts = useHostsStore();
const tabs = computed(() => store.hostTabs(props.hostId));
const host = computed(
  () =>
    hosts.catalog?.hosts.find((h) => h.id === props.hostId) ??
    tabs.value[0]?.panes[0]?.host ??
    null,
);
function newTerminal(): void {
  if (!props.hostId || host.value) store.open(host.value);
}
function sessionTitle(item: TerminalTab, index: number): string {
  return item.title === (item.panes[0]?.host?.name ?? '本地设备')
    ? `会话 ${index + 1}`
    : item.title;
}
const area = ref<HTMLElement>();
const menu = ref<{ key: string; x: number; y: number } | null>(null);
const renaming = ref<string | null>(null),
  title = ref('');
const tab = computed(() => store.tabs.find((t) => t.key === store.active));
const paneViews = computed(() =>
  store.tabs.flatMap((t) => {
    const layout = geometry(t.layout);
    return t.panes.map((pane) => ({ pane, tab: t.key, rect: layout.panes[pane.key] }));
  }),
);
const dividers = computed(() => (tab.value ? geometry(tab.value.layout).dividers : []));
let finishDrag: (() => void) | undefined;
function paneStyle(
  rect: { left: number; top: number; width: number; height: number } | undefined,
): Record<string, string> {
  return rect
    ? {
        left: `${rect.left}%`,
        top: `${rect.top}%`,
        width: `${rect.width}%`,
        height: `${rect.height}%`,
      }
    : { display: 'none' };
}
function split(axis: 'rows' | 'columns'): void {
  const pane = tab.value?.panes.find((p) => p.key === store.focused) ?? tab.value?.panes[0];
  if (pane) store.split(pane.key, axis);
}
function rename(key: string): void {
  menu.value = null;
  renaming.value = key;
  title.value = store.tabs.find((t) => t.key === key)?.title ?? '';
}
function submitRename(): void {
  if (renaming.value && store.rename(renaming.value, title.value)) renaming.value = null;
}
function context(key: string, event: MouseEvent): void {
  menu.value = {
    key,
    x: Math.min(event.clientX, window.innerWidth - 190),
    y: Math.min(event.clientY, window.innerHeight - 240),
  };
}
function dragTab(event: DragEvent, key: string): void {
  event.dataTransfer?.setData('text/plain', key);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}
function dropTab(event: DragEvent, key: string): void {
  const source = event.dataTransfer?.getData('text/plain');
  if (source) store.reorder(source, key);
}
function dragDivider(event: PointerEvent, divider: Divider): void {
  if (event.button !== 0 || !area.value) return;
  finishDrag?.();
  const bounds = area.value.getBoundingClientRect(),
    tabKey = store.active;
  const move = (event: PointerEvent): void => {
    const axis = divider.axis === 'columns';
    const whole = axis ? bounds.width : bounds.height;
    const origin =
      (axis ? bounds.left : bounds.top) +
      (whole * (axis ? divider.parent.left : divider.parent.top)) / 100;
    const size = (whole * (axis ? divider.parent.width : divider.parent.height)) / 100;
    store.resize(
      tabKey,
      divider.id,
      (((axis ? event.clientX : event.clientY) - origin) / size) * 100,
    );
  };
  const finish = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    document.body.style.userSelect = '';
    finishDrag = undefined;
  };
  finishDrag = finish;
  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}
function resizeKey(event: KeyboardEvent, divider: Divider): void {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    store.resize(
      store.active,
      divider.id,
      divider.ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -2 : 2),
    );
  }
}
function action(key: string, name: string): void {
  const pane = store.panes.find((p) => p.key === key);
  if (!pane) return;
  if (name === 'splitRows') store.split(key, 'rows');
  else if (name === 'splitColumns') store.split(key, 'columns');
  else if (name === 'newTab') store.open(pane.host);
  else if (name === 'closePane') void store.closePane(key);
  else if (name === 'nextTab') store.cycle(1);
  else if (name === 'previousTab') store.cycle(-1);
  else if (name === 'zoomIn' || name === 'zoomOut') {
    const config = application.state?.config;
    if (config)
      void application.save({
        ...config,
        terminalFontSize: Math.min(
          32,
          Math.max(10, config.terminalFontSize + (name === 'zoomIn' ? 1 : -1)),
        ),
      });
  }
}
onBeforeUnmount(() => {
  finishDrag?.();
});
</script>
<template>
  <div class="terminals-view">
    <div v-if="store.error" class="banner error" role="alert">
      {{ store.error }} <button class="text-button" @click="store.error = null">关闭提示</button>
    </div>
    <div v-if="store.restored" class="banner" role="status">
      已恢复布局，所有窗格保持未连接。点击窗格中的“连接”后才会打开新的远端 Shell。<button
        class="text-button"
        @click="store.restored = false"
      >
        知道了
      </button>
    </div>
    <div v-if="!tabs.length" class="workspace-empty">
      <h2>没有打开的终端</h2>
      <p>当前主机尚无终端。可新建会话，或通过工作区标签切换主机。</p>
      <button class="button" :disabled="!!props.hostId && !host" @click="newTerminal">
        {{ props.hostId ? '新建终端' : '打开本地终端' }}
      </button>
    </div>
    <template v-if="tabs.length">
      <div class="terminal-tabs" role="tablist" aria-label="终端标签">
        <div
          v-for="(item, index) in tabs"
          :key="item.key"
          :class="['terminal-tab', { active: store.active === item.key }]"
          draggable="true"
          @mousedown.middle.prevent
          @auxclick.middle.prevent="store.close(item.key)"
          @dragstart="dragTab($event, item.key)"
          @dragover.prevent
          @drop.prevent="dropTab($event, item.key)"
          @contextmenu.prevent="context(item.key, $event)"
        >
          <button
            role="tab"
            :aria-selected="store.active === item.key"
            @click="store.select(item.key)"
            @dblclick="rename(item.key)"
          >
            {{ sessionTitle(item, index) }}
            <small>{{
              item.panes.length > 1
                ? `${item.panes.length} 个窗格`
                : stateLabels[item.panes[0]?.state ?? 'idle']
            }}</small></button
          ><button
            :aria-label="`关闭标签 ${sessionTitle(item, index)}`"
            title="关闭标签"
            @click="store.close(item.key)"
          >
            <X :size="14" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div class="split-toolbar">
        <button
          class="tool-button"
          :aria-label="props.hostId ? '新建终端' : '新建本地终端'"
          title="为当前主机新建终端会话"
          @click="newTerminal"
        >
          <Plus :size="15" aria-hidden="true" />
        </button>
        <button
          class="tool-button"
          aria-label="水平分屏（上下）"
          title="水平分屏（上下）"
          @click="split('rows')"
        >
          <Rows2 :size="15" aria-hidden="true" /></button
        ><button
          class="tool-button"
          aria-label="垂直分屏（左右）"
          title="垂直分屏（左右）"
          @click="split('columns')"
        >
          <Columns2 :size="15" aria-hidden="true" /></button
        ><button
          class="tool-button"
          aria-label="重命名标签"
          title="重命名标签"
          @click="rename(store.active)"
        >
          <Pencil :size="14" aria-hidden="true" />
        </button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <button class="button" @click="store.closeOthers(store.active)">关闭其他标签</button
        ><button class="button" @click="store.closeOthers(store.active, true)">关闭右侧标签</button
        ><button class="button" @click="store.saveLayout()">
          <Save :size="14" aria-hidden="true" />保存布局
        </button>
      </div>
    </template>
    <div ref="area" class="split-area">
      <div
        v-for="item in paneViews"
        v-show="item.tab === store.active"
        :key="item.pane.key"
        :class="['split-pane', { focused: store.focused === item.pane.key }]"
        :style="paneStyle(item.rect)"
        @focusin="store.focused = item.pane.key"
        @pointerdown="store.focused = item.pane.key"
      >
        <TerminalPane
          :tab="item.pane"
          :active="item.tab === store.active && props.visible"
          @close="store.closePane(item.pane.key)"
          @action="action"
          @files="(host, path, pane) => emit('files', host, path, pane)"
          @monitor="(host) => emit('monitor', host)"
          @operations="(host) => emit('operations', host)"
          @automation="(host) => emit('automation', host)"
          @network="(host) => emit('network', host)"
        />
      </div>
      <div
        v-for="divider in dividers"
        :key="divider.id"
        :class="['split-divider', divider.axis]"
        :style="paneStyle(divider.rect)"
        role="separator"
        tabindex="0"
        :aria-orientation="divider.axis === 'columns' ? 'vertical' : 'horizontal'"
        :aria-valuenow="divider.ratio"
        aria-label="调整分屏大小"
        @pointerdown.prevent="dragDivider($event, divider)"
        @keydown="resizeKey($event, divider)"
      ></div>
    </div>
  </div>
  <Modal v-if="renaming" title="重命名标签" @close="renaming = null"
    ><form @submit.prevent="submitRename">
      <label
        >标签名称<input v-model="title" maxlength="128" required autofocus aria-label="标签名称"
      /></label>
      <footer class="dialog-actions">
        <button class="button" type="button" @click="renaming = null">取消</button
        ><button class="button primary" type="submit">保存名称</button>
      </footer>
    </form></Modal
  >
  <template v-if="menu"
    ><button class="context-backdrop" aria-label="关闭标签菜单" @click="menu = null"></button>
    <div class="context-menu" role="menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button role="menuitem" @click="rename(menu.key)">重命名</button
      ><button
        role="menuitem"
        @click="
          store.closeOthers(menu.key);
          menu = null;
        "
      >
        关闭其他标签</button
      ><button
        role="menuitem"
        @click="
          store.closeOthers(menu.key, true);
          menu = null;
        "
      >
        关闭右侧标签</button
      ><button
        role="menuitem"
        @click="
          store.close(menu.key);
          menu = null;
        "
      >
        关闭标签
      </button>
    </div></template
  >
</template>
