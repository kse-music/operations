<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
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
import { useFilesStore } from '../stores/files';
import { filesApi } from '../services/files';
import { errorMessage } from '../services/ipc';
const store = useFilesStore();
const container = ref<HTMLElement>(),
  error = ref<string | null>(null),
  busy = ref(false),
  confirmed = ref(false),
  pending = ref<'close' | 'reload' | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
  resetting = false;
const document = computed(() => store.document!);
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
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 14,
    wordWrap: 'on',
    readOnly: false,
  });
  model.onDidChangeContent(() => {
    if (resetting) return;
    const dirty =
      model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true) !==
      document.value.content;
    if (dirty !== store.dirty) {
      store.dirty = dirty;
      void filesApi.dirty(document.value.token, dirty).catch((cause) => {
        error.value = errorMessage(cause);
      });
    }
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (confirmed.value && !busy.value) void save();
  });
});
onBeforeUnmount(() => {
  editor?.dispose();
  model?.dispose();
});
async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  editor.updateOptions({ readOnly: true });
  try {
    const result = await filesApi.save(
      document.value.token,
      model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true),
      confirmed.value,
    );
    if (!result.document) {
      error.value = `${result.message ?? '保存失败'}；恢复路径：${result.recoveryPath ?? '无'}`;
      return;
    }
    store.document = result.document;
    store.dirty = false;
    store.notice = '远程文件已保存并校验。';
    void store.refresh();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
    editor.updateOptions({ readOnly: false });
  }
}
function request(action: 'close' | 'reload'): void {
  if (store.dirty) pending.value = action;
  else void perform(action);
}
async function perform(action: 'close' | 'reload'): Promise<void> {
  pending.value = null;
  busy.value = true;
  error.value = null;
  try {
    const old = document.value;
    if (action === 'close') {
      await filesApi.closeEditor(old.token, true);
      store.document = null;
      store.dirty = false;
    } else {
      const value = await filesApi.read(old.sessionId, old.path);
      await filesApi.closeEditor(old.token, true);
      resetting = true;
      store.document = value;
      editor.setValue(value.content);
      store.dirty = false;
      resetting = false;
    }
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
useErrorNotifications(() => [
  error.value,
  !document.value.atomicSave ? '服务器缺少原子替换扩展，此文档只可查看。' : null,
]);
</script>
<template>
  <Modal title="远程文本编辑" wide :busy="busy" @close="request('close')"
    ><div class="editor-header">
      <strong>{{ document.path }}{{ store.dirty ? ' · 未保存' : '' }}</strong
      ><button class="button" :disabled="busy" @click="request('reload')">重新加载</button
      ><button
        class="button primary"
        :disabled="busy || !confirmed || !document.atomicSave"
        @click="save"
      >
        {{ busy ? '保存中…' : '保存远程文件' }}</button
      ><button class="button" :disabled="busy" @click="request('close')">关闭编辑器</button>
    </div>

    <label class="checkbox-label"
      ><input v-model="confirmed" type="checkbox" />确认原子替换会改变
      inode；保留基本权限和属主，不适用于须保留 ACL、扩展属性或硬链接关系的文件。</label
    >
    <div ref="container" class="remote-editor" aria-label="Monaco 远程编辑器"></div>
    <p class="subtle">
      UTF-8，最大 2 MiB · 保存前重新核对内容、权限及属主；外部修改时拒绝覆盖。
    </p></Modal
  ><Modal v-if="pending" title="未保存内容" @close="pending = null"
    ><p>当前修改尚未保存。{{ pending === 'close' ? '关闭' : '重新加载' }}将丢弃修改。</p>
    <footer class="dialog-actions">
      <button class="button" @click="pending = null">返回编辑</button
      ><button class="button danger" @click="perform(pending!)">
        放弃修改并{{ pending === 'close' ? '关闭' : '重新加载' }}
      </button>
    </footer></Modal
  >
</template>
