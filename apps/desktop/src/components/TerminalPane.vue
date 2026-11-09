<script setup lang="ts">
import { clipboardApi } from '../services/clipboard';
import { useErrorNotifications } from '../composables/error-notifications';
import { opsApi } from '../services/ops';
import { pluginsApi } from '../services/plugins';
import { ArrowDown, ArrowUp } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
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
const name = computed(() => (props.tab.host ? hostDisplayName(props.tab.host) : '本地设备'));
const container = ref<HTMLElement>();
const searchInput = ref<HTMLInputElement>();
const message = ref<string | null>(null);
const trust = ref<Extract<TerminalEvent, { type: 'trust' }> | null>(null);
const query = ref('');
const finding = ref(false);
const pendingPaste = ref<string | null>(null);
const preferences = computed(
  () => application.state?.config.terminal ?? defaultTerminalPreferences(),
);
const working = ref(false);
const uploadProgress = ref<UploadProgress | null>(null);
let upload: ZmodemUpload | undefined;
const menu = ref<{ x: number; y: number } | null>(null);
const menuElement = ref<HTMLElement>();
const menuActions = computed(() => [
  { key: 'copy', label: '复制', disabled: false },
  { key: 'paste', label: '粘贴', disabled: props.tab.state !== 'connected' },
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
function update(values: Partial<Omit<TerminalPaneModel, 'key' | 'host'>>): void {
  if (props.standalone) emit('update', values);
  else store.update(props.tab.key, values);
}
function terminalAction(name: string): void {
  if (props.standalone && ['zoomIn', 'zoomOut', 'zoomReset'].includes(name)) {
    const base = application.state?.config.terminalFontSize ?? 16;
    const current = terminal.options.fontSize ?? base;
    terminal.options.fontSize =
      name === 'zoomReset'
        ? base
        : Math.max(8, Math.min(32, current + (name === 'zoomIn' ? 1 : -1)));
    fitTerminal();
  } else emit('action', props.tab.key, name);
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
  if (upload?.busy) {
    if (data.includes(3) || data.includes(24)) upload.cancel();
    return;
  }
  if (!inputQueue.enqueue(data, approvedPaste))
    message.value = '输入队列已满或已断线，本次输入未发送。';
}
async function connect(): Promise<void> {
  if (working.value) return;
  working.value = true;
  const attempt = ++generation;
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
      connectRequested: false,
      state: 'opening',
    });
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
      if (disposed || attempt !== generation) throw new Error('终端会话已改变，上传已取消。');
      return value.id;
    };
    const receiver = props.tab.host
      ? new ZmodemUpload({
          write: (data) => terminal.write(data),
          send: async (data) => {
            await ready();
            if (!inputQueue.enqueue(data)) throw new Error('ZMODEM 输入队列已满，上传已停止。');
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
        if (receiver) receiver.consume(new Uint8Array(event.data));
        else terminal.write(new Uint8Array(event.data));
        terminal.write(new Uint8Array(), () => {
          void opening
            .then((value) => terminalApi.ack(value.id, event.sequence))
            .catch((cause: unknown) => {
              if (attempt === generation && props.tab.state === 'connected')
                message.value = errorMessage(cause);
            });
        });
      } else if (event.type === 'state') {
        if (['closed', 'failed', 'disconnected'].includes(event.state)) {
          receiver?.dispose();
          pendingPaste.value = null;
          inputQueue.reset();
        }
        update({ state: event.state });
        if (event.message) message.value = event.message;
        if (event.state !== 'awaiting_trust') trust.value = null;
      } else if (event.type === 'trust') trust.value = event;
      else if (event.type === 'exit') {
        receiver?.dispose();
        terminal.write(
          `\r\n\x1b[90m[Shell 已结束${event.status === null ? '' : `，退出码 ${event.status}`}]\x1b[0m\r\n`,
        );
      }
    };
    const size = { cols: terminal.cols, rows: terminal.rows };
    const opening = props.tab.host
      ? open(props.tab.host.id, size, receive)
      : terminalApi.openLocal(size, receive);
    const value = await opening;
    if (disposed || attempt !== generation) {
      await terminalApi.close(value.id);
      return;
    }
    session = value;
    inputQueue.reset(value.id);
    focusTerminal();
    update({
      sessionId: value.id,
      ...('transportId' in value
        ? { transportId: value.transportId, routeHostIds: value.routeHostIds }
        : { shell: value.shell }),
    });
  } catch (cause) {
    update({ state: 'failed' });
    message.value = errorMessage(cause);
  } finally {
    working.value = false;
  }
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
    message.value = '无法写入剪贴板，请检查系统权限。';
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
  if (
    !props.active ||
    !event.ctrlKey ||
    event.deltaY === 0 ||
    document.querySelector('dialog[open]')
  )
    return;
  event.preventDefault();
  event.stopImmediatePropagation();
  terminalAction(event.deltaY < 0 ? 'zoomIn' : 'zoomOut');
}
function terminalContextMenu(event: MouseEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!props.active || document.querySelector('dialog[open]')) return;
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
    message.value = '请先连接终端再粘贴。';
    return;
  }
  const attempt = generation;
  try {
    const text = await clipboardApi.readText();
    if (!disposed && attempt === generation) requestPaste(text);
  } catch {
    message.value = '无法读取剪贴板，请检查系统权限。';
  }
}
function requestPaste(text: string): void {
  if (upload?.busy) {
    message.value = 'ZMODEM 上传期间无法粘贴，请先完成或取消上传。';
    return;
  }
  if (props.tab.state !== 'connected') {
    message.value = '请先连接终端再粘贴。';
    return;
  }
  if (encoder.encode(text).length > 2 * 1024 * 1024) {
    message.value = '单次粘贴最多 2 MiB，请分批粘贴。';
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
    message.value = '请先连接终端再粘贴。';
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
function terminalOptions() {
  const p = preferences.value;
  return {
    fontFamily: resolveTerminalFontFamily(p.fontFamily),
    lineHeight: resolveTerminalLineHeight(p.lineHeight),
    scrollback: p.scrollback,
    theme: terminalThemes[p.theme],
    cursorBlink: p.cursorBlink,
    cursorStyle: p.cursorStyle,
  };
}
function find(backward = false): void {
  if (!query.value) return;
  const found = backward ? search.findPrevious(query.value) : search.findNext(query.value);
  message.value = found ? null : '滚动缓冲中没有匹配内容。';
}
onMounted(() => {
  terminal = new Terminal({
    ...terminalOptions(),
    fontSize: application.state?.config.terminalFontSize ?? 16,
    allowProposedApi: false,
    allowTransparency: false,
    ignoreBracketedPasteMode: false,
  });
  fit = new FitAddon();
  search = new SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.parser.registerOscHandler(7, (data) => {
    const cwd = osc7Path(data);
    if (cwd) update({ cwd });
    return true;
  });
  container.value!.addEventListener('paste', nativePaste, true);
  terminal.onSelectionChange(copySelection);
  terminal.onData((data) => queueInput(encoder.encode(data)));
  terminal.onBinary((data) => queueInput(Uint8Array.from(data, (char) => char.charCodeAt(0))));
  terminal.onResize((size) => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (session && props.tab.state === 'connected')
        void terminalApi
          .resize(session.id, { cols: size.cols, rows: size.rows })
          .catch((cause: unknown) => {
            message.value = errorMessage(cause);
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
  if (props.tab.connectRequested) void connect();
});
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
      pendingFontSize = size;
      fitTerminal();
    }
  },
);
onBeforeUnmount(() => {
  disposed = true;
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
</script>
<template>
  <section
    class="terminal-pane"
    :aria-label="`终端 ${name}`"
    :aria-description="stateLabels[tab.state] ?? tab.state"
    :data-host-id="tab.host?.id ?? ''"
    :data-state="tab.state"
  >
    <div v-if="finding" class="terminal-find">
      <input
        ref="searchInput"
        v-model="query"
        aria-label="终端查找内容"
        placeholder="在终端滚动缓冲中查找"
        @keydown.enter="find()"
      /><button class="tool-button" aria-label="上一个" title="上一个匹配" @click="find(true)">
        <ArrowUp :size="14" aria-hidden="true" /></button
      ><button class="tool-button" aria-label="下一个" title="下一个匹配" @click="find()">
        <ArrowDown :size="14" aria-hidden="true" />
      </button>
    </div>

    <div
      ref="container"
      class="xterm-container"
      aria-label="交互式 Shell"
      :data-state="tab.state"
      :style="{ backgroundColor: terminalThemes[preferences.theme].background }"
      @wheel.capture="zoomWithWheel"
      @mousedown.capture="preventTerminalRightClick"
      @contextmenu.capture="terminalContextMenu"
    ></div>
    <div v-if="uploadProgress" class="terminal-upload" role="status" aria-live="polite">
      <span v-if="uploadProgress.phase === 'choosing'">ZMODEM：请选择要上传的本地文件…</span>
      <template v-else-if="uploadProgress.phase === 'uploading'">
        <span>{{ uploadProgress.name }}</span>
        <progress
          :value="uploadProgress.sent"
          :max="uploadProgress.size || 1"
          aria-label="ZMODEM 上传进度"
        ></progress>
        <span>{{ uploadProgress.sent }} / {{ uploadProgress.size }} 字节</span>
      </template>
      <span v-else>ZMODEM：等待远端确认完成…</span>
      <button class="button" @click="upload?.cancel()">取消上传</button>
    </div>
    <Modal
      v-if="trust && active && (standalone || store.focused === tab.key)"
      title="确认 SSH 主机指纹"
      @close="confirm(false)"
    >
      <p>
        首次连接 {{ trust.hostname }}:{{
          trust.port
        }}。请从服务器控制台或其他可信渠道核对指纹后再信任。
      </p>
      <p>{{ trust.algorithm }}</p>
      <code class="fingerprint">{{ trust.fingerprint }}</code>
      <p class="subtle">确认后保存至本机。以后检测到密钥变化将阻止连接；60 秒未确认则取消。</p>
      <footer class="dialog-actions">
        <button class="button" @click="confirm(false)">拒绝连接</button
        ><button class="button primary" @click="confirm(true)">已核对，信任并连接</button>
      </footer>
    </Modal>
    <Modal v-if="pendingPaste !== null" title="确认大文本粘贴" @close="pendingPaste = null"
      ><p>
        将向 {{ name }} 发送 {{ pendingPaste.length }} 个字符、约
        {{ pendingPaste.split(/\r?\n/).length }} 行。换行可能执行命令，请核对目标和内容。
      </p>
      <pre class="paste-preview"
        >{{ pendingPaste.slice(0, 300) }}{{ pendingPaste.length > 300 ? '…' : '' }}</pre>
      <p class="subtle">
        终端启用 Bracketed Paste 时将保留粘贴边界。Shell 的启动配置和应用行为由目标设备决定。
      </p>
      <footer class="dialog-actions">
        <button class="button" @click="pendingPaste = null">取消</button
        ><button class="button primary" @click="approvePaste">确认粘贴</button>
      </footer></Modal
    >
    <Teleport :to="standalone ? (container?.closest('dialog') ?? 'body') : 'body'">
      <template v-if="menu">
        <button
          class="context-backdrop"
          aria-label="关闭终端菜单"
          @click="closeMenu"
          @contextmenu.prevent="closeMenu"
          @wheel.prevent
        ></button>
        <div
          ref="menuElement"
          class="context-menu terminal-context-menu"
          role="menu"
          aria-label="终端操作"
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
