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
  switchUser: vi.fn(),
  read: vi.fn(),
  openEditor: vi.fn(),
  editorStatus: vi.fn(),
  closeEditor: vi.fn(),
  externalPrepare: vi.fn(),
  externalReady: vi.fn(),
  externalSave: vi.fn(),
  openLocal: vi.fn(),
  cancel: vi.fn(),
  externalCancel: vi.fn(),
}));
vi.mock('../services/files', () => ({ filesApi: mocks }));
import { useFilesStore } from './files';
import { usePluginsStore } from './plugins';
import type { Host } from '../types/hosts';
import type { TransferInfo, TextDocument } from '../types/files';
import { useNotificationsStore } from './notifications';
const host = {
  id: 'host',
  name: 'Actual host',
  hostname: 'server.example',
  username: 'ops',
} as Host;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
  mocks.local.mockResolvedValue({ path: 'local', parent: null, entries: [] });
  mocks.connections.mockResolvedValue([]);
  mocks.tasks.mockResolvedValue([]);
  mocks.clearTransfers.mockResolvedValue(undefined);
  mocks.closeEditor.mockResolvedValue(undefined);
  mocks.openLocal.mockResolvedValue(true);
});

describe('file opening and external editing', () => {
  function connected() {
    const store = useFilesStore();
    store.active = host.id;
    store.connections[host.id] = {
      host,
      id: 'session',
      state: 'connected',
      error: null,
      trust: null,
      path: '/',
      listing: null,
      loading: false,
    };
    mocks.connections.mockResolvedValue([{ id: 'session', hostId: host.id }]);
    return store;
  }
  const external = {
    token: 'external',
    sessionId: 'session',
    path: '/config.ini',
    localPath: 'D:/app/external-edits/edit-1/config.ini',
    transferId: 'download',
    ready: false,
    atomicSave: true,
  };
  it('keeps native close state when an older open response arrives afterwards', async () => {
    const store = connected();
    let opened!: (value: { token: string; sessionId: string; path: string }) => void;
    mocks.openEditor.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );
    const request = store.edit('/config.ini');
    store.editorState({ document: null, dirty: false });
    opened({ token: 'closed', sessionId: 'session', path: '/config.ini' });
    await request;
    expect(store.document).toBeNull();
    expect(store.editorBusy).toBe(false);
  });
  it('does not overwrite a newer native editor event with an older startup snapshot', async () => {
    const store = connected();
    let snapshot!: (value: { document: null; dirty: boolean }) => void;
    mocks.editorStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          snapshot = resolve;
        }),
    );
    const request = store.syncEditorState();
    store.editorState({
      document: { token: 'live', sessionId: 'session', path: '/config.ini' },
      dirty: true,
    });
    snapshot({ document: null, dirty: false });
    await request;
    expect(store.document?.token).toBe('live');
    expect(store.dirty).toBe(true);
  });
  it('shows read progress, keeps ini eligible and offers a fallback with the actual error', async () => {
    const store = connected();
    store.connections[host.id]!.username = 'root';
    let reject!: (error: unknown) => void;
    mocks.openEditor.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const request = store.edit('/config.ini', 100);
    expect(store.editorBusy).toBe(true);
    expect(store.openingPath).toBe('/config.ini');
    expect(mocks.openEditor).toHaveBeenCalledWith('session', '/config.ini', 'root@server.example');
    reject({ code: 'TEXT_ENCODING', message: '文件不是有效 UTF-8，未进行有损解码' });
    await request;
    expect(store.editorBusy).toBe(false);
    expect(store.openIssue?.message).toContain('UTF-8');
    expect(store.document).toBeNull();
    expect(store.error).toBeNull();
    mocks.openEditor.mockClear();
    await store.edit('/large.log', 2 * 1024 * 1024 + 1);
    expect(mocks.openEditor).not.toHaveBeenCalled();
    expect(store.openIssue?.message).toContain('2 MiB');
  });
  it('opens only a verified completed download once and keeps the original session when another host becomes active', async () => {
    const store = connected();
    store.offerExternal('/config.ini');
    mocks.externalPrepare.mockResolvedValue(external);
    await store.startExternal();
    expect(mocks.externalPrepare).toHaveBeenCalledWith('session', '/config.ini');
    store.active = 'other-host';
    mocks.tasks.mockResolvedValue([transfer({ id: 'download', state: 'completed', filesDone: 1 })]);
    mocks.externalReady.mockResolvedValue({ ...external, ready: true });
    await store.poll();
    await vi.waitFor(() =>
      expect(mocks.openLocal).toHaveBeenCalledExactlyOnceWith(external.localPath),
    );
    await store.poll();
    expect(mocks.externalReady).toHaveBeenCalledExactlyOnceWith('external');
    expect(mocks.openLocal).toHaveBeenCalledTimes(1);
    expect(store.externalDocument?.sessionId).toBe('session');
  });
  it('does not open a failed download or upload without confirmation and retains recovery state after conflicts', async () => {
    const store = connected();
    store.externalDocument = { ...external };
    mocks.tasks.mockResolvedValue([
      transfer({ id: 'download', state: 'failed', message: '网络中断' }),
    ]);
    await store.poll();
    expect(mocks.openLocal).not.toHaveBeenCalled();
    expect(store.externalError).toBe('网络中断');
    store.externalDocument.ready = true;
    await store.saveExternal(false);
    expect(mocks.externalSave).not.toHaveBeenCalled();
    mocks.externalSave.mockRejectedValueOnce({ message: '文件已被外部修改；未覆盖' });
    await store.saveExternal(true);
    expect(mocks.externalSave).toHaveBeenCalledExactlyOnceWith('external', true);
    expect(store.externalDocument.localPath).toBe(external.localPath);
    expect(store.externalError).toContain('未覆盖');
    expect(await store.prepareHostClose(host.id)).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it('ends external editing explicitly while keeping the local recovery path', async () => {
    const store = connected();
    store.externalDocument = { ...external };
    store.tasks = [transfer({ id: 'download', state: 'running' })];
    await store.closeExternal();
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('download');
    expect(mocks.closeEditor).toHaveBeenCalledExactlyOnceWith('external', true);
    expect(store.externalDocument).toBeNull();
    expect(useNotificationsStore().items).toEqual([
      expect.objectContaining({ text: expect.stringContaining(external.localPath), error: false }),
    ]);
  });
  it('displays the retained external copy path without its Windows prefix', async () => {
    const store = connected();
    const localPath = '\\\\?\\C:\\ServerDeck\\external-edits\\edit-1\\config.ini';
    store.externalDocument = { ...external, localPath, ready: true };
    await store.openLocal(localPath);
    expect(mocks.openLocal).toHaveBeenCalledExactlyOnceWith(localPath);
    expect(store.externalDocument.localPath).toBe(localPath);
    await store.closeExternal();
    expect(useNotificationsStore().items).toEqual([
      expect.objectContaining({
        text: '已结束外部编辑，本地副本保留于：C:\\ServerDeck\\external-edits\\edit-1\\config.ini',
      }),
    ]);
  });
  it.each(['timeout', 'dismiss'])(
    'does not replay a finished edit notice after %s and host reopening',
    async (action) => {
      vi.useFakeTimers();
      const store = connected();
      const notifications = useNotificationsStore();
      store.externalDocument = { ...external, ready: true };
      await store.closeExternal();
      expect(notifications.items).toHaveLength(1);
      if (action === 'dismiss') notifications.dismiss(notifications.items[0]!.id);
      else await vi.advanceTimersByTimeAsync(6000);
      expect(notifications.items).toEqual([]);
      expect(await store.prepareHostClose(host.id)).toBe(true);
      expect(await store.clearHostTransfers(host.id)).toBe(true);
      mocks.open.mockImplementationOnce(async (_host, callback) => {
        callback({ type: 'state', state: 'connected' });
        return { id: 'reopened' };
      });
      mocks.connections.mockResolvedValue([{ id: 'reopened', hostId: host.id }]);
      mocks.list.mockResolvedValue({ path: '/', parent: null, entries: [] });
      await store.open(host);
      expect(store.current?.state).toBe('connected');
      expect(notifications.items).toEqual([]);
      store.externalDocument = { ...external, sessionId: 'reopened', ready: true };
      await store.closeExternal();
      expect(notifications.items).toEqual([
        expect.objectContaining({
          text: expect.stringContaining(external.localPath),
          error: false,
        }),
      ]);
    },
  );
  it('cancels an in-flight external save without closing or losing its recovery copy', async () => {
    const store = connected();
    store.externalDocument = { ...external, ready: true };
    let reject!: (error: unknown) => void;
    mocks.externalSave.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const saving = store.saveExternal(true);
    expect(store.externalSaving).toBe(true);
    await store.cancelExternalSave();
    expect(mocks.externalCancel).toHaveBeenCalledExactlyOnceWith('external');
    reject({ message: '回传已取消' });
    await saving;
    expect(store.externalSaving).toBe(false);
    expect(store.externalDocument.localPath).toBe(external.localPath);
    expect(mocks.closeEditor).not.toHaveBeenCalled();
  });
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
  it.each([false, true])(
    'protects an open independent document (dirty=%s) before asking to cancel its transfers',
    async (dirty) => {
      const store = useFilesStore();
      store.document = { sessionId: 'session', token: 'document' } as TextDocument;
      store.dirty = dirty;
      mocks.tasks.mockResolvedValue([transfer({ state: 'running' })]);
      mocks.connections.mockResolvedValue([{ id: 'session', hostId: 'host' }]);
      const ask = vi.spyOn(usePluginsStore(), 'ask');
      expect(await store.prepareHostClose('host')).toBe(false);
      expect(store.error).toContain('请先关闭');
      expect(store.document.token).toBe('document');
      expect(ask).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
    },
  );
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
  it('replaces the file identity only after verification and ignores late events from the old lease', async () => {
    let receive!: (event: unknown) => void;
    mocks.open.mockImplementation(async (_host, callback) => {
      receive = callback;
      callback({ type: 'state', state: 'connected' });
      return { id: 'old' };
    });
    mocks.list.mockResolvedValue({ path: '/home/user', parent: '/home', entries: [] });
    const store = useFilesStore();
    await store.open(host);
    let finish!: (value: unknown) => void;
    mocks.switchUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = store.switchUser({ username: 'root', serverPath: '', password: null });
    expect(store.current?.id).toBe('old');
    expect(store.current?.switchingUser).toBe(true);
    await store.navigate('/ignored');
    expect(mocks.list).toHaveBeenCalledTimes(1);
    finish({
      session: { id: 'root-session', routeHostIds: [] },
      listing: { path: '/root', parent: '/', entries: [] },
    });
    expect(await pending).toBe(true);
    receive({ type: 'state', state: 'closed' });
    expect(store.current).toMatchObject({
      id: 'root-session',
      username: 'root',
      state: 'connected',
      path: '/root',
      switchingUser: false,
    });
    expect(store.stepHistory('remote', 'back')).toBe(false);
  });
  it('keeps the old identity and directory on failure and blocks switching with an open editor', async () => {
    const store = useFilesStore();
    store.active = host.id;
    store.connections[host.id] = {
      host,
      id: 'old',
      state: 'connected',
      path: '/home',
      listing: null,
      loading: false,
      error: null,
      trust: null,
    };
    mocks.switchUser.mockRejectedValue({ message: 'sudo denied' });
    expect(await store.switchUser({ username: 'root', serverPath: '', password: null })).toBe(
      false,
    );
    expect(store.current).toMatchObject({ id: 'old', path: '/home', state: 'connected' });
    expect(store.error).toBe('sudo denied');
    store.document = { sessionId: 'old' } as TextDocument;
    expect(await store.switchUser(null)).toBe(false);
    expect(mocks.switchUser).toHaveBeenCalledTimes(1);
    expect(store.error).toContain('保存并关闭');
  });
  it('waits for a pending user switch before closing the host and discards an earlier poll', async () => {
    const store = useFilesStore();
    store.active = host.id;
    store.connections[host.id] = {
      host,
      id: 'old',
      state: 'connected',
      path: '/home',
      listing: null,
      loading: false,
      error: null,
      trust: null,
    };
    let pollFinish!: (value: unknown) => void;
    mocks.connections.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pollFinish = resolve;
        }),
    );
    const poll = store.poll();
    let finish!: (value: unknown) => void;
    mocks.switchUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = store.switchUser({ username: 'root', serverPath: '', password: null });
    store.closingHosts.push(host.id);
    const close = store.prepareHostClose(host.id);
    expect(mocks.close).not.toHaveBeenCalled();
    finish({ session: { id: 'root-session' }, listing: { path: '/', parent: null, entries: [] } });
    expect(await pending).toBe(true);
    expect(await close).toBe(true);
    expect(mocks.close).toHaveBeenCalledWith('root-session', false);
    pollFinish([{ id: 'old' }]);
    await poll;
    expect(store.current?.state).toBe('closed');
  });
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
