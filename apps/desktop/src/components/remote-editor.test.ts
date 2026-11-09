import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import type { TextDocument } from '../types/files';

const mock = vi.hoisted(() => {
  let value = '';
  let changed = () => {};
  let moved: (event: { position: { lineNumber: number; column: number } }) => void = () => {};
  const model = {
    getValue: vi.fn(() => value),
    getLineCount: vi.fn(() => value.split('\n').length),
    getEOL: vi.fn(() => (value.includes('\r\n') ? '\r\n' : '\n')),
    onDidChangeContent: vi.fn((callback: () => void) => {
      changed = callback;
    }),
    dispose: vi.fn(),
  };
  const find = vi.fn().mockResolvedValue(undefined);
  const editor = {
    updateOptions: vi.fn(),
    addCommand: vi.fn(),
    onDidChangeCursorPosition: vi.fn((callback: typeof moved) => {
      moved = callback;
    }),
    getAction: vi.fn(() => ({ run: find })),
    setValue: vi.fn((next: string) => {
      value = next;
      changed();
    }),
    focus: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    model,
    editor,
    find,
    create: vi.fn<(element: HTMLElement, options: Record<string, unknown>) => typeof editor>(
      () => editor,
    ),
    createModel: vi.fn((content: string) => {
      value = content;
      return model;
    }),
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    change: (content: string) => {
      value = content;
      changed();
    },
    move: (lineNumber: number, column: number) => moved({ position: { lineNumber, column } }),
  };
});
vi.mock('monaco-editor/editor/editor.api', () => ({
  editor: {
    create: mock.create,
    createModel: mock.createModel,
    defineTheme: mock.defineTheme,
    setTheme: mock.setTheme,
    EndOfLinePreference: { TextDefined: 0 },
  },
  languages: { getLanguages: () => [{ id: 'json' }] },
  KeyMod: { CtrlCmd: 1 },
  KeyCode: { KeyS: 2 },
}));
vi.mock('monaco-editor/editor/contrib/find/browser/findController', () => ({}));
vi.mock('monaco-editor/languages/definitions/javascript/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/typescript/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/python/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/shell/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/sql/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/yaml/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/rust/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/markdown/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/xml/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/css/register', () => ({}));
vi.mock('monaco-editor/languages/definitions/html/register', () => ({}));
vi.mock('monaco-editor/editor/editor.worker?worker', () => ({ default: class {} }));
import RemoteEditor from './RemoteEditor.vue';
import { useFilesStore } from '../stores/files';
import { filesApi } from '../services/files';

let app: App, pinia: Pinia, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const doc: TextDocument = {
  token: 'file',
  sessionId: 'session',
  path: '/srv/scripts/deploy.sh',
  content: '#!/bin/sh\necho ready\n',
  sha256: 'hash',
  permissions: 0o644,
  uid: 1000,
  gid: 1000,
  atomicSave: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  useFilesStore().document = { ...doc };
  vi.spyOn(filesApi, 'dirty').mockResolvedValue(undefined);
  vi.spyOn(filesApi, 'closeEditor').mockResolvedValue(undefined);
  vi.spyOn(useFilesStore(), 'refresh').mockResolvedValue(undefined);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  document.documentElement.dataset.theme = 'dark';
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root.remove();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});
async function mount() {
  const store = useFilesStore();
  app = createApp({ render: () => (store.document ? h(RemoteEditor) : null) }).use(pinia);
  app.mount(root);
  await nextTick();
}
function button(label: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
}
function saveButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('.editor-save')!;
}
function confirm() {
  document.querySelector<HTMLInputElement>('.editor-save-policy input')!.click();
}

it('shows actual cursor, line endings and dirty state while maximizing preserves the model', async () => {
  await mount();
  expect(document.querySelector('.editor-file-heading')?.textContent).toContain('deploy.sh');
  expect(document.querySelector('.editor-file-heading p')?.getAttribute('title')).toBe(doc.path);
  mock.change('one\r\ntwo\r\nthree');
  mock.move(3, 6);
  await nextTick();
  const status = document.querySelector('.editor-statusbar')!;
  expect(status.textContent).toContain('行 3，列 6');
  expect(status.textContent).toContain('3 行');
  expect(status.textContent).toContain('CRLF');
  expect(status.textContent).toContain('Shell');
  expect(status.textContent).toContain('有未保存的修改');
  expect(filesApi.dirty).toHaveBeenCalledWith('file', true);
  button('最大化编辑器').click();
  await nextTick();
  expect(document.querySelector('dialog')?.classList.contains('is-maximized')).toBe(true);
  button('还原编辑器').click();
  await nextTick();
  expect(mock.create).toHaveBeenCalledTimes(1);
  expect(mock.model.getValue()).toBe('one\r\ntwo\r\nthree');
});

it('requires explicit replacement consent for both save button and keyboard save', async () => {
  const save = vi.spyOn(filesApi, 'save').mockResolvedValue({
    document: { ...doc, content: 'changed' },
    recoveryPath: null,
    message: null,
  });
  await mount();
  mock.change('changed');
  expect(saveButton().disabled).toBe(true);
  const command = mock.editor.addCommand.mock.calls[0]![1] as () => void;
  command();
  expect(save).not.toHaveBeenCalled();
  confirm();
  await nextTick();
  expect(saveButton().disabled).toBe(false);
  command();
  await vi.waitFor(() => expect(useFilesStore().dirty).toBe(false));
  expect(save).toHaveBeenCalledExactlyOnceWith('file', 'changed', true);
  expect(document.querySelector('.editor-statusbar')?.textContent).toContain('已与远程文件同步');
});

it('keeps failed content editable and displays the actual save error', async () => {
  vi.spyOn(filesApi, 'save').mockRejectedValue({ message: '远端内容已变化' });
  await mount();
  mock.change('my draft');
  confirm();
  await nextTick();
  saveButton().click();
  await vi.waitFor(() =>
    expect(document.querySelector('.editor-feedback')?.textContent).toBe('远端内容已变化'),
  );
  expect(useFilesStore().dirty).toBe(true);
  expect(mock.model.getValue()).toBe('my draft');
  expect(mock.editor.updateOptions).toHaveBeenLastCalledWith({ readOnly: false });
});

it('keeps unsupported atomic saves read only, including keyboard commands', async () => {
  useFilesStore().document!.atomicSave = false;
  const save = vi.spyOn(filesApi, 'save');
  await mount();
  expect(mock.create.mock.calls[0]![1]).toMatchObject({ readOnly: true });
  expect(saveButton().disabled).toBe(true);
  (mock.editor.addCommand.mock.calls[0]![1] as () => void)();
  expect(save).not.toHaveBeenCalled();
  expect(document.querySelector('.editor-feedback')?.textContent).toContain('只可查看');
});

it.each(['关闭编辑器', '重新加载'])(
  'protects dirty content before %s and preserves it when cancelled',
  async (action) => {
    const read = vi.spyOn(filesApi, 'read');
    await mount();
    mock.change('unsaved');
    if (action === '关闭编辑器') button(action).click();
    else
      [...document.querySelectorAll<HTMLButtonElement>('.editor-toolbar button')]
        .find((b) => b.textContent?.includes(action))!
        .click();
    await nextTick();
    const review = document.querySelector<HTMLDialogElement>('dialog[aria-label="未保存内容"]')!;
    expect(review.open).toBe(true);
    expect(filesApi.closeEditor).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    [...review.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('返回编辑'))!
      .click();
    await nextTick();
    expect(mock.model.getValue()).toBe('unsaved');
    expect(useFilesStore().document).not.toBeNull();
  },
);

it('reuses Monaco find and wrap actions and follows the application theme', async () => {
  await mount();
  button('查找文本').click();
  button('自动换行').click();
  await nextTick();
  expect(mock.find).toHaveBeenCalledOnce();
  expect(mock.editor.updateOptions).toHaveBeenCalledWith({ wordWrap: 'off' });
  expect(button('自动换行').getAttribute('aria-pressed')).toBe('false');
  document.documentElement.dataset.theme = 'light';
  await nextTick();
  expect(mock.defineTheme).toHaveBeenLastCalledWith(
    'serverdeck-editor',
    expect.objectContaining({ base: 'vs' }),
  );
});

it('closes a clean document and releases Monaco without dereferencing a closed document', async () => {
  await mount();
  button('关闭编辑器').click();
  await vi.waitFor(() => expect(useFilesStore().document).toBeNull());
  expect(filesApi.closeEditor).toHaveBeenCalledExactlyOnceWith('file', true);
  expect(mock.editor.dispose).toHaveBeenCalledOnce();
  expect(mock.model.dispose).toHaveBeenCalledOnce();
  expect(document.querySelector('dialog')).toBeNull();
});
