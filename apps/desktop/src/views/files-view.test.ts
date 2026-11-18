import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import FilesView from './FilesView.vue';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';
import { useFilesStore } from '../stores/files';
import { useHostsStore } from '../stores/hosts';
import { useNotificationsStore } from '../stores/notifications';
import { useApplicationStore } from '../stores/application';
import { clipboardApi } from '../services/clipboard';
import { filesApi } from '../services/files';
import { hostInput } from '../types/hosts';
import { defaultProductPreferences } from '../types/product';
import type { Bootstrap } from '../types/ipc';
import type { DirectoryListing, FileEntry, FileUserSession, TransferInfo } from '../types/files';

const release = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => release) }),
}));
let app: App | undefined, pinia: Pinia, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalPopover = ['showPopover', 'hidePopover'].map(
  (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
);
const entry: FileEntry = {
  name: 'config',
  path: '/srv/api/config',
  kind: 'directory',
  size: null,
  modified: null,
  permissions: 0o755,
  uid: 1000,
  gid: 1000,
};
async function mountView() {
  app = createApp(FilesView, { hostId: 'a' }).use(pinia);
  app.mount(root);
  await nextTick();
}
beforeEach(async () => {
  for (const [name] of originalPopover)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value() {} });
  pinia = createPinia();
  const host = {
    ...hostInput(),
    id: 'a',
    name: 'API',
    hostname: '192.0.2.11',
    username: 'operator',
    createdAt: '',
    updatedAt: '',
  };
  const hosts = useHostsStore(pinia),
    files = useFilesStore(pinia);
  hosts.catalog = { hosts: [host], groups: [], credentials: [], pendingSecretDeletions: 0 };
  files.active = 'a';
  files.local = { path: 'D:/test', parent: null, entries: [] };
  files.connections.a = {
    host,
    id: 'sftp-a',
    state: 'connected',
    error: null,
    trust: null,
    path: '/srv/api',
    listing: { path: '/srv/api', parent: '/srv', entries: [entry] },
    loading: false,
  };
  root = document.createElement('div');
  document.body.append(root);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  vi.spyOn(filesApi, 'localDrives').mockResolvedValue([
    { path: 'C:\\', name: 'C: 本地磁盘' },
    { path: 'D:\\', name: 'D: 本地磁盘' },
  ]);
  await mountView();
});
afterEach(() => {
  setLocale('zh-CN');
  app?.unmount();
  disposePinia(pinia);
  root.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of originalPopover) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});

const drivePicker = () => root.querySelector<HTMLButtonElement>('[aria-label="选择本地磁盘"]')!;
async function newFile() {
  root.querySelector<HTMLButtonElement>('[aria-label="新建文件"]')!.click();
  await nextTick();
  return document.querySelector<HTMLDialogElement>('.new-file-dialog')!;
}
it('offers new file beside new folder and opens its created document directly in the built-in editor', async () => {
  const files = useFilesStore(pinia);
  const button = root.querySelector<HTMLButtonElement>('[aria-label="新建文件"]')!;
  expect(button.previousElementSibling?.getAttribute('aria-label')).toBe('新建文件夹');
  expect(button.textContent?.trim()).toBe('');
  const document = { token: 'created', sessionId: 'sftp-a', path: '/srv/api/中文 ;$config.ini' };
  const create = vi.spyOn(filesApi, 'createEditor').mockResolvedValue(document);
  const existing = vi.spyOn(filesApi, 'openEditor');
  const listing = vi.spyOn(filesApi, 'list').mockResolvedValue(files.current!.listing!);
  const dialog = await newFile();
  await nameFolder(dialog, '中文 ;$config.ini');
  createFolder(dialog);
  await vi.waitFor(() => expect(window.document.querySelector('.new-file-dialog')).toBeNull());
  expect(create).toHaveBeenCalledExactlyOnceWith('sftp-a', document.path, 'operator@192.0.2.11');
  expect(existing).not.toHaveBeenCalled();
  expect(files.document).toEqual(document);
  expect(listing).toHaveBeenCalledWith('sftp-a', '/srv/api');
});
it('retains the file name and error when creation fails and refreshes the original directory', async () => {
  const files = useFilesStore(pinia);
  vi.spyOn(filesApi, 'createEditor').mockRejectedValue({
    message: '同名文件、目录或链接已存在，请使用其他文件名',
  });
  const listing = vi.spyOn(filesApi, 'list').mockResolvedValue(files.current!.listing!);
  const dialog = await newFile();
  await nameFolder(dialog, 'existing.txt');
  createFolder(dialog);
  await vi.waitFor(() =>
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('同名'),
  );
  expect(dialog.querySelector<HTMLInputElement>('input[autofocus]')!.value).toBe('existing.txt');
  expect(files.openIssue).toBeNull();
  expect(listing).toHaveBeenCalledWith('sftp-a', '/srv/api');
});
it('blocks duplicate creation and avoids refreshing a replacement SFTP identity', async () => {
  const files = useFilesStore(pinia);
  let complete!: (value: { token: string; sessionId: string; path: string }) => void;
  const create = vi.spyOn(filesApi, 'createEditor').mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const listing = vi.spyOn(filesApi, 'list');
  const dialog = await newFile();
  await nameFolder(dialog, 'pending.txt');
  createFolder(dialog);
  createFolder(dialog);
  await nextTick();
  expect(create).toHaveBeenCalledTimes(1);
  expect(dialog.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  files.current!.id = 'new-identity';
  complete({ token: 'pending', sessionId: 'sftp-a', path: '/srv/api/pending.txt' });
  await vi.waitFor(() => expect(document.querySelector('.new-file-dialog')).toBeNull());
  expect(listing).not.toHaveBeenCalled();
});
it('cancels an unsubmitted file name when the remote directory changes', async () => {
  const files = useFilesStore(pinia);
  const create = vi.spyOn(filesApi, 'createEditor');
  const dialog = await newFile();
  await nameFolder(dialog, 'unsubmitted.txt');
  files.current!.path = '/different';
  await nextTick();
  expect(document.querySelector('.new-file-dialog')).toBeNull();
  expect(create).not.toHaveBeenCalled();
});
const newFolder = async () => {
  root.querySelector<HTMLButtonElement>('[aria-label="新建文件夹"]')!.click();
  await nextTick();
  return document.querySelector<HTMLDialogElement>('.new-directory-dialog')!;
};
async function nameFolder(dialog: HTMLDialogElement, name: string) {
  const input = dialog.querySelector<HTMLInputElement>('input[autofocus]')!;
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}
function createFolder(dialog: HTMLDialogElement) {
  dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}
it('creates a remote directory with the selected mode and remembers it only for the original session', async () => {
  const files = useFilesStore(pinia);
  const action = vi.spyOn(filesApi, 'action').mockResolvedValue(undefined);
  vi.spyOn(filesApi, 'list').mockResolvedValue(files.current!.listing!);
  const dialog = await newFolder();
  await nameFolder(dialog, '中文 ;$folder');
  dialog.querySelector<HTMLInputElement>('.directory-attributes > .checkbox-label input')!.click();
  const mode = dialog.querySelector<HTMLInputElement>('.directory-mode input')!;
  mode.value = '2770';
  mode.dispatchEvent(new Event('input', { bubbles: true }));
  dialog.querySelector<HTMLInputElement>('.directory-remember input')!.click();
  await nextTick();
  createFolder(dialog);
  await vi.waitFor(() => expect(document.querySelector('.new-directory-dialog')).toBeNull());
  expect(action).toHaveBeenCalledExactlyOnceWith('sftp-a', {
    kind: 'mkdir',
    path: '/srv/api/中文 ;$folder',
    permissions: 0o2770,
  });
  const reopened = await newFolder();
  expect(reopened.querySelector<HTMLInputElement>('.directory-mode input')!.value).toBe('2770');
  expect(reopened.querySelector<HTMLInputElement>('.directory-remember input')!.checked).toBe(true);
  files.current!.id = 'another-identity';
  await nextTick();
  expect(document.querySelector('.new-directory-dialog')).toBeNull();
  const next = await newFolder();
  expect(next.querySelector<HTMLInputElement>('.directory-mode input')!.value).toBe('0755');
  expect(
    next.querySelector<HTMLInputElement>('.directory-attributes > .checkbox-label input')!.checked,
  ).toBe(false);
  expect(next.querySelector<HTMLInputElement>('.directory-remember input')!.checked).toBe(false);
});
it('uses default permissions and clears remembered options after a successful creation without remembering', async () => {
  const files = useFilesStore(pinia);
  files.current!.newDirectorySettings = { sessionId: 'sftp-a', permissions: 0o700 };
  const action = vi.spyOn(filesApi, 'action').mockResolvedValue(undefined);
  vi.spyOn(filesApi, 'list').mockResolvedValue(files.current!.listing!);
  const dialog = await newFolder();
  await nameFolder(dialog, 'default');
  dialog.querySelector<HTMLInputElement>('.directory-attributes > .checkbox-label input')!.click();
  dialog.querySelector<HTMLInputElement>('.directory-remember input')!.click();
  await nextTick();
  createFolder(dialog);
  await vi.waitFor(() => expect(document.querySelector('.new-directory-dialog')).toBeNull());
  expect(action).toHaveBeenCalledExactlyOnceWith('sftp-a', {
    kind: 'mkdir',
    path: '/srv/api/default',
    permissions: null,
  });
  expect(files.current!.newDirectorySettings).toBeUndefined();
});
it('retains a failed creation draft and remembered settings, then blocks duplicate retries until completion', async () => {
  const files = useFilesStore(pinia);
  files.current!.newDirectorySettings = { sessionId: 'sftp-a', permissions: 0o700 };
  let complete!: () => void;
  const action = vi
    .spyOn(filesApi, 'action')
    .mockRejectedValueOnce(new Error('权限不足'))
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
  vi.spyOn(filesApi, 'list').mockResolvedValue(files.current!.listing!);
  const dialog = await newFolder();
  await nameFolder(dialog, 'retry');
  dialog.querySelector<HTMLInputElement>('.directory-remember input')!.click();
  await nextTick();
  createFolder(dialog);
  await vi.waitFor(() =>
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('权限不足'),
  );
  expect(dialog.querySelector<HTMLInputElement>('input[autofocus]')!.value).toBe('retry');
  expect(dialog.querySelector<HTMLInputElement>('.directory-mode input')!.value).toBe('0700');
  expect(files.current!.newDirectorySettings?.permissions).toBe(0o700);
  createFolder(dialog);
  createFolder(dialog);
  await nextTick();
  expect(action).toHaveBeenCalledTimes(2);
  expect(dialog.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(dialog.isConnected).toBe(true);
  complete();
  await vi.waitFor(() => expect(document.querySelector('.new-directory-dialog')).toBeNull());
});
it('cancels a creation draft when its parent directory changes without submitting', async () => {
  const files = useFilesStore(pinia);
  const action = vi.spyOn(filesApi, 'action');
  const dialog = await newFolder();
  await nameFolder(dialog, 'unsubmitted');
  files.current!.path = '/other';
  await nextTick();
  expect(document.querySelector('.new-directory-dialog')).toBeNull();
  expect(action).not.toHaveBeenCalled();
});
it('places an accessible icon-only search button beside hidden items and defaults to the current directory', async () => {
  const button = root.querySelector<HTMLButtonElement>('.file-search-open')!;
  expect(button.classList.contains('tool-button')).toBe(true);
  expect(button.textContent?.trim()).toBe('');
  expect(button.getAttribute('aria-label')).toBe('搜索远程文件');
  expect(button.title).toBe('搜索远程文件');
  expect(button.previousElementSibling?.getAttribute('aria-label')).toBe('显示隐藏项');
  button.click();
  await nextTick();
  expect(document.querySelector<HTMLInputElement>('.file-search-options input')?.checked).toBe(
    false,
  );
});
it('searches in a dialog and double-clicks a result to reveal its page without opening the file', async () => {
  const files = useFilesStore(pinia);
  const state = files.ensureSearch()!;
  const target: FileEntry = {
    ...entry,
    kind: 'file',
    name: 'z-config.txt',
    path: '/srv/api/z-config.txt',
    size: 12,
  };
  state.query = 'config';
  state.status = 'completed';
  state.entries = [{ entry: target, parent: '/srv/api' }];
  const rows = Array.from({ length: 240 }, (_, index) => ({
    ...target,
    name: `a-${index}`,
    path: `/srv/api/a-${index}`,
  }));
  vi.spyOn(filesApi, 'list').mockResolvedValue({
    path: '/srv/api',
    parent: '/srv',
    entries: [...rows, target],
  });
  const editor = vi.spyOn(filesApi, 'openEditor');
  root.querySelector<HTMLButtonElement>('.file-search-open')!.click();
  await nextTick();
  const dialog = document.querySelector<HTMLDialogElement>('.file-search-dialog')!;
  expect(dialog.querySelector('footer')).toBeNull();
  dialog
    .querySelector('.file-search-result-name')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await vi.waitFor(() => {
    expect(document.querySelector('.file-search-dialog')).toBeNull();
    expect((document.activeElement as HTMLElement)?.dataset.path).toBe(target.path);
  });
  expect(editor).not.toHaveBeenCalled();
  expect(
    root
      .querySelector('.file-name[data-path="/srv/api/z-config.txt"]')
      ?.closest('tr')
      ?.classList.contains('selected'),
  ).toBe(true);
  root.querySelector<HTMLButtonElement>('.file-search-open')!.click();
  await nextTick();
  expect(document.querySelector<HTMLInputElement>('#file-search-query')?.value).toBe('config');
  expect(document.querySelector('[aria-label="搜索结果"]')?.textContent).toContain('z-config.txt');
});
it('keeps the search dialog open when a result was removed before locating', async () => {
  const files = useFilesStore(pinia);
  const state = files.ensureSearch()!;
  state.query = 'config';
  state.status = 'completed';
  state.entries = [{ entry, parent: '/srv/api' }];
  vi.spyOn(filesApi, 'list').mockResolvedValue({ path: '/srv/api', parent: '/srv', entries: [] });
  root.querySelector<HTMLButtonElement>('.file-search-open')!.click();
  await nextTick();
  document
    .querySelector('.file-search-result-name')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('.file-search-dialog')?.textContent).toContain(
      '文件已移动或删除',
    ),
  );
});
const remoteTable = () => root.querySelector<HTMLElement>('[aria-label="远程文件"]')!;
const renameTable = (side: 'local' | 'remote') =>
  root.querySelector<HTMLElement>(`[aria-label="${side === 'local' ? '本地' : '远程'}文件"]`)!;
const renameInput = (side: 'local' | 'remote' = 'remote') =>
  renameTable(side).querySelector<HTMLInputElement>('.file-rename-input');
function renameKey(input: Element, key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  input.dispatchEvent(event);
  return event;
}
function changeRename(value: string, side: 'local' | 'remote' = 'remote') {
  const input = renameInput(side)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function beginRename(
  name: string,
  trigger: 'F2' | 'menu' = 'F2',
  side: 'local' | 'remote' = 'remote',
) {
  const button = [...renameTable(side).querySelectorAll<HTMLButtonElement>('.file-name')].find(
    (item) => item.title === name,
  )!;
  button.click();
  await nextTick();
  if (trigger === 'F2') renameKey(button, 'F2');
  else {
    button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await nextTick();
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === '重命名')!
      .click();
  }
  await vi.waitFor(() => expect(document.activeElement).toBe(renameInput(side)));
  return renameInput(side)!;
}

it.each([
  { name: 'config.json', kind: 'file' as const, end: 6, trigger: 'F2' as const },
  { name: 'folder.with.dots', kind: 'directory' as const, end: 16, trigger: 'F2' as const },
  { name: 'README', kind: 'file' as const, end: 6, trigger: 'menu' as const },
  { name: 'archive.tar.gz', kind: 'file' as const, end: 11, trigger: 'F2' as const },
  { name: '.env', kind: 'file' as const, end: 4, trigger: 'F2' as const },
  { name: 'trailing.', kind: 'file' as const, end: 9, trigger: 'F2' as const },
])(
  'edits $name inline via $trigger and selects the expected name segment',
  async ({ name, kind, end, trigger }) => {
    const files = useFilesStore(pinia);
    files.current!.listing!.entries = [{ ...entry, name, kind, path: `/srv/api/${name}` }];
    const action = vi.spyOn(filesApi, 'action').mockResolvedValue();
    await nextTick();
    if (name.startsWith('.')) {
      root.querySelector<HTMLButtonElement>('[aria-label="显示隐藏项"]')!.click();
      await nextTick();
    }
    const input = await beginRename(name, trigger);
    expect(document.querySelector('dialog')).toBeNull();
    expect(input.closest('tr')).not.toBeNull();
    expect(input.value).toBe(name);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(end);
    expect(action).not.toHaveBeenCalled();
  },
);

it.each(['Escape', 'unchanged'] as const)(
  'cancels inline renaming with %s without a remote request',
  async (trigger) => {
    const action = vi.spyOn(filesApi, 'action').mockResolvedValue();
    const input = await beginRename('config');
    if (trigger === 'unchanged') renameKey(input, 'Enter');
    else {
      changeRename('draft');
      renameKey(input, 'Escape');
    }
    await nextTick();
    expect(renameInput()).toBeNull();
    expect(remoteTable().querySelector('.file-name')?.textContent).toContain('config');
    expect(action).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(remoteTable().querySelector('.file-name'));
  },
);

it('commits once on Enter, retains focus while saving, then selects and focuses the renamed row', async () => {
  const files = useFilesStore(pinia);
  let finish!: () => void;
  const action = vi.spyOn(filesApi, 'action').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = vi.spyOn(files, 'refresh').mockResolvedValue();
  const list = vi.spyOn(filesApi, 'list').mockResolvedValue({
    path: '/srv/api',
    parent: '/srv',
    entries: [{ ...entry, name: 'renamed', path: '/srv/api/renamed' }],
  });
  const local = vi
    .spyOn(filesApi, 'local')
    .mockResolvedValue({ path: 'D:/test', parent: null, entries: [] });
  const input = await beginRename('config');
  changeRename('renamed');
  renameKey(input, 'Enter');
  renameKey(input, 'Enter');
  renameKey(input, 'Escape');
  await nextTick();
  expect(action).toHaveBeenCalledExactlyOnceWith('sftp-a', {
    kind: 'rename',
    path: '/srv/api/config',
    destination: '/srv/api/renamed',
  });
  expect(renameInput()).toBe(input);
  expect(input.readOnly).toBe(true);
  expect(document.activeElement).toBe(input);
  finish();
  await vi.waitFor(() => expect(renameInput()).toBeNull());
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(remoteTable().querySelector('.file-name')),
  );
  expect(remoteTable().querySelector<HTMLInputElement>('tbody input')!.checked).toBe(true);
  expect(remoteTable().querySelector('.file-name')?.textContent).toContain('renamed');
  expect(list).toHaveBeenCalledExactlyOnceWith('sftp-a', '/srv/api');
  expect(local).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it('keeps a failed rename editable with its error and allows a corrected retry', async () => {
  const files = useFilesStore(pinia);
  const action = vi
    .spyOn(filesApi, 'action')
    .mockRejectedValueOnce({ message: '目标已存在，不能覆盖' })
    .mockResolvedValue();
  vi.spyOn(files, 'navigate').mockResolvedValue();
  const input = await beginRename('config', 'menu');
  changeRename('existing');
  renameKey(input, 'Enter');
  await vi.waitFor(() =>
    expect(remoteTable().querySelector('[role="alert"]')?.textContent).toBe('目标已存在，不能覆盖'),
  );
  expect(renameInput()).toBe(input);
  expect(input.readOnly).toBe(false);
  expect(input.value).toBe('existing');
  changeRename('different');
  await nextTick();
  expect(remoteTable().querySelector('[role="alert"]')).toBeNull();
  renameKey(input, 'Enter');
  await vi.waitFor(() => expect(renameInput()).toBeNull());
  expect(action).toHaveBeenLastCalledWith('sftp-a', {
    kind: 'rename',
    path: '/srv/api/config',
    destination: '/srv/api/different',
  });
});

it.each(['', '..', 'sub/name'])(
  'rejects invalid inline names (%s) before calling the backend',
  async (name) => {
    const action = vi.spyOn(filesApi, 'action').mockResolvedValue();
    const input = await beginRename('config');
    changeRename(name);
    renameKey(input, 'Enter');
    await nextTick();
    expect(renameInput()).toBe(input);
    expect(action).not.toHaveBeenCalled();
    if (name)
      expect(remoteTable().querySelector('[role="alert"]')?.textContent).toContain('名称不能包含');
  },
);

it('leaves IME Enter, repeated Enter, Delete and double-clicks inside the rename editor', async () => {
  const files = useFilesStore(pinia);
  const action = vi.spyOn(filesApi, 'action').mockResolvedValue();
  const navigate = vi.spyOn(files, 'navigate').mockResolvedValue();
  const input = await beginRename('config');
  changeRename('draft');
  renameKey(input, 'Enter', { isComposing: true });
  renameKey(input, 'Enter', { keyCode: 229 });
  renameKey(input, 'Enter', { repeat: true });
  renameKey(input, 'Delete');
  input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await nextTick();
  expect(renameInput()).toBe(input);
  expect(action).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(document.querySelector('dialog')).toBeNull();
});

it.each([
  'host',
  'session',
  'directory',
  'disconnect',
  'loading',
  'switching',
  'closing',
  'removed',
] as const)('cancels an unsubmitted rename when its %s changes', async (change) => {
  const files = useFilesStore(pinia);
  const action = vi.spyOn(filesApi, 'action').mockResolvedValue();
  const input = await beginRename('config');
  changeRename('draft');
  if (change === 'host') files.active = 'other';
  if (change === 'session') files.current!.id = 'replacement';
  if (change === 'directory') files.current!.path = '/other';
  if (change === 'disconnect') files.current!.state = 'disconnected';
  if (change === 'loading') files.current!.loading = true;
  if (change === 'switching') files.current!.switchingUser = true;
  if (change === 'closing') files.closingHosts.push('a');
  if (change === 'removed') files.current!.listing!.entries = [];
  await nextTick();
  expect(renameInput()).toBeNull();
  renameKey(input, 'Enter');
  expect(action).not.toHaveBeenCalled();
});

it('keeps an in-flight rename and its refresh bound to the original host', async () => {
  const files = useFilesStore(pinia);
  const original = files.connections.a!;
  let finish!: () => void;
  const action = vi.spyOn(filesApi, 'action').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = vi.spyOn(files, 'refresh').mockResolvedValue();
  const navigate = vi.spyOn(files, 'navigate').mockResolvedValue();
  const input = await beginRename('config');
  changeRename('renamed');
  renameKey(input, 'Enter');
  files.connections.b = { ...original, host: { ...original.host, id: 'b' }, id: 'sftp-b' };
  files.active = 'b';
  await nextTick();
  finish();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/srv/api', original));
  expect(action).toHaveBeenCalledExactlyOnceWith('sftp-a', {
    kind: 'rename',
    path: '/srv/api/config',
    destination: '/srv/api/renamed',
  });
  expect(refresh).not.toHaveBeenCalled();
  expect(files.current!.id).toBe('sftp-b');
});

it.each(['directory', 'session'] as const)(
  'does not disturb a new %s after a rename was submitted',
  async (change) => {
    const files = useFilesStore(pinia);
    let finish!: () => void;
    const action = vi.spyOn(filesApi, 'action').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = vi.spyOn(files, 'refresh').mockResolvedValue();
    const navigate = vi.spyOn(files, 'navigate').mockResolvedValue();
    const input = await beginRename('config');
    changeRename('renamed');
    renameKey(input, 'Enter');
    if (change === 'directory') {
      files.current!.path = '/other';
      files.current!.listing = {
        path: '/other',
        parent: '/',
        entries: [{ ...entry, path: '/other/config' }],
      };
    } else files.current!.id = 'sftp-replacement';
    await nextTick();
    const checkbox = remoteTable().querySelector<HTMLInputElement>('tbody input')!;
    if (!checkbox.checked) checkbox.click();
    await nextTick();
    expect(checkbox.checked).toBe(true);
    finish();
    await vi.waitFor(() => expect(action).toHaveResolved());
    await nextTick();
    expect(checkbox.checked).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledExactlyOnceWith('sftp-a', {
      kind: 'rename',
      path: '/srv/api/config',
      destination: '/srv/api/renamed',
    });
  },
);

it('cancels the draft when a hidden target is removed from the visible list', async () => {
  const files = useFilesStore(pinia);
  files.current!.listing!.entries = [{ ...entry, name: '.config', path: '/srv/api/.config' }];
  const action = vi.spyOn(filesApi, 'action').mockResolvedValue();
  root.querySelector<HTMLButtonElement>('[aria-label="显示隐藏项"]')!.click();
  await nextTick();
  await beginRename('.config');
  changeRename('draft');
  root.querySelector<HTMLButtonElement>('[aria-label="显示隐藏项"]')!.click();
  await nextTick();
  expect(renameInput()).toBeNull();
  expect(action).not.toHaveBeenCalled();
});

it('cancels the draft when paging away from its row', async () => {
  const files = useFilesStore(pinia);
  files.current!.listing!.entries = [
    entry,
    ...Array.from({ length: 200 }, (_, index) => ({
      ...entry,
      name: `z-${index}`,
      path: `/srv/api/z-${index}`,
      kind: 'file' as const,
    })),
  ];
  const action = vi.spyOn(filesApi, 'action').mockResolvedValue();
  await nextTick();
  await beginRename('config');
  changeRename('draft');
  remoteTable()
    .closest('.file-side')!
    .querySelector<HTMLButtonElement>('.file-pagination button:last-child')!
    .click();
  await nextTick();
  expect(renameInput()).toBeNull();
  expect(remoteTable().querySelectorAll('tbody tr')).toHaveLength(1);
  expect(action).not.toHaveBeenCalled();
});
it.each([
  { side: 'local' as const, kind: 'file' as const, trigger: 'F2' as const, save: 'blur' },
  { side: 'local' as const, kind: 'directory' as const, trigger: 'menu' as const, save: 'Enter' },
  { side: 'remote' as const, kind: 'file' as const, trigger: 'F2' as const, save: 'blur' },
  { side: 'remote' as const, kind: 'directory' as const, trigger: 'menu' as const, save: 'blur' },
])(
  'renames a $side $kind using $trigger and $save without refreshing the other pane',
  async ({ side, kind, trigger, save }) => {
    const files = useFilesStore(pinia);
    const parent = side === 'local' ? 'D:/test' : '/srv/api';
    const name = 'config.json';
    const source = { ...entry, kind, name, path: `${parent}/${name}` };
    const changed = { ...source, name: 'new.json', path: `${parent}/new.json` };
    if (side === 'local') {
      files.local!.entries = [source];
      files.current!.state = 'disconnected';
    } else files.current!.listing!.entries = [source];
    const remote = vi.spyOn(filesApi, 'action').mockResolvedValue();
    const native = vi.spyOn(filesApi, 'localRename').mockResolvedValue(changed.path);
    const localRead = vi
      .spyOn(filesApi, 'local')
      .mockResolvedValue({ path: parent, parent: null, entries: [changed] });
    const remoteRead = vi
      .spyOn(filesApi, 'list')
      .mockResolvedValue({ path: parent, parent: '/srv', entries: [changed] });
    const both = vi.spyOn(files, 'refresh').mockResolvedValue();
    await nextTick();
    const input = await beginRename(name, trigger, side);
    expect([input.selectionStart, input.selectionEnd]).toEqual([
      0,
      kind === 'file' ? 6 : name.length,
    ]);
    changeRename(changed.name, side);
    const outside = root.querySelector<HTMLInputElement>(
      `[aria-label="${side === 'local' ? '本地路径' : '远程路径'}"]`,
    )!;
    if (save === 'blur') outside.focus();
    else {
      renameKey(input, 'Enter');
      input.blur();
    }
    await vi.waitFor(() =>
      expect(renameTable(side).querySelector('.file-name')?.textContent).toContain(changed.name),
    );
    expect(renameInput(side)).toBeNull();
    expect(document.querySelector('dialog')).toBeNull();
    if (side === 'local') {
      expect(native).toHaveBeenCalledExactlyOnceWith({
        parent,
        path: source.path,
        name: changed.name,
      });
      expect(localRead).toHaveBeenCalledExactlyOnceWith(parent);
      expect(remote).not.toHaveBeenCalled();
      expect(remoteRead).not.toHaveBeenCalled();
    } else {
      expect(remote).toHaveBeenCalledExactlyOnceWith('sftp-a', {
        kind: 'rename',
        path: source.path,
        destination: changed.path,
      });
      expect(remoteRead).toHaveBeenCalledExactlyOnceWith('sftp-a', parent);
      expect(native).not.toHaveBeenCalled();
      expect(localRead).not.toHaveBeenCalled();
    }
    expect(both).not.toHaveBeenCalled();
    if (save === 'blur') expect(document.activeElement).toBe(outside);
  },
);

it('keeps the row selected and focused by the user during a blur save', async () => {
  const files = useFilesStore(pinia);
  const other = { ...entry, name: 'other', path: '/srv/api/other' };
  files.current!.listing!.entries = [entry, other];
  const action = vi.spyOn(filesApi, 'action').mockResolvedValue();
  vi.spyOn(filesApi, 'list').mockResolvedValue({
    path: '/srv/api',
    parent: '/srv',
    entries: [{ ...entry, name: 'renamed', path: '/srv/api/renamed' }, other],
  });
  await nextTick();
  await beginRename('config');
  changeRename('renamed');
  const otherButton = [...remoteTable().querySelectorAll<HTMLButtonElement>('.file-name')].find(
    (button) => button.title === 'other',
  )!;
  otherButton.click();
  await vi.waitFor(() => expect(renameInput()).toBeNull());
  await vi.waitFor(() => expect(remoteTable().textContent).toContain('renamed'));
  expect(action).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(otherButton);
  expect(remoteTable().querySelector<HTMLInputElement>('[aria-label="选择 other"]')!.checked).toBe(
    true,
  );
  expect(
    remoteTable().querySelector<HTMLInputElement>('[aria-label="选择 renamed"]')!.checked,
  ).toBe(false);
});

it('binds the remote copy dialog to the selected paths and closes it when identity changes', async () => {
  const files = useFilesStore(pinia);
  files.current!.listing!.entries = [entry, { ...entry, name: 'second', path: '/srv/api/second' }];
  const start = vi.spyOn(filesApi, 'remoteCopy').mockRejectedValue({ message: '测试提交失败' });
  await nextTick();
  for (const checkbox of root.querySelectorAll<HTMLInputElement>(
    '[aria-label="远程文件"] tbody input[type="checkbox"]',
  )) {
    checkbox.click();
    await nextTick();
  }
  root
    .querySelector('[aria-label="远程文件"] tbody tr')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.trim() === '远程复制')!
    .click();
  await nextTick();
  const dialog = document.querySelector<HTMLDialogElement>('dialog:has(.remote-copy)')!;
  const target = dialog.querySelector('select')!;
  target.value = 'a';
  target.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  expect(dialog.textContent).toContain('2 个选中项目');
  expect(dialog.querySelector('pre')?.textContent).toBe('/srv/api/config\n/srv/api/second');
  expect(start).not.toHaveBeenCalled();
  vi.spyOn(filesApi, 'list').mockResolvedValue({
    path: '/',
    parent: null,
    entries: [{ ...entry, name: 'target', path: '/target' }],
  });
  dialog.querySelector<HTMLButtonElement>('.remote-directory-select')!.click();
  await vi.waitFor(() => expect(dialog.querySelector('[data-path="/target"]')).not.toBeNull());
  dialog.querySelector<HTMLButtonElement>('[data-path="/target"] .directory-entry')!.click();
  await nextTick();
  dialog
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sftp-a',
        sources: ['/srv/api/config', '/srv/api/second'],
        destination: '/target',
        name: null,
        confirmed: true,
      }),
    ),
  );
  files.current!.id = 'replacement';
  await nextTick();
  expect(document.querySelector('.remote-copy')).toBeNull();
});

it.each(['local', 'remote'] as const)(
  'keeps a failed %s blur save editable and cancels with Esc',
  async (side) => {
    const files = useFilesStore(pinia);
    if (side === 'local') files.local!.entries = [{ ...entry, path: 'D:/test/config' }];
    const backend =
      side === 'local'
        ? vi.spyOn(filesApi, 'localRename').mockRejectedValue({ message: '目标已存在，未覆盖' })
        : vi.spyOn(filesApi, 'action').mockRejectedValue({ message: '目标已存在，未覆盖' });
    await nextTick();
    const input = await beginRename('config', 'F2', side);
    changeRename('existing', side);
    input.blur();
    await vi.waitFor(() =>
      expect(renameTable(side).querySelector('[role="alert"]')?.textContent).toBe(
        '目标已存在，未覆盖',
      ),
    );
    expect(renameInput(side)).toBe(input);
    expect(input.value).toBe('existing');
    expect(input.readOnly).toBe(false);
    input.focus();
    renameKey(input, 'Escape');
    await nextTick();
    expect(renameInput(side)).toBeNull();
    expect(backend).toHaveBeenCalledTimes(1);
  },
);

const progressTask = (id: string, hostId = 'a'): TransferInfo => ({
  id,
  hostId,
  sessionId: `sftp-${hostId}`,
  direction: 'upload',
  state: 'running',
  sources: ['D:/test/image.iso'],
  destination: '/root',
  totalBytes: 1000,
  transferredBytes: 140,
  remainingBytes: 860,
  bytesPerSecond: 10,
  elapsedSeconds: 14,
  dragExport: false,
  filesTotal: 1,
  filesDone: 0,
  skipped: 0,
  message: null,
  recoveryPaths: [],
});
const progressDialog = () => document.querySelector<HTMLDialogElement>('.file-transfer-dialog');

it('opens a background upload once when an incompatible checkpoint requires a restart decision', async () => {
  const files = useFilesStore(pinia);
  const upload = progressTask('upload');
  const hide = async () => {
    Array.from(progressDialog()!.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === '后台传输')!
      .click();
    await nextTick();
    expect(progressDialog()).toBeNull();
  };
  files.tasks = [upload];
  await nextTick();
  await hide();
  files.tasks = [{ ...upload, state: 'verifying', resumedBytes: 1024 }];
  await nextTick();
  expect(progressDialog()).toBeNull();
  const prompt = {
    token: 'decision',
    target: '/archive.iso',
    partialBytes: 2048,
  };
  files.tasks = [{ ...upload, state: 'awaitingRestart', restartPrompt: prompt }];
  await nextTick();
  expect(progressDialog()?.textContent).toContain('从头上传');
  await hide();
  files.tasks = [{ ...upload, state: 'awaitingRestart', restartPrompt: { ...prompt } }];
  await nextTick();
  expect(progressDialog()).toBeNull();
  files.tasks = [upload];
  await nextTick();
  expect(progressDialog()).toBeNull();
});
it('keeps background transfers running and makes the close button cancel until cleanup finishes', async () => {
  const files = useFilesStore(pinia);
  const cancel = vi.spyOn(filesApi, 'cancel').mockResolvedValue();
  vi.spyOn(files, 'poll').mockImplementation(async () => {
    files.tasks = files.tasks.map((task) => ({ ...task, state: 'cancelling' }));
  });
  files.tasks = [progressTask('upload')];
  await nextTick();
  expect(root.querySelector('.transfer-panel')).toBeNull();
  expect(progressDialog()?.open).toBe(true);
  expect(progressDialog()?.querySelectorAll('h2')).toHaveLength(1);
  expect(progressDialog()?.textContent).toContain('传输任务（1）');
  expect(progressDialog()?.querySelector('[data-time="elapsed"]')?.textContent?.trim()).toBe(
    '0:00:14',
  );
  expect(progressDialog()?.querySelector('[data-time="remaining"]')?.textContent?.trim()).toBe(
    '0:01:26',
  );
  expect(progressDialog()?.textContent).not.toContain('重试会从头传输');
  expect(progressDialog()?.querySelector('.transfer-row button')).toBeNull();
  [...progressDialog()!.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '后台传输')!
    .click();
  await nextTick();
  expect(progressDialog()).toBeNull();
  expect(files.tasks[0]?.state).toBe('running');
  files.tasks = [{ ...files.tasks[0]!, elapsedSeconds: 30 }];
  await nextTick();
  expect(progressDialog()).toBeNull();
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '传输任务（1）')!
    .click();
  await nextTick();
  expect(progressDialog()?.querySelector('[data-time="elapsed"]')?.textContent?.trim()).toBe(
    '0:00:30',
  );
  expect(cancel).not.toHaveBeenCalled();
  progressDialog()!
    .querySelector<HTMLButtonElement>('[aria-label="取消此主机的全部传输"]')!
    .click();
  await vi.waitFor(() => expect(files.tasks[0]?.state).toBe('cancelling'));
  expect(
    progressDialog()?.querySelector<HTMLButtonElement>('.modal-heading button')?.disabled,
  ).toBe(true);
  expect(progressDialog()?.textContent).toContain('正在取消并清理');
  files.tasks = [{ ...files.tasks[0]!, state: 'cancelled' }];
  await nextTick();
  expect(progressDialog()).toBeNull();
  expect(cancel).toHaveBeenCalledExactlyOnceWith('upload');
});

it('reopens for new tasks and closes only after every task on this host has finished', async () => {
  const files = useFilesStore(pinia);
  files.tasks = [progressTask('first'), progressTask('other-host', 'b')];
  await nextTick();
  expect(progressDialog()?.querySelectorAll('.transfer-row')).toHaveLength(1);
  expect(progressDialog()?.querySelector('[data-task-id="other-host"]')).toBeNull();
  [...progressDialog()!.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === '后台传输')!
    .click();
  await nextTick();
  files.tasks.push({ ...progressTask('second'), direction: 'download', state: 'queued' });
  await nextTick();
  expect(progressDialog()?.getAttribute('aria-label')).toBe('传输任务（2）');
  expect(progressDialog()?.querySelectorAll('.transfer-row')).toHaveLength(2);
  files.tasks[0] = { ...files.tasks[0]!, state: 'completed', remainingBytes: 0 };
  await nextTick();
  expect(progressDialog()?.getAttribute('aria-label')).toBe('传输任务（1）');
  files.tasks[2] = { ...files.tasks[2]!, state: 'cancelled' };
  await nextTick();
  expect(progressDialog()).toBeNull();
  expect(root.textContent).not.toContain('传输任务（');
  const history = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === '传输记录',
  )!;
  history.click();
  await nextTick();
  expect(document.querySelector('dialog[aria-label="传输记录"] .transfer-panel')).not.toBeNull();
  expect(files.tasks.find((task) => task.id === 'other-host')?.state).toBe('running');
});

it('opens progress after transfer confirmation and keeps explicit cancellation bound to the task', async () => {
  const files = useFilesStore(pinia);
  const snapshot = progressTask('confirmed');
  vi.spyOn(filesApi, 'pick').mockResolvedValue(snapshot.sources);
  const start = vi.spyOn(filesApi, 'start').mockResolvedValue(snapshot);
  const cancel = vi.spyOn(filesApi, 'cancel').mockResolvedValue();
  vi.spyOn(files, 'poll').mockImplementation(async () => {
    files.tasks = [{ ...snapshot, state: cancel.mock.calls.length ? 'cancelled' : 'running' }];
  });
  root.querySelector<HTMLButtonElement>('[aria-label="选择上传文件…"]')!.click();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog[aria-label="确认文件传输"]')).not.toBeNull(),
  );
  document
    .querySelector('dialog[aria-label="确认文件传输"] form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(progressDialog()?.open).toBe(true));
  expect(start).toHaveBeenCalledOnce();
  expect(document.querySelector('dialog[aria-label="确认文件传输"]')).toBeNull();
  progressDialog()!.dispatchEvent(new Event('cancel', { cancelable: true }));
  await vi.waitFor(() => expect(progressDialog()).toBeNull());
  expect(cancel).toHaveBeenCalledExactlyOnceWith('confirmed');
});

it('shows Windows drag-export progress in the application and cancels only this host tasks', async () => {
  const files = useFilesStore(pinia);
  const exported = {
    ...progressTask('windows'),
    direction: 'download' as const,
    dragExport: true,
    destination: 'C:\\Temp\\serverdeck-drag-test',
  };
  files.tasks = [exported, progressTask('other-host', 'b')];
  await nextTick();
  expect(progressDialog()?.getAttribute('aria-label')).toBe('传输任务（1）');
  expect(progressDialog()?.textContent).toContain('拖放到的 Windows 文件夹');
  expect(progressDialog()?.textContent).not.toContain('serverdeck-drag-test');
  const cancelled = new Set<string>();
  const cancel = vi.spyOn(filesApi, 'cancel').mockImplementation(async (id) => {
    cancelled.add(id);
  });
  vi.spyOn(files, 'poll').mockImplementation(async () => {
    files.tasks = files.tasks.map((task) =>
      cancelled.has(task.id) ? { ...task, state: 'cancelled' } : task,
    );
  });
  files.tasks.push(progressTask('first'), progressTask('second'));
  await nextTick();
  expect(progressDialog()?.getAttribute('aria-label')).toBe('传输任务（3）');
  expect(progressDialog()?.querySelector('[data-task-id="windows"]')).not.toBeNull();
  progressDialog()!.querySelector<HTMLButtonElement>('.modal-heading button')!.click();
  await vi.waitFor(() => expect(progressDialog()).toBeNull());
  expect(cancelled).toEqual(new Set(['windows', 'first', 'second']));
  expect(cancel).toHaveBeenCalledTimes(3);
  expect(files.tasks[0]?.state).toBe('cancelled');
  expect(files.tasks[1]?.state).toBe('running');
});

it('attempts every cancellation and leaves failed requests visible for retry', async () => {
  const files = useFilesStore(pinia);
  files.tasks = [progressTask('first'), progressTask('second')];
  const cancelled = new Set<string>();
  const cancel = vi.spyOn(filesApi, 'cancel').mockImplementation(async (id) => {
    if (id === 'second') throw { message: '取消请求失败，请重试' };
    cancelled.add(id);
  });
  vi.spyOn(files, 'poll').mockImplementation(async () => {
    files.tasks = files.tasks.map((task) =>
      cancelled.has(task.id) ? { ...task, state: 'cancelled' } : task,
    );
  });
  await nextTick();
  progressDialog()!.querySelector<HTMLButtonElement>('.modal-heading button')!.click();
  await vi.waitFor(() =>
    expect(progressDialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      '取消请求失败',
    ),
  );
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(progressDialog()?.getAttribute('aria-label')).toBe('传输任务（1）');
  cancel.mockImplementation(async (id) => {
    cancelled.add(id);
  });
  progressDialog()!.querySelector<HTMLButtonElement>('.modal-heading button')!.click();
  await vi.waitFor(() => expect(progressDialog()).toBeNull());
  expect(cancel).toHaveBeenLastCalledWith('second');
});

it.each([
  ['local', 'directory', '进入目录', '上传选中'],
  ['local', 'file', '选择应用打开…', '上传选中'],
  ['remote', 'directory', '进入目录', '下载选中'],
  ['remote', 'file', '打开文本', '下载选中'],
] as const)(
  'shows the expected icons, labels and action order for the %s %s menu',
  async (side, kind, open, transfer) => {
    const files = useFilesStore(pinia);
    const selected = { ...entry, kind };
    if (side === 'local') files.local!.entries = [selected];
    else files.current!.listing!.entries = [selected];
    await nextTick();
    root
      .querySelector(`[aria-label="${side === 'local' ? '本地文件' : '远程文件'}"] tbody tr`)!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await nextTick();
    const buttons = [
      ...root.querySelectorAll<HTMLButtonElement>('.file-context-menu [role="menuitem"]'),
    ];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      open,
      ...(side === 'remote' && kind === 'file' ? ['使用系统应用编辑…'] : []),
      transfer,
      ...(side === 'remote' ? ['远程复制'] : []),
      '删除',
      '重命名',
      ...(side === 'remote' ? ['在新终端中打开'] : []),
      '属性',
    ]);
    for (const button of buttons) {
      expect(button.firstElementChild?.tagName).toBe('svg');
      expect(button.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    }
    buttons.find((button) => button.textContent?.trim() === '删除')!.click();
    await nextTick();
    expect(root.querySelector('.file-context-menu')).toBeNull();
  },
);

it.each(['local', 'remote'] as const)(
  'closes the %s file menu on a right-click anywhere else, even when propagation is stopped',
  async (side) => {
    const files = useFilesStore(pinia);
    files.local!.entries = [
      { ...entry, name: 'local.txt', path: 'D:/test/local.txt', kind: 'file' },
    ];
    await nextTick();
    const row = root.querySelector(
      `[aria-label="${side === 'local' ? '本地' : '远程'}文件"] tbody tr`,
    )!;
    for (const outside of [
      root.querySelector('h1')!,
      root.querySelector('.path-bar input')!,
      document.body,
    ]) {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await nextTick();
      expect(root.querySelector('.file-context-menu')).not.toBeNull();
      outside.addEventListener(
        'contextmenu',
        (event) => {
          event.preventDefault();
          event.stopPropagation();
        },
        { once: true },
      );
      outside.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await nextTick();
      expect(root.querySelector('.file-context-menu')).toBeNull();
    }
  },
);

it.each([
  ['local', 'local'],
  ['local', 'remote'],
  ['remote', 'local'],
  ['remote', 'remote'],
] as const)('replaces a %s file menu with the new %s target and its position', async (from, to) => {
  const files = useFilesStore(pinia);
  files.local!.entries = ['first', 'second'].map((name) => ({
    ...entry,
    name,
    path: `D:/test/${name}`,
    kind: 'file' as const,
  }));
  files.current!.listing!.entries = ['first', 'second'].map((name) => ({
    ...entry,
    name,
    path: `/srv/api/${name}`,
    kind: 'file' as const,
  }));
  await nextTick();
  const row = (side: 'local' | 'remote', name: string) =>
    root.querySelector(
      `[aria-label="${side === 'local' ? '本地' : '远程'}文件"] .file-name[title="${name}"]`,
    )!;
  row(from, 'first').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }),
  );
  await nextTick();
  row(to, 'second').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 90 }),
  );
  await nextTick();
  expect(root.querySelectorAll('.file-context-menu')).toHaveLength(1);
  const menu = root.querySelector<HTMLElement>('.file-context-menu')!;
  expect(menu.style.left).toBe('80px');
  expect(menu.style.top).toBe('90px');
  const remove = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === '删除',
  )!;
  remove.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  await nextTick();
  expect(menu.isConnected).toBe(true);
  remove.click();
  await vi.waitFor(() => {
    const dialog = document.querySelector(
      `dialog[aria-label="${to === 'local' ? '确认移入回收站' : '确认删除远程项目'}"]`,
    );
    expect(dialog?.textContent).toContain('second');
    expect(dialog?.textContent).not.toContain('first');
  });
});

it('closes a file menu on outside pointer presses and removes its global listeners on unmount', async () => {
  app?.unmount();
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  await mountView();
  root
    .querySelector('[aria-label="远程文件"] tbody tr')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await nextTick();
  root.querySelector('h1')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  await nextTick();
  expect(root.querySelector('.file-context-menu')).toBeNull();
  app?.unmount();
  app = undefined;
  for (const type of ['contextmenu', 'pointerdown']) {
    const listener = add.mock.calls.find(
      ([event, , capture]) => event === type && capture === true,
    )?.[1];
    expect(listener).toBeDefined();
    expect(remove).toHaveBeenCalledWith(type, listener, true);
  }
});

const driveOptions = () => [
  ...document.querySelectorAll<HTMLElement>('[aria-label="本地磁盘"] [role="option"]'),
];
const driveName = () => drivePicker().querySelector('.file-location-value')?.textContent?.trim();
async function selectDrive(name: string): Promise<void> {
  drivePicker().click();
  await nextTick();
  driveOptions()
    .find((option) => option.textContent?.trim() === name)!
    .click();
  await nextTick();
}
async function driveKey(key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  drivePicker().dispatchEvent(event);
  await nextTick();
  await nextTick();
  return event;
}

it('does not leave a finished external edit notice as a banner when the file page is reopened', async () => {
  const files = useFilesStore(pinia);
  const localPath = 'D:/app/external-edits/edit-1/config.ini';
  files.externalDocument = {
    token: 'external',
    sessionId: 'sftp-a',
    path: '/srv/api/config.ini',
    localPath,
    transferId: 'download',
    ready: true,
    atomicSave: true,
  };
  vi.spyOn(filesApi, 'closeEditor').mockResolvedValue(undefined);
  await files.closeExternal();
  await nextTick();
  expect(root.querySelector('.banner.success')).toBeNull();
  const notifications = useNotificationsStore(pinia);
  expect(notifications.items).toEqual([
    expect.objectContaining({ text: expect.stringContaining(localPath), error: false }),
  ]);
  notifications.dismiss(notifications.items[0]!.id);
  app!.unmount();
  await mountView();
  expect(root.querySelector('.banner.success')).toBeNull();
  expect(root.textContent).not.toContain(localPath);
  expect(notifications.items).toEqual([]);
});

it('opens local ini files with the system application picker on double click and reports failures locally', async () => {
  const files = useFilesStore(pinia);
  files.local!.entries = [
    { ...entry, name: 'config.ini', path: 'D:/test/config.ini', kind: 'file', size: 120 },
  ];
  const open = vi.spyOn(filesApi, 'openLocal').mockResolvedValue(true);
  const read = vi.spyOn(filesApi, 'read');
  await nextTick();
  root
    .querySelector('[title="config.ini"]')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('D:/test/config.ini'));
  expect(read).not.toHaveBeenCalled();
  open.mockRejectedValueOnce({ message: '无法显示系统打开方式' });
  root
    .querySelector('[title="config.ini"]')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await vi.waitFor(() => expect(files.error).toBe('无法显示系统打开方式'));
});

it('places the navigation buttons before the local drive selector and path input', async () => {
  await vi.waitFor(() => expect(filesApi.localDrives).toHaveBeenCalled());
  const picker = drivePicker();
  expect(root.querySelector('[aria-label="选择本地目录"]')).toBeNull();
  const controls = Array.from(picker.closest('form')!.children);
  expect(controls.map((control) => control.getAttribute('aria-label'))).toEqual([
    '上一级',
    '根目录',
    '主目录',
    '选择本地磁盘',
    '本地路径',
  ]);
  picker.click();
  await nextTick();
  expect(driveOptions().map((option) => option.textContent?.trim())).toEqual([
    'C: 本地磁盘',
    'D: 本地磁盘',
  ]);
  expect(driveOptions().every((option) => option.firstElementChild?.tagName === 'svg')).toBe(true);
  expect(driveName()).toBe('D: 本地磁盘');
  expect(root.querySelector('[aria-label="选择上传文件夹…"]')).not.toBeNull();
});

it('uses local parent, share root and system home with SFTP disconnected', async () => {
  const files = useFilesStore(pinia);
  files.current!.state = 'failed';
  const share = '\\\\?\\UNC\\server\\projects\\';
  const home = '\\\\?\\C:\\Users\\demo';
  files.local = { path: share + 'one\\two', parent: share + 'one', entries: [] };
  const read = vi.spyOn(filesApi, 'local').mockImplementation(async (path) => ({
    path: path ?? home,
    parent: path === share ? null : path === null ? '\\\\?\\C:\\Users' : share,
    entries: [],
  }));
  const remote = vi.spyOn(filesApi, 'list');
  await nextTick();
  const addressBar = drivePicker().closest('form')!;
  const [parent, rootDirectory, userHome] =
    addressBar.querySelectorAll<HTMLButtonElement>('button');
  parent!.click();
  await vi.waitFor(() => expect(files.local?.path).toBe(share + 'one'));
  rootDirectory!.click();
  await vi.waitFor(() => expect(files.local?.path).toBe(share));
  expect(parent!.disabled).toBe(true);
  expect(rootDirectory!.disabled).toBe(true);
  userHome!.click();
  await vi.waitFor(() =>
    expect(addressBar.querySelector<HTMLInputElement>('[aria-label="本地路径"]')?.value).toBe(
      'C:\\Users\\demo',
    ),
  );
  expect(read.mock.calls).toEqual([[share + 'one'], [share], [null]]);
  expect(files.current!.path).toBe('/srv/api');
  expect(remote).not.toHaveBeenCalled();
});

it('browses the local tree independently and discards pending branches when the drive changes', async () => {
  const files = useFilesStore(pinia);
  files.current!.state = 'failed';
  const drive = '\\\\?\\D:\\';
  const project = drive + 'project';
  const docs = project + '\\docs';
  const old = project + '\\old';
  const listings = new Map<string, DirectoryListing>([
    [drive, { path: drive, parent: null, entries: [{ ...entry, path: project, name: 'project' }] }],
    [
      project,
      {
        path: project,
        parent: drive,
        entries: [
          { ...entry, path: docs, name: 'docs' },
          { ...entry, path: old, name: 'old' },
          { ...entry, path: project + '\\alias', name: 'alias', kind: 'symlink' },
        ],
      },
    ],
    [
      docs,
      {
        path: docs,
        parent: project,
        entries: [{ ...entry, path: docs + '\\guide.txt', name: 'guide.txt', kind: 'file' }],
      },
    ],
  ]);
  files.local = listings.get(project)!;
  let resolveOld!: (value: DirectoryListing) => void;
  const read = vi.spyOn(filesApi, 'local').mockImplementation(async (path) => {
    if (path === old)
      return new Promise<DirectoryListing>((resolve) => {
        resolveOld = resolve;
      });
    return listings.get(path!)!;
  });
  const pane = drivePicker().closest('.file-side')!;
  const toggle = pane.querySelector<HTMLButtonElement>('[aria-label="显示本地目录树"]')!;
  const row = (path: string) =>
    [...pane.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
      (el) => el.dataset.path === path,
    );
  const table = pane.querySelector('table')!;
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  toggle.click();
  await vi.waitFor(() => expect(row(project)?.getAttribute('aria-selected')).toBe('true'));
  expect(read).toHaveBeenCalledExactlyOnceWith(drive);
  expect(row(drive)?.querySelector('.directory-entry')?.textContent).toBe('D:\\');
  expect(row(project + '\\alias')).toBeUndefined();
  expect(root.querySelector('[aria-label="显示远程目录树"]')?.getAttribute('aria-pressed')).toBe(
    'false',
  );
  row(old)!.querySelector<HTMLButtonElement>('.directory-toggle')!.click();
  await nextTick();
  expect(row(old)?.getAttribute('aria-busy')).toBe('true');
  expect(files.local?.path).toBe(project);
  row(docs)!.querySelector<HTMLButtonElement>('.directory-entry')!.click();
  await vi.waitFor(() => expect(row(docs)?.getAttribute('aria-selected')).toBe('true'));
  expect(row(docs)?.textContent?.trim()).toBe('docs');
  expect(table.textContent).toContain('guide.txt');
  expect(row(docs + '\\guide.txt')).toBeUndefined();
  expect(files.stepHistory('local', 'back')).toBe(true);
  await vi.waitFor(() => expect(row(project)?.getAttribute('aria-selected')).toBe('true'));

  const nextDrive = '\\\\?\\C:\\';
  files.local = { path: nextDrive, parent: null, entries: [] };
  await nextTick();
  resolveOld({
    path: old,
    parent: project,
    entries: [{ ...entry, name: 'late', path: old + '\\late' }],
  });
  await nextTick();
  expect(row(nextDrive)?.getAttribute('aria-selected')).toBe('true');
  expect(row(drive)).toBeUndefined();
  expect(pane.textContent).not.toContain('late');
  toggle.click();
  await nextTick();
  expect(pane.querySelector('[role="tree"]')).toBeNull();
  expect(pane.querySelector('table')).toBe(table);
});

it('updates generated drive captions without reloading drives or translating file names', async () => {
  await vi.waitFor(() => expect(driveName()).toBe('D: 本地磁盘'));
  const files = useFilesStore(pinia);
  files.local!.entries = [{ ...entry, name: '本地磁盘', path: 'D:/test/本地磁盘' }];
  const requests = vi.mocked(filesApi.localDrives).mock.calls.length;
  setLocale('en-US');
  await nextTick();
  expect(root.querySelector('.file-location-value')?.textContent?.trim()).toBe('D: Local disk');
  expect(root.querySelector('[title="本地磁盘"]')).not.toBeNull();
  expect(files.local!.path).toBe('D:/test');
  expect(filesApi.localDrives).toHaveBeenCalledTimes(requests);
  setLocale('zh-CN');
  await nextTick();
  expect(driveName()).toBe('D: 本地磁盘');
});

it('navigates to the selected drive root and preserves local back navigation', async () => {
  const files = useFilesStore(pinia);
  const load = vi.spyOn(filesApi, 'local').mockImplementation(async (path) => ({
    path: path!,
    parent: null,
    entries: [],
  }));
  await selectDrive('C: 本地磁盘');
  await vi.waitFor(() => expect(files.local?.path).toBe('C:\\'));
  expect(load).toHaveBeenCalledWith('C:\\');
  expect(root.querySelector<HTMLInputElement>('[aria-label="本地路径"]')?.value).toBe('C:\\');
  expect(files.current?.path).toBe('/srv/api');
  expect(files.stepHistory('local', 'back')).toBe(true);
  await vi.waitFor(() => expect(files.local?.path).toBe('D:/test'));
  expect(driveName()).toBe('D: 本地磁盘');
});

it('restores the previous drive and list when a drive becomes unavailable', async () => {
  const files = useFilesStore(pinia);
  const previous = files.local;
  let reject!: (error: unknown) => void;
  vi.spyOn(filesApi, 'local').mockImplementation(
    () => new Promise((_resolve, fail) => (reject = fail)),
  );
  await selectDrive('C: 本地磁盘');
  expect(files.localLoading).toBe(true);
  expect(driveName()).toBe('C: 本地磁盘');
  reject({ message: '磁盘不可用' });
  await vi.waitFor(() => expect(files.error).toBe('磁盘不可用'));
  expect(files.local).toBe(previous);
  expect(driveName()).toBe('D: 本地磁盘');
  expect(root.querySelector<HTMLInputElement>('[aria-label="本地路径"]')?.value).toBe('D:/test');
});

it('matches canonical Windows drive paths and leaves UNC paths unselected', async () => {
  const files = useFilesStore(pinia);
  const picker = drivePicker();
  files.local = { path: '\\\\?\\c:\\Users\\test', parent: null, entries: [] };
  await nextTick();
  expect(driveName()).toBe('C: 本地磁盘');
  files.local = { path: '\\\\?\\UNC\\server\\share', parent: null, entries: [] };
  await nextTick();
  expect(driveName()).toBe('');
  expect(picker.querySelector('.file-location-value svg')).toBeNull();
  picker.click();
  await nextTick();
  expect(driveOptions()).toHaveLength(2);
  expect(driveOptions().every((option) => option.getAttribute('aria-selected') === 'false')).toBe(
    true,
  );
  expect(root.querySelector<HTMLInputElement>('[aria-label="本地路径"]')?.value).toBe(
    '\\\\server\\share',
  );
});

it('shows loading and failure states and retries drive discovery on focus', async () => {
  app!.unmount();
  let reject!: (error: unknown) => void;
  vi.mocked(filesApi.localDrives).mockImplementationOnce(
    () => new Promise((_resolve, fail) => (reject = fail)),
  );
  await mountView();
  const picker = drivePicker();
  expect(picker.disabled).toBe(true);
  expect(picker.textContent).toContain('加载磁盘');
  reject({ message: '无法读取磁盘列表' });
  await vi.waitFor(() => expect(picker.disabled).toBe(false));
  expect(picker.textContent).toContain('磁盘加载失败');
  expect(useFilesStore(pinia).error).toBe('无法读取磁盘列表');
  picker.dispatchEvent(new FocusEvent('focus'));
  await vi.waitFor(() => expect(driveName()).toBe('D: 本地磁盘'));
  vi.mocked(filesApi.localDrives).mockResolvedValueOnce([]);
  picker.click();
  await vi.waitFor(() => expect(picker.textContent).toContain('无可用磁盘'));
  expect(driveOptions()).toHaveLength(0);
});

it('selects icon options by keyboard and cancels without changing drives', async () => {
  const files = useFilesStore(pinia);
  const load = vi.spyOn(filesApi, 'local').mockImplementation(async (path) => ({
    path: path!,
    parent: null,
    entries: [],
  }));
  const picker = drivePicker();
  picker.focus();
  await driveKey('ArrowDown');
  expect(picker.getAttribute('aria-expanded')).toBe('true');
  expect(load).not.toHaveBeenCalled();
  const activeName = () =>
    document.getElementById(picker.getAttribute('aria-activedescendant')!)?.textContent?.trim();
  expect(activeName()).toBe('D: 本地磁盘');
  await driveKey('Home');
  expect(activeName()).toBe('C: 本地磁盘');
  await driveKey('ArrowDown');
  expect(activeName()).toBe('D: 本地磁盘');
  await driveKey('ArrowUp');
  expect(activeName()).toBe('C: 本地磁盘');
  await driveKey('End');
  expect(activeName()).toBe('D: 本地磁盘');
  await driveKey('c');
  expect(activeName()).toBe('C: 本地磁盘');
  await driveKey('Enter');
  await vi.waitFor(() => expect(files.local?.path).toBe('C:\\'));
  expect(driveOptions()).toHaveLength(0);
  expect(document.activeElement).toBe(picker);
  await driveKey(' ');
  await driveKey('End');
  expect((await driveKey('Escape')).defaultPrevented).toBe(true);
  expect(picker.getAttribute('aria-expanded')).toBe('false');
  expect(load).toHaveBeenCalledTimes(1);
  expect(files.local?.path).toBe('C:\\');
});

it('dismisses the drive menu on outside actions and while the file workspace is blocked', async () => {
  const picker = drivePicker();
  const input = root.querySelector<HTMLInputElement>('[aria-label="本地路径"]')!;
  for (const dismiss of [
    () => input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
    () => input.focus(),
    () => window.dispatchEvent(new Event('scroll')),
    () => window.dispatchEvent(new Event('resize')),
    () => window.dispatchEvent(new Event('blur')),
  ]) {
    picker.focus();
    await driveKey('Enter');
    expect(driveOptions()).toHaveLength(2);
    dismiss();
    await nextTick();
    expect(driveOptions()).toHaveLength(0);
  }
  await driveKey('Enter');
  expect((await driveKey('Tab')).defaultPrevented).toBe(false);
  expect(driveOptions()).toHaveLength(0);
  await driveKey('Enter');
  useFilesStore(pinia).current!.switchingUser = true;
  await nextTick();
  expect(picker.disabled).toBe(true);
  expect(driveOptions()).toHaveLength(0);
});

it('refreshes an open drive list and leaves navigation pending until an option is selected', async () => {
  const files = useFilesStore(pinia);
  const load = vi
    .spyOn(filesApi, 'local')
    .mockImplementation(async (path) => ({ path: path!, parent: null, entries: [] }));
  let finish!: (drives: { path: string; name: string }[]) => void;
  vi.mocked(filesApi.localDrives).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await driveKey('Enter');
  await driveKey('Home');
  finish([
    { path: 'C:\\', name: 'C: 本地磁盘' },
    { path: 'E:\\', name: 'E: 本地磁盘' },
  ]);
  await vi.waitFor(() =>
    expect(driveOptions().map((option) => option.textContent?.trim())).toEqual([
      'C: 本地磁盘',
      'E: 本地磁盘',
    ]),
  );
  expect(load).not.toHaveBeenCalled();
  expect(driveName()).toBe('');
  await driveKey('End');
  await driveKey('Enter');
  await vi.waitFor(() => expect(files.local?.path).toBe('E:\\'));
});

it('removes the teleported drive menu when its view is unmounted', async () => {
  await driveKey('Enter');
  expect(driveOptions()).toHaveLength(2);
  app!.unmount();
  app = undefined;
  expect(document.querySelector('[aria-label="本地磁盘"]')).toBeNull();
  window.dispatchEvent(new Event('scroll'));
});

const folderPicker = () => root.querySelector<HTMLButtonElement>('[aria-label="选择远程目录"]')!;
const treeToggle = () => root.querySelector<HTMLButtonElement>('[aria-label="显示远程目录树"]')!;
const treeRow = (path: string) =>
  [...root.querySelectorAll<HTMLElement>('.directory-browser [role="treeitem"]')].find(
    (element) => element.dataset.path === path,
  );
function directoryListing(path: string, names: string[]): DirectoryListing {
  return {
    path,
    parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
    entries: names.map((name) => ({
      ...entry,
      name,
      path: (path === '/' ? '' : path) + '/' + name,
    })),
  };
}
it('browses folders above the remote table and synchronizes navigation, hidden items and refresh', async () => {
  const files = useFilesStore(pinia);
  const current = directoryListing('/srv/api', ['config', '.cache']);
  current.entries.push({ ...entry, name: 'app.log', path: '/srv/api/app.log', kind: 'file' });
  files.current!.listing = current;
  const folders: Record<string, string[]> = {
    '/': ['srv'],
    '/srv': ['api'],
    '/srv/api/config': ['profiles'],
    '/srv/api/config/profiles': [],
  };
  const read = vi
    .spyOn(filesApi, 'list')
    .mockImplementation(async (_id, path) => directoryListing(path, folders[path] ?? []));
  vi.spyOn(filesApi, 'rememberDirectory').mockResolvedValue();
  const table = root.querySelector('table[aria-label="远程文件"]')!;
  const local = files.local;
  expect(treeToggle().getAttribute('aria-pressed')).toBe('false');
  expect(root.querySelector('[role="tree"]')).toBeNull();
  treeToggle().click();
  await vi.waitFor(() => expect(treeRow('/srv/api')?.getAttribute('aria-selected')).toBe('true'));
  expect(read.mock.calls.map(([, path]) => path).sort()).toEqual(['/', '/srv']);
  expect(treeRow('/srv/api/.cache')).toBeUndefined();
  expect(treeRow('/srv/api/app.log')).toBeUndefined();
  expect(table.textContent).toContain('app.log');
  root.querySelector<HTMLButtonElement>('[aria-label="显示隐藏项"]')!.click();
  await nextTick();
  expect(treeRow('/srv/api/.cache')).toBeDefined();
  expect(table.textContent).toContain('.cache');
  treeRow(entry.path)!.querySelector<HTMLButtonElement>('.directory-toggle')!.click();
  await vi.waitFor(() => expect(treeRow(entry.path + '/profiles')).toBeDefined());
  expect(files.current!.path).toBe('/srv/api');
  expect(filesApi.rememberDirectory).not.toHaveBeenCalled();
  treeRow(entry.path)!.querySelector<HTMLButtonElement>('.directory-entry')!.click();
  await vi.waitFor(() => expect(treeRow(entry.path)?.getAttribute('aria-selected')).toBe('true'));
  expect(table.textContent).toContain('profiles');
  expect(table.textContent).not.toContain('app.log');
  expect(folderName()).toBe('config');
  table.querySelector('tbody tr')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const profiles = entry.path + '/profiles';
  await vi.waitFor(() => expect(treeRow(profiles)?.getAttribute('aria-selected')).toBe('true'));
  expect(treeRow(profiles)?.textContent?.trim()).toBe('profiles');
  expect(treeRow(profiles)?.hasAttribute('aria-expanded')).toBe(false);
  expect(files.stepHistory('remote', 'back')).toBe(true);
  await vi.waitFor(() => expect(treeRow(entry.path)?.getAttribute('aria-selected')).toBe('true'));
  folders[entry.path] = ['renamed'];
  root.querySelector<HTMLButtonElement>('[aria-label="刷新远程"]')!.click();
  await vi.waitFor(() => expect(treeRow(entry.path + '/renamed')).toBeDefined());
  expect(treeRow(profiles)).toBeUndefined();
  treeToggle().click();
  await nextTick();
  expect(root.querySelector('[role="tree"]')).toBeNull();
  expect(root.querySelector('table[aria-label="远程文件"]')).toBe(table);
  expect(table.textContent).toContain('renamed');
  expect(files.local).toBe(local);
});

it('keeps a confirmed directory usable under an unreadable ancestor and isolates late branch reads by session', async () => {
  const files = useFilesStore(pinia);
  let finish!: (listing: DirectoryListing) => void;
  vi.spyOn(filesApi, 'list').mockImplementation(async (_id, path) => {
    if (path === '/srv') throw new Error('目录无读取权限');
    if (path === entry.path)
      return new Promise<DirectoryListing>((resolve) => {
        finish = resolve;
      });
    return directoryListing(path, []);
  });
  treeToggle().click();
  await vi.waitFor(() => expect(treeRow('/srv')?.textContent).toContain('目录无读取权限'));
  expect(treeRow('/srv/api')?.getAttribute('aria-selected')).toBe('true');
  treeRow(entry.path)!.querySelector<HTMLButtonElement>('.directory-toggle')!.click();
  await nextTick();
  expect(treeRow(entry.path)?.getAttribute('aria-busy')).toBe('true');
  files.current!.id = 'other-identity';
  files.current!.path = '/';
  files.current!.listing = directoryListing('/', ['public']);
  await nextTick();
  finish(directoryListing(entry.path, ['old-private-directory']));
  await nextTick();
  expect(treeRow('/')?.getAttribute('aria-selected')).toBe('true');
  expect(treeRow('/public')).toBeDefined();
  expect(treeRow('/srv')).toBeUndefined();
  expect(root.textContent).not.toContain('old-private-directory');
});

const folderOptions = () => [
  ...document.querySelectorAll<HTMLElement>('[aria-label="远程目录层级"] [role="option"]'),
];
const folderName = () => folderPicker().querySelector('.file-location-value')?.textContent?.trim();
async function chooseFolder(name: string): Promise<void> {
  folderPicker().click();
  await nextTick();
  folderOptions()
    .find((option) => option.textContent?.trim() === name)!
    .click();
  await nextTick();
}

it('places the navigation buttons before the remote ancestor folder menu and path input', async () => {
  const files = useFilesStore(pinia);
  files.current!.listing = { path: '/home/dh', parent: '/home', entries: [] };
  files.current!.path = '/home/dh';
  await nextTick();
  const controls = Array.from(folderPicker().closest('form')!.children);
  expect(controls.map((control) => control.getAttribute('aria-label'))).toEqual([
    '上一级',
    '根目录',
    '主目录',
    '选择远程目录',
    '远程路径',
  ]);
  expect(folderName()).toBe('dh');
  folderPicker().click();
  await nextTick();
  const options = folderOptions();
  expect(options.map((option) => option.textContent?.trim())).toEqual(['/ <root>', 'home', 'dh']);
  expect(options.map((option) => option.style.getPropertyValue('--location-depth'))).toEqual([
    '0',
    '1',
    '2',
  ]);
  expect(
    options.every((option) =>
      option.firstElementChild?.matches('.file-entry-icon[data-kind="directory"]'),
    ),
  ).toBe(true);
  expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
    'false',
    'false',
    'true',
  ]);
});

it('opens the parent, root and session home from the remote address bar and follows a switched identity', async () => {
  const files = useFilesStore(pinia);
  const addressBar = folderPicker().closest('form')!;
  const [parent, rootDirectory, home] = addressBar.querySelectorAll<HTMLButtonElement>('button');
  vi.spyOn(filesApi, 'rememberDirectory').mockResolvedValue();
  const read = vi.spyOn(filesApi, 'list').mockImplementation(async (id, path) => {
    const sessionHome = id === 'sudo-a' ? '/private/operator' : '/users/login';
    return directoryListing(path === '.' ? sessionHome : path, []);
  });
  const saved = vi.spyOn(filesApi, 'lastDirectory');
  parent!.click();
  await vi.waitFor(() => expect(files.current?.path).toBe('/srv'));
  rootDirectory!.click();
  await vi.waitFor(() => expect(files.current?.path).toBe('/'));
  expect(parent!.disabled).toBe(true);
  expect(rootDirectory!.disabled).toBe(true);
  read.mockRejectedValueOnce(new Error('目录无读取权限'));
  home!.click();
  await vi.waitFor(() => expect(files.current?.error).toBe('目录无读取权限'));
  expect(files.current?.path).toBe('/');
  home!.click();
  await vi.waitFor(() => expect(folderName()).toBe('login'));
  vi.spyOn(filesApi, 'switchUser').mockResolvedValue({
    session: { id: 'sudo-a', hostId: 'a', transportId: 'transport', routeHostIds: [] },
    listing: directoryListing('/private/operator', []),
  });
  await files.switchUser({ username: 'operator2', serverPath: '', password: null });
  rootDirectory!.click();
  await vi.waitFor(() => expect(files.current?.path).toBe('/'));
  home!.click();
  await vi.waitFor(() => expect(files.current?.path).toBe('/private/operator'));
  expect(read.mock.calls).toEqual([
    ['sftp-a', '/srv'],
    ['sftp-a', '/'],
    ['sftp-a', '.'],
    ['sftp-a', '.'],
    ['sudo-a', '/'],
    ['sudo-a', '.'],
  ]);
  expect(saved).not.toHaveBeenCalled();
  files.current!.state = 'failed';
  await nextTick();
  expect([parent, rootDirectory, home].every((button) => button!.disabled)).toBe(true);
});

it('navigates to a selected ancestor through the current SFTP connection and records remote history', async () => {
  const files = useFilesStore(pinia);
  const local = files.local;
  const list = vi.spyOn(filesApi, 'list').mockImplementation(async (_id, path) => ({
    path,
    parent: path === '/' ? null : '/',
    entries: [],
  }));
  await chooseFolder('srv');
  await vi.waitFor(() => expect(files.current?.path).toBe('/srv'));
  expect(list).toHaveBeenCalledExactlyOnceWith('sftp-a', '/srv');
  expect(root.querySelector<HTMLInputElement>('[aria-label="远程路径"]')?.value).toBe('/srv');
  expect(folderName()).toBe('srv');
  expect(folderOptions()).toHaveLength(0);
  expect(files.local).toBe(local);
  expect(files.stepHistory('remote', 'back')).toBe(true);
  await vi.waitFor(() => expect(files.current?.path).toBe('/srv/api'));
  expect(folderName()).toBe('api');
});

it('shows a pending ancestor then restores the previous folder and list on a permission error', async () => {
  const files = useFilesStore(pinia);
  const previous = files.current!.listing;
  let reject!: (cause: unknown) => void;
  vi.spyOn(filesApi, 'list').mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await chooseFolder('srv');
  expect(folderName()).toBe('srv');
  expect(files.current?.loading).toBe(true);
  reject({ message: '目录无访问权限' });
  await vi.waitFor(() => expect(files.current?.error).toBe('目录无访问权限'));
  expect(files.current?.listing).toBe(previous);
  expect(files.current?.path).toBe('/srv/api');
  expect(folderName()).toBe('api');
  expect(root.querySelector<HTMLInputElement>('[aria-label="远程路径"]')?.value).toBe('/srv/api');
});

it('selects the remote root by keyboard and keeps a single root item at the root directory', async () => {
  const files = useFilesStore(pinia);
  const list = vi
    .spyOn(filesApi, 'list')
    .mockResolvedValue({ path: '/', parent: null, entries: [] });
  folderPicker().focus();
  for (const key of ['ArrowDown', 'Home', 'Enter']) {
    folderPicker().dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
    await nextTick();
    await nextTick();
  }
  await vi.waitFor(() => expect(files.current?.path).toBe('/'));
  expect(list).toHaveBeenCalledWith('sftp-a', '/');
  expect(folderName()).toBe('/ <root>');
  folderPicker().click();
  await nextTick();
  expect(folderOptions()).toHaveLength(1);
  expect(
    folderPicker().closest('.file-side')!.querySelector<HTMLButtonElement>('[aria-label="上一级"]')
      ?.disabled,
  ).toBe(true);
});

it('keeps the folder menu open when scrolling its contents or the adjacent path field', async () => {
  folderPicker().click();
  await nextTick();
  const menu = document.querySelector('[aria-label="远程目录层级"]')!;
  menu.dispatchEvent(new Event('scroll'));
  root.querySelector('[aria-label="远程路径"]')!.dispatchEvent(new Event('scroll'));
  await nextTick();
  expect(menu.isConnected).toBe(true);
  folderPicker().closest('.file-side')!.dispatchEvent(new Event('scroll'));
  await nextTick();
  expect(menu.isConnected).toBe(false);
});

it('uses the verified folder chain while a relative path is unresolved and never follows unsubmitted text', async () => {
  const files = useFilesStore(pinia);
  const input = root.querySelector<HTMLInputElement>('[aria-label="远程路径"]')!;
  input.value = '/typed/but/not/submitted';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  expect(folderName()).toBe('api');
  files.current!.pendingPath = '../next';
  await nextTick();
  folderPicker().click();
  await nextTick();
  expect(folderOptions().map((option) => option.textContent?.trim())).toEqual([
    '/ <root>',
    'srv',
    'api',
  ]);
});

it('closes a stale folder menu when SFTP identity changes and disables it while disconnected', async () => {
  const files = useFilesStore(pinia);
  const list = vi.spyOn(filesApi, 'list');
  folderPicker().click();
  await nextTick();
  expect(folderOptions()).toHaveLength(3);
  files.current!.id = 'new-identity';
  files.current!.listing = { path: '/home/new-user', parent: '/home', entries: [] };
  files.current!.path = '/home/new-user';
  await nextTick();
  expect(folderOptions()).toHaveLength(0);
  expect(folderName()).toBe('new-user');
  folderPicker().click();
  await nextTick();
  files.current!.state = 'failed';
  await nextTick();
  expect(folderPicker().disabled).toBe(true);
  expect(folderOptions()).toHaveLength(0);
  files.current!.listing = null;
  await nextTick();
  expect(folderName()).toBe('未连接');
  expect(list).not.toHaveBeenCalled();
});

it('confirms a sudo identity, clears the password immediately, and displays the verified user', async () => {
  const files = useFilesStore(pinia);
  let finish!: (value: FileUserSession) => void;
  const change = vi.spyOn(filesApi, 'switchUser').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === '切换用户',
  )!;
  button.click();
  await nextTick();
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="切换 SFTP 用户"]')!;
  const password = dialog.querySelector<HTMLInputElement>('[aria-label="sudo 密码"]')!;
  expect(dialog.querySelector<HTMLInputElement>('[aria-label="目标用户"]')?.value).toBe('root');
  password.value = 'temporary-password';
  password.dispatchEvent(new Event('input', { bubbles: true }));
  dialog
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await nextTick();
  expect(change).toHaveBeenCalledWith('sftp-a', {
    username: 'root',
    serverPath: '',
    password: 'temporary-password',
  });
  expect(password.value).toBe('');
  expect(password.disabled).toBe(true);
  expect(root.querySelector('.files-view')?.hasAttribute('inert')).toBe(true);
  finish({
    session: { id: 'sudo-a', hostId: 'a', transportId: 'transport', routeHostIds: [] },
    listing: { path: '/', parent: null, entries: [] },
  });
  await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  expect(files.current?.id).toBe('sudo-a');
  expect(root.textContent).toContain('root');
  expect(change.mock.calls[0]![1]?.password).toBeNull();
});

it('returns to the login user only after an explicit confirmation', async () => {
  const files = useFilesStore(pinia);
  files.current!.username = 'root';
  files.current!.elevated = true;
  const change = vi.spyOn(filesApi, 'switchUser').mockResolvedValue({
    session: { id: 'normal-a', hostId: 'a', transportId: 'transport', routeHostIds: [] },
    listing: { path: '/home/operator', parent: '/home', entries: [] },
  });
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.getAttribute('aria-label') === '切换用户')!
    .click();
  await nextTick();
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="切换 SFTP 用户"]')!;
  dialog.querySelector<HTMLInputElement>('[type="checkbox"]')!.click();
  await nextTick();
  expect(dialog.querySelector('[aria-label="sudo 密码"]')).toBeNull();
  expect(change).not.toHaveBeenCalled();
  dialog
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(files.current?.id).toBe('normal-a'));
  expect(change).toHaveBeenCalledWith('sftp-a', null);
  expect(files.current?.username).toBe('operator');
});

it('preserves the original connection after sudo rejection and leaves a blank password for retry', async () => {
  const files = useFilesStore(pinia);
  vi.spyOn(filesApi, 'switchUser').mockRejectedValue({ message: 'sudo denied' });
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.getAttribute('aria-label') === '切换用户')!
    .click();
  await nextTick();
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="切换 SFTP 用户"]')!;
  dialog
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(files.error).toBe('sudo denied'));
  expect(files.current?.id).toBe('sftp-a');
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector<HTMLInputElement>('[aria-label="sudo 密码"]')!.value).toBe('');
});

it('drops a file chooser result if the SFTP identity changed while it was open', async () => {
  const files = useFilesStore(pinia);
  let finish!: (paths: string[]) => void;
  vi.spyOn(filesApi, 'pick').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  root.querySelector<HTMLButtonElement>('[aria-label="选择上传文件…"]')!.click();
  await nextTick();
  files.current!.id = 'new-identity';
  finish(['D:/selected.txt']);
  await nextTick();
  await nextTick();
  expect(document.querySelector('dialog')).toBeNull();
});

it.each(['local', 'remote'] as const)(
  'keeps the latest %s target and spinner when an older read finishes first',
  async (side) => {
    const files = useFilesStore(pinia);
    const finishes: ((listing: DirectoryListing) => void)[] = [];
    vi.spyOn(filesApi, side === 'local' ? 'local' : 'list').mockImplementation(
      () => new Promise<DirectoryListing>((resolve) => finishes.push(resolve)),
    );
    const navigate = (path: string) =>
      side === 'local' ? files.localLoad(path) : files.navigate(path);
    const label = side === 'local' ? '本地' : '远程';
    const input = root.querySelector<HTMLInputElement>(`[aria-label="${label}路径"]`)!;
    const pane = input.closest('.file-side')!;
    const old = navigate('/slow');
    const latest = navigate('/target');
    await nextTick();
    expect(input.value).toBe('/target');
    finishes[0]!({ path: '/slow', parent: '/', entries: [] });
    await old;
    await nextTick();
    expect(input.value).toBe('/target');
    expect(pane.querySelector('.file-list-loading')).not.toBeNull();
    expect(pane.querySelectorAll('tbody tr')).toHaveLength(0);
    finishes[1]!({ path: '/canonical/target', parent: '/canonical', entries: [entry] });
    await latest;
    await nextTick();
    expect(input.value).toBe('/canonical/target');
    expect(pane.querySelector('.file-list-loading')).toBeNull();
    expect(pane.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(pane.querySelector('.file-table')?.getAttribute('aria-busy')).toBe('false');
  },
);

it.each(['local', 'remote'] as const)(
  'shows the target path immediately and restores the %s directory after a failed read',
  async (side) => {
    const files = useFilesStore(pinia);
    if (side === 'local') files.local!.entries = [entry];
    await nextTick();
    const label = side === 'local' ? '本地' : '远程';
    const input = root.querySelector<HTMLInputElement>(`[aria-label="${label}路径"]`)!;
    const originalPath = input.value;
    const table = root.querySelector<HTMLTableElement>(`[aria-label="${label}文件"]`)!;
    const header = table.tHead;
    table.querySelector<HTMLInputElement>('tbody input')!.click();
    await nextTick();
    const toolbar = table.closest('.file-side')!.querySelector('.toolbar')!;
    const transfer = [...toolbar.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        button.getAttribute('aria-label') === (side === 'local' ? '上传选中' : '下载选中'),
    )!;
    expect(transfer.disabled).toBe(false);
    let reject!: (cause: unknown) => void;
    const read = vi.spyOn(filesApi, side === 'local' ? 'local' : 'list');
    read.mockImplementationOnce(
      () =>
        new Promise<DirectoryListing>((_resolve, fail) => {
          reject = fail;
        }),
    );
    table.querySelector('.file-name')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await nextTick();
    expect(input.value).toBe(entry.path);
    expect(table.tHead).toBe(header);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(table.closest('.file-side')!.querySelector('[role="status"]')?.textContent).toContain(
      '正在读取目录',
    );
    expect(transfer.disabled).toBe(true);
    reject({ message: 'directory unavailable' });
    await vi.waitFor(() => expect(input.value).toBe(originalPath));
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(table.closest('.file-side')!.querySelector('.file-list-loading')).toBeNull();
    expect(side === 'local' ? files.error : files.current?.error).toBe('directory unavailable');
  },
);

it.each([
  ...['button', 'Delete'].flatMap((trigger) => [
    { trigger, names: ['config'], recursive: true },
    { trigger, names: ['guide.txt', 'config'], recursive: true },
    { trigger, names: ['guide.txt'], recursive: false },
  ]),
])(
  'confirms deletion of $names via $trigger with recursive=$recursive',
  async ({ trigger, names, recursive }) => {
    const files = useFilesStore(pinia);
    files.current!.listing!.entries.push({
      ...entry,
      name: 'guide.txt',
      path: '/srv/api/guide.txt',
      kind: 'file',
    });
    const action = vi.spyOn(filesApi, 'action').mockResolvedValue(undefined);
    vi.spyOn(files, 'refresh').mockResolvedValue(undefined);
    await nextTick();
    for (const name of names) {
      root.querySelector<HTMLInputElement>(`[aria-label="选择 ${name}"]`)!.click();
      await nextTick();
    }
    const remove = root.querySelector<HTMLButtonElement>('[aria-label="删除选中"]')!;
    const openDialog = async () => {
      if (trigger === 'button') remove.click();
      else {
        const name = root.querySelector<HTMLElement>('[aria-label="远程文件"] .file-name')!;
        name.focus();
        name.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
        );
      }
      await nextTick();
      return document.querySelector<HTMLDialogElement>('dialog[aria-label="确认删除远程项目"]')!;
    };

    const dialog = await openDialog();
    expect(dialog.querySelector('input[type="checkbox"]')).toBeNull();
    expect(dialog.querySelectorAll('.file-delete-message p')).toHaveLength(1);
    dialog.querySelector<HTMLButtonElement>('button[autofocus]')!.click();
    await nextTick();
    expect(dialog.isConnected).toBe(false);
    expect(action).not.toHaveBeenCalled();

    (await openDialog()).querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    expect(action).toHaveBeenCalledExactlyOnceWith('sftp-a', {
      kind: 'remove',
      paths: names.map((name) => `/srv/api/${name}`),
      recursive,
      confirmed: true,
    });
  },
);

it.each([
  { trigger: 'Delete', success: true },
  { trigger: 'Delete', success: false },
  { trigger: 'menu', success: true },
  { trigger: 'menu', success: false },
])(
  'recycles the local selection via $trigger after confirmation and retains failures ($success)',
  async ({ trigger, success }) => {
    const files = useFilesStore(pinia);
    const local = {
      ...entry,
      name: 'report.txt',
      path: 'D:/test/report.txt',
      kind: 'file' as const,
    };
    files.local!.entries = [
      local,
      { ...local, name: 'folder', path: 'D:/test/folder', kind: 'directory' },
    ];
    const recycle = vi.spyOn(filesApi, 'localRecycle');
    if (success) recycle.mockResolvedValue();
    else recycle.mockRejectedValue({ message: '回收站不可用' });
    const remote = vi.spyOn(filesApi, 'action').mockResolvedValue();
    const load = vi.spyOn(files, 'localLoad').mockResolvedValue();
    await nextTick();
    root.querySelector<HTMLInputElement>('[aria-label="远程文件"] tbody input')!.click();
    for (const name of ['report.txt', 'folder']) {
      root
        .querySelector<HTMLInputElement>(`[aria-label="本地文件"] [aria-label="选择 ${name}"]`)!
        .click();
      await nextTick();
    }
    await nextTick();
    const open = async () => {
      const name = root.querySelector<HTMLElement>('[aria-label="本地文件"] .file-name')!;
      if (trigger === 'Delete') {
        name.focus();
        name.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
        );
      } else {
        name.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        await nextTick();
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((button) => button.textContent?.trim() === '删除')!
          .click();
      }
      await nextTick();
      return document.querySelector<HTMLDialogElement>('[aria-label="确认移入回收站"]')!;
    };
    let dialog = await open();
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('2 个本地项目');
    expect(dialog.textContent).not.toContain('永久删除');
    expect(recycle).not.toHaveBeenCalled();
    dialog.querySelector<HTMLButtonElement>('button[autofocus]')!.click();
    await nextTick();
    expect(document.querySelector('dialog')).toBeNull();
    dialog = await open();
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() =>
      expect(recycle).toHaveBeenCalledExactlyOnceWith({
        parent: 'D:/test',
        paths: ['D:/test/report.txt', 'D:/test/folder'],
        confirmed: true,
      }),
    );
    await nextTick();
    expect(remote).not.toHaveBeenCalled();
    expect(
      root.querySelector<HTMLInputElement>('[aria-label="远程文件"] tbody input')!.checked,
    ).toBe(true);
    if (success) {
      expect(document.querySelector('dialog')).toBeNull();
      expect(load).toHaveBeenCalledExactlyOnceWith('D:/test', undefined, 'a');
    } else {
      expect(dialog.open).toBe(true);
      expect(files.error).toBe('回收站不可用');
      expect(load).not.toHaveBeenCalled();
      expect(
        [...root.querySelectorAll<HTMLInputElement>('[aria-label="本地文件"] tbody input')].every(
          (input) => input.checked,
        ),
      ).toBe(true);
    }
  },
);

it.each(['local', 'remote'] as const)(
  'rejects changed targets before confirming %s deletion',
  async (side) => {
    const files = useFilesStore(pinia);
    files.local!.entries = [
      { ...entry, name: 'local.txt', path: 'D:/test/local.txt', kind: 'file' },
    ];
    const recycle = vi.spyOn(filesApi, 'localRecycle').mockResolvedValue();
    const action = vi.spyOn(filesApi, 'action').mockResolvedValue();
    await nextTick();
    const table = root.querySelector<HTMLElement>(
      `[aria-label="${side === 'local' ? '本地' : '远程'}文件"]`,
    )!;
    table.querySelector<HTMLInputElement>('tbody input')!.click();
    await nextTick();
    table
      .querySelector('.file-name')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await nextTick();
    const dialog = document.querySelector<HTMLDialogElement>('dialog')!;
    expect(dialog.open).toBe(true);
    if (side === 'local') files.local!.path = 'D:/different';
    else files.current!.id = 'sftp-replaced';
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await nextTick();
    expect(recycle).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(files.error).toBe('文件操作目标已变化，请重新选择。');
  },
);

it('keeps Delete in directory text inputs as editing and blocks disconnected remote deletion', async () => {
  const files = useFilesStore(pinia);
  const action = vi.spyOn(filesApi, 'action').mockResolvedValue();
  root.querySelector<HTMLInputElement>('[aria-label="远程文件"] tbody input')!.click();
  await nextTick();
  for (const input of root.querySelectorAll<HTMLInputElement>('.path-bar input')) {
    const key = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    input.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
  }
  files.current!.state = 'disconnected';
  root
    .querySelector('[aria-label="远程文件"] .file-name')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await nextTick();
  expect(document.querySelector('dialog')).toBeNull();
  expect(action).not.toHaveBeenCalled();
});

it('hands a Windows drag to the native exporter once it crosses the window edge', async () => {
  vi.stubGlobal('isTauri', true);
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  const files = useFilesStore(pinia);
  const drag = vi.spyOn(filesApi, 'dragDownload').mockResolvedValue(undefined);
  files.current!.listing!.entries = [
    { ...entry, name: 'guide.txt', path: '/srv/api/guide.txt', kind: 'file' },
    { ...entry, name: 'alias.txt', path: '/srv/api/alias.txt', kind: 'symlink' },
    entry,
  ];
  app?.unmount();
  await mountView();

  const rows = [...root.querySelectorAll<HTMLTableRowElement>('[aria-label="远程文件"] tbody tr')];
  const row = (name: string) => rows.find((item) => item.textContent?.includes(name))!;
  const point = (target: EventTarget, name: string, clientX: number) => {
    const event = new MouseEvent(name, { button: 0, buttons: 1, bubbles: true, clientX });
    Object.defineProperties(event, {
      pointerId: { value: 42 },
      pointerType: { value: 'mouse' },
    });
    target.dispatchEvent(event);
  };
  const prepare = (source: HTMLElement) => {
    Object.assign(source, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
    });
    point(source, 'pointerdown', 10);
  };
  row('guide.txt').querySelector('input')!.click();
  await nextTick();
  row('alias.txt').querySelector('input')!.click();
  await nextTick();
  prepare(row('guide.txt'));
  point(window, 'pointermove', 13);
  expect(drag).not.toHaveBeenCalled();
  point(window, 'pointermove', -3);
  point(window, 'pointermove', -30);
  expect(drag).toHaveBeenCalledExactlyOnceWith('sftp-a', [
    '/srv/api/guide.txt',
    '/srv/api/alias.txt',
  ]);
  expect(row('guide.txt').releasePointerCapture).toHaveBeenCalledWith(42);

  prepare(row('config'));
  point(window, 'pointermove', -3);
  expect(drag).toHaveBeenCalledTimes(1);
  expect(files.error).toContain('须为文件或文件链接');
});

it.each([
  ['\\\\?\\C:\\Users\\示例\\Documents', 'C:\\Users\\示例\\Documents'],
  ['\\\\?\\UNC\\server\\share\\资料', '\\\\server\\share\\资料'],
  ['\\\\?\\Volume{example}\\资料', '\\\\?\\Volume{example}\\资料'],
  ['/home/user/资料', '/home/user/资料'],
])(
  'displays and copies a local path %s without changing the stored path',
  async (path, display) => {
    const files = useFilesStore(pinia);
    const copy = vi.spyOn(clipboardApi, 'writeText').mockResolvedValue(undefined);
    files.local = { path, parent: null, entries: [] };
    await nextTick();
    expect(root.querySelector<HTMLInputElement>('[aria-label="本地路径"]')!.value).toBe(display);
    expect(root.querySelector<HTMLInputElement>('[aria-label="远程路径"]')!.value).toBe('/srv/api');
    root.querySelector<HTMLButtonElement>('[aria-label="复制本地路径"]')!.click();
    expect(copy).toHaveBeenCalledExactlyOnceWith(display);
    expect(files.local.path).toBe(path);
    await nextTick();
    expect(useNotificationsStore(pinia).items).toEqual([
      expect.objectContaining({ text: '绝对路径已复制。', error: false }),
    ]);
    expect(root.querySelector('.banner.success')).toBeNull();
  },
);

it.each([
  ['local', '\\\\?\\C:\\Users\\DingHao\\.hyperframes'],
  ['local', '\\\\?\\UNC\\server\\share\\资料'],
  ['local', '/home/user/资料'],
  ['remote', '/srv/api/config'],
] as const)(
  'omits absolute-path copying from the %s context menu without changing the entry',
  async (side, path) => {
    const files = useFilesStore(pinia);
    const copy = vi.spyOn(clipboardApi, 'writeText').mockResolvedValue(undefined);
    const listing = side === 'local' ? files.local! : files.current!.listing!;
    listing.entries = [{ ...entry, path }];
    await nextTick();
    root
      .querySelector(`[aria-label="${side === 'local' ? '本地' : '远程'}文件"] tbody tr`)!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await nextTick();
    const copyButton = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.trim() === '复制绝对路径',
    );
    expect(copyButton).toBeUndefined();
    expect(copy).not.toHaveBeenCalled();
    expect(listing.entries[0]!.path).toBe(path);
  },
);

it('uses the original path when reopening a displayed long path and accepts a typed new path', async () => {
  const files = useFilesStore(pinia);
  const display = 'D:\\' + '目录123\\'.repeat(48) + '归档';
  const path = '\\\\?\\' + display;
  files.local = { path, parent: null, entries: [] };
  const local = vi
    .spyOn(filesApi, 'local')
    .mockImplementation(async () => ({ path, parent: null, entries: [] }));
  const input = root.querySelector<HTMLInputElement>('[aria-label="本地路径"]')!;
  const form = input.closest('form')!;
  const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const type = (value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  await nextTick();

  expect(input.value).toBe(display);
  submit();
  expect(local).toHaveBeenLastCalledWith(path);
  await vi.waitFor(() => expect(files.localLoading).toBe(false));

  type(path);
  submit();
  await vi.waitFor(() => expect(input.value).toBe(display));

  local.mockResolvedValueOnce({ path: '\\\\?\\D:\\Downloads', parent: null, entries: [] });
  type('D:\\Downloads');
  submit();
  expect(local).toHaveBeenLastCalledWith('D:\\Downloads');
  await vi.waitFor(() => expect(files.local?.path).toBe('\\\\?\\D:\\Downloads'));
  expect(input.value).toBe('D:\\Downloads');
});

it.each([
  ['local', '\\\\?\\C:\\Users\\DH\\.sts4', 'C:\\Users\\DH\\.sts4'],
  ['local', '\\\\?\\UNC\\server\\share\\资料', '\\\\server\\share\\资料'],
  ['remote', '/srv/api/\\\\?\\C:\\directory/file', '/srv/api/\\\\?\\C:\\directory'],
] as const)(
  'opens native local properties or shows the unchanged %s parent',
  async (side, path, expected) => {
    const files = useFilesStore(pinia);
    const listing = side === 'local' ? files.local! : files.current!.listing!;
    const selected = { ...entry, path };
    listing.entries = [selected];
    const properties = vi.spyOn(filesApi, 'properties').mockResolvedValue(selected);
    const nativeProperties = vi.spyOn(filesApi, 'localProperties').mockResolvedValue();
    await nextTick();
    root
      .querySelector(`[aria-label="${side === 'local' ? '本地' : '远程'}文件"] tbody tr`)!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await nextTick();
    [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.trim() === '属性')!
      .click();
    if (side === 'remote')
      await vi.waitFor(() => {
        const details = document.querySelector('.file-properties')!;
        expect([...details.querySelectorAll('dt')].map((item) => item.textContent)).toEqual([
          '位置',
          '大小',
        ]);
        expect(details.querySelector('dd')?.textContent).toBe(expected);
      });
    else {
      expect(nativeProperties).toHaveBeenCalledExactlyOnceWith(path);
      expect(document.querySelector('.file-properties-dialog')).toBeNull();
    }
    expect(listing.entries[0]!.path).toBe(path);
    if (side === 'remote') expect(properties).toHaveBeenCalledExactlyOnceWith('sftp-a', path);
    else expect(properties).not.toHaveBeenCalled();
  },
);

it.each(['local', 'preference', 'picker', 'edited', 'retry'] as const)(
  'formats the %s download destination while preserving the actual transfer path',
  async (source) => {
    const files = useFilesStore(pinia);
    const path = '\\\\?\\D:\\' + '目录123\\'.repeat(48) + '归档';
    const display = path.slice(4);
    files.local = { path, parent: null, entries: [] };
    if (source === 'preference') {
      files.local.path = 'C:\\Users\\DH';
      useApplicationStore(pinia).state = {
        config: { product: { ...defaultProductPreferences(), downloadDirectory: path } },
      } as Bootstrap;
    }
    const start = vi.spyOn(filesApi, 'start').mockRejectedValue({ message: '排队失败' });
    const retry = vi.spyOn(filesApi, 'retry').mockRejectedValue({ message: '排队失败' });
    if (source === 'retry') {
      files.tasks = [
        {
          id: 'download',
          hostId: 'a',
          sessionId: 'sftp-a',
          direction: 'download',
          state: 'failed',
          sources: [entry.path],
          destination: path,
          totalBytes: 0,
          transferredBytes: 0,
          remainingBytes: 0,
          bytesPerSecond: 0,
          elapsedSeconds: 0,
          dragExport: false,
          filesTotal: 0,
          filesDone: 0,
          skipped: 0,
          message: null,
          recoveryPaths: [],
        },
      ];
      await nextTick();
      [...root.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === '传输记录')!
        .click();
      await nextTick();
      document.querySelector<HTMLButtonElement>('dialog .transfer-row button')!.click();
    } else {
      await nextTick();
      root
        .querySelector<HTMLInputElement>('[aria-label="远程文件"] input[type="checkbox"]')!
        .click();
      await nextTick();
      root.querySelector<HTMLButtonElement>('[aria-label="下载选中"]')!.click();
    }
    await nextTick();
    const dialog = document.querySelector<HTMLDialogElement>(
      `dialog[aria-label="${source === 'retry' ? '重试传输' : '确认文件传输'}"]`,
    )!;
    const destination = dialog.querySelector<HTMLInputElement>('[aria-label="传输目标目录"]')!;
    expect(destination.value).toBe(display);
    if (source === 'picker') {
      vi.spyOn(filesApi, 'pick').mockResolvedValue(['\\\\?\\UNC\\server\\share\\下载']);
      [...dialog.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === '选择下载目录')!
        .click();
      await vi.waitFor(() => expect(destination.value).toBe('\\\\server\\share\\下载'));
    } else if (source === 'edited') {
      destination.value = 'D:\\另一个目录';
      destination.dispatchEvent(new Event('input', { bubbles: true }));
    }
    dialog
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    if (source === 'retry') {
      expect(retry).toHaveBeenCalledExactlyOnceWith('download', 'sftp-a', 'skip', false);
      expect(start).not.toHaveBeenCalled();
    } else {
      expect(start).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          direction: 'download',
          sources: [entry.path],
          destination:
            source === 'picker'
              ? '\\\\?\\UNC\\server\\share\\下载'
              : source === 'edited'
                ? 'D:\\另一个目录'
                : path,
        }),
      );
    }
    expect(files.local.path).toBe(source === 'preference' ? 'C:\\Users\\DH' : path);
  },
);

it('sorts each file pane by its clicked header and shows only that pane’s active direction', async () => {
  const files = useFilesStore(pinia);
  const rows: FileEntry[] = [
    { ...entry, name: 'folder' },
    { ...entry, name: 'a', path: '/a', kind: 'file', size: 20, permissions: 0o644, owner: 'z' },
    { ...entry, name: 'b', path: '/b', kind: 'file', size: 10, permissions: 0o600, owner: 'a' },
  ];
  files.local = { path: 'D:/test', parent: null, entries: rows };
  files.current!.listing = { path: '/srv/api', parent: '/srv', entries: rows };
  await nextTick();
  const local = root.querySelector<HTMLTableElement>('[aria-label="本地文件"]')!;
  const remote = root.querySelector<HTMLTableElement>('[aria-label="远程文件"]')!;
  const sort = async (table: HTMLTableElement, label: string, direction: string) => {
    const button = [...table.querySelectorAll<HTMLButtonElement>('th button')].find(
      (item) => item.textContent?.trim() === label,
    )!;
    button.click();
    await nextTick();
    expect(table.querySelectorAll('th[aria-sort]')).toHaveLength(1);
    expect(button.closest('th')?.getAttribute('aria-sort')).toBe(direction);
  };
  const names = (table: HTMLTableElement) =>
    [...table.querySelectorAll<HTMLButtonElement>('tbody .file-name')].map(
      (button) => button.title,
    );
  const headings = (table: HTMLTableElement) =>
    [...table.querySelectorAll('th button')].map((button) => button.textContent?.trim());

  expect(root.querySelector('.file-list-tools select')).toBeNull();
  expect(headings(local)).toEqual(['名称', '大小', '类型', '修改时间']);
  expect(headings(remote)).toEqual(['名称', '大小', '类型', '修改时间', '权限', '拥有者']);
  for (const table of [local, remote]) {
    const cells = [...table.tBodies[0]!.rows[1]!.cells];
    expect(cells.slice(2, 5).map((cell) => cell.textContent?.trim())).toEqual([
      '20 B',
      '文件',
      '—',
    ]);
  }
  expect(names(local)).toEqual(['folder', 'a', 'b']);
  await sort(local, '大小', 'ascending');
  expect(names(local)).toEqual(['folder', 'b', 'a']);
  expect(names(remote)).toEqual(['folder', 'a', 'b']);
  await sort(local, '大小', 'descending');
  expect(names(local)).toEqual(['folder', 'a', 'b']);
  await sort(remote, '权限', 'ascending');
  expect(names(remote)).toEqual(['folder', 'b', 'a']);
  await sort(remote, '拥有者', 'ascending');
  expect(names(remote)).toEqual(['folder', 'b', 'a']);
  await sort(remote, '拥有者', 'descending');
  expect(names(remote)).toEqual(['folder', 'a', 'b']);
  expect(local.querySelector('th[aria-sort="descending"]')?.textContent?.trim()).toBe('大小');
});

it('filters hidden remote files and folders and removes them from the active selection', async () => {
  const files = useFilesStore(pinia);
  const hiddenFile = { ...entry, name: '.env', path: '/srv/api/.env', kind: 'file' } as const;
  const hiddenFolder = { ...entry, name: '.git', path: '/srv/api/.git' };
  files.current!.listing!.entries = [hiddenFile, hiddenFolder];
  files.local!.entries = [{ ...hiddenFile, path: 'D:/test/.env' }];
  await nextTick();
  const remote = root.querySelector<HTMLTableElement>('[aria-label="远程文件"]')!;
  const pane = remote.closest('.file-side')!;
  const toggle = pane.querySelector<HTMLButtonElement>(
    '.toolbar .tool-button[aria-label="显示隐藏项"]',
  )!;
  expect(toggle.textContent?.trim()).toBe('');
  expect(toggle.querySelector('svg')).not.toBeNull();
  expect(toggle.title).toBe('显示隐藏项');
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(remote.querySelectorAll('tbody tr')).toHaveLength(0);
  expect(pane.textContent).toContain('当前目录只有隐藏项');
  expect(root.querySelector('[aria-label="本地文件"] [aria-label="选择 .env"]')).not.toBeNull();

  files.current!.listing!.entries.push(entry);
  await nextTick();
  expect(pane.querySelector('.file-list-tools')?.textContent?.trim()).toBe('1 项 · 0 已选');
  toggle.click();
  await nextTick();
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(remote.querySelectorAll('tbody tr')).toHaveLength(3);
  remote.querySelector<HTMLInputElement>('[aria-label="全选当前页远程文件"]')!.click();
  await nextTick();
  expect(pane.querySelector('.file-list-tools')?.textContent?.trim()).toBe('3 项 · 3 已选');

  toggle.click();
  await nextTick();
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(pane.querySelector('.file-list-tools')?.textContent?.trim()).toBe('1 项 · 1 已选');
  const download = [...pane.querySelectorAll<HTMLButtonElement>('.toolbar button')].find(
    (button) => button.getAttribute('aria-label') === '下载选中',
  )!;
  download.click();
  await nextTick();
  expect(document.querySelector('dialog .file-path-preview')?.textContent).toBe('/srv/api/config');
});

it('uses the existing SFTP connection to navigate and keeps it alive when the page unmounts', async () => {
  const list = vi
    .spyOn(filesApi, 'list')
    .mockResolvedValue({ path: '/srv/api/config', parent: '/srv/api', entries: [] });
  const close = vi.spyOn(filesApi, 'close');
  root.querySelector('.file-name')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await vi.waitFor(() => expect(useFilesStore(pinia).current?.path).toBe('/srv/api/config'));
  expect(list).toHaveBeenCalledWith('sftp-a', '/srv/api/config');
  expect(root.querySelector('[aria-label="本地路径"]')).not.toBeNull();
  expect(root.querySelector('[aria-label="选择上传文件…"]')).not.toBeNull();
  app!.unmount();
  app = undefined;
  expect(close).not.toHaveBeenCalled();
  expect(useFilesStore(pinia).connections.a?.id).toBe('sftp-a');
  expect(release).toHaveBeenCalled();
});

it('routes mouse back and forward to the hovered pane and consumes them at the history boundary', async () => {
  const local = vi.spyOn(filesApi, 'local').mockImplementation(async (path) => ({
    path: path ?? 'D:/test',
    parent: null,
    entries: [],
  }));
  const list = vi
    .spyOn(filesApi, 'list')
    .mockImplementation(async (_id, path) => ({ path, parent: null, entries: [] }));
  const localInput = root.querySelector<HTMLInputElement>('[aria-label="本地路径"]')!;
  const remoteInput = root.querySelector<HTMLInputElement>('[aria-label="远程路径"]')!;
  const sideButton = (element: Element, button: number) =>
    element.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true, cancelable: true }));

  expect(sideButton(remoteInput, 3)).toBe(false);
  expect(list).not.toHaveBeenCalled();
  expect(sideButton(remoteInput, 1)).toBe(true);
  localInput.value = 'D:/new';
  localInput.dispatchEvent(new Event('input', { bubbles: true }));
  localInput.form!.dispatchEvent(new Event('submit', { cancelable: true }));
  root
    .querySelector('[aria-label="远程文件"] .file-name')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await vi.waitFor(() => {
    expect(useFilesStore(pinia).local?.path).toBe('D:/new');
    expect(remoteInput.value).toBe('/srv/api/config');
  });

  expect(sideButton(localInput, 3)).toBe(false);
  await vi.waitFor(() => expect(localInput.value).toBe('D:/test'));
  expect(remoteInput.value).toBe('/srv/api/config');
  expect(sideButton(remoteInput, 3)).toBe(false);
  await vi.waitFor(() => expect(remoteInput.value).toBe('/srv/api'));
  expect(localInput.value).toBe('D:/test');
  expect(sideButton(localInput, 3)).toBe(false);
  expect(local).toHaveBeenCalledTimes(2);

  expect(sideButton(localInput, 4)).toBe(false);
  expect(sideButton(remoteInput, 4)).toBe(false);
  await vi.waitFor(() => {
    expect(localInput.value).toBe('D:/new');
    expect(remoteInput.value).toBe('/srv/api/config');
  });
});

it('displays conventional upload paths and submits the original paths after conflict confirmation', async () => {
  const sources = ['\\\\?\\D:\\test\\release.tar.gz', '\\\\?\\UNC\\server\\share\\资料.txt'];
  vi.spyOn(filesApi, 'pick').mockResolvedValue(sources);
  const start = vi.spyOn(filesApi, 'start').mockRejectedValue({ message: '传输排队失败' });
  root.querySelector<HTMLButtonElement>('[aria-label="选择上传文件…"]')!.click();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog[aria-label="确认文件传输"]')).not.toBeNull(),
  );
  const dialog = document.querySelector('dialog[aria-label="确认文件传输"]')!;
  expect(dialog.textContent).toContain('API');
  expect(dialog.querySelector('.file-path-preview')?.textContent).toBe(
    'D:\\test\\release.tar.gz\n\\\\server\\share\\资料.txt',
  );
  expect(dialog.querySelector<HTMLInputElement>('[aria-label="传输目标目录"]')?.value).toBe(
    '/srv/api',
  );
  expect(start).not.toHaveBeenCalled();
  const conflict = dialog.querySelector<HTMLSelectElement>('[aria-label="冲突处理"]')!;
  expect([...conflict.options].map((option) => option.value)).toEqual([
    'fail',
    'skip',
    'overwrite',
  ]);
  expect(conflict.value).toBe('fail');
  conflict.value = 'overwrite';
  conflict.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  const confirm = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const submit = dialog.querySelector<HTMLButtonElement>('button.primary')!;
  expect(confirm.required).toBe(true);
  submit.click();
  expect(start).not.toHaveBeenCalled();
  confirm.click();
  submit.click();
  expect(start).toHaveBeenCalledExactlyOnceWith({
    sessionId: 'sftp-a',
    direction: 'upload',
    sources,
    destination: '/srv/api',
    conflict: 'overwrite',
    confirmOverwrite: true,
  });
  await vi.waitFor(() => expect(useFilesStore(pinia).error).toBe('传输排队失败'));
});

it('keeps failures retryable and retains the established endpoint when host settings change', async () => {
  const files = useFilesStore(pinia),
    hosts = useHostsStore(pinia);
  hosts.catalog!.hosts[0] = { ...hosts.catalog!.hosts[0]!, hostname: 'changed.example' };
  const list = vi
    .spyOn(filesApi, 'list')
    .mockRejectedValue({ code: 'SFTP_NETWORK', message: '连接中断' });
  root.querySelector<HTMLButtonElement>('[aria-label="刷新远程"]')!.click();
  await vi.waitFor(() => expect(files.current?.state).toBe('failed'));
  expect(list).toHaveBeenCalledWith('sftp-a', '/srv/api');
  expect(files.current?.error).toBe('连接中断');
  await nextTick();
  expect(files.current?.host).toMatchObject({ hostname: '192.0.2.11', username: 'operator' });
  expect(
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === '连接 SFTP',
    )?.disabled,
  ).toBe(false);
});
