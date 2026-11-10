<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, reactive, computed, nextTick } from 'vue';
import { FileCode2, Save, RotateCw, Search, WrapText, X } from '@lucide/vue';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/html/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import Modal from './Modal.vue';
import { useNotificationsStore } from '../stores/notifications';
import { editorApi } from '../services/editor';
import type { TextDocument } from '../types/files';
import { errorMessage } from '../services/ipc';
const props = defineProps<{ initialDocument: TextDocument }>();
const store = reactive({ document: props.initialDocument, dirty: false });
const notifications = useNotificationsStore();
const emit = defineEmits<{ ready: []; closed: [] }>();
const shortcutModifier = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';
const container = ref<HTMLElement>(),
  error = ref<string | null>(null),
  busy = ref(false),
  wrap = ref(true),
  position = ref({ lineNumber: 1, column: 1 }),
  lineCount = ref(1),
  lineEnding = ref('LF'),
  pending = ref<'close' | 'reload' | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
  resetting = false;
let appearance: MutationObserver | undefined;
let dirtyUpdates = Promise.resolve();
const document = computed(() => store.document!);
const fileName = computed(() => document.value.path.split('/').pop() || document.value.path);
const directory = computed(() => document.value.path.slice(0, -fileName.value.length) || '/');
const languageLabel = computed(
  () =>
    ({
      javascript: 'JavaScript',
      typescript: 'TypeScript',
      python: 'Python',
      shell: 'Shell',
      sql: 'SQL',
      yaml: 'YAML',
      rust: 'Rust',
      markdown: 'Markdown',
      xml: 'XML',
      html: 'HTML',
      css: 'CSS',
      json: 'JSON',
      plaintext: '纯文本',
    })[language(document.value.path)],
);
function updateStatus(): void {
  lineCount.value = model.getLineCount();
  lineEnding.value = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
}
function updateAppearance(): void {
  const root = globalThis.document.documentElement;
  const styles = getComputedStyle(root);
  const color = (name: string) => {
    const value = styles.getPropertyValue(name).trim();
    // CSS minification shortens e.g. #ffffff to #fff. Monaco's token color
    // table requires full-length hex values, including editor.background.
    return /^#[\da-f]{3,4}$/i.test(value)
      ? `#${[...value.slice(1)].map((digit) => digit + digit).join('')}`
      : value;
  };
  const colors = Object.fromEntries(
    [
      ['editor.background', '--panel'],
      ['editor.foreground', '--text'],
      ['editorGutter.background', '--panel'],
      ['editorLineNumber.foreground', '--muted'],
      ['editorLineNumber.activeForeground', '--accent'],
      ['editor.lineHighlightBackground', '--panel-soft'],
      ['editor.selectionBackground', '--accent-bg'],
    ]
      .map(([key, token]) => [key!, color(token!)])
      .filter(([, value]) => value),
  );
  monaco.editor.defineTheme('serverdeck-editor', {
    base: root.dataset.theme === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: { ...colors, 'editor.lineHighlightBorder': '#00000000' },
  });
  monaco.editor.setTheme('serverdeck-editor');
  const fontSize = Math.round(14 * (Number.parseFloat(color('--interface-font-scale')) || 1));
  editor.updateOptions({ fontSize, lineHeight: Math.round(fontSize * 1.6) });
}
function toggleWrap(): void {
  wrap.value = !wrap.value;
  editor.updateOptions({ wordWrap: wrap.value ? 'on' : 'off' });
}
async function find(): Promise<void> {
  try {
    await editor.getAction('actions.find')?.run();
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
function language(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return (
    (
      {
        js: 'javascript',
        ts: 'typescript',
        py: 'python',
        sh: 'shell',
        bashrc: 'shell',
        zshrc: 'shell',
        sql: 'sql',
        yml: 'yaml',
        yaml: 'yaml',
        rs: 'rust',
        md: 'markdown',
        xml: 'xml',
        html: 'html',
        css: 'css',
        json: 'json',
      } as Record<string, string>
    )[ext] ?? 'plaintext'
  );
}
onMounted(() => {
  (
    globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker: () => Worker } }
  ).MonacoEnvironment = { getWorker: () => new EditorWorker() };
  if (!monaco.languages.getLanguages().some((l) => l.id === 'json')) {
    monaco.languages.register({ id: 'json', extensions: ['.json'] });
    monaco.languages.setMonarchTokensProvider('json', {
      tokenizer: {
        root: [
          [/"(?:[^"\\]|\\.)*"\s*(?=:)/, 'type'],
          [/"(?:[^"\\]|\\.)*"/, 'string'],
          [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
          [/\b(?:true|false|null)\b/, 'keyword'],
          [/[{}[\],:]/, 'delimiter'],
        ],
      },
    });
  }
  model = monaco.editor.createModel(document.value.content, language(document.value.path));
  editor = monaco.editor.create(container.value!, {
    model,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 14,
    wordWrap: 'on',
    readOnly: !document.value.atomicSave,
    fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
    padding: { top: 14, bottom: 14 },
    lineNumbersMinChars: 4,
    renderLineHighlight: 'all',
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    smoothScrolling: true,
  });
  updateStatus();
  updateAppearance();
  appearance = new MutationObserver(updateAppearance);
  appearance.observe(globalThis.document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style'],
  });
  editor.onDidChangeCursorPosition((event) => {
    position.value = event.position;
  });
  model.onDidChangeContent(() => {
    updateStatus();
    if (resetting) return;
    const dirty =
      model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true) !==
      document.value.content;
    if (dirty !== store.dirty) {
      store.dirty = dirty;
      dirtyUpdates = dirtyUpdates
        .then(() => editorApi.dirty(dirty))
        .catch((cause) => {
          error.value = errorMessage(cause);
        });
    }
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void save();
  });
  editor.focus();
  emit('ready');
});
onBeforeUnmount(() => {
  appearance?.disconnect();
  editor?.dispose();
  model?.dispose();
});
async function save(): Promise<boolean> {
  if (busy.value || !document.value.atomicSave) return false;
  busy.value = true;
  error.value = null;
  editor.updateOptions({ readOnly: true });
  try {
    await dirtyUpdates;
    const result = await editorApi.save(
      model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true),
    );
    if (!result.document) {
      error.value = `${result.message ?? '保存失败'}；恢复路径：${result.recoveryPath ?? '无'}`;
      return false;
    }
    store.document = result.document;
    store.dirty = false;
    notifications.push('远程文件已保存并校验。');
    return true;
  } catch (cause) {
    error.value = errorMessage(cause);
    return false;
  } finally {
    busy.value = false;
    if (store.document) editor.updateOptions({ readOnly: !store.document.atomicSave });
  }
}
function request(action: 'close' | 'reload'): void {
  if (busy.value) return;
  if (store.dirty) pending.value = action;
  else void perform(action, false);
}
async function perform(action: 'close' | 'reload', discard: boolean): Promise<void> {
  pending.value = null;
  busy.value = true;
  error.value = null;
  editor.updateOptions({ readOnly: true });
  try {
    await dirtyUpdates;
    if (action === 'close') {
      await editorApi.close(discard);
      emit('closed');
    } else {
      const value = await editorApi.reload(discard);
      resetting = true;
      try {
        store.document = value;
        editor.setValue(value.content);
        store.dirty = false;
      } finally {
        resetting = false;
      }
    }
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
    if (store.document) editor.updateOptions({ readOnly: !store.document.atomicSave });
  }
}
async function cancelReview(): Promise<void> {
  pending.value = null;
  await nextTick();
  editor.focus();
}
async function saveAndPerform(): Promise<void> {
  const action = pending.value;
  if (action && (await save())) await perform(action, false);
}
function protectDraft(event: BeforeUnloadEvent): void {
  if (store.dirty || busy.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => window.addEventListener('beforeunload', protectDraft));
onBeforeUnmount(() => window.removeEventListener('beforeunload', protectDraft));
defineExpose({ requestClose: () => request('close') });
</script>
<template>
  <section class="remote-editor-window" aria-label="远程文本编辑">
    <header class="editor-titlebar">
      <span class="editor-file-icon"><FileCode2 :size="22" aria-hidden="true" /></span>
      <div class="editor-file-heading">
        <div class="editor-file-name">
          <h2 :title="fileName">{{ fileName }}</h2>
          <span v-if="store.dirty" class="editor-modified">未保存</span
          ><span v-if="!document.atomicSave" class="editor-readonly">只读</span>
        </div>
        <p :title="document.path">{{ directory }}</p>
      </div>
      <div class="editor-window-actions">
        <button
          class="icon-button"
          aria-label="关闭编辑器"
          title="关闭编辑器"
          :disabled="busy"
          @click="request('close')"
        >
          <X :size="18" aria-hidden="true" />
        </button>
      </div>
    </header>
    <div class="editor-toolbar" role="toolbar" aria-label="编辑操作">
      <button
        class="button primary editor-save"
        :disabled="busy || !document.atomicSave"
        @click="save"
      >
        <Save :size="15" aria-hidden="true" />{{ busy ? '处理中…' : '保存'
        }}<kbd>{{ shortcutModifier }}+S</kbd>
      </button>
      <button class="button editor-action" :disabled="busy" @click="request('reload')">
        <RotateCw :size="15" aria-hidden="true" /><span>重新加载</span>
      </button>
      <span class="editor-toolbar-divider" aria-hidden="true"></span>
      <button
        class="tool-button"
        aria-label="查找文本"
        :title="`查找文本 (${shortcutModifier}+F)`"
        :disabled="busy"
        @click="find"
      >
        <Search :size="16" aria-hidden="true" />
      </button>
      <button
        class="tool-button"
        aria-label="自动换行"
        title="自动换行"
        :aria-pressed="wrap"
        :disabled="busy"
        @click="toggleWrap"
      >
        <WrapText :size="16" aria-hidden="true" />
      </button>
      <span class="editor-toolbar-label">远程文本编辑</span>
    </div>
    <p v-if="error || !document.atomicSave" class="editor-feedback" role="alert">
      {{ error || '服务器缺少原子替换扩展，此文件只可查看。' }}
    </p>
    <div ref="container" class="remote-editor" aria-label="Monaco 远程编辑器"></div>
    <footer class="editor-statusbar" aria-label="编辑器状态">
      <span class="editor-sync-state" :class="{ modified: store.dirty }"
        ><span class="editor-status-dot" aria-hidden="true"></span
        >{{
          busy
            ? '正在处理…'
            : !document.atomicSave
              ? '只读'
              : store.dirty
                ? '有未保存的修改'
                : '已与远程文件同步'
        }}</span
      >
      <div class="editor-document-status">
        <span>行 {{ position.lineNumber }}，列 {{ position.column }}</span
        ><span>{{ lineCount }} 行</span><span>UTF-8</span><span>{{ lineEnding }}</span
        ><span>{{ languageLabel }}</span>
      </div>
    </footer>
  </section>
  <Modal v-if="pending" title="未保存内容" :busy="busy" @close="cancelReview"
    ><p>当前修改尚未保存。{{ pending === 'close' ? '关闭' : '重新加载' }}将丢弃修改。</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <footer class="dialog-actions">
      <button class="button" :disabled="busy" @click="cancelReview">返回编辑</button>
      <button
        class="button primary"
        :disabled="busy || !document.atomicSave"
        @click="saveAndPerform"
      >
        保存并{{ pending === 'close' ? '关闭' : '重新加载' }}
      </button>
      <button class="button danger" :disabled="busy" @click="perform(pending!, true)">
        放弃修改并{{ pending === 'close' ? '关闭' : '重新加载' }}
      </button>
    </footer></Modal
  >
</template>
