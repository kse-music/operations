import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia, getActivePinia, disposePinia } from 'pinia';
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  list: vi.fn(),
  local: vi.fn(),
  tasks: vi.fn(),
  connections: vi.fn(),
  close: vi.fn(),
  clearTransfers: vi.fn(),
}));
vi.mock('../services/files', () => ({ filesApi: mocks }));
import { useFilesStore } from './files';
import { usePluginsStore } from './plugins';
import type { Host } from '../types/hosts';
import type { TransferInfo, TextDocument } from '../types/files';
import { useNotificationsStore } from './notifications';
const host = { id: 'host', name: 'Actual host' } as Host;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
  mocks.local.mockResolvedValue({ path: 'local', parent: null, entries: [] });
  mocks.connections.mockResolvedValue([]);
  mocks.tasks.mockResolvedValue([]);
  mocks.clearTransfers.mockResolvedValue(undefined);
});

describe('host transfer lifetime', () => {
  it('keeps the connection and records when cancelling the close confirmation', async () => {
    const store = useFilesStore();
    const task = transfer({ state: 'running' });
    mocks.tasks.mockResolvedValue([task]);
    mocks.connections.mockResolvedValue([{ id: 'session', hostId: 'host' }]);
    const ask = vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(false);
    expect(await store.prepareHostClose('host')).toBe(false);
    expect(ask).toHaveBeenCalledWith('取消传输并关闭主机', expect.stringContaining('1 个未完成'));
    expect(store.tasks).toEqual([task]);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.clearTransfers).not.toHaveBeenCalled();
  });
  it('cancels every lease of this host while preserving other host records and sessions', async () => {
    const store = useFilesStore();
    const task = transfer({ state: 'running' });
    const other = transfer({ id: 'other', hostId: 'other', sessionId: 'other-session' });
    mocks.tasks
      .mockResolvedValueOnce([task, other])
      .mockResolvedValue([{ ...task, state: 'cancelled' }, other]);
    mocks.connections.mockResolvedValue([
      { id: 'session', hostId: 'host' },
      { id: 'old-lease', hostId: 'host' },
      { id: 'other-session', hostId: 'other' },
    ]);
    vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(true);
    expect(await store.prepareHostClose('host')).toBe(true);
    expect(mocks.close.mock.calls).toEqual([
      ['session', true],
      ['old-lease', true],
    ]);
    expect(store.tasks).toHaveLength(2);
    expect(await store.clearHostTransfers('host')).toBe(true);
    expect(mocks.clearTransfers).toHaveBeenCalledExactlyOnceWith('host');
    expect(store.tasks).toEqual([other]);
  });
  it('does not ask for confirmation when all transfers are finished', async () => {
    mocks.tasks.mockResolvedValue([transfer()]);
    mocks.connections.mockResolvedValue([{ id: 'session', hostId: 'host' }]);
    const ask = vi.spyOn(usePluginsStore(), 'ask');
    expect(await useFilesStore().prepareHostClose('host')).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith('session', false);
  });
  it('preserves records and reports cancellation or cleanup failures', async () => {
    const store = useFilesStore();
    mocks.tasks.mockResolvedValue([transfer({ state: 'running' })]);
    mocks.connections.mockResolvedValue([{ id: 'session', hostId: 'host' }]);
    vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(true);
    mocks.close.mockRejectedValueOnce({ message: 'cancel failed' });
    expect(await store.prepareHostClose('host')).toBe(false);
    expect(store.error).toBe('cancel failed');
    expect(store.tasks).toHaveLength(1);
    mocks.clearTransfers.mockRejectedValueOnce({ message: 'still running' });
    expect(await store.clearHostTransfers('host')).toBe(false);
    expect(store.error).toBe('still running');
    expect(store.tasks).toHaveLength(1);
  });
  it('rejects a stale poll response after clearing the host history', async () => {
    const store = useFilesStore();
    let finish!: (tasks: TransferInfo[]) => void;
    mocks.tasks.mockImplementationOnce(
      () =>
        new Promise<TransferInfo[]>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = store.poll();
    expect(await store.clearHostTransfers('host')).toBe(true);
    finish([transfer()]);
    await pending;
    expect(store.tasks).toEqual([]);
  });
  it('does not open a new lease during workspace close', async () => {
    const store = useFilesStore();
    store.closingHosts.push(host.id);
    await store.open(host);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('protects an unsaved document before asking to cancel its transfers', async () => {
    const store = useFilesStore();
    store.document = { sessionId: 'session', token: 'document' } as TextDocument;
    store.dirty = true;
    mocks.tasks.mockResolvedValue([transfer({ state: 'running' })]);
    mocks.connections.mockResolvedValue([{ id: 'session', hostId: 'host' }]);
    const ask = vi.spyOn(usePluginsStore(), 'ask');
    expect(await store.prepareHostClose('host')).toBe(false);
    expect(store.error).toContain('保存或关闭');
    expect(store.document.token).toBe('document');
    expect(ask).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it('waits for an in-flight connection and closes it before forgetting the host', async () => {
    let finish!: (value: { id: string }) => void;
    mocks.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const store = useFilesStore();
    const open = store.open(host);
    store.closingHosts.push(host.id);
    const close = store.prepareHostClose(host.id);
    expect(mocks.close).not.toHaveBeenCalled();
    finish({ id: 'late-session' });
    await open;
    expect(await close).toBe(true);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith('late-session', false);
  });
});
afterEach(() => {
  disposePinia(getActivePinia()!);
  vi.useRealTimers();
});
describe('file workspace ownership', () => {
  it('opens through the real IPC boundary and never disconnects just because the page changes', async () => {
    mocks.open.mockImplementation(async (_host, receive) => {
      receive({ type: 'state', state: 'connected' });
      return { id: 'session' };
    });
    mocks.list.mockResolvedValue({ path: '/home/user', parent: '/home', entries: [] });
    const store = useFilesStore();
    await store.open(host);
    expect(store.current?.state).toBe('connected');
    expect(mocks.list).toHaveBeenCalledWith('session', '.');
    expect(store.current?.path).toBe('/home/user');
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it('does not replace a newer directory response with stale in-flight navigation', async () => {
    mocks.open.mockImplementation(async (_host, receive) => {
      receive({ type: 'state', state: 'connected' });
      return { id: 'session' };
    });
    mocks.list.mockResolvedValue({ path: '/home', parent: '/', entries: [] });
    const store = useFilesStore();
    await store.open(host);
    let finish: (value: unknown) => void = () => {};
    mocks.list
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({ path: '/new', parent: '/', entries: [] });
    const slow = store.navigate('/old');
    await store.navigate('/new');
    finish({ path: '/old', parent: '/', entries: [] });
    await slow;
    expect(store.current?.path).toBe('/new');
    expect(store.stepHistory('remote', 'back')).toBe(true);
    await vi.waitFor(() => expect(store.current?.path).toBe('/home'));
    expect(store.stepHistory('remote', 'back')).toBe(false);
  });

  it('keeps remote history on each connection and discards it when the connection is replaced', async () => {
    mocks.open.mockImplementation(async (hostId, receive) => {
      receive({ type: 'state', state: 'connected' });
      return { id: `session-${hostId}` };
    });
    mocks.list.mockImplementation(async (_id, path) => ({ path, parent: '/', entries: [] }));
    const store = useFilesStore();
    await store.open(host, '/start');
    await store.navigate('/second');
    await store.open({ ...host, id: 'other' }, '/other');
    expect(store.stepHistory('remote', 'back')).toBe(false);

    store.active = host.id;
    expect(store.stepHistory('remote', 'back')).toBe(true);
    await vi.waitFor(() => expect(store.current?.path).toBe('/start'));
    expect(mocks.list).toHaveBeenLastCalledWith(`session-${host.id}`, '/start');

    expect(await store.clearHostTransfers(host.id)).toBe(true);
    await store.open(host, '/start');
    expect(store.stepHistory('remote', 'forward')).toBe(false);
  });

  it('preserves failed history steps and drops forward entries only after a new visit', async () => {
    mocks.open.mockImplementation(async (_host, receive) => {
      receive({ type: 'state', state: 'connected' });
      return { id: 'session' };
    });
    mocks.list.mockImplementation(async (_id, path) => ({ path, parent: '/', entries: [] }));
    const store = useFilesStore();
    await store.open(host, '/first');
    await store.navigate('/second');
    mocks.list.mockRejectedValueOnce({ message: 'directory unavailable' });
    expect(store.stepHistory('remote', 'back')).toBe(true);
    await vi.waitFor(() => expect(store.current?.error).toBe('directory unavailable'));
    expect(store.current?.path).toBe('/second');

    expect(store.stepHistory('remote', 'back')).toBe(true);
    expect(store.stepHistory('remote', 'back')).toBe(false);
    await store.refresh();
    expect(store.current?.path).toBe('/first');
    expect(store.stepHistory('remote', 'back')).toBe(false);
    await store.refresh();
    expect(store.stepHistory('remote', 'forward')).toBe(true);
    await vi.waitFor(() => expect(store.current?.path).toBe('/second'));

    expect(store.stepHistory('remote', 'back')).toBe(true);
    await vi.waitFor(() => expect(store.current?.path).toBe('/first'));
    await store.navigate('/different');
    expect(store.stepHistory('remote', 'forward')).toBe(false);
  });
});

const transfer = (values: Partial<TransferInfo> = {}): TransferInfo => ({
  id: 'transfer',
  hostId: 'host',
  sessionId: 'session',
  direction: 'upload',
  state: 'completed',
  sources: ['source.txt'],
  destination: '/srv',
  totalBytes: 12,
  transferredBytes: 12,
  remainingBytes: 0,
  bytesPerSecond: 12,
  filesTotal: 1,
  filesDone: 1,
  skipped: 0,
  message: '传输完成，1 个文件通过 SHA-256 校验，跳过 0 个文件',
  recoveryPaths: [],
  ...values,
});

describe('SFTP transfer notifications', () => {
  it.each([
    transfer(),
    transfer({ filesTotal: 0, filesDone: 0, message: '目录传输完成，没有普通文件' }),
    transfer({
      skipped: 1,
      filesDone: 0,
      message: '传输完成，0 个文件通过 SHA-256 校验，跳过 1 个文件',
    }),
    transfer({ direction: 'download' }),
    transfer({ state: 'cancelled', message: '排队任务已取消' }),
  ])('does not toast a normal $direction/$state result', async (task) => {
    vi.useFakeTimers();
    const store = useFilesStore();
    mocks.tasks.mockResolvedValue([task]);
    await store.poll();
    expect(useNotificationsStore().items).toEqual([]);
    expect(store.tasks).toEqual([task]);
    expect(store.pending).toBe(0);
  });

  it('refreshes the file listing on completion without a success toast or completion banner', async () => {
    vi.useFakeTimers();
    const store = useFilesStore();
    store.active = host.id;
    store.connections[host.id] = {
      host,
      id: 'session',
      state: 'connected',
      error: null,
      trust: null,
      path: '/srv',
      listing: null,
      loading: false,
    };
    mocks.connections.mockResolvedValue([{ id: 'session' }]);
    store.tasks = [transfer({ state: 'verifying', message: null })];
    const completed = transfer();
    mocks.tasks.mockResolvedValue([completed]);
    const listing = { path: '/srv', parent: '/', entries: [] };
    mocks.list.mockResolvedValue(listing);
    await store.poll();
    expect(mocks.list).toHaveBeenCalledWith('session', '/srv');
    expect(store.current?.listing).toEqual(listing);
    expect(store.tasks).toEqual([completed]);
    expect(store.notice).toBeNull();
    expect(useNotificationsStore().items).toEqual([]);
  });

  it.each([
    transfer({ state: 'failed', message: 'Permission denied' }),
    transfer({ state: 'cancelled', message: '临时文件清理失败', recoveryPaths: ['/srv/.partial'] }),
    transfer({ recoveryPaths: ['/srv/.partial'] }),
  ])('keeps errors and recovery paths visible once ($state)', async (task) => {
    vi.useFakeTimers();
    const store = useFilesStore(),
      notifications = useNotificationsStore();
    mocks.tasks.mockResolvedValue([task]);
    await store.poll();
    expect(notifications.items).toHaveLength(1);
    expect(notifications.items[0]).toMatchObject({ error: true });
    expect(notifications.items[0]?.text).toContain(task.message);
    for (const path of task.recoveryPaths) expect(notifications.items[0]?.text).toContain(path);
    await store.poll();
    expect(notifications.items).toHaveLength(1);
    notifications.dismiss(notifications.items[0]!.id);
    await store.poll();
    expect(notifications.items).toHaveLength(0);
  });
});
