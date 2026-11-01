<script setup lang="ts">
import { opsApi } from '../services/ops';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { filesApi } from '../services/files';
import { osc7Path } from '../services/osc7';
import type { Host } from '../types/hosts';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import { stateLabels, type TerminalEvent, type TerminalSession } from '../types/terminal';
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
let terminal: Terminal;
let fit: FitAddon;
let search: SearchAddon;
let observer: ResizeObserver;
let session: TerminalSession | undefined;
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
  message.value = null;
  trust.value = null;
  inputQueue.reset();
  try {
    if (session) await terminalApi.close(session.id);
    session = undefined;
    store.update(props.tab.key, { sessionId: undefined, state: 'opening' });
    fitTerminal();
    terminal.write('\r\n\x1b[90m── 新的 SSH Shell ──\x1b[0m\r\n');
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
    const opening = open(
      props.tab.host.id,
      { cols: terminal.cols, rows: terminal.rows },
      (event) => {
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
      },
    );
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
      transportId: value.transportId,
      routeHostIds: value.routeHostIds,
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
    await navigator.clipboard.writeText(terminal.getSelection());
  } catch {
    message.value = '无法写入剪贴板，请检查系统权限。';
  }
}
async function paste(): Promise<void> {
  try {
    requestPaste(await navigator.clipboard.readText());
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
  if (props.tab.connectRequested) void connect();
});
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
watch(
  () => props.active,
  async (active) => {
    if (active) {
      await nextTick();
      fitTerminal();
      focusTerminal();
    }
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
  container.value?.removeEventListener('paste', nativePaste, true);
  if (session) void terminalApi.close(session.id).catch(() => {});
  terminal?.dispose();
  inputQueue.dispose();
});
</script>
<template>
  <section class="terminal-pane" :aria-label="`终端 ${tab.host.name}`">
    <div class="terminal-toolbar">
      <strong>{{ tab.host.name }}</strong
      ><span class="subtle"
        >{{ tab.host.username }}@{{ tab.host.hostname }}:{{ tab.host.port }}</span
      >
      <span :class="['session-state', tab.state]" role="status">{{
        stateLabels[tab.state] ?? tab.state
      }}</span>
      <button
        class="button"
        :disabled="working || !['closed', 'failed', 'idle'].includes(tab.state)"
        @click="connect"
      >
        {{ tab.state === 'idle' ? '连接' : '重新连接' }}
      </button>
      <button class="button" @click="emit('automation', tab.host)">自动化</button
      ><button
        v-if="['failed', 'disconnected'].includes(tab.state)"
        class="button"
        @click="emit('network', tab.host)"
      >
        诊断连接异常
      </button>
      <button class="button" @click="emit('operations', tab.host)">运维</button>
      <button class="button" @click="emit('monitor', tab.host)">监控</button>
      <button class="button" @click="emit('files', tab.host, tab.cwd, tab.key)">SFTP 文件</button>
      <button class="button" @click="toggleFind">查找</button
      ><button class="button" @click="copy">复制</button>
      <button class="button" :disabled="tab.state !== 'connected'" @click="paste">粘贴</button
      ><button class="button" @click="emit('close')">关闭终端</button>
      <button class="button" :disabled="tab.state !== 'connected'" @click="forwards = true">
        端口转发
      </button>
      <button class="button" @click="exporting = true">导出内容</button>
      <button v-if="trust" class="button" @click="store.focused = tab.key">查看主机指纹</button>
    </div>
    <div v-if="finding" class="terminal-find">
      <input
        ref="searchInput"
        v-model="query"
        aria-label="终端查找内容"
        placeholder="在终端滚动缓冲中查找"
        @keydown.enter="find()"
      /><button class="button" @click="find(true)">上一个</button
      ><button class="button" @click="find()">下一个</button>
    </div>
    <div v-if="message" class="banner error" role="alert">{{ message }}</div>
    <div ref="container" class="xterm-container" aria-label="交互式 Shell"></div>
    <div class="terminal-footnote">
      <span v-if="tab.fileAction">此窗格是已确认的文件命令，手动重连将重新运行该命令。 · </span>
      {{ preferences.shortcuts.copy }} / {{ preferences.shortcuts.paste }} 复制粘贴 ·
      {{ preferences.shortcuts.find }} 查找 · Ctrl+C / Z 发送到远端
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
        将向 {{ tab.host.name }} 发送 {{ pendingPaste.length }} 个字符、约
        {{ pendingPaste.split(/\r?\n/).length }} 行。换行可能执行命令，请核对目标和内容。
      </p>
      <pre class="paste-preview"
        >{{ pendingPaste.slice(0, 300) }}{{ pendingPaste.length > 300 ? '…' : '' }}</pre>
      <p class="subtle">
        远端启用 Bracketed Paste 时将保留粘贴边界。Shell 的启动配置和应用行为仍由远端决定。
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
      v-if="forwards && session"
      :session-id="session.id"
      :host-name="tab.host.name"
      @close="forwards = false"
    />
  </section>
</template>
