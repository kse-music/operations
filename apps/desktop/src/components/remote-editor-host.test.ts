import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia, disposePinia } from 'pinia';
import Host from './RemoteEditorHost.vue';
import { editorApi } from '../services/editor';
import type { TextDocument } from '../types/files';
vi.mock('./RemoteEditor.vue', () => {
  throw new Error('fixture module load failure');
});
afterEach(() => vi.restoreAllMocks());
it('contains a failed editor import and keeps a close action available without a global UI error', async () => {
  const pinia = createPinia();
  const doc = {
    token: 'document',
    sessionId: 'session',
    path: '/server.ini',
    atomicSave: true,
  } as TextDocument;
  const close = vi.spyOn(editorApi, 'close').mockResolvedValue(undefined);
  const modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp(Host, { document: doc }).use(pinia),
    globalError = vi.fn();
  app.config.errorHandler = globalError;
  try {
    app.mount(root);
    await nextTick();
    await vi.waitFor(() => expect(root.textContent).toContain('内置编辑器加载失败'));
    expect(close).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledExactlyOnceWith(false));
    expect(globalError).not.toHaveBeenCalled();
  } finally {
    app.unmount();
    disposePinia(pinia);
    root.remove();
    if (modal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', modal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  }
});
