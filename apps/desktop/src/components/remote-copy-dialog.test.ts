import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import RemoteCopyDialog from './RemoteCopyDialog.vue';
import { filesApi } from '../services/files';
import { terminalApi } from '../services/terminal';
import { useFilesStore } from '../stores/files';
import { useHostsStore } from '../stores/hosts';
import { hostInput } from '../types/hosts';
import type { DirectoryListing, TransferInfo } from '../types/files';

let app: App, root: HTMLElement, pinia: Pinia;
const started = vi.fn(),
  close = vi.fn();
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalPopover = ['showPopover', 'hidePopover'].map(
  (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
);
const task = {
  id: 'operation',
  sessionId: 'original-session',
  hostId: 'original-host',
  remoteCopy: true,
  sources: ['/work/source.txt'],
  destination: '/target',
  remoteName: 'copy.txt',
  direction: 'upload',
  state: 'queued',
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
} as TransferInfo;
const dialog = () => document.querySelector<HTMLDialogElement>('dialog')!;
const field = (text: string) =>
  [...dialog().querySelectorAll('label')].find(
    (label) => label.firstChild?.textContent?.trim() === text,
  )!.control as HTMLInputElement | HTMLButtonElement;
const tree = () => dialog().querySelector<HTMLElement>('.remote-directory-tree')!;
const treeRow = (path: string) =>
  [...tree().querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
    (row) => row.dataset.path === path,
  )!;
const button = (container: Element, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  )!;
const listing = (path: string, children: string[] = []): DirectoryListing => ({
  path,
  parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
  entries: children.map((name) => ({
    name,
    path: `${path === '/' ? '' : path}/${name}`,
    kind: 'directory',
    size: null,
    modified: null,
    permissions: null,
    uid: null,
    gid: null,
  })),
});
async function input(label: string, value: string) {
  const element = field(label);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}
async function chooseDirectory(path: string) {
  await vi.waitFor(() => expect((field('目标目录') as HTMLButtonElement).disabled).toBe(false));
  if (field('目标目录').getAttribute('aria-expanded') !== 'true') field('目标目录').click();
  await nextTick();
  if (path === '/') {
    await vi.waitFor(() => expect(treeRow('/')).toBeDefined());
    button(tree(), '/').click();
  } else {
    let prefix = '';
    const segments = path.slice(1).split('/');
    for (let index = 0; index < segments.length; index++) {
      prefix += `/${segments[index]}`;
      await vi.waitFor(() => expect(treeRow(prefix)).toBeDefined());
      if (index === segments.length - 1) button(treeRow(prefix), segments[index]!).click();
      else if (treeRow(prefix).getAttribute('aria-expanded') !== 'true') {
        treeRow(prefix).querySelector<HTMLButtonElement>('.directory-toggle')!.click();
        await nextTick();
      }
    }
  }
  await nextTick();
}
async function mount(
  sources = ['/work/source.txt'],
  retry?: TransferInfo,
  target: string | null = 'original-host',
) {
  app = createApp(RemoteCopyDialog, {
    sessionId: 'original-session',
    sourceHostId: 'original-host',
    host: 'Original host',
    sources,
    directory: retry?.destination ?? '/work',
    retry,
    onStarted: started,
    onClose: close,
  }).use(pinia);
  app.mount(root);
  await nextTick();
  if (!retry && target) {
    const select = dialog().querySelector('select')!;
    select.value = target;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();
  }
}
async function submit() {
  dialog()
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await nextTick();
}
beforeEach(() => {
  started.mockReset();
  close.mockReset();
  pinia = createPinia();
  for (const [name] of originalPopover)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value() {} });
  const folders: Record<string, string[]> = {
    '/': ['target', 'work', 'destination', 'typed'],
    '/work': ['folder'],
    '/work/folder': ['sub'],
  };
  vi.spyOn(filesApi, 'list').mockImplementation(async (_id, path) =>
    listing(path, folders[path] ?? []),
  );
  const source = {
    ...hostInput(),
    id: 'original-host',
    name: 'Source',
    hostname: 'source.example',
    username: 'reader',
    createdAt: '',
    updatedAt: '',
  };
  const target = {
    ...hostInput(),
    id: 'target-host',
    name: 'Target',
    hostname: 'target.example',
    username: 'writer',
    createdAt: '',
    updatedAt: '',
  };
  useHostsStore(pinia).catalog = {
    hosts: [source, target],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  const files = useFilesStore(pinia);
  files.active = source.id;
  files.connections[source.id] = {
    host: source,
    id: 'original-session',
    state: 'connected',
    error: null,
    trust: null,
    path: '/work',
    listing: null,
    loading: false,
  };
  files.connections[target.id] = {
    host: target,
    id: 'target-session',
    state: 'connected',
    error: null,
    trust: null,
    path: '/destination',
    listing: null,
    loading: false,
  };
  vi.spyOn(filesApi, 'tasks').mockResolvedValue([task]);
  vi.spyOn(filesApi, 'connections').mockResolvedValue([
    {
      id: 'original-session',
      hostId: source.id,
      transportId: 'source-transport',
      routeHostIds: [],
    },
    { id: 'target-session', hostId: target.id, transportId: 'target-transport', routeHostIds: [] },
  ]);
  root = document.createElement('div');
  document.body.append(root);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
});
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root.remove();
  vi.restoreAllMocks();
  for (const [name, descriptor] of originalPopover) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});

it('copies to an explicit directory and new name under the original identity', async () => {
  const start = vi.spyOn(filesApi, 'remoteCopy').mockResolvedValue(task);
  await mount();
  expect(button(dialog(), '确认').title).toBe('请选择目标目录。');
  expect(dialog().querySelector('form > .error-text')).toBeNull();
  await submit();
  expect(start).not.toHaveBeenCalled();
  await chooseDirectory('/target');
  await input('目标名称', '中文;$(id).txt');
  await submit();
  await vi.waitFor(() => expect(started).toHaveBeenCalledWith(task));
  expect(start).toHaveBeenCalledExactlyOnceWith({
    sessionId: 'original-session',
    targetSessionId: 'original-session',
    sources: ['/work/source.txt'],
    destination: '/target',
    name: '中文;$(id).txt',
    conflict: 'fail',
    confirmed: true,
    confirmOverwrite: false,
  });
  expect(close).toHaveBeenCalledOnce();
});

it('requires selecting a host and copies identical paths between separate servers', async () => {
  const start = vi.spyOn(filesApi, 'remoteCopy').mockResolvedValue(task);
  await mount(['/work/source.txt'], undefined, null);
  expect(button(dialog(), '确认').title).toBe('请选择目标主机。');
  await submit();
  expect(start).not.toHaveBeenCalled();
  const select = dialog().querySelector('select')!;
  expect(select.textContent).toContain('writer@target.example');
  select.value = 'target-host';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  expect(field('目标目录').value).toBe('');
  await chooseDirectory('/work');
  await submit();
  expect(start).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sessionId: 'original-session',
      targetSessionId: 'target-session',
      sources: ['/work/source.txt'],
      destination: '/work',
    }),
  );
  expect(useFilesStore(pinia).active).toBe('original-host');
});

it('automatically connects a selected host and confirms its fingerprint without switching the source', async () => {
  const files = useFilesStore(pinia);
  delete files.connections['target-host'];
  const connect = vi.spyOn(files, 'open').mockImplementation(async (host) => {
    files.connections[host.id] = {
      host,
      id: 'untrusted-target',
      state: 'awaiting_trust',
      error: null,
      trust: {
        type: 'trust',
        hostname: 'target.example',
        port: 22,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:target-key',
      },
      path: '.',
      listing: null,
      loading: false,
    };
  });
  const trust = vi.spyOn(terminalApi, 'trust').mockResolvedValue(undefined);
  const start = vi.spyOn(filesApi, 'remoteCopy').mockResolvedValue(task);
  await mount(['/work/source.txt'], undefined, 'target-host');
  expect(connect).toHaveBeenCalledOnce();
  expect(
    [...dialog().querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === '连接',
    ),
  ).toBe(false);
  await vi.waitFor(() => expect(dialog().textContent).toContain('SHA256:target-key'));
  expect(connect).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'target-host' }),
    undefined,
    undefined,
    { background: true },
  );
  await submit();
  expect(start).not.toHaveBeenCalled();
  [...dialog().querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '已核对，信任并连接')!
    .click();
  await vi.waitFor(() => expect(trust).toHaveBeenCalledExactlyOnceWith('untrusted-target', true));
  expect(files.active).toBe('original-host');
});

it('refuses a replacement target identity until the current connection is explicitly selected', async () => {
  const start = vi.spyOn(filesApi, 'remoteCopy').mockResolvedValue(task);
  await mount(['/work/source.txt'], undefined, 'target-host');
  const files = useFilesStore(pinia);
  files.connections['target-host']!.id = 'replacement';
  await nextTick();
  await submit();
  expect(start).not.toHaveBeenCalled();
  expect(button(dialog(), '确认').title).toBe('目标连接尚未就绪。');
  const select = dialog().querySelector('select')!;
  select.value = 'original-host';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  select.value = 'target-host';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  await chooseDirectory('/target');
  await submit();
  expect(start).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ targetSessionId: 'replacement' }),
  );
});

it('copies multiple frozen paths and requires explicit overwrite confirmation', async () => {
  const start = vi.spyOn(filesApi, 'remoteCopy').mockResolvedValue(task);
  await mount(['/work/a', '/work/folder']);
  expect(dialog().textContent).toContain('2 个选中项目');
  expect(
    [...dialog().querySelectorAll('label')].some((label) =>
      label.textContent?.startsWith('目标名称'),
    ),
  ).toBe(false);
  await chooseDirectory('/target');
  const select = dialog().querySelectorAll('select')[1]!;
  select.value = 'overwrite';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  await submit();
  expect(start).not.toHaveBeenCalled();
  dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  await nextTick();
  await submit();
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      name: null,
      sources: ['/work/a', '/work/folder'],
      conflict: 'overwrite',
      confirmOverwrite: true,
    }),
  );
});

it('rejects overlapping source and destination paths before queueing', async () => {
  const start = vi.spyOn(filesApi, 'remoteCopy').mockResolvedValue(task);
  await mount(['/work/folder']);
  await chooseDirectory('/work/folder/sub');
  await submit();
  expect(start).not.toHaveBeenCalled();
  expect(button(dialog(), '确认').title).toContain('源项目的内部');
  expect(dialog().querySelector('form > .error-text')).toBeNull();
});

it('preserves the chosen target and shows errors when queue registration fails', async () => {
  vi.spyOn(filesApi, 'remoteCopy').mockRejectedValue({ message: '会话已关闭' });
  await mount();
  await chooseDirectory('/target');
  await input('目标名称', 'new.txt');
  await submit();
  await vi.waitFor(() =>
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('会话已关闭'),
  );
  expect(field('目标目录').value).toBe('/target');
  expect(field('目标名称').value).toBe('new.txt');
  expect(started).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it('retries an existing copy without changing its frozen target', async () => {
  const retry = vi.spyOn(filesApi, 'remoteCopy').mockResolvedValue(task);
  await mount(task.sources, task);
  expect((field('目标目录') as HTMLButtonElement).disabled).toBe(true);
  expect(field('目标目录').value).toBe('/target');
  expect(field('目标名称').value).toBe('copy.txt');
  await submit();
  await vi.waitFor(() =>
    expect(retry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: 'original-session',
        targetSessionId: 'original-session',
        name: 'copy.txt',
        destination: '/target',
        conflict: 'skip',
        confirmOverwrite: false,
      }),
    ),
  );
});

it('opens a one-level dropdown tree and copies its chosen directory only on confirmation', async () => {
  const load = vi.spyOn(filesApi, 'list').mockImplementation(async (_id, path) => {
    const result = listing(
      path,
      path === '/' ? ['destination', '.hidden'] : path === '/destination' ? ['中文 文件夹'] : [],
    );
    result.entries.push(
      { ...listing('/', ['excluded']).entries[0]!, name: 'file.txt', kind: 'file' },
      { ...listing('/', ['excluded']).entries[0]!, name: 'link', kind: 'symlink' },
    );
    return result;
  });
  const start = vi.spyOn(filesApi, 'remoteCopy').mockResolvedValue(task);
  await mount(['/work/source.txt'], undefined, 'target-host');
  expect(dialog().textContent).not.toContain('中途失败或取消不会回退已完成的项目。');
  expect(dialog().textContent).not.toContain('浏览');
  expect(dialog().querySelector('.remote-copy-field input')).toBeNull();
  expect(field('目标目录').tagName).toBe('BUTTON');
  expect(field('目标目录').getAttribute('role')).toBe('combobox');
  await submit();
  expect(start).not.toHaveBeenCalled();
  field('目标目录').click();
  await vi.waitFor(() => expect(tree()?.querySelectorAll('[role="treeitem"]')).toHaveLength(3));
  expect(document.querySelectorAll('dialog')).toHaveLength(1);
  expect(tree().closest('[popover]')).not.toBeNull();
  expect(load).toHaveBeenCalledExactlyOnceWith('target-session', '/');
  expect(treeRow('/destination').getAttribute('aria-expanded')).toBe('false');
  expect(tree().textContent).not.toContain('file.txt');
  expect(tree().textContent).not.toContain('link');
  treeRow('/destination').querySelector<HTMLButtonElement>('.directory-toggle')!.click();
  await vi.waitFor(() => expect(tree()?.querySelectorAll('[role="treeitem"]')).toHaveLength(4));
  expect(load).toHaveBeenLastCalledWith('target-session', '/destination');
  expect(treeRow('/destination/中文 文件夹').getAttribute('aria-expanded')).toBe('false');
  button(tree(), '中文 文件夹').click();
  await nextTick();
  expect(tree()).toBeNull();
  expect(field('目标目录').getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(field('目标目录'));
  expect(field('目标目录').value).toBe('/destination/中文 文件夹');
  expect(start).not.toHaveBeenCalled();
  const files = useFilesStore(pinia);
  expect(files.active).toBe('original-host');
  expect(files.connections['original-host']!.path).toBe('/work');
  expect(files.connections['target-host']!.path).toBe('/destination');
  expect(files.connections['target-host']!.listing).toBeNull();
  button(dialog(), '确认').click();
  await vi.waitFor(() =>
    expect(start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        targetSessionId: 'target-session',
        destination: '/destination/中文 文件夹',
      }),
    ),
  );
});

it('can refresh an empty dropdown tree and select the remote root', async () => {
  const load = vi.spyOn(filesApi, 'list').mockImplementation(async (_id, path) => listing(path));
  await mount(['/work/source.txt'], undefined, 'target-host');
  field('目标目录').click();
  await vi.waitFor(() => expect(tree()?.textContent).toContain('没有子文件夹'));
  tree().querySelector<HTMLButtonElement>('[aria-label="刷新目录"]')!.click();
  await nextTick();
  await vi.waitFor(() => expect(treeRow('/').getAttribute('aria-busy')).toBe('false'));
  expect(load.mock.calls).toEqual([
    ['target-session', '/'],
    ['target-session', '/'],
  ]);
  button(tree(), '/').click();
  await nextTick();
  expect(tree()).toBeNull();
  expect(field('目标目录').value).toBe('/');
});

it('keeps the selected destination when a branch cannot load and supports retry and dismissal', async () => {
  await mount(['/work/source.txt'], undefined, 'target-host');
  await chooseDirectory('/typed');
  const load = vi
    .mocked(filesApi.list)
    .mockReset()
    .mockResolvedValueOnce(listing('/', ['blocked']))
    .mockRejectedValueOnce({ message: '没有读取权限' })
    .mockResolvedValue(listing('/blocked'));
  field('目标目录').click();
  await vi.waitFor(() => expect(tree()?.querySelectorAll('[role="treeitem"]')).toHaveLength(2));
  treeRow('/blocked').querySelector<HTMLButtonElement>('.directory-toggle')!.click();
  await vi.waitFor(() =>
    expect(tree().querySelector('[role="alert"]')?.textContent).toContain('没有读取权限'),
  );
  expect(field('目标目录').value).toBe('/typed');
  button(tree(), '重试').click();
  await nextTick();
  await vi.waitFor(() => expect(tree().textContent).toContain('没有子文件夹'));
  expect(load).toHaveBeenNthCalledWith(3, 'target-session', '/blocked');
  field('目标目录').click();
  await nextTick();
  expect(tree()).toBeNull();
  expect(field('目标目录').value).toBe('/typed');
  expect(close).not.toHaveBeenCalled();
});

it.each(['host', 'identity', 'hide'] as const)(
  'discards an in-flight directory response after %s changes',
  async (change) => {
    let respond!: (value: DirectoryListing) => void;
    vi.spyOn(filesApi, 'list').mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    await mount(['/work/source.txt'], undefined, 'target-host');
    field('目标目录').click();
    await nextTick();
    expect(tree().querySelector('[role="status"]')?.textContent).toBe('正在读取目录…');
    if (change === 'host') {
      const select = dialog().querySelector('select')!;
      select.value = 'original-host';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (change === 'identity')
      useFilesStore(pinia).connections['target-host']!.id = 'replacement';
    else field('目标目录').click();
    await nextTick();
    expect(tree()).toBeNull();
    const destination = field('目标目录').value;
    respond(listing('/', ['wrong-host']));
    await nextTick();
    await nextTick();
    expect(tree()).toBeNull();
    expect(field('目标目录').value).toBe(destination);
  },
);

it('keeps a loading branch collapsed and reuses its result when expanded again', async () => {
  let respond!: (value: DirectoryListing) => void;
  const load = vi
    .spyOn(filesApi, 'list')
    .mockResolvedValueOnce(listing('/', ['destination']))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
  await mount(['/work/source.txt'], undefined, 'target-host');
  field('目标目录').click();
  await vi.waitFor(() => expect(tree()?.querySelectorAll('[role="treeitem"]')).toHaveLength(2));
  const toggle = treeRow('/destination').querySelector<HTMLButtonElement>('.directory-toggle')!;
  toggle.click();
  await nextTick();
  toggle.click();
  await nextTick();
  respond(listing('/destination', ['child']));
  await nextTick();
  await nextTick();
  expect(treeRow('/destination').getAttribute('aria-expanded')).toBe('false');
  expect(tree().textContent).not.toContain('child');
  toggle.click();
  await nextTick();
  expect(treeRow('/destination/child')).toBeDefined();
  expect(load).toHaveBeenCalledTimes(2);
});

it('uses arrow keys to navigate and Enter to select without submitting the copy form', async () => {
  vi.spyOn(filesApi, 'list').mockImplementation(async (_id, path) =>
    listing(path, path === '/' ? ['destination'] : ['child']),
  );
  const start = vi.spyOn(filesApi, 'remoteCopy');
  await mount(['/work/source.txt'], undefined, 'target-host');
  field('目标目录').click();
  await vi.waitFor(() => expect(tree()?.querySelectorAll('[role="treeitem"]')).toHaveLength(2));
  treeRow('/').focus();
  treeRow('/').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
  );
  await nextTick();
  await nextTick();
  expect(document.activeElement).toBe(treeRow('/destination'));
  treeRow('/destination').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(treeRow('/destination/child')).toBeDefined());
  treeRow('/destination').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
  );
  await nextTick();
  expect(treeRow('/destination').getAttribute('aria-expanded')).toBe('false');
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  treeRow('/destination').dispatchEvent(enter);
  await nextTick();
  expect(enter.defaultPrevented).toBe(true);
  expect(field('目标目录').value).toBe('/destination');
  expect(tree()).toBeNull();
  expect(start).not.toHaveBeenCalled();
});

it('drops loading child results when refreshing the root and restores the one-level tree', async () => {
  let respond!: (value: DirectoryListing) => void;
  const load = vi
    .spyOn(filesApi, 'list')
    .mockResolvedValueOnce(listing('/', ['old']))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    )
    .mockResolvedValueOnce(listing('/', ['new']));
  await mount(['/work/source.txt'], undefined, 'target-host');
  field('目标目录').click();
  await vi.waitFor(() => expect(treeRow('/old')).toBeDefined());
  treeRow('/old').querySelector<HTMLButtonElement>('.directory-toggle')!.click();
  await nextTick();
  tree().querySelector<HTMLButtonElement>('[aria-label="刷新目录"]')!.click();
  await vi.waitFor(() => expect(treeRow('/new')).toBeDefined());
  respond(listing('/old', ['stale']));
  await nextTick();
  await nextTick();
  expect(treeRow('/old')).toBeUndefined();
  expect(tree().textContent).not.toContain('stale');
  expect(treeRow('/new').getAttribute('aria-expanded')).toBe('false');
  expect(load.mock.calls.map((call) => call[1])).toEqual(['/', '/old', '/']);
  expect(field('目标目录').value).toBe('');
});

it('rejects a directory that resolves to a different path without changing the destination', async () => {
  vi.spyOn(filesApi, 'list')
    .mockResolvedValueOnce(listing('/', ['changed']))
    .mockResolvedValueOnce(listing('/elsewhere', ['unexpected']));
  await mount(['/work/source.txt'], undefined, 'target-host');
  field('目标目录').click();
  await vi.waitFor(() => expect(treeRow('/changed')).toBeDefined());
  treeRow('/changed').querySelector<HTMLButtonElement>('.directory-toggle')!.click();
  await vi.waitFor(() =>
    expect(tree().querySelector('[role="alert"]')?.textContent).toContain('目录路径已变化'),
  );
  expect(tree().textContent).not.toContain('unexpected');
  expect(field('目标目录').value).toBe('');
});

it('does not accept typed destinations and requires an explicit dropdown selection', async () => {
  const start = vi.spyOn(filesApi, 'remoteCopy');
  await mount(['/work/source.txt'], undefined, 'target-host');
  const control = field('目标目录');
  expect(control.tagName).toBe('BUTTON');
  control.value = '/target';
  control.dispatchEvent(new Event('input', { bubbles: true }));
  await submit();
  expect(start).not.toHaveBeenCalled();
  expect(control.textContent).toContain('请选择目标目录');
  expect(dialog().querySelector('.remote-copy-field input')).toBeNull();
});

it('closes the dropdown with Esc and native light dismissal without closing the copy dialog', async () => {
  await mount(['/work/source.txt'], undefined, 'target-host');
  await chooseDirectory('/target');
  field('目标目录').click();
  await vi.waitFor(() => expect(treeRow('/')).toBeDefined());
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  treeRow('/').dispatchEvent(escape);
  await nextTick();
  expect(escape.defaultPrevented).toBe(true);
  expect(tree()).toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(field('目标目录').value).toBe('/target');
  field('目标目录').click();
  await vi.waitFor(() => expect(treeRow('/')).toBeDefined());
  const dismiss = new Event('beforetoggle');
  Object.defineProperty(dismiss, 'newState', { value: 'closed' });
  dialog().querySelector('[popover]')!.dispatchEvent(dismiss);
  await nextTick();
  expect(tree()).toBeNull();
  expect(field('目标目录').getAttribute('aria-expanded')).toBe('false');
  expect(field('目标目录').value).toBe('/target');
});

it('disables directory selection while automatically connecting the selected host', async () => {
  const files = useFilesStore(pinia);
  delete files.connections['target-host'];
  vi.spyOn(files, 'open').mockImplementation(async (host) => {
    files.connections[host.id] = {
      host,
      state: 'opening',
      error: null,
      trust: null,
      path: '.',
      listing: null,
      loading: false,
    };
  });
  const load = vi.spyOn(filesApi, 'list');
  await mount(['/work/source.txt'], undefined, 'target-host');
  expect((field('目标目录') as HTMLButtonElement).disabled).toBe(true);
  expect(load).not.toHaveBeenCalled();
  expect(dialog().querySelector('[role="status"]')?.textContent).toContain('连接中');
  expect(dialog().querySelector('form > .error-text')).toBeNull();
  expect(button(dialog(), '确认').disabled).toBe(true);
});

it('reuses an already connected target without opening or navigating it again', async () => {
  const files = useFilesStore(pinia);
  const connect = vi.spyOn(files, 'open');
  await mount(['/work/source.txt'], undefined, 'target-host');
  expect(connect).not.toHaveBeenCalled();
  expect((field('目标目录') as HTMLButtonElement).disabled).toBe(false);
  expect(files.connections['target-host']!.path).toBe('/destination');
  expect(files.active).toBe('original-host');
});

it('automatically prepares the original target for retry and freezes its new connection', async () => {
  const files = useFilesStore(pinia);
  delete files.connections['target-host'];
  const connect = vi.spyOn(files, 'open').mockImplementation(async (host) => {
    files.connections[host.id] = {
      host,
      id: 'retry-target',
      state: 'connected',
      error: null,
      trust: null,
      path: '/',
      listing: null,
      loading: false,
    };
  });
  const start = vi.spyOn(filesApi, 'remoteCopy').mockResolvedValue(task);
  await mount(task.sources, {
    ...task,
    remoteTargetHostId: 'target-host',
    remoteTargetSessionId: 'closed-target',
  });
  await vi.waitFor(() => expect(button(dialog(), '确认').disabled).toBe(false));
  expect(connect).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: 'target-host' }),
    undefined,
    undefined,
    { background: true },
  );
  expect((field('目标目录') as HTMLButtonElement).disabled).toBe(true);
  expect(field('目标目录').value).toBe('/target');
  await submit();
  expect(start).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      targetSessionId: 'retry-target',
      destination: '/target',
      conflict: 'skip',
    }),
  );
});

it('ignores a previous target connection finishing after another host has been selected', async () => {
  const files = useFilesStore(pinia);
  delete files.connections['target-host'];
  let finish!: () => void;
  const connect = vi.spyOn(files, 'open').mockImplementation((host) => {
    files.connections[host.id] = {
      host,
      state: 'opening',
      error: null,
      trust: null,
      path: '.',
      listing: null,
      loading: false,
    };
    return new Promise((resolve) => {
      finish = () => {
        files.connections[host.id]!.id = 'late-target';
        files.connections[host.id]!.state = 'connected';
        resolve();
      };
    });
  });
  const start = vi.spyOn(filesApi, 'remoteCopy').mockResolvedValue(task);
  await mount(['/work/source.txt'], undefined, 'target-host');
  const select = dialog().querySelector('select')!;
  select.value = 'original-host';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  await chooseDirectory('/target');
  finish();
  await nextTick();
  await nextTick();
  await submit();
  expect(connect).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ targetSessionId: 'original-session', destination: '/target' }),
  );
  expect(files.active).toBe('original-host');
});

it('shows a connection failure near the host and retries only when requested', async () => {
  const files = useFilesStore(pinia);
  delete files.connections['target-host'];
  const connect = vi
    .spyOn(files, 'open')
    .mockImplementationOnce(async (host) => {
      files.connections[host.id] = {
        host,
        state: 'failed',
        error: '认证失败',
        trust: null,
        path: '.',
        listing: null,
        loading: false,
      };
    })
    .mockImplementationOnce(async (host) => {
      files.connections[host.id] = {
        host,
        id: 'reconnected-target',
        state: 'connected',
        error: null,
        trust: null,
        path: '/',
        listing: null,
        loading: false,
      };
    });
  await mount(['/work/source.txt'], undefined, 'target-host');
  await vi.waitFor(() =>
    expect(dialog().querySelector('.connection-error')?.textContent).toContain('认证失败'),
  );
  expect(connect).toHaveBeenCalledOnce();
  expect((field('目标目录') as HTMLButtonElement).disabled).toBe(true);
  expect(
    dialog().querySelector('footer')?.previousElementSibling?.classList.contains('error-text'),
  ).toBe(false);
  button(dialog().querySelector('.connection-error')!, '重试').click();
  await vi.waitFor(() => expect((field('目标目录') as HTMLButtonElement).disabled).toBe(false));
  expect(connect).toHaveBeenCalledTimes(2);
  expect(dialog().querySelector('.connection-error')).toBeNull();
});

it('reports an acknowledged task after unmount without closing another dialog', async () => {
  let acknowledge!: (value: TransferInfo) => void;
  vi.spyOn(filesApi, 'remoteCopy').mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  await mount();
  await chooseDirectory('/target');
  await submit();
  app.unmount();
  acknowledge(task);
  await vi.waitFor(() => expect(useFilesStore(pinia).tasks).toContainEqual(task));
  expect(started).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});
