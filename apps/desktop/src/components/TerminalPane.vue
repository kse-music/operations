<script setup lang="ts">
import { tr } from '../i18n/messages';

import { clipboardApi } from '../services/clipboard';
import { useErrorNotifications } from '../composables/error-notifications';
import { opsApi } from '../services/ops';
import { pluginsApi } from '../services/plugins';
import { ArrowDown, ArrowUp } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { filesApi } from '../services/files';
import { osc7Path } from '../services/osc7';
import { hostDisplayName, type Host } from '../types/hosts';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import {
  stateLabels,
  type LocalTerminalSession,
  type TerminalEvent,
  type TerminalSession,
} from '../types/terminal';
import { useTerminalsStore, type TerminalPaneModel } from '../stores/terminals';
import { defaultTerminalPreferences, terminalThemes, shortcutKey } from '../types/preferences';
import { resolveTerminalFontFamily, resolveTerminalLineHeight } from '../services/terminal-font';
import { TerminalInputQueue } from '../services/terminal-input';
import { ZmodemUpload, type UploadProgress } from '../services/zmodem';
import { useApplicationStore } from '../stores/application';
import Modal from './Modal.vue';
import TerminalDropUpload from './TerminalDropUpload.vue';
import '@xterm/xterm/css/xterm.css';

const props = defineProps<{ tab: TerminalPaneModel; active: boolean; standalone?: boolean }>();
const emit = defineEmits<{
  update: [values: Partial<Omit<TerminalPaneModel, 'key' | 'host'>>];
  close: [];
  server: [host: Host];
  action: [key: string, name: string];
}>();
const application = useApplicationStore();
const store = useTerminalsStore();
const name = computed(() => (props.tab.host ? hostDisplayName(props.tab.host) : tr('本地设备')));
const container = ref<HTMLElement>();
const searchInput = ref<HTMLInputElement>();
const message = ref<string | null>(null);
const trust = ref<Extract<TerminalEvent, { type: 'trust' }> | null>(null);
const query = ref('');
const finding = ref(false);
const displayFontSize = ref(application.state?.config.terminalFontSize ?? 16);
const pendingPaste = ref<string | null>(null);
const preferences = computed(
  () => application.state?.config.terminal ?? defaultTerminalPreferences(),
);
const working = ref(false);
const uploadProgress = ref<UploadProgress | null>(null);
let upload: ZmodemUpload | undefined;
const dropUpload = ref<InstanceType<typeof TerminalDropUpload>>();
const dropEnabled = computed(
  () =>
    props.active &&
    props.tab.state === 'connected' &&
    !!props.tab.host &&
    !props.standalone &&
    !props.tab.pluginTerminal &&
    !props.tab.containerShell &&
    !props.tab.fileAction &&
    !uploadProgress.value,
);
function canReceiveDrop(): boolean {
  return terminal?.buffer?.active?.type === 'normal' && !upload?.busy;
}
const menu = ref<{ x: number; y: number } | null>(null);
const menuElement = ref<HTMLElement>();
const menuActions = computed(() => [
  { key: 'copy', label: tr('复制'), disabled: false },
  { key: 'paste', label: tr('粘贴'), disabled: props.tab.state !== 'connected' },
]);
let terminal: Terminal;
let fit: FitAddon;
let search: SearchAddon;
let observer: ResizeObserver;
let opened = false;
let pendingDisplayOptions = false;
let pendingFontSize: number | undefined;
let session: TerminalSession | LocalTerminalSession | undefined;
let generation = 0;
let disposed = false;
let approvedPaste = false;
const inputQueue = new TerminalInputQueue(terminalApi.input, (error) => {
  message.value = errorMessage(error);
});
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let scrollFrame: number | undefined;
let forceBottomScroll = false;
const encoder = new TextEncoder();
let unregisterUpload: (() => void) | undefined;
let unregisterConnection: (() => void) | undefined;

function isConnected(attempt: number): boolean {
  return !disposed && attempt === generation && props.tab.state === 'connected';
}
function updateScreen(): void {
  const buffer = terminal.buffer.active;
  const screen = {
    rows: terminal.rows,
    cols: terminal.cols,
    cursorRow: Math.min(buffer.cursorY + 1, terminal.rows),
    cursorCol: Math.min(buffer.cursorX + 1, terminal.cols),
  };
  const previous = props.tab.screen;
  if (
    !previous ||
    previous.rows !== screen.rows ||
    previous.cols !== screen.cols ||
    previous.cursorRow !== screen.cursorRow ||
    previous.cursorCol !== screen.cursorCol
  )
    update({ screen });
}
function fitTerminal(forceBottom = false): void {
  if (!props.active || !container.value?.clientWidth || !container.value.clientHeight || !terminal)
    return;
  const buffer = opened ? terminal.buffer.active : undefined;
  const followBottom =
    buffer?.type === 'normal' &&
    buffer.baseY > 0 &&
    (forceBottom || forceBottomScroll || buffer.viewportY === buffer.baseY);
  // Hidden DOM measurements poison xterm's character spacing cache.
  if (pendingDisplayOptions) {
    Object.assign(terminal.options, terminalOptions());
    pendingDisplayOptions = false;
  }
  if (pendingFontSize !== undefined) {
    terminal.options.fontSize = pendingFontSize;
    pendingFontSize = undefined;
  }
  const firstOpen = !opened;
  if (firstOpen) {
    terminal.open(container.value);
    opened = true;
  }
  fit.fit();
  if (followBottom) {
    forceBottomScroll ||= forceBottom;
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined;
      const force = forceBottomScroll;
      forceBottomScroll = false;
      if (
        !disposed &&
        props.active &&
        terminal.buffer.active === buffer &&
        (force || buffer.viewportY === buffer.baseY)
      ) {
        // xterm 6 can retain the scrollbar's old pixel offset after reflow even at baseY.
        // A relative scroll through the buffer also synchronizes that pixel offset.
        terminal.scrollLines(buffer.length);
      }
    });
  }
  if (firstOpen) focusTerminal();
}
function resizeTerminal(): void {
  closeMenu();
  fitTerminal(true);
}
function focusTerminal(): void {
  if (
    props.active &&
    opened &&
    (props.standalone || store.focused === props.tab.key) &&
    container.value?.clientWidth &&
    !dialogBlocksTerminal()
  )
    terminal.focus();
}
function dialogBlocksTerminal(): boolean {
  const dialogs = document.querySelectorAll('dialog[open]');
  const top = dialogs.item(dialogs.length - 1);
  return !!top && !(props.standalone && top.contains(container.value ?? null));
}
function activateDropTarget(id: string): void {
  if (
    disposed ||
    !props.active ||
    props.tab.state !== 'connected' ||
    session?.id !== id ||
    props.tab.sessionId !== id ||
    container.value?.closest('[inert]')
  )
    return;
  store.focused = props.tab.key;
  focusTerminal();
}
async function restoreDropFocus(id: string): Promise<void> {
  const attempt = generation;
  await nextTick();
  if (
    disposed ||
    generation !== attempt ||
    props.tab.state !== 'connected' ||
    session?.id !== id ||
    props.tab.sessionId !== id ||
    container.value?.closest('[inert]')
  )
    return;
  focusTerminal();
}
function update(values: Partial<Omit<TerminalPaneModel, 'key' | 'host'>>): void {
  if (props.standalone) emit('update', values);
  else store.update(props.tab.key, values);
}
function terminalAction(name: string): void {
  if (props.standalone && ['zoomIn', 'zoomOut', 'zoomReset'].includes(name)) {
    const base = application.state?.config.terminalFontSize ?? 16;
    const current = terminal.options.fontSize ?? base;
    displayFontSize.value =
      name === 'zoomReset'
        ? base
        : Math.max(10, Math.min(32, current + (name === 'zoomIn' ? 1 : -1)));
    terminal.options.fontSize = displayFontSize.value;
    fitTerminal();
    focusTerminal();
  } else emit('action', props.tab.key, name);
}
function clearScreen(): void {
  terminal.clear();
  focusTerminal();
}
async function toggleFind(): Promise<void> {
  finding.value = !finding.value;
  await nextTick();
  if (finding.value) searchInput.value?.focus();
  else {
    search.clearDecorations();
    terminal.clearSelection();
    terminal.scrollToBottom();
    focusTerminal();
  }
}
function queueInput(data: Uint8Array): void {
  if (props.tab.state !== 'connected' || !data.length) return;
  if (dropUpload.value?.busy) {
    if (data.includes(3) || data.includes(24)) dropUpload.value.cancel();
    return;
  }
  if (upload?.busy) {
    if (data.includes(3) || data.includes(24)) upload.cancel();
    return;
  }
  if (!inputQueue.enqueue(data, approvedPaste))
    message.value = tr('输入队列已满或已断线，本次输入未发送。');
}
async function connect(): Promise<void> {
  if (working.value) return;
  working.value = true;
  const attempt = ++generation;
  dropUpload.value?.dispose();
  upload?.dispose();
  upload = undefined;
  uploadProgress.value = null;
  pendingPaste.value = null;
  message.value = null;
  trust.value = null;
  inputQueue.reset();
  try {
    if (session) await terminalApi.close(session.id);
    session = undefined;
    update({
      sessionId: undefined,
      transportId: undefined,
      routeHostIds: undefined,
      cwd: undefined,
      cipher: undefined,
      connectRequested: false,
      state: 'opening',
    });
    if (attempt > 1) {
      finding.value = false;
      query.value = '';
      search.clearDecorations();
      // Cancel incomplete controls, then reset after queued output and before the new Shell.
      terminal.write('\x18\x1bc');
    }
    fitTerminal();
    const open = props.tab.pluginTerminal
      ? (
          hostId: string,
          size: import('../types/terminal').TerminalSize,
          receive: (event: TerminalEvent) => void,
        ) => {
          const launch = props.tab.pluginTerminal!;
          return pluginsApi.platformTerminalOpen(
            launch.pluginId,
            launch.owner,
            launch.ticket,
            hostId,
            size,
            receive,
          );
        }
      : props.tab.containerShell
        ? (
            hostId: string,
            size: import('../types/terminal').TerminalSize,
            receive: (event: TerminalEvent) => void,
          ) => opsApi.shell(hostId, size, props.tab.containerShell!, receive)
        : props.tab.fileAction
          ? (
              hostId: string,
              size: import('../types/terminal').TerminalSize,
              receive: (event: TerminalEvent) => void,
            ) => filesApi.terminal(hostId, size, props.tab.fileAction!, receive)
          : terminalApi.open;
    const ready = async () => {
      await Promise.resolve();
      const value = await opening;
      if (disposed || attempt !== generation) throw new Error(tr('终端会话已改变，上传已取消。'));
      return value.id;
    };
    const receiver = props.tab.host
      ? new ZmodemUpload({
          write: (data) => terminal.write(data),
          send: async (data) => {
            await ready();
            if (!inputQueue.enqueue(data)) throw new Error(tr('ZMODEM 输入队列已满，上传已停止。'));
            await inputQueue.flush();
          },
          pick: async () => terminalApi.uploadPick(await ready()),
          read: async (token, index, offset) =>
            terminalApi.uploadRead(await ready(), token, index, offset),
          release: async (token) => terminalApi.uploadRelease((await opening).id, token),
          progress: (value) => {
            if (!disposed && attempt === generation) uploadProgress.value = value;
          },
          failed: (cause) => {
            if (!disposed && attempt === generation) message.value = errorMessage(cause);
            else store.error = errorMessage(cause);
          },
          notice: (text) => {
            if (!disposed && attempt === generation) terminal.write(`\r\n[${text}]\r\n`);
          },
        })
      : undefined;
    upload = receiver;
    const receive = (event: TerminalEvent) => {
      if (disposed || attempt !== generation) return;
      if (event.type === 'data') {
        const data = new Uint8Array(event.data);
        const ordinary = dropUpload.value?.consume(data) ?? data;
        if (dropUpload.value?.busy) terminal.write(ordinary);
        else if (receiver) receiver.consume(ordinary);
        else terminal.write(ordinary);
        terminal.write(new Uint8Array(), () => {
          void opening
            .then((value) => {
              if (isConnected(attempt)) return terminalApi.ack(value.id, event.sequence);
            })
            .catch((cause: unknown) => {
              if (isConnected(attempt)) message.value = errorMessage(cause);
            });
        });
      } else if (event.type === 'connection') {
        update({ cipher: event.cipher });
      } else if (event.type === 'state') {
        if (['closed', 'failed', 'disconnected'].includes(event.state)) {
          dropUpload.value?.dispose();
          receiver?.dispose();
        }
        update({ state: event.state });
        if (event.message) message.value = event.message;
        if (event.state !== 'awaiting_trust') trust.value = null;
      } else if (event.type === 'trust') trust.value = event;
      else if (event.type === 'exit') {
        dropUpload.value?.dispose();
        receiver?.dispose();
        terminal.write(
          tr(
            '\r\n\u001b[90m[Shell 已结束{0}]\u001b[0m\r\n',
            event.status === null ? '' : tr('，退出码 {0}', event.status),
          ),
        );
      }
    };
    const size = { cols: terminal.cols, rows: terminal.rows };
    const opening = props.tab.host
      ? open(props.tab.host.id, size, receive)
      : props.tab.elevated
        ? terminalApi.openLocal(size, receive, true)
        : terminalApi.openLocal(size, receive);
    const value = await opening;
    if (disposed || attempt !== generation) {
      await terminalApi.close(value.id);
      return;
    }
    session = value;
    inputQueue.reset(props.tab.state === 'connected' ? value.id : undefined);
    focusTerminal();
    update({
      sessionId: value.id,
      ...('transportId' in value
        ? { transportId: value.transportId, routeHostIds: value.routeHostIds }
        : { shell: value.shell, elevated: value.elevated }),
    });
  } catch (cause) {
    update({ state: 'failed' });
    message.value = errorMessage(cause);
  } finally {
    working.value = false;
  }
}
async function changeConnection(action: 'reconnect' | 'disconnect'): Promise<void> {
  if (disposed || working.value) return;
  if (
    action === 'reconnect' &&
    (props.tab.fileAction || props.tab.containerShell || props.tab.pluginTerminal)
  )
    return;
  working.value = true;
  const previousState = props.tab.state;
  update({ state: 'closing', connectRequested: false });
  try {
    if (session) await terminalApi.close(session.id);
    if (disposed) return;
    ++generation;
    session = undefined;
    inputQueue.reset();
    dropUpload.value?.dispose();
    upload?.dispose();
    upload = undefined;
    uploadProgress.value = null;
    trust.value = null;
    pendingPaste.value = null;
    message.value = null;
    update({
      state: 'disconnected',
      sessionId: undefined,
      transportId: undefined,
      routeHostIds: undefined,
      cwd: undefined,
      cipher: undefined,
    });
  } catch (cause) {
    if (props.tab.state === 'closing') update({ state: previousState });
    throw cause;
  } finally {
    working.value = false;
  }
  if (action === 'reconnect' && !disposed) await connect();
}
async function confirm(accept: boolean): Promise<void> {
  if (!session) return;
  try {
    await terminalApi.trust(session.id, accept);
    trust.value = null;
  } catch (cause) {
    message.value = errorMessage(cause);
  }
}
async function copy(): Promise<void> {
  try {
    await clipboardApi.writeText(terminal.getSelection());
  } catch {
    message.value = tr('无法写入剪贴板，请检查系统权限。');
  }
}
function copySelection(): void {
  if (preferences.value.quickCopyPaste && props.active && terminal.hasSelection()) void copy();
}
function preventTerminalRightClick(event: MouseEvent): void {
  if (event.button === 2) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
function zoomWithWheel(event: WheelEvent): void {
  if (!props.active || !event.ctrlKey || event.deltaY === 0 || dialogBlocksTerminal()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  terminalAction(event.deltaY < 0 ? 'zoomIn' : 'zoomOut');
}
function terminalContextMenu(event: MouseEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!props.active || dialogBlocksTerminal()) return;
  if (preferences.value.quickCopyPaste && event.button === 2 && !event.shiftKey) {
    menu.value = null;
    void paste();
  } else void openMenu(event.clientX, event.clientY);
}
async function openMenu(x: number, y: number): Promise<void> {
  if (!props.active || dialogBlocksTerminal()) return;
  if (!props.standalone) store.focused = props.tab.key;
  if (trust.value) return;
  menu.value = { x, y };
  await nextTick();
  if (!menu.value || !menuElement.value) return;
  const bounds = menuElement.value.getBoundingClientRect();
  menu.value = {
    x: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
  };
  await nextTick();
  menuElement.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
function closeMenu(): void {
  if (!menu.value) return;
  menu.value = null;
  focusTerminal();
}
function menuKey(event: KeyboardEvent): void {
  const buttons = [
    ...(menuElement.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ];
  if (['Escape', 'Tab'].includes(event.key)) {
    event.preventDefault();
    closeMenu();
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !buttons.length) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
  buttons[index]?.focus();
}
function runMenuAction(key: string): void {
  if (menuActions.value.find((item) => item.key === key)?.disabled) return;
  closeMenu();
  if (key === 'copy') void copy();
  else if (key === 'paste') void paste();
}
async function paste(): Promise<void> {
  if (props.tab.state !== 'connected') {
    message.value = tr('请先连接终端再粘贴。');
    return;
  }
  const attempt = generation;
  try {
    const text = await clipboardApi.readText();
    if (!disposed && attempt === generation) requestPaste(text);
  } catch {
    message.value = tr('无法读取剪贴板，请检查系统权限。');
  }
}
function requestPaste(text: string): void {
  if (upload?.busy) {
    message.value = tr('ZMODEM 上传期间无法粘贴，请先完成或取消上传。');
    return;
  }
  if (props.tab.state !== 'connected') {
    message.value = tr('请先连接终端再粘贴。');
    return;
  }
  if (encoder.encode(text).length > 2 * 1024 * 1024) {
    message.value = tr('单次粘贴最多 2 MiB，请分批粘贴。');
    return;
  }
  if (text.length >= preferences.value.pasteConfirmChars || text.split(/\r?\n/).length > 50) {
    pendingPaste.value = text;
    return;
  }
  sendPaste(text);
}
function sendPaste(text: string): void {
  if (props.tab.state !== 'connected') {
    message.value = tr('请先连接终端再粘贴。');
    return;
  }
  message.value = null;
  approvedPaste = true;
  try {
    terminal.paste(text);
  } finally {
    approvedPaste = false;
  }
  terminal.focus();
}
async function approvePaste(): Promise<void> {
  const text = pendingPaste.value;
  pendingPaste.value = null;
  await nextTick();
  if (text !== null) sendPaste(text);
}
function nativePaste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text/plain');
  if (text !== undefined) {
    event.preventDefault();
    event.stopImmediatePropagation();
    requestPaste(text);
  }
}
async function sendDrop(id: string, data: Uint8Array): Promise<void> {
  if (disposed || session?.id !== id || props.tab.state !== 'connected')
    throw new Error(tr('终端会话已改变，上传已停止。'));
  if (!inputQueue.enqueue(data)) throw new Error(tr('终端输入队列已满，上传已停止。'));
  await inputQueue.flush();
}
async function interruptDrop(id: string): Promise<void> {
  if (disposed || session?.id !== id) throw new Error(tr('终端会话已结束。'));
  inputQueue.reset(id);
  await sendDrop(id, Uint8Array.of(3));
}
function terminalInputOptions() {
  const connected = props.tab.state === 'connected';
  return {
    cursorBlink: connected && preferences.value.cursorBlink,
    disableStdin: !connected,
  };
}
function terminalOptions() {
  const p = preferences.value;
  return {
    fontFamily: resolveTerminalFontFamily(p.fontFamily),
    lineHeight: resolveTerminalLineHeight(p.lineHeight),
    scrollback: p.scrollback,
    theme: terminalThemes[p.theme],
    ...terminalInputOptions(),
    cursorStyle: p.cursorStyle,
  };
}
function find(backward = false): void {
  if (!query.value) return;
  const found = backward ? search.findPrevious(query.value) : search.findNext(query.value);
  message.value = found ? null : tr('滚动缓冲中没有匹配内容。');
}
function activateLink(event: MouseEvent, url: string): void {
  event.preventDefault();
  if (
    event.button !== 0 ||
    disposed ||
    !props.active ||
    terminal.hasSelection() ||
    dialogBlocksTerminal()
  )
    return;
  const attempt = generation;
  void terminalApi.openLink(url).catch((cause: unknown) => {
    if (!disposed && attempt === generation) message.value = errorMessage(cause);
  });
}
onMounted(() => {
  if (!props.standalone)
    unregisterConnection = store.registerConnection(props.tab.key, changeConnection);
  if (!props.standalone)
    unregisterUpload = store.registerUpload(
      props.tab.key,
      () => !!dropUpload.value?.busy,
      async () => {
        await dropUpload.value?.stop();
      },
    );
  terminal = new Terminal({
    ...terminalOptions(),
    fontSize: application.state?.config.terminalFontSize ?? 16,
    allowProposedApi: false,
    allowTransparency: false,
    ignoreBracketedPasteMode: false,
    linkHandler: { activate: activateLink, allowNonHttpProtocols: false },
  });
  fit = new FitAddon();
  search = new SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(new WebLinksAddon(activateLink));
  terminal.parser.registerOscHandler(7, (data) => {
    const cwd = osc7Path(data);
    if (cwd) update({ cwd });
    return true;
  });
  container.value!.addEventListener('paste', nativePaste, true);
  terminal.onSelectionChange(copySelection);
  terminal.onCursorMove(updateScreen);
  terminal.onData((data) => queueInput(encoder.encode(data)));
  terminal.onBinary((data) => queueInput(Uint8Array.from(data, (char) => char.charCodeAt(0))));
  terminal.onResize((size) => {
    updateScreen();
    clearTimeout(resizeTimer);
    const attempt = generation;
    const id = session?.id;
    if (!id || !isConnected(attempt)) return;
    resizeTimer = setTimeout(() => {
      if (isConnected(attempt))
        void terminalApi
          .resize(id, { cols: size.cols, rows: size.rows })
          .catch((cause: unknown) => {
            if (isConnected(attempt)) message.value = errorMessage(cause);
          });
    }, 80);
  });
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const bounds = container.value!.getBoundingClientRect();
      void openMenu(bounds.left + 16, bounds.top + 16);
      return false;
    }
    const key = shortcutKey(event);
    const action = Object.entries(preferences.value.shortcuts).find(
      ([, binding]) => binding === key,
    )?.[0];
    if (action) event.preventDefault();
    if (action === 'copy') {
      void copy();
      return false;
    }
    if (action === 'paste') {
      void paste();
      return false;
    }
    if (action === 'find') {
      void toggleFind();
      return false;
    }
    if (action) {
      terminalAction(action);
      return false;
    }
    return true;
  });
  observer = new ResizeObserver(() => fitTerminal());
  observer.observe(container.value!);
  window.addEventListener('resize', resizeTerminal);
  fitTerminal();
  updateScreen();
  if (props.tab.connectRequested) void connect();
});
watch(
  () => props.tab.state,
  (state) => {
    if (terminal) Object.assign(terminal.options, terminalInputOptions());
    if (state === 'connected') inputQueue.reset(session?.id);
    else {
      clearTimeout(resizeTimer);
      pendingPaste.value = null;
      inputQueue.reset();
    }
  },
  { flush: 'sync' },
);
watch(
  () => props.tab.connectRequested,
  (requested) => {
    if (requested && props.tab.state === 'idle') void connect();
  },
);
watch(
  preferences,
  () => {
    if (terminal) {
      pendingDisplayOptions = true;
      fitTerminal();
    }
  },
  { deep: true },
);
watch(trust, (value) => {
  if (value) menu.value = null;
});
watch(
  () => props.active,
  async (active) => {
    if (active) {
      await nextTick();
      fitTerminal();
      focusTerminal();
    } else {
      menu.value = null;
    }
  },
);
watch(
  () => application.state?.config.terminalFontSize,
  (size) => {
    if (terminal && size) {
      displayFontSize.value = size;
      pendingFontSize = size;
      fitTerminal();
    }
  },
);
onBeforeUnmount(() => {
  unregisterConnection?.();
  unregisterUpload?.();
  disposed = true;
  dropUpload.value?.dispose();
  upload?.dispose();
  ++generation;
  clearTimeout(resizeTimer);
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
  observer?.disconnect();
  window.removeEventListener('resize', resizeTerminal);
  container.value?.removeEventListener('paste', nativePaste, true);
  if (session)
    void terminalApi.close(session.id).catch((cause: unknown) => {
      store.error = errorMessage(cause);
    });
  terminal?.dispose();
  inputQueue.dispose();
});
useErrorNotifications(message);
defineExpose({
  focus: focusTerminal,
  toggleFind,
  zoom: terminalAction,
  clearScreen,
  fontSize: displayFontSize,
  finding,
  message,
});
</script>
<template>
  <section
    class="terminal-pane"
    :aria-label="tr('终端 {0}', name)"
    :aria-description="stateLabels[tab.state] ?? tab.state"
    :data-host-id="tab.host?.id ?? ''"
    :data-state="tab.state"
  >
    <div v-if="finding" class="terminal-find">
      <input
        ref="searchInput"
        v-model="query"
        :aria-label="tr('终端查找内容')"
        :placeholder="tr('在终端滚动缓冲中查找')"
        @keydown.enter="find()"
        @keydown.esc.stop.prevent="toggleFind"
      /><button
        class="tool-button"
        :aria-label="tr('上一个')"
        :title="tr('上一个匹配')"
        @click="find(true)"
      >
        <ArrowUp :size="14" aria-hidden="true" /></button
      ><button
        class="tool-button"
        :aria-label="tr('下一个')"
        :title="tr('下一个匹配')"
        @click="find()"
      >
        <ArrowDown :size="14" aria-hidden="true" />
      </button>
    </div>

    <div
      ref="container"
      class="xterm-container"
      :aria-label="tr('交互式 Shell')"
      :data-state="tab.state"
      :style="{ backgroundColor: terminalThemes[preferences.theme].background }"
      @wheel.capture="zoomWithWheel"
      @mousedown.capture="preventTerminalRightClick"
      @contextmenu.capture="terminalContextMenu"
    ></div>
    <TerminalDropUpload
      v-if="tab.sessionId && tab.host"
      :key="tab.sessionId"
      ref="dropUpload"
      :session-id="tab.sessionId"
      :target="name"
      :enabled="dropEnabled"
      :can-receive="canReceiveDrop"
      :area="container"
      :send="sendDrop"
      :interrupt="interruptDrop"
      @error="message = errorMessage($event)"
      @activate="activateDropTarget"
      @closed="restoreDropFocus"
    />
    <div v-if="uploadProgress" class="terminal-upload" role="status" aria-live="polite">
      <span v-if="uploadProgress.phase === 'choosing'">{{
        tr('ZMODEM：请选择要上传的本地文件…')
      }}</span>
      <template v-else-if="uploadProgress.phase === 'uploading'">
        <span>{{ uploadProgress.name }}</span>
        <progress
          :value="uploadProgress.sent"
          :max="uploadProgress.size || 1"
          :aria-label="tr('ZMODEM 上传进度')"
        ></progress>
        <span>{{ uploadProgress.sent }} / {{ uploadProgress.size }}{{ tr(' 字节') }}</span>
      </template>
      <span v-else>{{ tr('ZMODEM：等待远端确认完成…') }}</span>
      <button class="button" @click="upload?.cancel()">{{ tr('取消上传') }}</button>
    </div>
    <Modal
      v-if="trust && active && (standalone || store.focused === tab.key)"
      :title="tr('确认 SSH 主机指纹')"
      @close="confirm(false)"
    >
      <p>
        {{ tr(' 首次连接 ') }}{{ trust.hostname }}:{{ trust.port
        }}{{ tr('。请从服务器控制台或其他可信渠道核对指纹后再信任。 ') }}
      </p>
      <p>{{ trust.algorithm }}</p>
      <code class="fingerprint">{{ trust.fingerprint }}</code>
      <p class="subtle">
        {{ tr('确认后保存至本机。以后检测到密钥变化将阻止连接；60 秒未确认则取消。') }}
      </p>
      <footer class="dialog-actions">
        <button class="button" @click="confirm(false)">{{ tr('拒绝连接') }}</button
        ><button class="button primary" @click="confirm(true)">
          {{ tr('已核对，信任并连接') }}
        </button>
      </footer>
    </Modal>
    <Modal v-if="pendingPaste !== null" :title="tr('确认大文本粘贴')" @close="pendingPaste = null"
      ><p>
        {{ tr(' 将向 ') }}{{ name }}{{ tr(' 发送 ') }}{{ pendingPaste.length
        }}{{ tr(' 个字符、约 ') }}{{ pendingPaste.split(/\r?\n/).length
        }}{{ tr(' 行。换行可能执行命令，请核对目标和内容。 ') }}
      </p>
      <pre class="paste-preview"
        >{{ pendingPaste.slice(0, 300) }}{{ pendingPaste.length > 300 ? '…' : '' }}</pre>
      <p class="subtle">
        {{
          tr(
            ' 终端启用 Bracketed Paste 时将保留粘贴边界。Shell 的启动配置和应用行为由目标设备决定。 ',
          )
        }}
      </p>
      <footer class="dialog-actions">
        <button class="button" @click="pendingPaste = null">{{ tr('取消') }}</button
        ><button class="button primary" @click="approvePaste">{{ tr('确认粘贴') }}</button>
      </footer></Modal
    >
    <Teleport :to="standalone ? (container?.closest('dialog') ?? 'body') : 'body'">
      <template v-if="menu">
        <button
          class="context-backdrop"
          :aria-label="tr('关闭终端菜单')"
          @click="closeMenu"
          @contextmenu.prevent="closeMenu"
          @wheel.prevent
        ></button>
        <div
          ref="menuElement"
          class="context-menu terminal-context-menu"
          role="menu"
          :aria-label="tr('终端操作')"
          :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
          @keydown="menuKey"
        >
          <button
            v-for="item in menuActions"
            :key="item.key"
            role="menuitem"
            :aria-label="item.label"
            :disabled="item.disabled"
            @click="runMenuAction(item.key)"
          >
            <span>{{ item.label }}</span>
            <kbd v-if="preferences.shortcuts[item.key]">{{ preferences.shortcuts[item.key] }}</kbd>
          </button>
        </div>
      </template>
    </Teleport>
  </section>
</template>
