import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import FilesView from './FilesView.vue';
import { useFilesStore } from '../stores/files';
import { useHostsStore } from '../stores/hosts';
import { clipboardApi } from '../services/clipboard';
import { filesApi } from '../services/files';
import { hostInput } from '../types/hosts';
import type { FileEntry } from '../types/files';

const release = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => release) }),
}));
let app: App | undefined, pinia: Pinia, root: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
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
beforeEach(async () => {
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
  app = createApp(FilesView, { hostId: 'a' }).use(pinia);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  app.mount(root);
  await nextTick();
});
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root.remove();
  vi.restoreAllMocks();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
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
    (button) => button.textContent?.trim() === '下载选中',
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
