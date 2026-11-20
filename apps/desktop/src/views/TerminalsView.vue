<script setup lang="ts">
import { tr } from '../i18n/messages';

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Check,
  Copy,
  ListX,
  Plus,
  RefreshCw,
  Save,
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
import TreeRenameInput from '../components/TreeRenameInput.vue';
const emit = defineEmits<{
  retryHost: [host: import('../types/hosts').Host];
  server: [host: import('../types/hosts').Host];
}>();
const store = useTerminalsStore(),
  application = useApplicationStore();
const props = withDefaults(
  defineProps<{
    visible?: boolean;
    hostId?: string;
    toolbarTarget?: string;
  }>(),
  {
    visible: true,
    hostId: '',
    toolbarTarget: '',
  },
);
const hosts = useHostsStore();
const tabs = computed(() => store.hostTabs(props.hostId));
const sessionTarget = computed(() => (props.hostId ? props.toolbarTarget : ''));
const sessionHeader = ref<HTMLElement>();
function sessionKeys(event: KeyboardEvent): void {
  if (!props.visible || event.defaultPrevented) return;
  const target = event.target as HTMLElement;
  if (
    !target.matches('[role="tab"]') ||
    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
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
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
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
  if (props.visible && (!props.hostId || host.value)) store.open(host.value);
}
function isDefaultSessionName(item: TerminalTab): boolean {
  const host = item.panes[0]?.host;
  return !item.renamed && (!host || item.title === hostDisplayName(host));
}
function sessionName(item: TerminalTab): string {
  return isDefaultSessionName(item) ? tr('会话 {0}', item.sessionNumber) : item.title;
}
function sessionTitle(item: TerminalTab): string {
  const saved = store.savedSessions(props.hostId).find((entry) => entry.id === item.savedId);
  const title = saved ? store.savedSessionTitle(saved) : sessionName(item);
  return item.panes.some((pane) => !pane.host && pane.elevated)
    ? tr('{0}（管理员）', title)
    : title;
}
function isLocalSessionIdle(item: TerminalTab): boolean {
  return !props.hostId && item.panes.every((pane) => pane.state === 'idle');
}
const area = ref<HTMLElement>();
const renaming = ref<string | null>(null),
  title = ref('');
const tab = computed(() => store.tabs.find((t) => t.key === store.active));
const menu = ref<{ key: string | undefined; x: number; y: number } | null>(null);
const menuElement = ref<HTMLElement>();
const menuTarget = computed(() => store.tabs.find((item) => item.key === menu.value?.key));
const canOpenElevated = computed(() => !props.hostId && navigator.platform.startsWith('Win'));
const creationMenu = computed(
  () => canOpenElevated.value && menu.value !== null && menu.value.key === undefined,
);
let menuTrigger: HTMLElement | null = null;
function closeMenu(): void {
  menu.value = null;
  if (props.visible && menuTrigger?.isConnected) menuTrigger.focus({ preventScroll: true });
  menuTrigger = null;
}
function createLocalSession(elevated: boolean): void {
  if (!props.visible || !creationMenu.value) return;
  closeMenu();
  store.open(null, undefined, undefined, elevated);
}
function addSession(event: MouseEvent): void {
  if (canOpenElevated.value) void openMenu(undefined, event);
  else newTerminal();
}
async function openMenu(key: string | undefined, event: MouseEvent | KeyboardEvent): Promise<void> {
  if (!props.visible || (key === undefined && !canOpenElevated.value)) return;
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget as HTMLElement;
  menuTrigger = key ? (target.querySelector<HTMLElement>('[role=tab]') ?? target) : target;
  const bounds = target.getBoundingClientRect();
  const anchored =
    key === undefined || event instanceof KeyboardEvent || (!event.clientX && !event.clientY);
  menu.value = {
    key,
    x: anchored ? bounds.left : event.clientX,
    y: anchored ? bounds.bottom : event.clientY,
  };
  const openedMenu = menu.value;
  await nextTick();
  if (menu.value !== openedMenu || !menuElement.value) return;
  const size = menuElement.value.getBoundingClientRect();
  openedMenu.x = Math.max(8, Math.min(openedMenu.x, window.innerWidth - size.width - 8));
  openedMenu.y = Math.max(8, Math.min(openedMenu.y, window.innerHeight - size.height - 8));
  await nextTick();
  if (menu.value === openedMenu)
    menuElement.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
function menuKey(event: KeyboardEvent): void {
  const element = event.currentTarget as HTMLElement;
  if (['Escape', 'Tab'].includes(event.key)) {
    event.preventDefault();
    closeMenu();
    return;
  }
  const buttons = [...element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
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
  action: 'duplicate' | 'rename' | 'reconnect' | 'disconnect' | 'all' | 'save',
): void {
  const target = menuTarget.value;
  closeMenu();
  if (!target) return;
  if (action === 'all') {
    void store.closeAll(target.key);
    return;
  }
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
  else if (action === 'disconnect') void store.disconnect(target.key);
  else if (action === 'save')
    void store.saveSession(target.key, sessionName(target), {
      defaultTitle: isDefaultSessionName(target),
    });
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
const renameError = ref<string | null>(null);
function rename(key: string): void {
  const item = tabs.value.find((item) => item.key === key);
  if (!item || store.saving || !props.visible) return;
  renaming.value = key;
  title.value = sessionName(item);
  renameError.value = null;
}
function finishRename(key: string, focus: boolean): void {
  renaming.value = null;
  if (focus)
    void nextTick(() =>
      document.querySelector<HTMLElement>(`[data-session-key="${key}"] [role=tab]`)?.focus(),
    );
}
async function submitRename(reason: 'enter' | 'blur'): Promise<void> {
  const key = renaming.value;
  const item = tabs.value.find((item) => item.key === key);
  if (!key || !item || store.saving) return;
  const ok = title.value.trim() === sessionName(item) || (await store.rename(key, title.value));
  if (renaming.value !== key) return;
  if (ok) finishRename(key, reason === 'enter');
  else renameError.value = store.error;
}
function sessionShortcut(event: KeyboardEvent): void {
  if (
    !props.visible ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    renaming.value ||
    document.querySelector('dialog[open]')
  )
    return;
  const saving = event.ctrlKey && event.key.toLowerCase() === 's';
  if (!saving && (event.ctrlKey || event.key !== 'F2')) return;
  const element = event.target instanceof HTMLElement ? event.target : null;
  if (
    element &&
    element !== document.body &&
    !element.closest('.terminal-tab, .terminal-session-menu, .xterm-container, .split-area')
  )
    return;
  if (
    element?.matches('input, textarea, [contenteditable=true]') &&
    !element.closest('.xterm-container')
  )
    return;
  const key =
    menu.value?.key ??
    element?.closest<HTMLElement>('[data-session-key]')?.dataset.sessionKey ??
    store.active;
  const item = tabs.value.find((item) => item.key === key);
  if (!item || (saving && !props.hostId && !navigator.platform.startsWith('Win'))) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.repeat) return;
  if (menu.value) closeMenu();
  if (saving)
    void store.saveSession(key, sessionName(item), { defaultTitle: isDefaultSessionName(item) });
  else rename(key);
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
  window.removeEventListener('keydown', sessionShortcut, true);
});
onMounted(() => {
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('keydown', sessionShortcut, true);
});
watch(
  () => [props.visible, props.hostId],
  () => {
    menu.value = null;
    menuTrigger = null;
    renaming.value = null;
  },
);
watch(
  () => [store.active, props.visible, props.hostId],
  () => {
    if (props.visible)
      sessionHeader.value?.querySelector('.terminal-tab.active')?.scrollIntoView?.({
        block: 'nearest',
        inline: 'nearest',
      });
  },
  { flush: 'post' },
);
watch(
  () => store.tabs.map((item) => item.key),
  (keys) => {
    if (renaming.value && !keys.includes(renaming.value)) renaming.value = null;
    if (menu.value && typeof menu.value.key === 'string' && !keys.includes(menu.value.key))
      closeMenu();
  },
);
</script>
<template>
  <div class="terminals-view">
    <Teleport :to="sessionTarget || 'body'" :disabled="!sessionTarget">
      <div
        ref="sessionHeader"
        class="terminal-session-header"
        role="group"
        :aria-label="tr('终端会话栏')"
      >
        <div
          v-if="tabs.length"
          class="terminal-tabs"
          role="tablist"
          :aria-label="props.hostId ? tr('终端标签') : tr('本地终端会话')"
          aria-orientation="horizontal"
          @keydown="sessionKeys"
        >
          <div
            v-for="item in tabs"
            :key="item.key"
            :class="['terminal-tab', { active: store.active === item.key }]"
            :data-session-key="item.key"
            :draggable="renaming !== item.key"
            @mousedown.middle.prevent
            @auxclick.middle.prevent="store.close(item.key)"
            @dragstart="dragTab($event, item.key)"
            @dragover.prevent
            @drop.prevent="dropTab($event, item.key)"
            @contextmenu.prevent.stop="openMenu(item.key, $event)"
            @keydown.shift.f10.prevent.stop="openMenu(item.key, $event)"
            @keydown.context-menu.prevent.stop="openMenu(item.key, $event)"
          >
            <TreeRenameInput
              v-if="renaming === item.key"
              :name="title"
              :label="tr('标签名称')"
              required
              :busy="store.saving === item.key"
              :error="renameError"
              @change="
                (value) => {
                  title = value;
                  renameError = null;
                }
              "
              @submit="submitRename"
              @cancel="finishRename(item.key, true)"
            />
            <button
              v-else
              role="tab"
              :title="sessionTitle(item)"
              :aria-selected="store.active === item.key"
              :tabindex="store.active === item.key ? 0 : -1"
              @click="store.select(item.key)"
              @dblclick="rename(item.key)"
            >
              <span class="terminal-session-name">
                <svg
                  v-if="
                    isLocalSessionIdle(item) ||
                    item.panes.some((pane) =>
                      ['closed', 'failed', 'disconnected'].includes(pane.state),
                    )
                  "
                  class="terminal-disconnected-icon"
                  viewBox="0 0 16 16"
                  role="img"
                  :aria-label="isLocalSessionIdle(item) ? tr('未连接') : tr('已断开连接')"
                >
                  <circle cx="8" cy="8" r="7" fill="currentColor" />
                  <path d="M4 8h8" stroke="white" stroke-width="2" />
                </svg>
                <Check
                  v-else-if="item.panes.every((pane) => pane.state === 'connected')"
                  class="terminal-connected-icon"
                  :size="14"
                  :stroke-width="3.5"
                  role="img"
                  :aria-label="tr('已连接')"
                />
                <span class="terminal-session-title">{{ sessionTitle(item) }}</span>
              </span>
              <span v-if="!props.hostId || item.savedId" class="terminal-session-saved">
                {{ item.savedId ? tr('已保存') : tr('未保存') }}
              </span>
              <small v-if="item.panes.length > 1">{{ tr('{0} 个窗格', item.panes.length) }}</small>
              <small
                v-else-if="
                  !['connected', 'disconnected'].includes(item.panes[0]?.state ?? 'idle') &&
                  !isLocalSessionIdle(item)
                "
                >{{ stateLabels[item.panes[0]?.state ?? 'idle'] }}</small
              ></button
            ><button
              class="terminal-session-close"
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
          :aria-haspopup="canOpenElevated ? 'menu' : undefined"
          :aria-expanded="canOpenElevated ? creationMenu : undefined"
          :disabled="!!props.hostId && !host"
          @click="addSession"
        >
          <Plus :size="15" aria-hidden="true" />
        </button>
      </div>
    </Teleport>
    <div v-if="props.hostId && store.sshErrors[props.hostId]" class="workspace-empty" role="alert">
      <p>{{ store.sshErrors[props.hostId] }}</p>
      <button v-if="!tabs.length && host" class="button" @click="newTerminal">
        {{ tr('新建终端') }}
      </button>
      <button class="button" @click="host && emit('retryHost', host)">
        {{ tr('重试加载已保存会话') }}
      </button>
    </div>
    <div v-else-if="store.sshLoading.has(props.hostId)" class="workspace-empty" role="status">
      {{ tr('正在加载已保存会话…') }}
    </div>
    <div v-else-if="!tabs.length" class="workspace-empty">
      <h2>{{ tr('没有打开的终端') }}</h2>
      <p v-if="props.hostId">
        {{ tr('当前主机尚无终端。可新建会话，或通过工作区标签切换主机。') }}
      </p>
      <p v-else>{{ tr('可新建终端，或从侧栏恢复已保存的会话。') }}</p>
      <button class="button" :disabled="!!props.hostId && !host" @click="newTerminal">
        {{ props.hostId ? tr('新建终端') : tr('打开本地终端') }}
      </button>
    </div>
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
        :aria-label="tr('关闭会话菜单')"
        @click="closeMenu"
        @contextmenu.prevent="closeMenu"
        @wheel.prevent="closeMenu"
      ></button>
      <div
        ref="menuElement"
        class="context-menu terminal-session-menu"
        role="menu"
        :aria-label="creationMenu ? tr('新建终端会话') : tr('终端会话操作')"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @keydown="menuKey"
      >
        <template v-if="creationMenu">
          <button role="menuitem" @click="createLocalSession(false)">
            <SquareTerminal class="menu-icon-purple" aria-hidden="true" />{{ tr('新建') }}
          </button>
          <button role="menuitem" @click="createLocalSession(true)">
            <Shield class="menu-icon-gold" aria-hidden="true" />{{ tr('新建(管理员)') }}
          </button>
        </template>
        <template v-else-if="menuTarget">
          <button role="menuitem" @click="runMenu('duplicate')">
            <Copy class="menu-icon-blue" aria-hidden="true" />{{ tr('复制') }}
          </button>
          <button
            role="menuitem"
            :aria-label="tr('保存')"
            aria-keyshortcuts="Control+S"
            :disabled="!menuTarget || !store.canSave(menuTarget.key)"
            @click="runMenu('save')"
          >
            <Save class="menu-icon-green" aria-hidden="true" />{{ tr('保存') }}<kbd>Ctrl+S</kbd>
          </button>
          <button
            role="menuitem"
            :aria-label="tr('重命名')"
            aria-keyshortcuts="F2"
            @click="runMenu('rename')"
          >
            <TextCursorInput class="menu-icon-gold" aria-hidden="true" />{{ tr('重命名')
            }}<kbd>F2</kbd>
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
        </template>
      </div>
    </template>
  </Teleport>
</template>
