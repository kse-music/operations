import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import FilesView from './FilesView.vue';
import { useFilesStore } from '../stores/files';
import { useHostsStore } from '../stores/hosts';
import { clipboardApi } from '../services/clipboard';
import { filesApi } from '../services/files';
import { hostInput } from '../types/hosts';
import type { DirectoryListing, FileEntry } from '../types/files';

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
async function mountView() {
  app = createApp(FilesView, { hostId: 'a' }).use(pinia);
  app.mount(root);
  await nextTick();
}
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
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  await mountView();
});
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
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
    const transfer = [...toolbar.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes(side === 'local' ? '上传选中' : '下载选中'),
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
  { names: ['config'], recursive: true },
  { names: ['guide.txt', 'config'], recursive: true },
  { names: ['guide.txt'], recursive: false },
])('confirms deletion of $names with recursive=$recursive', async ({ names, recursive }) => {
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
    remove.click();
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
  },
);

it.each([
  ['local', '\\\\?\\C:\\Users\\DingHao\\.hyperframes', 'C:\\Users\\DingHao\\.hyperframes'],
  ['local', '\\\\?\\UNC\\server\\share\\资料', '\\\\server\\share\\资料'],
  ['local', '/home/user/资料', '/home/user/资料'],
  ['remote', '/srv/api/config', '/srv/api/config'],
] as const)(
  'copies the displayed %s entry path from its context menu',
  async (side, path, display) => {
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
    )!;
    copyButton.click();
    expect(copy).toHaveBeenCalledExactlyOnceWith(display);
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
