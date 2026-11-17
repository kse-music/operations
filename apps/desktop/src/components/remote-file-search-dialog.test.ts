import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import RemoteFileSearchDialog from './RemoteFileSearchDialog.vue';
import type { FileSearchState } from '../types/files';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';

let app: App | undefined, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
function mount(state: Partial<FileSearchState> = {}) {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  const result: FileSearchState = {
    sessionId: 'session',
    requestId: '',
    path: '/root',
    query: 'test',
    recursive: false,
    includeHidden: false,
    status: 'completed',
    issues: [],
    scannedDirectories: 2,
    scannedEntries: 4,
    skippedDirectories: 0,
    currentPath: null,
    message: null,
    entries: [
      {
        parent: '/root/cert',
        entry: {
          name: 'test.pem',
          path: '/root/cert/test.pem',
          kind: 'file',
          size: 12,
          modified: null,
          permissions: null,
          uid: null,
          gid: null,
        },
      },
    ],
    ...state,
  };
  const locate = vi.fn(),
    search = vi.fn(),
    stop = vi.fn(),
    close = vi.fn(),
    change = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(RemoteFileSearchDialog, {
    state: result,
    locating: false,
    locateError: null,
    onLocate: locate,
    onSearch: search,
    onStop: stop,
    onClose: close,
    onChange: change,
  });
  app.mount(root);
  return { locate, search, stop, close, change, result };
}
afterEach(() => {
  app?.unmount();
  root?.remove();
  setLocale('zh-CN');
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});
it('locates by double-click and Enter without a bottom action bar', async () => {
  const { locate, result } = mount();
  await nextTick();
  const dialog = document.querySelector('dialog')!;
  expect(dialog.querySelector('footer')).toBeNull();
  expect(
    [...dialog.querySelectorAll('button')].map((button) => button.textContent?.trim()),
  ).not.toContain('定位文件');
  expect(dialog.textContent).not.toContain('双击结果可在目录中定位');
  expect(dialog.querySelector('mark')?.textContent).toBe('test');
  const button = dialog.querySelector<HTMLButtonElement>('.file-search-result-name')!;
  button.click();
  expect(locate).not.toHaveBeenCalled();
  button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  expect(locate).toHaveBeenCalledExactlyOnceWith(result.entries[0]);
  button.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  expect(locate).toHaveBeenCalledTimes(2);
});
it('submits explicitly, updates options and closes from the title bar or Esc', async () => {
  const { search, close, change } = mount({ status: 'idle', entries: [] });
  await nextTick();
  const dialog = document.querySelector('dialog')!;
  expect(dialog.querySelector<HTMLInputElement>('.file-search-options input')?.checked).toBe(false);
  const input = dialog.querySelector<HTMLInputElement>('#file-search-query')!;
  input.value = 'config';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(change).toHaveBeenCalledWith({ query: 'config' });
  expect(search).not.toHaveBeenCalled();
  dialog
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(search).toHaveBeenCalledOnce();
  dialog.querySelector<HTMLButtonElement>('.icon-button')!.click();
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(close).toHaveBeenCalledTimes(2);
});
it('explains wildcard input and highlights a complete wildcard match', async () => {
  mount({ query: '*.pem' });
  await nextTick();
  const dialog = document.querySelector('dialog')!;
  expect(dialog.querySelector<HTMLInputElement>('#file-search-query')?.placeholder).toContain(
    '*.sh',
  );
  expect(dialog.textContent).toContain('支持 *、? 通配符');
  expect(dialog.querySelector('mark')?.textContent).toBe('test.pem');
});
it('keeps stop and close available while scanning and marks partial or failed results', async () => {
  const { stop, close } = mount({
    status: 'running',
    skippedDirectories: 1,
    issues: [{ path: '/root/denied', message: '权限不足' }],
  });
  await nextTick();
  const dialog = document.querySelector('dialog')!;
  expect(dialog.querySelector<HTMLInputElement>('#file-search-query')!.disabled).toBe(true);
  dialog
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(stop).toHaveBeenCalledOnce();
  dialog.querySelector<HTMLButtonElement>('.icon-button')!.click();
  expect(close).toHaveBeenCalledOnce();
  expect(dialog.querySelector('details')?.textContent).toContain('结果不完整');
  expect(dialog.querySelector('details')?.textContent).toContain('/root/denied');
});
it('renders an English empty state and distinguishes failure from no matches', async () => {
  setLocale('en-US');
  mount({ status: 'failed', entries: [], message: 'remote failure' });
  await nextTick();
  const dialog = document.querySelector('dialog')!;
  expect(dialog.getAttribute('aria-label')).toBe('Search remote files');
  expect(dialog.textContent).toContain('Search failed');
  expect(dialog.textContent).not.toContain('No matching files');
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('remote failure');
});
