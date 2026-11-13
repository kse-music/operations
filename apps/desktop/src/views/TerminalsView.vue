<script setup lang="ts">
import { tr } from '../i18n/messages';

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Copy,
  ListX,
  Plus,
  RefreshCw,
  Save,
  BookmarkX,
  Shield,
  SquareTerminal,
  TextCursorInput,
  Unplug,
  X,
} from '@lucide/vue';
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
  defineProps<{
    visible?: boolean;
    hostId?: string;
    toolbarTarget?: string;
    localSessionTarget?: string;
  }>(),
  {
    visible: true,
    hostId: '',
    toolbarTarget: '',
    localSessionTarget: '',
  },
);
const hosts = useHostsStore();
const tabs = computed(() => store.hostTabs(props.hostId));
const sidebarSessions = computed(() => !props.hostId && !!props.localSessionTarget);
const sessionTarget = computed(() =>
  sidebarSessions.value ? props.localSessionTarget : props.toolbarTarget,
);
function sessionKeys(event: KeyboardEvent): void {
  if (!sidebarSessions.value || !props.visible || event.defaultPrevented) return;
  const target = event.target as HTMLElement;
  if (
    !target.matches('[role="tab"]') ||
    !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
  )
    return;
  const buttons = [
    ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  const index = buttons.indexOf(target as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next]?.click();
  buttons[next]?.focus();
}
const host = computed(
  () =>
    hosts.catalog?.hosts.find((h) => h.id === props.hostId) ??
    tabs.value[0]?.panes[0]?.host ??
    null,
);
function newTerminal(): void {
  if (!props.hostId || host.value) store.open(host.value);
}
const canChooseLocalMode = computed(() => !props.hostId && navigator.platform.startsWith('Win'));
function addTerminal(event: MouseEvent): void {
  if (!props.visible) return;
  if (canChooseLocalMode.value) void openMenu(null, event);
  else newTerminal();
}
function selectLocalMode(elevated: boolean): void {
  if (!props.visible || !canChooseLocalMode.value || menu.value?.key !== null) return;
  closeMenu();
  store.open(null, undefined, undefined, elevated);
}
function sessionTitle(item: TerminalTab): string {
  const host = item.panes[0]?.host;
  const title =
    !item.renamed && (!host || item.title === hostDisplayName(host))
      ? tr('会话 {0}', item.sessionNumber)
      : item.title;
  return item.panes.some((pane) => !pane.host && pane.elevated)
    ? tr('{0}（管理员）', title)
    : title;
}
const area = ref<HTMLElement>();
const renaming = ref<string | null>(null),
  title = ref('');
const tab = computed(() => store.tabs.find((t) => t.key === store.active));
const menu = ref<{ key: string | null; x: number; y: number } | null>(null);
const menuElement = ref<HTMLElement>();
const menuTarget = computed(() => store.tabs.find((item) => item.key === menu.value?.key));
let menuTrigger: HTMLElement | null = null;
function closeMenu(): void {
  menu.value = null;
  if (props.visible && menuTrigger?.isConnected) menuTrigger.focus({ preventScroll: true });
}
async function openMenu(key: string | null, event: MouseEvent | KeyboardEvent): Promise<void> {
  if (!props.visible) return;
  const target = event.currentTarget as HTMLElement;
  menuTrigger = target.querySelector<HTMLElement>('[role=tab]') ?? target;
  const bounds = target.getBoundingClientRect();
  const anchored = event instanceof KeyboardEvent || (!event.clientX && !event.clientY);
  menu.value = {
    key,
    x: anchored ? bounds.left : event.clientX,
    y: anchored ? bounds.bottom : event.clientY,
  };
  await nextTick();
  if (!menu.value || !menuElement.value) return;
  const size = menuElement.value.getBoundingClientRect();
  menu.value.x = Math.max(8, Math.min(menu.value.x, window.innerWidth - size.width - 8));
  menu.value.y = Math.max(8, Math.min(menu.value.y, window.innerHeight - size.height - 8));
  await nextTick();
  menuElement.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
function menuKey(event: KeyboardEvent): void {
  if (['Escape', 'Tab'].includes(event.key)) {
    event.preventDefault();
    closeMenu();
    return;
  }
  const buttons = [
    ...(menuElement.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ];
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
function runMenu(
  action: 'duplicate' | 'rename' | 'reconnect' | 'disconnect' | 'all' | 'close' | 'unsave',
): void {
  const target = store.tabs.find((item) => item.key === menu.value?.key);
  closeMenu();
  if (!target) return;
  if (action === 'duplicate' || action === 'reconnect') {
    const snapshot = target.panes[0]?.host;
    const configured = snapshot && hosts.catalog?.hosts.find((item) => item.id === snapshot.id);
    if (snapshot && (!configured || !sameHostConnection(snapshot, configured))) {
      store.error =
        action === 'duplicate'
          ? tr('主机连接配置已变更，请从主机树重新打开后再复制会话。')
          : tr('主机连接配置已变更，请从主机树重新打开后再重新连接会话。');
      return;
    }
    if (action === 'duplicate') store.duplicate(target.key);
    else void store.reconnect(target.key);
  } else if (action === 'rename') rename(target.key);
  else if (action === 'unsave') void store.unsaveLocal(target.key);
  else if (action === 'disconnect') void store.disconnect(target.key);
  else if (action === 'all') void store.closeAll(target.key);
  else void store.close(target.key);
}
const paneViews = computed(() =>
  store.tabs.flatMap((t) => {
    if (
      t.savedId &&
      t.key !== store.active &&
      t.panes.every((pane) => pane.state === 'idle' && !pane.connectRequested)
    )
      return [];
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
  if (store.localSaving) return;
  renaming.value = key;
  title.value = store.tabs.find((t) => t.key === key)?.title ?? '';
}
const savingName = computed(() => !!renaming.value && store.localSaving === renaming.value);
const savingLocalName = computed(
  () =>
    navigator.platform.startsWith('Win') &&
    !!renaming.value &&
    store.tabs.find((tab) => tab.key === renaming.value)?.panes.every((pane) => !pane.host),
);
async function submitRename(): Promise<void> {
  const key = renaming.value;
  if (!key || savingName.value) return;
  const saved = savingLocalName.value
    ? await store.saveLocal(key, title.value)
    : store.rename(key, title.value);
  if (saved && renaming.value === key) renaming.value = null;
}
function closeRename(): void {
  if (!savingName.value) renaming.value = null;
}
function saveShortcut(event: KeyboardEvent): void {
  if (
    !props.visible ||
    props.hostId ||
    !event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    event.key.toLowerCase() !== 's'
  )
    return;
  if (document.querySelector('dialog[open]') && !renaming.value) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (
    !event.repeat &&
    !renaming.value &&
    tab.value &&
    tab.value.panes.every((pane) => !pane.host)
  ) {
    closeMenu();
    rename(tab.value.key);
  }
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
  window.removeEventListener('keydown', saveShortcut, true);
});
onMounted(() => {
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('keydown', saveShortcut, true);
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
    if (
      menu.value &&
      (menu.value.key === null ? !tabs.value.length : !keys.includes(menu.value.key))
    )
      closeMenu();
  },
);
</script>
<template>
  <div class="terminals-view">
    <div v-if="!props.hostId && store.savedError" class="workspace-empty" role="alert">
      <p>{{ store.savedError }}</p>
      <button class="button" :disabled="store.savedLoading" @click="store.loadSaved">
        {{ tr('重试加载已保存会话') }}
      </button>
    </div>
    <div v-if="!tabs.length" class="workspace-empty">
      <h2>{{ tr('没有打开的终端') }}</h2>
      <p v-if="!props.hostId && store.savedLoading" role="status">
        {{ tr('正在加载已保存会话…') }}
      </p>
      <p v-else>{{ tr('当前主机尚无终端。可新建会话，或通过工作区标签切换主机。') }}</p>
      <button class="button" :disabled="!!props.hostId && !host" @click="newTerminal">
        {{ props.hostId ? tr('新建终端') : tr('打开本地终端') }}
      </button>
    </div>
    <Teleport
      v-if="tabs.length || sidebarSessions"
      :to="sessionTarget || 'body'"
      :disabled="!sessionTarget"
    >
      <div class="terminal-session-header">
        <p v-if="!tabs.length" class="local-session-empty" role="status">
          {{ tr('没有打开的终端') }}
        </p>
        <div
          v-else
          class="terminal-tabs"
          role="tablist"
          :aria-label="sidebarSessions ? tr('本地终端会话') : tr('终端标签')"
          :aria-orientation="sidebarSessions ? 'vertical' : 'horizontal'"
          @keydown="sessionKeys"
        >
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
              :tabindex="sidebarSessions && store.active !== item.key ? -1 : 0"
              @click="store.select(item.key)"
              @dblclick="rename(item.key)"
            >
              <svg
                v-if="
                  item.panes.some((pane) =>
                    ['closed', 'failed', 'disconnected'].includes(pane.state),
                  )
                "
                class="terminal-disconnected-icon"
                viewBox="0 0 16 16"
                role="img"
                :aria-label="tr('已断开连接')"
              >
                <title>{{ tr('已断开连接') }}</title>
                <circle cx="8" cy="8" r="7" fill="currentColor" />
                <path d="M4 8h8" stroke="white" stroke-width="2" />
              </svg>
              <span class="terminal-session-title">{{ sessionTitle(item) }}</span>
              <Save
                v-if="item.savedId"
                :size="12"
                :aria-label="tr('已保存')"
                :title="tr('已保存')"
              />
              <small>{{
                item.panes.length > 1
                  ? tr('{0} 个窗格', item.panes.length)
                  : stateLabels[item.panes[0]?.state ?? 'idle']
              }}</small></button
            ><button
              :aria-label="tr('关闭标签 {0}', sessionTitle(item))"
              :title="tr('关闭标签')"
              @click="store.close(item.key)"
            >
              <X :size="14" aria-hidden="true" />
            </button>
          </div>
        </div>
        <button
          class="shell-icon-button"
          :aria-label="tr('新建终端会话')"
          :title="tr('新建终端会话')"
          :aria-haspopup="canChooseLocalMode ? 'menu' : undefined"
          :aria-expanded="canChooseLocalMode ? menu?.key === null : undefined"
          @click="addTerminal"
        >
          <SquareTerminal v-if="sidebarSessions" :size="16" aria-hidden="true" />
          <Plus v-else :size="15" aria-hidden="true" />
          <span v-if="sidebarSessions">{{ tr('新建会话') }}</span>
        </button>
      </div>
    </Teleport>
    <div ref="area" class="split-area">
      <div
        v-for="item in paneViews"
        :key="item.pane.key"
        :class="[
          'split-pane',
          {
            focused: store.focused === item.pane.key,
            'terminal-hidden': item.tab !== store.active,
          },
        ]"
        :inert="item.tab !== store.active || undefined"
        :aria-hidden="item.tab !== store.active || undefined"
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
        :aria-label="tr('调整分屏大小')"
        @pointerdown.prevent="dragDivider($event, divider)"
        @keydown="resizeKey($event, divider)"
      ></div>
    </div>
  </div>
  <Teleport to="body">
    <template v-if="menu">
      <button
        class="context-backdrop"
        :aria-label="menu.key === null ? tr('关闭新建会话菜单') : tr('关闭会话菜单')"
        @click="closeMenu"
        @contextmenu.prevent="closeMenu"
        @wheel.prevent="closeMenu"
      ></button>
      <div
        ref="menuElement"
        class="context-menu terminal-session-menu"
        role="menu"
        :aria-label="menu.key === null ? tr('新建终端会话') : tr('终端会话操作')"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @keydown="menuKey"
      >
        <template v-if="menu.key === null">
          <button role="menuitem" @click="selectLocalMode(false)">
            <SquareTerminal class="menu-icon-purple" :size="14" aria-hidden="true" />{{
              tr('新建普通会话')
            }}
          </button>
          <button role="menuitem" @click="selectLocalMode(true)">
            <Shield class="menu-icon-gold" :size="14" aria-hidden="true" />{{
              tr('以管理员身份运行')
            }}
          </button>
        </template>
        <template v-else>
          <button
            v-if="!props.hostId && menuTarget?.savedId"
            role="menuitem"
            :disabled="!!store.localSaving"
            @click="runMenu('unsave')"
          >
            <BookmarkX class="menu-icon-gold" aria-hidden="true" />{{ tr('取消保存') }}
          </button>
          <button role="menuitem" @click="runMenu('duplicate')">
            <Copy class="menu-icon-blue" aria-hidden="true" />{{ tr('复制') }}
          </button>
          <button role="menuitem" @click="runMenu('rename')">
            <TextCursorInput class="menu-icon-gold" aria-hidden="true" />{{ tr('重命名') }}
          </button>
          <button
            role="menuitem"
            :disabled="!menuTarget || !store.canReconnect(menuTarget.key)"
            @click="runMenu('reconnect')"
          >
            <RefreshCw class="menu-icon-green" aria-hidden="true" />{{ tr('重新连接') }}
          </button>
          <button
            role="menuitem"
            :disabled="!menuTarget || !store.canDisconnect(menuTarget.key)"
            @click="runMenu('disconnect')"
          >
            <Unplug class="menu-icon-red" aria-hidden="true" />{{ tr('断开连接') }}
          </button>
          <button role="menuitem" @click="runMenu('all')">
            <ListX class="menu-icon-red" aria-hidden="true" />{{ tr('关闭所有') }}
          </button>
          <button role="menuitem" @click="runMenu('close')">
            <X class="menu-icon-muted" aria-hidden="true" />{{ tr('关闭') }}
          </button>
        </template>
      </div>
    </template>
  </Teleport>
  <Modal
    v-if="renaming"
    :title="tr('重命名标签')"
    :busy="savingName"
    panel-class="terminal-rename-dialog"
    @close="closeRename"
    ><form class="terminal-rename-form" @submit.prevent="submitRename">
      <label
        >{{ tr('标签名称')
        }}<input
          v-model="title"
          class="terminal-rename-input"
          maxlength="128"
          required
          :disabled="savingName"
          autofocus
          :aria-label="tr('标签名称')"
      /></label>
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="savingName" @click="closeRename">
          {{ tr('取消') }}</button
        ><button
          class="button primary"
          type="submit"
          :disabled="savingName || (savingLocalName && !!renaming && !store.canSaveLocal(renaming))"
        >
          {{ tr('保存') }}
        </button>
      </footer>
    </form></Modal
  >
</template>
