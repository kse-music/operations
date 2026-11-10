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
import { useNotificationsStore } from '../stores/notifications';
import { editorApi } from '../services/editor';

let app: App, pinia: Pinia, root: HTMLDivElement, currentDoc: TextDocument;
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
  currentDoc = { ...doc };
  vi.spyOn(editorApi, 'dirty').mockResolvedValue(undefined);
  vi.spyOn(editorApi, 'close').mockResolvedValue(undefined);
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
  document.documentElement.style.removeProperty('--panel');
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});
async function mount() {
  app = createApp({ render: () => h(RemoteEditor, { initialDocument: currentDoc }) }).use(pinia);
  app.mount(root);
  await nextTick();
}
function button(label: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
}
function saveButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('.editor-save')!;
}

it('fills an independent editor surface and shows actual cursor, line endings and dirty state', async () => {
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
  expect(editorApi.dirty).toHaveBeenCalledWith(true);
  expect(document.querySelector('.remote-editor-window')).not.toBeNull();
  expect(document.querySelector('dialog')).toBeNull();
  expect(mock.create).toHaveBeenCalledTimes(1);
  expect(mock.model.getValue()).toBe('one\r\ntwo\r\nthree');
});

it.each(['button', 'keyboard'])('saves atomically by default via %s', async (action) => {
  const save = vi.spyOn(editorApi, 'save').mockResolvedValue({
    document: { ...doc, content: 'changed' },
    recoveryPath: null,
    message: null,
  });
  await mount();
  mock.change('changed');
  await nextTick();
  expect(document.querySelector('.editor-save-policy')).toBeNull();
  expect(document.querySelector('.editor-save-details')).toBeNull();
  expect(saveButton().disabled).toBe(false);
  if (action === 'button') saveButton().click();
  else (mock.editor.addCommand.mock.calls[0]![1] as () => void)();
  await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith('changed'));
  await nextTick();
  expect(document.querySelector('.editor-statusbar')?.textContent).toContain('已与远程文件同步');
  expect(useNotificationsStore().items).toEqual([
    expect.objectContaining({ text: '远程文件已保存并校验。', error: false }),
  ]);
});

it('blocks repeated button and keyboard saves while a save is pending', async () => {
  let finish!: (result: Awaited<ReturnType<typeof editorApi.save>>) => void;
  const save = vi.spyOn(editorApi, 'save').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  mock.change('changed');
  saveButton().click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(saveButton().disabled).toBe(true);
  expect(mock.editor.updateOptions).toHaveBeenLastCalledWith({ readOnly: true });
  saveButton().click();
  (mock.editor.addCommand.mock.calls[0]![1] as () => void)();
  expect(save).toHaveBeenCalledExactlyOnceWith('changed');
  finish({ document: { ...doc, content: 'changed' }, recoveryPath: null, message: null });
  await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
  expect(document.querySelector('.editor-statusbar')?.textContent).toContain('已与远程文件同步');
});

it('keeps failed content editable and displays the actual save error', async () => {
  vi.spyOn(editorApi, 'save').mockRejectedValue({ message: '远端内容已变化' });
  await mount();
  mock.change('my draft');
  await nextTick();
  saveButton().click();
  await vi.waitFor(() =>
    expect(document.querySelector('.editor-feedback')?.textContent).toBe('远端内容已变化'),
  );
  expect(document.querySelector('.editor-statusbar')?.textContent).toContain('有未保存的修改');
  expect(mock.model.getValue()).toBe('my draft');
  expect(mock.editor.updateOptions).toHaveBeenLastCalledWith({ readOnly: false });
});

it('keeps unsupported atomic saves read only, including keyboard commands', async () => {
  currentDoc.atomicSave = false;
  const save = vi.spyOn(editorApi, 'save');
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
    const read = vi.spyOn(editorApi, 'reload');
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
    expect(editorApi.close).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    [...review.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('返回编辑'))!
      .click();
    await nextTick();
    expect(mock.model.getValue()).toBe('unsaved');
    expect(document.querySelector('.remote-editor-window')).not.toBeNull();
    expect(mock.editor.focus).toHaveBeenCalledTimes(2);
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

it('expands minified CSS colors before passing a light theme to Monaco', async () => {
  document.documentElement.dataset.theme = 'light';
  document.documentElement.style.setProperty('--panel', '#fff');
  await mount();
  expect(mock.defineTheme).toHaveBeenCalledWith(
    'serverdeck-editor',
    expect.objectContaining({
      base: 'vs',
      colors: expect.objectContaining({
        'editor.background': '#ffffff',
        'editorGutter.background': '#ffffff',
      }),
    }),
  );
});

it('requests a clean native close without authorizing draft discard', async () => {
  await mount();
  button('关闭编辑器').click();
  await vi.waitFor(() => expect(editorApi.close).toHaveBeenCalledExactlyOnceWith(false));
  app.unmount();
  app = undefined!;
  expect(mock.editor.dispose).toHaveBeenCalledOnce();
  expect(mock.model.dispose).toHaveBeenCalledOnce();
  expect(document.querySelector('dialog')).toBeNull();
});

function reviewButton(text: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((b) =>
    b.textContent?.includes(text),
  )!;
}

it('saves before closing a dirty native editor and leaves the draft open when saving fails', async () => {
  const save = vi.spyOn(editorApi, 'save').mockRejectedValueOnce({ message: '远端内容已变化' });
  await mount();
  mock.change('draft to protect');
  button('关闭编辑器').click();
  await nextTick();
  reviewButton('保存并关闭').click();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog')?.textContent).toContain('远端内容已变化'),
  );
  expect(editorApi.close).not.toHaveBeenCalled();
  expect(mock.model.getValue()).toBe('draft to protect');
  save.mockResolvedValueOnce({
    document: { ...doc, content: 'draft to protect' },
    recoveryPath: null,
    message: null,
  });
  reviewButton('保存并关闭').click();
  await vi.waitFor(() => expect(editorApi.close).toHaveBeenCalledExactlyOnceWith(false));
  expect(save).toHaveBeenCalledTimes(2);
});

it('closes a dirty editor only after explicit discard and keeps it open if close fails', async () => {
  vi.mocked(editorApi.close).mockRejectedValueOnce({ message: '关闭失败，请重试' });
  await mount();
  mock.change('unsaved');
  button('关闭编辑器').click();
  await nextTick();
  reviewButton('放弃修改并关闭').click();
  await vi.waitFor(() => expect(editorApi.close).toHaveBeenCalledExactlyOnceWith(true));
  expect(mock.model.getValue()).toBe('unsaved');
  await vi.waitFor(() =>
    expect(document.querySelector('.editor-feedback')?.textContent).toContain('关闭失败'),
  );
});

it('ignores close requests during a save and waits for dirty updates before saving', async () => {
  let markDirty!: () => void, finish!: (result: Awaited<ReturnType<typeof editorApi.save>>) => void;
  vi.mocked(editorApi.dirty).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        markDirty = resolve;
      }),
  );
  const save = vi.spyOn(editorApi, 'save').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  mock.change('pending');
  saveButton().click();
  await nextTick();
  expect(save).not.toHaveBeenCalled();
  button('关闭编辑器').click();
  expect(editorApi.close).not.toHaveBeenCalled();
  expect(document.querySelector('dialog')).toBeNull();
  markDirty();
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  finish({ document: { ...doc, content: 'pending' }, recoveryPath: null, message: null });
  await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
  button('关闭编辑器').click();
  await vi.waitFor(() => expect(editorApi.close).toHaveBeenCalledExactlyOnceWith(false));
});

it('reloads only the bound document after discard and preserves the draft when remote reading fails', async () => {
  const reload = vi.spyOn(editorApi, 'reload').mockRejectedValueOnce({ message: '连接已断开' });
  await mount();
  mock.change('local draft');
  const trigger = () =>
    [...document.querySelectorAll<HTMLButtonElement>('.editor-toolbar button')]
      .find((b) => b.textContent?.includes('重新加载'))!
      .click();
  trigger();
  await nextTick();
  reviewButton('放弃修改并重新加载').click();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledExactlyOnceWith(true));
  await vi.waitFor(() =>
    expect(document.querySelector('.editor-feedback')?.textContent).toContain('连接已断开'),
  );
  expect(mock.model.getValue()).toBe('local draft');
  reload.mockResolvedValueOnce({ ...doc, token: 'replacement', content: 'latest remote' });
  trigger();
  await nextTick();
  reviewButton('放弃修改并重新加载').click();
  await vi.waitFor(() => expect(mock.model.getValue()).toBe('latest remote'));
  expect(mock.create).toHaveBeenCalledOnce();
  expect(document.querySelector('.editor-statusbar')?.textContent).toContain('已与远程文件同步');
});

it('protects a dirty draft against browser unload while preserving the current model', async () => {
  await mount();
  const clean = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  mock.change('unsaved draft');
  const dirty = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
  expect(mock.model.getValue()).toBe('unsaved draft');
});
