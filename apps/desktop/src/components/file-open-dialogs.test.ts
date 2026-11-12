import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import FileOpenDialogs from './FileOpenDialogs.vue';
import { useFilesStore } from '../stores/files';
import { filesApi } from '../services/files';

let app: App, pinia: Pinia, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  pinia = createPinia();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(FileOpenDialogs).use(pinia);
  app.mount(root);
});
afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  root.remove();
  vi.restoreAllMocks();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});
it.each([
  ['\\\\?\\C:\\ServerDeck\\external-edits\\配置.ini', 'C:\\ServerDeck\\external-edits\\配置.ini'],
  ['\\\\?\\UNC\\server\\share\\配置.ini', '\\\\server\\share\\配置.ini'],
])('formats an external copy %s but opens the original path', async (localPath, expected) => {
  const store = useFilesStore(pinia);
  const remote = '/srv/\\\\?\\C:\\config.ini';
  store.externalDocument = {
    token: 'external',
    sessionId: 'session',
    path: remote,
    localPath,
    transferId: 'download',
    atomicSave: true,
    ready: true,
  };
  const open = vi.spyOn(filesApi, 'openLocal').mockResolvedValue(true);
  await nextTick();
  const dialog = document.querySelector('dialog[aria-label="外部编辑远程文件"]')!;
  expect(
    [...dialog.querySelectorAll('.file-open-path')].map((item) => item.textContent?.trim()),
  ).toEqual([`远程：${remote}`, `本地副本：${expected}`]);
  [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '选择应用打开…')!
    .click();
  expect(open).toHaveBeenCalledExactlyOnceWith(localPath);
  expect(store.externalDocument.localPath).toBe(localPath);
});
