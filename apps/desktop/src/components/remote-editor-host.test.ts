import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia, disposePinia } from 'pinia';
import Host from './RemoteEditorHost.vue';
import { useFilesStore } from '../stores/files';
import { filesApi } from '../services/files';
import type { TextDocument } from '../types/files';
vi.mock('./RemoteEditor.vue', () => {
  throw new Error('fixture module load failure');
});
afterEach(() => vi.restoreAllMocks());
it('contains a failed editor import and releases the document for external editing without a global UI error', async () => {
  const pinia = createPinia(),
    files = useFilesStore(pinia);
  files.document = {
    token: 'document',
    sessionId: 'session',
    path: '/server.ini',
    atomicSave: true,
  } as TextDocument;
  const close = vi.spyOn(filesApi, 'closeEditor').mockResolvedValue(undefined);
  const modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp(Host).use(pinia),
    globalError = vi.fn();
  app.config.errorHandler = globalError;
  try {
    app.mount(root);
    await nextTick();
    await vi.waitFor(() => expect(files.openIssue?.message).toContain('内置编辑器加载失败'));
    expect(close).toHaveBeenCalledExactlyOnceWith('document', false);
    expect(files.document).toBeNull();
    expect(files.openIssue?.path).toBe('/server.ini');
    expect(globalError).not.toHaveBeenCalled();
  } finally {
    app.unmount();
    disposePinia(pinia);
    root.remove();
    if (modal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', modal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  }
});
