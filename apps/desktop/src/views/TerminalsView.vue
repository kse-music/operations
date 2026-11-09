<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Plus, X } from '@lucide/vue';
import { useTerminalsStore, type TerminalTab } from '../stores/terminals';
import { useApplicationStore } from '../stores/application';
import { useHostsStore } from '../stores/hosts';
import { stateLabels } from '../types/terminal';
import { hostDisplayName } from '../types/hosts';
import { sameHostConnection } from '../services/product-links';
import { geometry, type Divider } from '../services/layout';
import TerminalPane from '../components/TerminalPane.vue';
import Modal from '../components/Modal.vue';
const emit = defineEmits<{
  server: [host: import('../types/hosts').Host];
}>();
const store = useTerminalsStore(),
  application = useApplicationStore();
const props = withDefaults(
  defineProps<{ visible?: boolean; hostId?: string; toolbarTarget?: string }>(),
  {
    visible: true,
    hostId: '',
    toolbarTarget: '',
  },
);
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
function sessionTitle(item: TerminalTab): string {
  const host = item.panes[0]?.host;
  return item.title === (host ? hostDisplayName(host) : '本地设备')
    ? `会话 ${item.sessionNumber}`
    : item.title;
}
const area = ref<HTMLElement>();
const renaming = ref<string | null>(null),
  title = ref('');
const tab = computed(() => store.tabs.find((t) => t.key === store.active));
const menu = ref<{ key: string; x: number; y: number } | null>(null);
const menuElement = ref<HTMLElement>();
let menuTrigger: HTMLElement | null = null;
function closeMenu(): void {
  menu.value = null;
  if (props.visible && menuTrigger?.isConnected) menuTrigger.focus({ preventScroll: true });
}
async function openMenu(key: string, event: MouseEvent | KeyboardEvent): Promise<void> {
  if (!props.visible) return;
  const target = event.currentTarget as HTMLElement;
  menuTrigger = target.querySelector<HTMLElement>('[role=tab]') ?? target;
  const bounds = target.getBoundingClientRect();
  const keyboard = event instanceof KeyboardEvent || (!event.clientX && !event.clientY);
  menu.value = {
    key,
    x: keyboard ? bounds.left : event.clientX,
    y: keyboard ? bounds.bottom : event.clientY,
  };
  await nextTick();
  if (!menu.value || !menuElement.value) return;
  const size = menuElement.value.getBoundingClientRect();
  menu.value.x = Math.max(8, Math.min(menu.value.x, window.innerWidth - size.width - 8));
  menu.value.y = Math.max(8, Math.min(menu.value.y, window.innerHeight - size.height - 8));
  await nextTick();
  menuElement.value?.querySelector<HTMLButtonElement>('button')?.focus();
}
function menuKey(event: KeyboardEvent): void {
  if (['Escape', 'Tab'].includes(event.key)) {
    event.preventDefault();
    closeMenu();
    return;
  }
  const buttons = [...(menuElement.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
  if (!buttons.length || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  buttons[
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
  ]?.focus();
}
function runMenu(action: 'duplicate' | 'rename' | 'all' | 'close'): void {
  const target = store.tabs.find((item) => item.key === menu.value?.key);
  closeMenu();
  if (!target) return;
  if (action === 'duplicate') {
    const snapshot = target.panes[0]?.host;
    const configured = snapshot && hosts.catalog?.hosts.find((item) => item.id === snapshot.id);
    if (snapshot && (!configured || !sameHostConnection(snapshot, configured))) {
      store.error = '主机连接配置已变更，请从主机树重新打开后再复制会话。';
      return;
    }
    store.duplicate(target.key);
  } else if (action === 'rename') rename(target.key);
  else if (action === 'all') void store.closeAll(target.key);
  else void store.close(target.key);
}
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
function rename(key: string): void {
  renaming.value = key;
  title.value = store.tabs.find((t) => t.key === key)?.title ?? '';
}
function submitRename(): void {
  if (renaming.value && store.rename(renaming.value, title.value)) renaming.value = null;
}
function dragTab(event: DragEvent, key: string): void {
  closeMenu();
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
let pendingFontSize: number | undefined;
let zooming = false;
async function zoomFontSize(delta: number): Promise<void> {
  const config = application.state?.config;
  if (!config || application.loading || (application.saving && !zooming)) return;
  pendingFontSize = Math.min(
    32,
    Math.max(10, (pendingFontSize ?? config.terminalFontSize) + delta),
  );
  if (zooming) return;
  zooming = true;
  try {
    while (pendingFontSize !== undefined) {
      const current = application.state?.config;
      const size: number = pendingFontSize;
      if (!current || size === current.terminalFontSize) break;
      await application.save({ ...current, terminalFontSize: size });
      if (application.error || pendingFontSize === size) break;
    }
  } finally {
    pendingFontSize = undefined;
    zooming = false;
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
  else if (name === 'zoomIn' || name === 'zoomOut') void zoomFontSize(name === 'zoomIn' ? 1 : -1);
}
onBeforeUnmount(() => {
  finishDrag?.();
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('blur', closeMenu);
});
onMounted(() => {
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
});
watch(
  () => [props.visible, props.hostId],
  () => {
    menu.value = null;
  },
);
watch(
  () => store.tabs.map((item) => item.key),
  (keys) => {
    if (menu.value && !keys.includes(menu.value.key)) closeMenu();
  },
);
</script>
<template>
  <div class="terminals-view">
    <div v-if="!tabs.length" class="workspace-empty">
      <h2>没有打开的终端</h2>
      <p>当前主机尚无终端。可新建会话，或通过工作区标签切换主机。</p>
      <button class="button" :disabled="!!props.hostId && !host" @click="newTerminal">
        {{ props.hostId ? '新建终端' : '打开本地终端' }}
      </button>
    </div>
    <Teleport
      v-if="tabs.length"
      :to="props.toolbarTarget || 'body'"
      :disabled="!props.toolbarTarget"
    >
      <div class="terminal-session-header">
        <div class="terminal-tabs" role="tablist" aria-label="终端标签">
          <div
            v-for="item in tabs"
            :key="item.key"
            :class="['terminal-tab', { active: store.active === item.key }]"
            draggable="true"
            @mousedown.middle.prevent
            @auxclick.middle.prevent="store.close(item.key)"
            @dragstart="dragTab($event, item.key)"
            @dragover.prevent
            @drop.prevent="dropTab($event, item.key)"
            @contextmenu.prevent.stop="openMenu(item.key, $event)"
            @keydown.shift.f10.prevent.stop="openMenu(item.key, $event)"
            @keydown.context-menu.prevent.stop="openMenu(item.key, $event)"
          >
            <button
              role="tab"
              :title="item.title"
              :aria-selected="store.active === item.key"
              @click="store.select(item.key)"
              @dblclick="rename(item.key)"
            >
              {{ sessionTitle(item) }}
              <small>{{
                item.panes.length > 1
                  ? `${item.panes.length} 个窗格`
                  : stateLabels[item.panes[0]?.state ?? 'idle']
              }}</small></button
            ><button
              :aria-label="`关闭标签 ${sessionTitle(item)}`"
              title="关闭标签"
              @click="store.close(item.key)"
            >
              <X :size="14" aria-hidden="true" />
            </button>
          </div>
        </div>
        <button
          class="shell-icon-button"
          aria-label="新建终端会话"
          title="新建终端会话"
          @click="newTerminal"
        >
          <Plus :size="15" aria-hidden="true" />
        </button>
      </div>
    </Teleport>
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
          @server="(host) => emit('server', host)"
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
  <Teleport to="body">
    <template v-if="menu">
      <button
        class="context-backdrop"
        aria-label="关闭会话菜单"
        @click="closeMenu"
        @contextmenu.prevent="closeMenu"
        @wheel.prevent="closeMenu"
      ></button>
      <div
        ref="menuElement"
        class="context-menu"
        role="menu"
        aria-label="终端会话操作"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @keydown="menuKey"
      >
        <button role="menuitem" @click="runMenu('duplicate')">复制</button>
        <button role="menuitem" @click="runMenu('rename')">重命名</button>
        <button role="menuitem" @click="runMenu('all')">关闭所有</button>
        <button role="menuitem" @click="runMenu('close')">关闭</button>
      </div>
    </template>
  </Teleport>
  <Modal v-if="renaming" title="重命名标签" @close="renaming = null"
    ><form @submit.prevent="submitRename">
      <label
        >标签名称<input
          v-model="title"
          class="terminal-rename-input"
          maxlength="128"
          required
          autofocus
          aria-label="标签名称"
      /></label>
      <footer class="dialog-actions">
        <button class="button" type="button" @click="renaming = null">取消</button
        ><button class="button primary" type="submit">保存名称</button>
      </footer>
    </form></Modal
  >
</template>
