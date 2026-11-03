<script setup lang="ts">
import { clipboardApi } from '../services/clipboard';
import { useErrorNotifications } from '../composables/error-notifications';
import { opsApi } from '../services/ops';
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
import { TerminalInputQueue } from '../services/terminal-input';
import ForwardDialog from './ForwardDialog.vue';
import { useApplicationStore } from '../stores/application';
import Modal from './Modal.vue';
import '@xterm/xterm/css/xterm.css';

const props = defineProps<{ tab: TerminalPaneModel; active: boolean }>();
const emit = defineEmits<{
  close: [];
  monitor: [host: Host];
  operations: [host: Host];
  automation: [host: Host];
  network: [host: Host];
  action: [key: string, name: string];
  files: [host: Host, path: string | undefined, pane: string];
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
const pendingPaste = ref<string | null>(null),
  exporting = ref(false),
  forwards = ref(false);
const preferences = computed(
  () => application.state?.config.terminal ?? defaultTerminalPreferences(),
);
const working = ref(false);
const menu = ref<{ x: number; y: number } | null>(null);
const menuElement = ref<HTMLElement>();
const menuActions = computed(() => [
  {
    key: 'connect',
    label: props.tab.state === 'idle' ? '连接' : '重新连接',
    disabled: working.value || !['closed', 'failed', 'idle'].includes(props.tab.state),
  },
  { key: 'copy', label: '复制', disabled: false },
  { key: 'paste', label: '粘贴', disabled: props.tab.state !== 'connected' },
  { key: 'find', label: '查找', disabled: false },
  ...(props.tab.host
    ? [
        { key: 'automation', label: '自动化', disabled: false },
        { key: 'operations', label: '运维', disabled: false },
        { key: 'monitor', label: '监控', disabled: false },
        { key: 'files', label: 'SFTP 文件', disabled: false },
        ...(['failed', 'disconnected'].includes(props.tab.state)
          ? [{ key: 'network', label: '诊断连接异常', disabled: false }]
          : []),
        { key: 'forwards', label: '端口转发', disabled: props.tab.state !== 'connected' },
      ]
    : []),
  { key: 'export', label: '导出内容', disabled: false },
  { key: 'close', label: '关闭终端', disabled: false },
]);
let terminal: Terminal;
let fit: FitAddon;
let search: SearchAddon;
let observer: ResizeObserver;
let session: TerminalSession | LocalTerminalSession | undefined;
let generation = 0;
let disposed = false;
let approvedPaste = false;
const inputQueue = new TerminalInputQueue(terminalApi.input, (error) => {
  message.value = errorMessage(error);
});
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
const encoder = new TextEncoder();

function fitTerminal(): void {
  if (!props.active || !container.value?.clientWidth || !terminal) return;
  fit.fit();
}
function focusTerminal(): void {
  if (
    props.active &&
    store.focused === props.tab.key &&
    container.value?.clientWidth &&
    !document.querySelector('dialog[open]')
  )
    terminal.focus();
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
  if (!inputQueue.enqueue(data, approvedPaste))
    message.value = '输入队列已满或已断线，本次输入未发送。';
}
async function connect(): Promise<void> {
  if (working.value) return;
  working.value = true;
  const attempt = ++generation;
  pendingPaste.value = null;
  message.value = null;
  trust.value = null;
  inputQueue.reset();
  try {
    if (session) await terminalApi.close(session.id);
    session = undefined;
    store.update(props.tab.key, { sessionId: undefined, state: 'opening' });
    fitTerminal();
    terminal.write(
      `\r\n\x1b[90m── ${props.tab.host ? '新的 SSH Shell' : '本地 Shell'} ──\x1b[0m\r\n`,
    );
    const open = props.tab.containerShell
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
    const receive = (event: TerminalEvent) => {
      if (disposed || attempt !== generation) return;
      if (event.type === 'data') {
        terminal.write(new Uint8Array(event.data), () => {
          void opening
            .then((value) => terminalApi.ack(value.id, event.sequence))
            .catch((cause: unknown) => {
              if (attempt === generation && props.tab.state === 'connected')
                message.value = errorMessage(cause);
            });
        });
      } else if (event.type === 'state') {
        store.update(props.tab.key, { state: event.state });
        if (event.message) message.value = event.message;
        if (event.state !== 'awaiting_trust') trust.value = null;
      } else if (event.type === 'trust') trust.value = event;
      else if (event.type === 'exit')
        terminal.write(
          `\r\n\x1b[90m[Shell 已结束${event.status === null ? '' : `，退出码 ${event.status}`}]\x1b[0m\r\n`,
        );
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
    store.update(props.tab.key, {
      sessionId: value.id,
      ...('transportId' in value
        ? { transportId: value.transportId, routeHostIds: value.routeHostIds }
        : { shell: value.shell }),
    });
  } catch (cause) {
    store.update(props.tab.key, { state: 'failed' });
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
  emit('action', props.tab.key, event.deltaY < 0 ? 'zoomIn' : 'zoomOut');
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
  if (!props.active || document.querySelector('dialog[open]')) return;
  store.focused = props.tab.key;
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
  closeMenu();
  switch (key) {
    case 'connect':
      void connect();
      break;
    case 'copy':
      void copy();
      break;
    case 'paste':
      void paste();
      break;
    case 'find':
      void toggleFind();
      break;
    case 'automation':
      if (props.tab.host) emit('automation', props.tab.host);
      break;
    case 'operations':
      if (props.tab.host) emit('operations', props.tab.host);
      break;
    case 'monitor':
      if (props.tab.host) emit('monitor', props.tab.host);
      break;
    case 'files':
      if (props.tab.host) emit('files', props.tab.host, props.tab.cwd, props.tab.key);
      break;
    case 'network':
      if (props.tab.host) emit('network', props.tab.host);
      break;
    case 'forwards':
      forwards.value = true;
      break;
    case 'export':
      exporting.value = true;
      break;
    case 'close':
      emit('close');
      break;
  }
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
function exportText(): void {
  const buffer = terminal.buffer.normal;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index++)
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  const url = URL.createObjectURL(
    new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `serverdeck-terminal-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  exporting.value = false;
}
function terminalOptions() {
  const p = preferences.value;
  return {
    fontFamily: p.fontFamily,
    lineHeight: p.lineHeight / 100,
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
    fontSize: application.state?.config.terminalFontSize ?? 14,
    allowProposedApi: false,
    allowTransparency: false,
    ignoreBracketedPasteMode: false,
  });
  fit = new FitAddon();
  search = new SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.open(container.value!);
  terminal.parser.registerOscHandler(7, (data) => {
    const cwd = osc7Path(data);
    if (cwd) store.update(props.tab.key, { cwd });
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
      emit('action', props.tab.key, action);
      return false;
    }
    return true;
  });
  observer = new ResizeObserver(fitTerminal);
  observer.observe(container.value!);
  window.addEventListener('resize', closeMenu);
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
      Object.assign(terminal.options, terminalOptions());
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
    } else menu.value = null;
  },
);
watch(
  () => application.state?.config.terminalFontSize,
  (size) => {
    if (terminal && size) {
      terminal.options.fontSize = size;
      fitTerminal();
    }
  },
);
onBeforeUnmount(() => {
  disposed = true;
  ++generation;
  clearTimeout(resizeTimer);
  observer?.disconnect();
  window.removeEventListener('resize', closeMenu);
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
      @wheel.capture="zoomWithWheel"
      @mousedown.capture="preventTerminalRightClick"
      @contextmenu.capture="terminalContextMenu"
    ></div>
    <div class="terminal-footnote">
      <span v-if="tab.fileAction">此窗格是已确认的文件命令，手动重连将重新运行该命令。 · </span>
      {{ preferences.quickCopyPaste ? 'Shift+右键' : '右键' }} 打开终端操作 ·
      {{ preferences.shortcuts.copy }} / {{ preferences.shortcuts.paste }} 复制粘贴 ·
      {{ preferences.shortcuts.find }} 查找 · Ctrl+滚轮 缩放字体 · Ctrl+C / Z 发送到{{
        tab.host ? '远端' : '本地终端'
      }}
    </div>
    <Modal
      v-if="trust && active && store.focused === tab.key"
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
    <Modal v-if="exporting" title="导出终端内容" @close="exporting = false"
      ><p>
        导出当前终端普通屏幕及滚动历史的 UTF-8
        纯文本。内容可能包含命令、口令或其他秘密，请确认保存位置和用途。
      </p>
      <p class="subtle">不会自动录制会话；仅在本次点击后生成本地下载。</p>
      <footer class="dialog-actions">
        <button class="button" @click="exporting = false">取消</button
        ><button class="button primary" @click="exportText">确认导出文本</button>
      </footer></Modal
    >
    <ForwardDialog
      v-if="forwards && session && tab.host"
      :session-id="session.id"
      :host-name="hostDisplayName(tab.host)"
      @close="forwards = false"
    />
    <Teleport to="body">
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
          <p class="terminal-menu-heading">
            {{ name }} · {{ stateLabels[tab.state] ?? tab.state }}
          </p>
          <p v-if="tab.host" class="terminal-menu-heading">
            {{ tab.host.username }}@{{ tab.host.hostname }}:{{ tab.host.port }}
          </p>
          <button
            v-for="item in menuActions"
            :key="item.key"
            role="menuitem"
            :disabled="item.disabled"
            @click="runMenuAction(item.key)"
          >
            {{ item.label }}
          </button>
        </div>
      </template>
    </Teleport>
  </section>
</template>
