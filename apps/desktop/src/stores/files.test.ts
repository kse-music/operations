import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia, getActivePinia, disposePinia } from 'pinia';
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  list: vi.fn(),
  lastDirectory: vi.fn(),
  rememberDirectory: vi.fn(),
  local: vi.fn(),
  tasks: vi.fn(),
  remoteCopy: vi.fn(),
  retry: vi.fn(),
  connections: vi.fn(),
  close: vi.fn(),
  clearTransfers: vi.fn(),
  switchUser: vi.fn(),
  read: vi.fn(),
  openEditor: vi.fn(),
  createEditor: vi.fn(),
  editorStatus: vi.fn(),
  closeEditor: vi.fn(),
  externalPrepare: vi.fn(),
  externalReady: vi.fn(),
  externalSave: vi.fn(),
  openLocal: vi.fn(),
  cancel: vi.fn(),
  externalCancel: vi.fn(),
  search: vi.fn(),
  cancelSearch: vi.fn(),
}));
vi.mock('../services/files', () => ({ filesApi: mocks }));
import { useFilesStore } from './files';
import { usePluginsStore } from './plugins';
import type { Host } from '../types/hosts';
import type {
  DirectoryListing,
  TransferInfo,
  TextDocument,
  FileSearchEvent,
  FileSearchInput,
} from '../types/files';
import { useNotificationsStore } from './notifications';
const host = {
  id: 'host',
  name: 'Actual host',
  hostname: 'server.example',
  username: 'ops',
} as Host;
describe('remote file search ownership and cancellation', () => {
  function connected() {
    const store = useFilesStore();
    store.active = host.id;
    store.connections[host.id] = {
      host,
      id: 'search-session',
      state: 'connected',
      error: null,
      trust: null,
      path: '/srv',
      listing: null,
      loading: false,
    };
    store.ensureSearch();
    store.changeSearch({ query: 'config' });
    return store;
  }
  function event(requestId: string, patch: Partial<FileSearchEvent> = {}): FileSearchEvent {
    return {
      requestId,
      status: 'running',
      entries: [],
      issues: [],
      scannedDirectories: 1,
      scannedEntries: 2,
      skippedDirectories: 0,
      currentPath: '/srv',
      message: null,
      ...patch,
    };
  }
  it('accumulates deltas, preserves conditions and drops responses for replaced requests or identities', async () => {
    const receivers: ((event: FileSearchEvent) => void)[] = [];
    mocks.search.mockImplementation(
      (_id: string, _input: FileSearchInput, receive: (event: FileSearchEvent) => void) => {
        receivers.push(receive);
        return Promise.resolve();
      },
    );
    const store = connected();
    const search = store.current!.search!;
    expect(search.path).toBe('/srv');
    expect(search.recursive).toBe(false);
    store.changeSearch({ recursive: true });
    expect(store.ensureSearch()?.recursive).toBe(true);
    await store.startSearch();
    const first = search.requestId;
    receivers[0]!(
      event(first, {
        entries: [
          {
            parent: '/srv',
            entry: {
              name: 'config',
              path: '/srv/config',
              kind: 'file',
              size: 1,
              modified: null,
              permissions: null,
              uid: null,
              gid: null,
            },
          },
        ],
      }),
    );
    receivers[0]!(
      event(first, {
        status: 'completed',
        skippedDirectories: 1,
        issues: [{ path: '/srv/denied', message: 'permission denied' }],
      }),
    );
    expect(search.entries).toHaveLength(1);
    expect(search.issues).toHaveLength(1);
    expect(store.ensureSearch()).toBe(search);
    await store.startSearch();
    const second = search.requestId;
    expect(second).not.toBe(first);
    receivers[0]!(event(first, { status: 'failed', message: 'stale' }));
    expect(search.status).toBe('running');
    expect(search.message).toBeNull();
    expect(search.entries).toEqual([]);
    store.current!.id = 'switched-user';
    receivers[1]!(event(second, { status: 'completed' }));
    expect(search.status).toBe('running');
    expect(store.ensureSearch()?.sessionId).toBe('switched-user');
    expect(store.current!.search?.query).toBe('');
  });
  it('waits for start registration and shares a stop request when closing immediately', async () => {
    let register!: () => void;
    mocks.search.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          register = resolve;
        }),
    );
    mocks.cancelSearch.mockResolvedValue(undefined);
    const store = connected();
    const starting = store.startSearch();
    const first = store.cancelSearch();
    const second = store.cancelSearch();
    await Promise.resolve();
    expect(mocks.cancelSearch).not.toHaveBeenCalled();
    expect(store.current!.search?.status).toBe('cancelling');
    register();
    await starting;
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(mocks.cancelSearch).toHaveBeenCalledExactlyOnceWith(
      'search-session',
      store.current!.search!.requestId,
    );
    expect(store.current!.search?.status).toBe('cancelled');
  });
  it('surfaces start and stop failures and keeps an unconfirmed stop active for retry', async () => {
    const store = connected();
    mocks.search.mockImplementation(() => {
      throw new Error('start unavailable');
    });
    await store.startSearch();
    expect(store.current!.search?.status).toBe('failed');
    expect(store.current!.search?.message).toContain('start unavailable');
    mocks.search.mockResolvedValue(undefined);
    await store.startSearch();
    mocks.cancelSearch.mockRejectedValue(new Error('stop unavailable'));
    expect(await store.cancelSearch()).toBe(false);
    expect(store.current!.search?.status).toBe('running');
    expect(store.current!.search?.message).toContain('stop unavailable');
    mocks.cancelSearch.mockResolvedValue(undefined);
    expect(await store.cancelSearch()).toBe(true);
  });
});
it('refreshes only an existing local browser still at the renamed parent', async () => {
  const store = useFilesStore();
  store.active = 'a';
  store.local = { path: 'D:/a', parent: 'D:/', entries: [] };
  store.active = 'b';
  store.local = { path: 'E:/b', parent: 'E:/', entries: [] };
  mocks.local.mockResolvedValue({ path: 'D:/a', parent: 'D:/', entries: [] });
  await store.refreshLocal('missing', 'D:/a');
  await store.refreshLocal('a', 'D:/old');
  expect(mocks.local).not.toHaveBeenCalled();
  await store.refreshLocal('a', 'D:/a');
  expect(mocks.local).toHaveBeenCalledExactlyOnceWith('D:/a');
  expect(store.active).toBe('b');
  expect(store.local?.path).toBe('E:/b');
  store.active = 'a';
  expect(store.local?.path).toBe('D:/a');
});
beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
  mocks.lastDirectory.mockResolvedValue(null);
  mocks.rememberDirectory.mockResolvedValue(undefined);
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
  it('creates a file directly in the built-in editor on the original connection', async () => {
    const store = connected();
    store.current!.path = '/srv';
    store.current!.username = 'root';
    const document = { token: 'new', sessionId: 'session', path: '/srv/中文 ;$file.txt' };
    mocks.createEditor.mockResolvedValue(document);
    expect(await store.createFile('中文 ;$file.txt')).toBe(true);
    expect(mocks.createEditor).toHaveBeenCalledExactlyOnceWith(
      'session',
      document.path,
      'root@server.example',
    );
    expect(mocks.openEditor).not.toHaveBeenCalled();
    expect(mocks.externalPrepare).not.toHaveBeenCalled();
    expect(store.document).toEqual(document);
    expect(store.dirty).toBe(false);
    expect(store.editorBusy).toBe(false);
  });
  it('shows creation failures without offering external editing or losing an existing document', async () => {
    const store = connected();
    mocks.createEditor.mockRejectedValue({
      message: '同名文件、目录或链接已存在，请使用其他文件名',
    });
    expect(await store.createFile('exists.txt')).toBe(false);
    expect(store.error).toContain('同名');
    expect(store.openIssue).toBeNull();
    mocks.createEditor.mockClear();
    store.editorState({
      document: { token: 'live', sessionId: 'session', path: '/live.txt' },
      dirty: true,
    });
    expect(await store.createFile('another.txt')).toBe(false);
    expect(mocks.createEditor).not.toHaveBeenCalled();
    expect(store.document?.path).toBe('/live.txt');
    expect(store.dirty).toBe(true);
  });
  it('blocks duplicate creates and retains newer native close events and the original identity', async () => {
    const store = connected();
    let complete!: (value: { token: string; sessionId: string; path: string }) => void;
    mocks.createEditor.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = store.createFile('first.txt');
    expect(store.editorBusy).toBe(true);
    expect(await store.createFile('duplicate.txt')).toBe(false);
    store.active = 'other';
    store.editorState({ document: null, dirty: false });
    complete({ token: 'closed', sessionId: 'session', path: '/first.txt' });
    expect(await pending).toBe(true);
    expect(mocks.createEditor).toHaveBeenCalledExactlyOnceWith(
      'session',
      '/first.txt',
      'ops@server.example',
    );
    expect(store.document).toBeNull();
  });
  it('rejects path traversal before invoking file creation', async () => {
    const store = connected();
    await expect(store.createFile('../escape')).rejects.toThrow();
    expect(mocks.createEditor).not.toHaveBeenCalled();
  });
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
      else await vi.advanceTimersByTimeAsync(3000);
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
  it('keeps the source active while opening or reusing a target connection in the background', async () => {
    const store = useFilesStore();
    store.active = 'source';
    mocks.open.mockImplementationOnce(async (_host, callback) => {
      callback({ type: 'state', state: 'connected' });
      return { id: 'target-session' };
    });
    mocks.list.mockResolvedValue({ path: '/target-home', parent: '/', entries: [] });
    await store.open(host, undefined, undefined, { background: true });
    expect(store.active).toBe('source');
    expect(store.connections.host?.path).toBe('/target-home');
    expect(mocks.local).not.toHaveBeenCalled();
    mocks.list.mockClear();
    await store.open(host, '/different', undefined, { background: true });
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(store.connections.host?.path).toBe('/target-home');
  });
  it('protects the target host close and clears the shared record without closing the source lease', async () => {
    const store = useFilesStore();
    const task = transfer({
      state: 'running',
      remoteCopy: true,
      remoteTargetHostId: 'target',
      remoteTargetSessionId: 'target-session',
    });
    mocks.connections.mockResolvedValue([
      { id: 'session', hostId: 'host' },
      { id: 'target-session', hostId: 'target' },
    ]);
    mocks.tasks.mockResolvedValueOnce([task]).mockResolvedValue([{ ...task, state: 'cancelled' }]);
    const ask = vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(true);
    expect(await store.prepareHostClose('target')).toBe(true);
    expect(ask).toHaveBeenCalledWith(
      '取消传输并关闭主机',
      expect.stringContaining('1 个未完成'),
      undefined,
      undefined,
      { hostIds: ['target'] },
    );
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith('target-session', true);
    expect(await store.clearHostTransfers('target')).toBe(true);
    expect(store.tasks).toEqual([]);
  });
  it('keeps the connection and records when cancelling the close confirmation', async () => {
    const store = useFilesStore();
    const task = transfer({ state: 'running' });
    mocks.tasks.mockResolvedValue([task]);
    mocks.connections.mockResolvedValue([{ id: 'session', hostId: 'host' }]);
    const ask = vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(false);
    expect(await store.prepareHostClose('host')).toBe(false);
    expect(ask).toHaveBeenCalledWith(
      '取消传输并关闭主机',
      expect.stringContaining('1 个未完成'),
      undefined,
      undefined,
      { hostIds: ['host'] },
    );
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
describe('local file workspace ownership', () => {
  const listing = (path: string): DirectoryListing => ({ path, parent: null, entries: [] });

  beforeEach(() => {
    mocks.local.mockImplementation(async (path) => listing(path ?? 'C:/home'));
  });

  it('restores the last successful local path after closing a host and recreating the store', async () => {
    const saved = new Map<string, string>();
    mocks.lastDirectory.mockImplementation(async (id, side) =>
      side === 'local' ? (saved.get(id) ?? null) : null,
    );
    mocks.rememberDirectory.mockImplementation(async (id, path, side) => {
      if (side === 'local') saved.set(id, path);
    });
    const firstPath = 'D:/logs 中文';
    let store = useFilesStore();
    store.active = 'a';
    await store.localLoad(firstPath);
    mocks.local.mockRejectedValueOnce({ code: 'LOCAL_PERMISSION', message: 'denied' });
    await store.localLoad('D:/denied');
    expect(saved.get('a')).toBe(firstPath);
    store.active = 'b';
    await store.localLoad('E:/project');

    expect(await store.clearHostTransfers('a')).toBe(true);
    store.active = 'a';
    await store.localLoad();
    expect(store.local?.path).toBe(firstPath);
    expect(store.stepHistory('local', 'back')).toBe(false);

    disposePinia(getActivePinia()!);
    setActivePinia(createPinia());
    store = useFilesStore();
    store.active = 'a';
    await store.localLoad();
    expect(store.local?.path).toBe(firstPath);
    store.active = 'b';
    await store.localLoad();
    expect(store.local?.path).toBe('E:/project');
    expect(store.stepHistory('local', 'back')).toBe(false);

    mocks.lastDirectory.mockClear();
    await store.localLoad(null);
    expect(mocks.lastDirectory).not.toHaveBeenCalled();
    expect(store.local?.path).toBe('C:/home');
    expect(saved.get('b')).toBe('C:/home');
  });

  it.each(['LOCAL_NOT_FOUND', 'LOCAL_PERMISSION', 'LOCAL_NOT_DIRECTORY'])(
    'uses and remembers the home directory when a saved local path returns %s',
    async (code) => {
      const store = useFilesStore();
      store.active = 'a';
      mocks.lastDirectory.mockResolvedValueOnce('D:/unavailable');
      mocks.local.mockRejectedValueOnce({ code, message: 'unavailable' });
      await store.localLoad();
      expect(mocks.local.mock.calls).toEqual([['D:/unavailable'], [null]]);
      expect(store.local?.path).toBe('C:/home');
      expect(mocks.rememberDirectory).toHaveBeenCalledExactlyOnceWith('a', 'C:/home', 'local');
    },
  );

  it('keeps a saved location intact when loading its setting fails', async () => {
    const store = useFilesStore();
    store.active = 'a';
    mocks.lastDirectory.mockRejectedValueOnce({ message: 'invalid setting' });
    await store.localLoad();
    expect(store.local?.path).toBe('C:/home');
    expect(store.error).toContain('invalid setting');
    expect(mocks.rememberDirectory).not.toHaveBeenCalled();
  });

  it('waits for the latest local write before restoring a reopened host and exiting', async () => {
    const store = useFilesStore();
    store.active = 'a';
    let written: string | null = null;
    let finish!: () => void;
    mocks.lastDirectory.mockImplementation(async () => written);
    mocks.rememberDirectory
      .mockImplementationOnce(
        (_id, path) =>
          new Promise<void>((resolve) => {
            finish = () => {
              written = path;
              resolve();
            };
          }),
      )
      .mockImplementation(async (_id, path) => {
        written = path;
      });
    const first = store.localLoad('D:/first');
    await vi.waitFor(() => expect(mocks.rememberDirectory).toHaveBeenCalledOnce());
    const second = store.localLoad('D:/latest');
    await vi.waitFor(() => expect(store.local?.path).toBe('D:/latest'));
    expect(await store.clearHostTransfers('a')).toBe(true);
    const reopening = store.localLoad();
    const flushed = vi.fn();
    const exit = store.flushDirectoryWrites().then(flushed);
    await Promise.resolve();
    expect(flushed).not.toHaveBeenCalled();
    expect(mocks.lastDirectory).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second, reopening, exit]);
    expect(mocks.rememberDirectory.mock.calls).toEqual([
      ['a', 'D:/first', 'local'],
      ['a', 'D:/latest', 'local'],
    ]);
    expect(store.local?.path).toBe('D:/latest');
    expect(flushed).toHaveBeenCalledOnce();
  });

  it('keeps local directories and back/forward history on each host', async () => {
    const store = useFilesStore();
    store.active = 'a';
    await store.localLoad('D:/a');
    await store.localLoad('D:/a/next');
    store.active = 'b';
    expect(store.local).toBeNull();
    expect(store.stepHistory('local', 'back')).toBe(false);
    await store.localLoad('E:/b');
    await store.localLoad('E:/b/next');
    expect(store.stepHistory('local', 'back')).toBe(true);
    await vi.waitFor(() => expect(store.local?.path).toBe('E:/b'));

    store.active = 'a';
    expect(store.local?.path).toBe('D:/a/next');
    expect(store.stepHistory('local', 'forward')).toBe(false);
    expect(store.stepHistory('local', 'back')).toBe(true);
    await vi.waitFor(() => expect(store.local?.path).toBe('D:/a'));
    expect(store.stepHistory('local', 'back')).toBe(false);

    store.active = 'b';
    expect(store.stepHistory('local', 'forward')).toBe(true);
    await vi.waitFor(() => expect(store.local?.path).toBe('E:/b/next'));
    store.active = 'a';
    expect(store.stepHistory('local', 'forward')).toBe(true);
    await vi.waitFor(() => expect(store.local?.path).toBe('D:/a/next'));
  });

  it('keeps in-flight local reads and loading state on their original hosts', async () => {
    const store = useFilesStore();
    let finish!: (value: DirectoryListing) => void;
    store.active = 'a';
    mocks.local.mockImplementationOnce(
      () => new Promise<DirectoryListing>((resolve) => (finish = resolve)),
    );
    const pending = store.localLoad('D:/a');
    store.active = 'b';
    expect(store.localLoading).toBe(false);
    expect(store.localPendingPath).toBeNull();
    await store.localLoad('E:/b');
    store.active = 'a';
    expect(store.localLoading).toBe(true);
    expect(store.localPendingPath).toBe('D:/a');
    finish(listing('D:/a'));
    await pending;
    expect(store.local?.path).toBe('D:/a');
    expect(store.localLoading).toBe(false);
    expect(store.localPendingPath).toBeNull();
    store.active = 'b';
    expect(store.local?.path).toBe('E:/b');
    expect(store.stepHistory('local', 'back')).toBe(false);
  });

  it('rejects stale reads and preserves the directory and history after a failed visit', async () => {
    const store = useFilesStore();
    store.active = 'a';
    await store.localLoad('D:/a');
    let finish!: (value: DirectoryListing) => void;
    mocks.local.mockImplementationOnce(
      () => new Promise<DirectoryListing>((resolve) => (finish = resolve)),
    );
    const stale = store.localLoad('D:/stale');
    await store.localLoad('D:/a/next');
    finish(listing('D:/stale'));
    await stale;
    expect(store.local?.path).toBe('D:/a/next');
    mocks.local.mockRejectedValueOnce({ message: 'disk unavailable' });
    expect(store.stepHistory('local', 'back')).toBe(true);
    await vi.waitFor(() => expect(store.localLoading).toBe(false));
    expect(store.error).toBe('disk unavailable');
    expect(store.local?.path).toBe('D:/a/next');
    expect(store.localPendingPath).toBeNull();
    expect(store.stepHistory('local', 'back')).toBe(true);
    await vi.waitFor(() => expect(store.local?.path).toBe('D:/a'));
    expect(store.stepHistory('local', 'back')).toBe(false);
  });

  it('discards local state only after a successful host close and ignores its late response', async () => {
    const store = useFilesStore();
    store.active = 'a';
    await store.localLoad('D:/a');
    await store.localLoad('D:/a/next');
    mocks.clearTransfers.mockRejectedValueOnce({ message: 'still running' });
    expect(await store.clearHostTransfers('a')).toBe(false);
    expect(store.local?.path).toBe('D:/a/next');
    let finish!: (value: DirectoryListing) => void;
    mocks.local.mockImplementationOnce(
      () => new Promise<DirectoryListing>((resolve) => (finish = resolve)),
    );
    const stale = store.localLoad('D:/stale');
    expect(await store.clearHostTransfers('a')).toBe(true);
    expect(store.local).toBeNull();
    expect(store.localLoading).toBe(false);
    expect(store.localPendingPath).toBeNull();
    await store.localLoad('D:/reopened');
    finish(listing('D:/stale'));
    await stale;
    expect(store.local?.path).toBe('D:/reopened');
    expect(store.stepHistory('local', 'back')).toBe(false);
  });

  it('initializes a delayed connection on its own host after switching tabs', async () => {
    const store = useFilesStore();
    let finish!: (value: { id: string }) => void;
    mocks.open.mockImplementationOnce(
      () => new Promise<{ id: string }>((resolve) => (finish = resolve)),
    );
    const pending = store.open(host);
    store.active = 'other';
    await store.localLoad('E:/other');
    finish({ id: 'session' });
    await pending;
    expect(store.local?.path).toBe('E:/other');
    store.active = host.id;
    expect(store.local?.path).toBe('C:/home');
  });

  it('refreshes the original local pane when the host changes during a remote refresh', async () => {
    const store = useFilesStore();
    store.active = 'other';
    await store.localLoad('E:/other');
    store.active = host.id;
    await store.localLoad('D:/host');
    store.connections[host.id] = {
      host,
      id: 'session',
      state: 'connected',
      error: null,
      trust: null,
      path: '/home',
      listing: null,
      loading: false,
    };
    let finish!: (value: DirectoryListing) => void;
    mocks.list.mockImplementationOnce(
      () => new Promise<DirectoryListing>((resolve) => (finish = resolve)),
    );
    mocks.local.mockClear();
    const pending = store.refresh();
    store.active = 'other';
    finish(listing('/home'));
    await pending;
    expect(mocks.local).toHaveBeenCalledExactlyOnceWith('D:/host');
    expect(store.local?.path).toBe('E:/other');
  });
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
  it('uses the latest explicit mount path while waiting for a connection and preserves listing errors', async () => {
    let receive!: (event: import('../types/terminal').TerminalEvent) => void;
    mocks.open.mockImplementation(async (_host, events) => {
      receive = events;
      return { id: 'session' };
    });
    mocks.list.mockRejectedValueOnce({ code: 'SFTP_PERMISSION', message: 'Permission denied' });
    const store = useFilesStore();
    await store.open(host);
    await store.open(host, '/older');
    await store.open(host, '/mnt/应用 数据');
    receive({ type: 'state', state: 'connected', code: null, message: null });
    await vi.waitFor(() => expect(store.current?.error).toBe('Permission denied'));
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith('session', '/mnt/应用 数据');
    expect(mocks.lastDirectory).not.toHaveBeenCalledWith(host.id, 'remote');
    expect(mocks.rememberDirectory).not.toHaveBeenCalledWith(host.id, expect.any(String), 'remote');
    expect(store.current?.listing).toBeNull();
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
    expect(mocks.rememberDirectory).not.toHaveBeenCalledWith(host.id, '/old', 'remote');
    expect(store.stepHistory('remote', 'back')).toBe(true);
    await vi.waitFor(() => expect(store.current?.path).toBe('/home'));
    expect(store.stepHistory('remote', 'back')).toBe(false);
  });

  it('restores the last successful remote directory separately for each host after recreating the store', async () => {
    const saved = new Map<string, string>();
    const other = { ...host, id: 'other' };
    mocks.lastDirectory.mockImplementation(async (id, side) =>
      side === 'remote' ? (saved.get(id) ?? null) : null,
    );
    mocks.rememberDirectory.mockImplementation(async (id, path, side) => {
      if (side === 'remote') saved.set(id, path);
    });
    mocks.open.mockImplementation(async (id, receive) => {
      receive({ type: 'state', state: 'connected' });
      return { id: `session-${id}` };
    });
    mocks.list.mockImplementation(async (_id, path) => ({
      path: path === '.' ? '/home/ops' : path,
      parent: '/',
      entries: [],
    }));
    let store = useFilesStore();
    await store.open(host);
    await store.navigate('/var/log/nginx');
    mocks.list.mockRejectedValueOnce({ code: 'SFTP_PERMISSION', message: 'denied' });
    await store.navigate('/denied');
    await store.open(other);
    await store.navigate('/srv/app');
    expect([...saved]).toEqual([
      [host.id, '/var/log/nginx'],
      [other.id, '/srv/app'],
    ]);

    disposePinia(getActivePinia()!);
    setActivePinia(createPinia());
    store = useFilesStore();
    mocks.list.mockClear();
    await store.open(host);
    expect(store.current?.path).toBe('/var/log/nginx');
    expect(store.stepHistory('remote', 'back')).toBe(false);
    await store.open(other);
    expect(store.current?.path).toBe('/srv/app');
    expect(mocks.list.mock.calls).toEqual([
      [`session-${host.id}`, '/var/log/nginx'],
      [`session-${other.id}`, '/srv/app'],
    ]);
  });

  it.each(['SFTP_NOT_FOUND', 'SFTP_PERMISSION', 'SFTP_OPERATION'])(
    'falls back to the default directory when restoring fails with %s',
    async (code) => {
      mocks.open.mockImplementation(async (_id, receive) => {
        receive({ type: 'state', state: 'connected' });
        return { id: 'session' };
      });
      mocks.lastDirectory.mockResolvedValueOnce('/old/path');
      mocks.list
        .mockRejectedValueOnce({ code, message: 'unavailable' })
        .mockResolvedValueOnce({ path: '/home/ops', parent: '/home', entries: [] });
      const store = useFilesStore();
      await store.open(host);
      expect(mocks.list.mock.calls).toEqual([
        ['session', '/old/path'],
        ['session', '.'],
      ]);
      expect(store.current?.path).toBe('/home/ops');
      expect(store.current?.error).toBeNull();
      expect(mocks.rememberDirectory.mock.calls.filter(([, , side]) => side === 'remote')).toEqual([
        [host.id, '/home/ops', 'remote'],
      ]);
    },
  );

  it('keeps the saved directory on a connection error and surfaces the problem', async () => {
    mocks.open.mockImplementation(async (_id, receive) => {
      receive({ type: 'state', state: 'connected' });
      return { id: 'session' };
    });
    mocks.lastDirectory.mockResolvedValueOnce('/old/path');
    mocks.list.mockRejectedValue({ code: 'SFTP_NETWORK', message: 'network failed' });
    const store = useFilesStore();
    await store.open(host);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith('session', '/old/path');
    expect(store.current?.state).toBe('failed');
    expect(store.current?.error).toBe('network failed');
    expect(mocks.rememberDirectory.mock.calls.some(([, , side]) => side === 'remote')).toBe(false);
  });

  it('finishes overlapping directory writes in navigation order before exit', async () => {
    mocks.open.mockImplementation(async (_id, receive) => {
      receive({ type: 'state', state: 'connected' });
      return { id: 'session' };
    });
    mocks.list.mockImplementation(async (_id, path) => ({ path, parent: '/', entries: [] }));
    const store = useFilesStore();
    await store.open(host, '/home');
    mocks.rememberDirectory.mockClear();
    let completeFirst!: () => void;
    mocks.rememberDirectory.mockImplementationOnce(
      () => new Promise<void>((resolve) => (completeFirst = resolve)),
    );
    const first = store.navigate('/first');
    await vi.waitFor(() => expect(mocks.rememberDirectory).toHaveBeenCalledOnce());
    const second = store.navigate('/second');
    await vi.waitFor(() => expect(store.current?.path).toBe('/second'));
    const flushed = vi.fn();
    const exit = store.flushDirectoryWrites().then(flushed);
    await Promise.resolve();
    expect(flushed).not.toHaveBeenCalled();
    completeFirst();
    await Promise.all([first, second, exit]);
    expect(mocks.rememberDirectory.mock.calls).toEqual([
      [host.id, '/first', 'remote'],
      [host.id, '/second', 'remote'],
    ]);
    expect(flushed).toHaveBeenCalledOnce();
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
  elapsedSeconds: 1,
  dragExport: false,
  filesTotal: 1,
  filesDone: 1,
  skipped: 0,
  message: '传输完成，1 个文件通过 SHA-256 校验，跳过 0 个文件',
  recoveryPaths: [],
  ...values,
});

describe('SFTP transfer notifications', () => {
  it.each([false, true])(
    'refreshes both copy endpoints without refreshing a replacement target identity (%s)',
    async (replaced) => {
      const store = useFilesStore();
      store.active = 'host';
      for (const [id, sessionId, path] of [
        ['host', 'session', '/source'],
        ['target', replaced ? 'replacement' : 'target-session', '/dest'],
      ]) {
        store.connections[id!] = {
          host: { ...host, id: id! },
          id: sessionId!,
          state: 'connected',
          error: null,
          trust: null,
          path: path!,
          listing: null,
          loading: false,
        };
      }
      const task = transfer({
        state: 'running',
        remoteCopy: true,
        remoteTargetHostId: 'target',
        remoteTargetSessionId: 'target-session',
      });
      store.tasks = [task];
      mocks.tasks.mockResolvedValue([{ ...task, state: 'completed' }]);
      mocks.connections.mockResolvedValue([
        { id: 'session', hostId: 'host' },
        { id: replaced ? 'replacement' : 'target-session', hostId: 'target' },
      ]);
      mocks.list.mockImplementation(async (_session, path) => ({ path, parent: '/', entries: [] }));
      await store.poll();
      await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledWith('session', '/source'));
      expect(mocks.list).toHaveBeenCalledTimes(replaced ? 1 : 2);
      if (!replaced) expect(mocks.list).toHaveBeenCalledWith('target-session', '/dest');
      expect(mocks.local).not.toHaveBeenCalled();
    },
  );
  it('retains a newly acknowledged remote task when an older poll finishes later', async () => {
    const store = useFilesStore();
    let finishOldPoll!: (tasks: TransferInfo[]) => void;
    mocks.tasks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldPoll = resolve;
        }),
    );
    const oldPoll = store.poll();
    const task = transfer({ state: 'queued', remoteCopy: true });
    mocks.remoteCopy.mockResolvedValue(task);
    await store.startRemoteCopy({
      sessionId: 'session',
      sources: ['/source'],
      destination: '/dest',
      name: null,
      conflict: 'fail',
      confirmed: true,
      confirmOverwrite: false,
    });
    finishOldPoll([]);
    await oldPoll;
    expect(store.tasks).toEqual([task]);
  });
  it.each(['failed', 'cancelled', 'completed'])(
    'refreshes the original host after a remote copy becomes %s, including partial outcomes',
    async (state) => {
      const store = useFilesStore();
      const other = { ...host, id: 'other-host' };
      store.active = other.id;
      store.connections.host = {
        host,
        id: 'session',
        state: 'connected',
        error: null,
        trust: null,
        path: '/source',
        listing: null,
        loading: false,
      };
      store.connections[other.id] = {
        host: other,
        id: 'other-session',
        state: 'connected',
        error: null,
        trust: null,
        path: '/other',
        listing: null,
        loading: false,
      };
      store.tasks = [transfer({ state: 'running', remoteCopy: true })];
      mocks.connections.mockResolvedValue([
        { id: 'session', hostId: 'host' },
        { id: 'other-session', hostId: other.id },
      ]);
      mocks.tasks.mockResolvedValue([
        transfer({
          state,
          remoteCopy: true,
          filesDone: 1,
          filesTotal: 2,
          message: '部分项目已处理',
        }),
      ]);
      mocks.list.mockResolvedValue({ path: '/source', parent: '/', entries: [] });
      await store.poll();
      await vi.waitFor(() =>
        expect(mocks.list).toHaveBeenCalledExactlyOnceWith('session', '/source'),
      );
      expect(store.connections[other.id]?.path).toBe('/other');
      expect(mocks.local).not.toHaveBeenCalled();
    },
  );
  it('does not refresh a replacement identity after an old remote operation completes', async () => {
    const store = useFilesStore();
    store.active = host.id;
    store.connections.host = {
      host,
      id: 'replacement',
      state: 'connected',
      error: null,
      trust: null,
      path: '/new-user',
      listing: null,
      loading: false,
    };
    store.tasks = [transfer({ state: 'running', remoteCopy: true })];
    mocks.connections.mockResolvedValue([{ id: 'replacement', hostId: host.id }]);
    mocks.tasks.mockResolvedValue([transfer({ state: 'completed', remoteCopy: true })]);
    await store.poll();
    expect(mocks.list).not.toHaveBeenCalled();
  });
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
  it('formats local download recovery paths without changing task records', async () => {
    const path = '\\\\?\\C:\\Downloads\\.partial';
    const task = transfer({ direction: 'download', state: 'failed', recoveryPaths: [path] });
    const store = useFilesStore();
    mocks.tasks.mockResolvedValue([task]);
    await store.poll();
    expect(useNotificationsStore().items[0]?.text).toContain(
      '待检查临时文件：C:\\Downloads\\.partial',
    );
    expect(useNotificationsStore().items[0]?.text).not.toContain('\\\\?\\');
    expect(store.tasks[0]!.recoveryPaths).toEqual([path]);
  });
});
