import { afterEach, expect, it, vi } from 'vitest';
import {
  archiveFileName,
  imageReference,
  runImageArchive,
  validArchiveName,
  inspectImageTarget,
} from './image-archive';
const api = vi.hoisted(() => ({ call: vi.fn(), invoke: vi.fn(), ensure: vi.fn() }));
vi.mock('@serverdeck/plugin-sdk', () => ({ invoke: api.invoke }));
vi.mock('@serverdeck/plugin-sdk/platform', () => ({ call: api.call }));
vi.mock('@serverdeck/plugin-sdk/connections', () => ({ ensureConnection: api.ensure }));
const nonce = '01234567-89ab-cdef-0123-456789abcdef';
const directory = `/tmp/serverdeck-image-${nonce}`;
const prepared = {
  events: [{ type: 'data', stream: 'stdout', dataBase64: btoa(`SD_ARCHIVE_PREPARED:${nonce}\n`) }],
};
const ready = {
  events: [
    {
      type: 'data',
      stream: 'stdout',
      dataBase64: btoa(
        `SD_ARCHIVE_CONTENT:${nonce}:${'c'.repeat(64)}\nSD_ARCHIVE_READY:${nonce}\n`,
      ),
    },
  ],
};
const completed = {
  id: 'copy',
  state: 'completed',
  totalBytes: 1024,
  transferredBytes: 1024,
  bytesPerSecond: 512,
  sha256: 'a'.repeat(64),
  message: null,
  recoveryPaths: [],
};
function setup() {
  api.invoke.mockResolvedValue({
    streamId: 'stream',
    directory,
    path: `${directory}/image.tar`,
    nonce,
  });
  api.ensure.mockResolvedValue({ hostId: 'host', state: 'connected' });
  let polls = 0;
  api.call.mockImplementation(async (request) => {
    switch (request.kind) {
      case 'stream_poll':
        return ++polls === 1 ? prepared : ready;
      case 'transfer_prepare':
      case 'transfer_download_prepare':
        return { id: 'copy', bytes: 1024 };
      case 'transfer_start':
        return completed;
      default:
        return null;
    }
  });
}
afterEach(() => vi.resetAllMocks());
it('uploads a chosen local archive without overwrite, waits for load success and drains before cleanup', async () => {
  setup();
  await runImageArchive(
    'host',
    { kind: 'import', fileName: 'image.tar', confirmed: true },
    'C:/images/image.tar',
    new AbortController().signal,
    vi.fn(),
  );
  expect(api.ensure).toHaveBeenCalledWith('host', true);
  expect(api.call).toHaveBeenCalledWith({
    kind: 'transfer_prepare',
    source: { kind: 'local', path: 'C:/images/image.tar' },
    destination: { hostId: 'host', path: directory },
    overwrite: false,
  });
  expect(api.call.mock.calls.slice(-2).map(([request]) => request.kind)).toEqual([
    'transfer_close',
    'stream_stop',
  ]);
  expect(api.call.mock.calls.filter(([r]) => r.kind === 'stream_poll')).toHaveLength(2);
});
it('saves the selected tag and downloads the completed archive to the chosen local file', async () => {
  setup();
  const progress = vi.fn();
  const request = {
    kind: 'export',
    id: 'a'.repeat(64),
    reference: 'registry:5000/app:latest',
    fileName: 'image.tar',
    confirmed: true,
  } as const;
  await runImageArchive(
    'host',
    request,
    'C:/exports/image.tar',
    new AbortController().signal,
    progress,
  );
  expect(api.invoke).toHaveBeenCalledWith('image_archive', { hostId: 'host', request });
  expect(api.call).toHaveBeenCalledWith({
    kind: 'transfer_download_prepare',
    source: { hostId: 'host', path: `${directory}/image.tar` },
    destination: 'C:/exports/image.tar',
  });
  expect(
    api.call.mock.calls.findIndex(([r]) => r.kind === 'transfer_download_prepare'),
  ).toBeGreaterThan(api.call.mock.calls.findIndex(([r]) => r.kind === 'stream_poll'));
  expect(progress.mock.calls.some(([value]) => value.stage === 'downloading')).toBe(true);
});
it('cancels a running transfer and closes it before releasing remote staging', async () => {
  setup();
  const controller = new AbortController();
  api.call.mockImplementation(async (r) => {
    if (r.kind === 'stream_poll') return prepared;
    if (r.kind === 'transfer_prepare') return { id: 'copy' };
    if (r.kind === 'transfer_start') {
      controller.abort();
      return { ...completed, state: 'running' };
    }
    return null;
  });
  await expect(
    runImageArchive(
      'host',
      { kind: 'import', fileName: 'image.tar', confirmed: true },
      'C:/image.tar',
      controller.signal,
      vi.fn(),
    ),
  ).rejects.toThrow('取消');
  expect(api.call.mock.calls.slice(-2).map(([request]) => request.kind)).toEqual([
    'transfer_close',
    'stream_stop',
  ]);
});
it('reports load failure and cleanup errors with the remote recovery directory', async () => {
  setup();
  let polls = 0;
  api.call.mockImplementation(async (r) => {
    if (r.kind === 'stream_poll')
      return ++polls === 1
        ? prepared
        : { events: [{ type: 'state', state: 'failed', message: 'invalid tar archive' }] };
    if (r.kind === 'transfer_prepare') return { id: 'copy' };
    if (r.kind === 'transfer_start') return completed;
    if (r.kind === 'stream_stop') throw new Error('cleanup disconnected');
    return null;
  });
  await expect(
    runImageArchive(
      'host',
      { kind: 'import', fileName: 'image.tar', confirmed: true },
      'C:/image.tar',
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow(`invalid tar archive\ncleanup disconnected\n远程暂存位置：${directory}`);
});
it('rejects unverified transfers without reporting a successful import', async () => {
  setup();
  api.call.mockImplementation(async (r) => {
    if (r.kind === 'stream_poll') return prepared;
    if (r.kind === 'transfer_prepare') return { id: 'copy' };
    if (r.kind === 'transfer_start')
      return {
        ...completed,
        state: 'unverified',
        message: 'target changed',
        recoveryPaths: ['/recovery'],
      };
    return null;
  });
  await expect(
    runImageArchive(
      'host',
      { kind: 'import', fileName: 'image.tar', confirmed: true },
      'C:/image.tar',
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow('target changed\n/recovery');
});

it('displays the ordinary local recovery path when an export download fails', async () => {
  setup();
  const original = api.call.getMockImplementation()!;
  api.call.mockImplementation(async (request) =>
    request.kind === 'transfer_start'
      ? {
          ...completed,
          state: 'failed',
          message: '校验失败',
          recoveryPaths: ['\\\\?\\C:\\exports\\.partial'],
        }
      : original(request),
  );
  await expect(
    runImageArchive(
      'host',
      {
        kind: 'export',
        id: 'a'.repeat(64),
        reference: 'app:v1',
        fileName: 'image.tar',
        confirmed: true,
      },
      '\\\\?\\C:\\exports\\image.tar',
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow('校验失败\nC:\\exports\\.partial');
});
it('constructs safe export names and retains registry ports and tags', () => {
  const row = { ID: `sha256:${'a'.repeat(64)}`, Repository: 'registry:5000/team/app', Tag: 'v1' };
  expect(imageReference(row)).toBe('registry:5000/team/app:v1');
  expect(archiveFileName(row)).toBe('registry-5000-team-app-v1-aaaaaaaaaaaa.tar');
  expect(imageReference({ ...row, Tag: '<none>' })).toBe(row.ID);
  for (const name of ['', '..', '../x.tar', 'a\\b.tar', 'x\n.tar'])
    expect(validArchiveName(name)).toBe(false);
});

it.each(['import', 'export'] as const)(
  'keeps %s verification, Docker loading and cleanup separate from byte transfer',
  async (kind) => {
    setup();
    let polls = 0;
    const states = [
      { ...completed, state: 'running', transferredBytes: 512, sha256: null },
      { ...completed, state: 'running', sha256: null },
      { ...completed, state: 'verifying', sha256: null },
      completed,
    ];
    api.call.mockImplementation(async (r) => {
      if (r.kind === 'stream_poll') return ++polls === 1 ? prepared : ready;
      if (['transfer_prepare', 'transfer_download_prepare'].includes(r.kind)) return { id: 'copy' };
      if (['transfer_start', 'transfer_status'].includes(r.kind)) return states.shift();
      return null;
    });
    const update = vi.fn();
    await runImageArchive(
      'host',
      kind === 'import'
        ? { kind, fileName: 'image.tar', confirmed: true }
        : {
            kind,
            id: 'a'.repeat(64),
            reference: 'image:tag',
            fileName: 'image.tar',
            confirmed: true,
          },
      'C:/image.tar',
      new AbortController().signal,
      update,
    );
    const transfers = update.mock.calls.map(([value]) => value).filter((value) => value.transfer);
    expect(transfers.map((value) => value.stage)).toEqual([
      kind === 'import' ? 'uploading' : 'downloading',
      'verifying',
      'verifying',
    ]);
    expect(update.mock.calls.at(-1)?.[0]).toMatchObject({ stage: 'finishing' });
    expect(update.mock.calls.at(-1)?.[0].transfer).toBeUndefined();
    if (kind === 'import') {
      const loading = update.mock.calls
        .map(([value]) => value)
        .find((value) => value.stage === 'loading');
      expect(loading).toBeDefined();
      expect(loading.transfer).toBeUndefined();
    }
  },
);

const remoteRequest = {
  kind: 'transfer',
  id: `sha256:${'a'.repeat(64)}`,
  reference: 'app:v1',
  fileName: 'image.tar',
  confirmed: true,
  targetHostId: 'target',
  expectedTargetId: null,
  replaceConfirmed: false,
} as const;
function remoteSetup() {
  setup();
  api.invoke.mockImplementation(async (_action, { hostId }) => ({
    streamId: hostId,
    nonce,
    directory: `${directory}-${hostId}`,
    path: `${directory}-${hostId}/image.tar`,
  }));
  const polls: Record<string, number> = {};
  api.call.mockImplementation(async (r) => {
    if (r.kind === 'stream_poll')
      return (polls[r.streamId] = (polls[r.streamId] ?? 0) + 1) === 1 ? prepared : ready;
    if (r.kind === 'transfer_prepare') return { id: 'copy' };
    if (r.kind === 'transfer_start') return completed;
    return null;
  });
}
it('relays directly through the native remote transfer and verifies target load before cleaning both hosts', async () => {
  remoteSetup();
  const update = vi.fn();
  await runImageArchive('source', remoteRequest, '', new AbortController().signal, update);
  expect(api.invoke.mock.calls.map(([, input]) => input)).toEqual([
    {
      hostId: 'source',
      request: {
        kind: 'export',
        id: remoteRequest.id,
        reference: 'app:v1',
        fileName: 'image.tar',
        confirmed: true,
      },
    },
    {
      hostId: 'target',
      request: {
        kind: 'receive',
        id: remoteRequest.id,
        reference: 'app:v1',
        contentSha256: 'c'.repeat(64),
        fileName: 'image.tar',
        expectedTargetId: null,
        replaceConfirmed: false,
        confirmed: true,
      },
    },
  ]);
  expect(api.call).toHaveBeenCalledWith({
    kind: 'transfer_prepare',
    source: { kind: 'remote', hostId: 'source', path: `${directory}-source/image.tar` },
    destination: { hostId: 'target', path: `${directory}-target` },
    overwrite: false,
  });
  expect(api.call.mock.calls.slice(-3).map(([r]) => r)).toEqual([
    { kind: 'transfer_close', id: 'copy' },
    { kind: 'stream_stop', streamId: 'target' },
    { kind: 'stream_stop', streamId: 'source' },
  ]);
  expect(update.mock.calls.map(([p]) => p.stage)).toContain('loading');
  expect(update.mock.calls.at(-1)?.[0].stage).toBe('finishing');
});
it('does not start target load or a file transfer if source export fails', async () => {
  remoteSetup();
  api.call.mockImplementation(async (r) =>
    r.kind === 'stream_poll'
      ? { events: [{ type: 'state', state: 'failed', message: 'source tag changed' }] }
      : null,
  );
  await expect(
    runImageArchive('source', remoteRequest, '', new AbortController().signal, vi.fn()),
  ).rejects.toThrow('source tag changed');
  expect(api.invoke).toHaveBeenCalledOnce();
  expect(api.call.mock.calls.some(([r]) => r.kind === 'transfer_prepare')).toBe(false);
  expect(api.call).toHaveBeenLastCalledWith({ kind: 'stream_stop', streamId: 'source' });
});
it('drains a cancelled relay before stopping both staging owners', async () => {
  remoteSetup();
  const controller = new AbortController();
  const original = api.call.getMockImplementation()!;
  api.call.mockImplementation(async (r) => {
    if (r.kind === 'transfer_start') {
      controller.abort();
      return { ...completed, state: 'running' };
    }
    return original(r);
  });
  await expect(
    runImageArchive('source', remoteRequest, '', controller.signal, vi.fn()),
  ).rejects.toThrow('取消');
  expect(api.call.mock.calls.slice(-3).map(([r]) => r.kind)).toEqual([
    'transfer_close',
    'stream_stop',
    'stream_stop',
  ]);
});
it('reports target load failure and both recovery locations even when target cleanup fails', async () => {
  remoteSetup();
  const original = api.call.getMockImplementation()!;
  let polls = 0;
  api.call.mockImplementation(async (r) => {
    if (r.kind === 'stream_poll' && r.streamId === 'target' && ++polls === 2)
      return { events: [{ type: 'state', state: 'failed', message: 'Target image tag changed' }] };
    if (r.kind === 'stream_stop' && r.streamId === 'target')
      throw new Error('target cleanup disconnected');
    return original(r);
  });
  await expect(
    runImageArchive('source', remoteRequest, '', new AbortController().signal, vi.fn()),
  ).rejects.toThrow(
    `Target image tag changed\ntarget cleanup disconnected\n远程暂存位置：source: ${directory}-source`,
  );
  expect(api.call).toHaveBeenLastCalledWith({ kind: 'stream_stop', streamId: 'source' });
});
it('does not load a relay whose native verification failed', async () => {
  remoteSetup();
  const original = api.call.getMockImplementation()!;
  api.call.mockImplementation(async (r) =>
    r.kind === 'transfer_start'
      ? { ...completed, state: 'unverified', message: 'digest mismatch' }
      : original(r),
  );
  await expect(
    runImageArchive('source', remoteRequest, '', new AbortController().signal, vi.fn()),
  ).rejects.toThrow('digest mismatch');
  expect(
    api.call.mock.calls.filter(([r]) => r.kind === 'stream_poll' && r.streamId === 'target'),
  ).toHaveLength(1);
});
it.each([null, `sha256:${'b'.repeat(64)}`])(
  'reads the actual target tag snapshot (%s) through an authenticated connection',
  async (id) => {
    api.ensure.mockResolvedValue(undefined);
    api.invoke.mockResolvedValue({
      success: true,
      records: id ? [{ Repository: 'app', Tag: 'v1', ID: id }] : [],
    });
    await expect(
      inspectImageTarget('target', 'app:v1', new AbortController().signal),
    ).resolves.toBe(id);
    expect(api.ensure).toHaveBeenCalledWith('target', true);
    expect(api.invoke).toHaveBeenCalledWith('query', {
      hostId: 'target',
      request: { kind: 'images' },
    });
  },
);
it('rejects a failed target query and ignores a cancelled late query response', async () => {
  api.ensure.mockResolvedValue(undefined);
  api.invoke.mockResolvedValue({ success: false, message: 'Docker unavailable' });
  await expect(
    inspectImageTarget('target', 'app:v1', new AbortController().signal),
  ).rejects.toThrow('Docker unavailable');
  const controller = new AbortController();
  api.invoke.mockImplementation(async () => {
    controller.abort();
    return { success: true, records: [] };
  });
  await expect(inspectImageTarget('target', 'app:v1', controller.signal)).rejects.toMatchObject({
    code: 'USER_CANCELLED',
  });
});

it('keeps final stderr and unterminated stdout when a failed event shares the last poll batch', async () => {
  remoteSetup();
  const original = api.call.getMockImplementation()!;
  let polls = 0;
  api.call.mockImplementation(async (r) => {
    if (r.kind === 'stream_poll' && r.streamId === 'target' && ++polls === 2)
      return {
        events: [
          { type: 'data', stream: 'stdout', dataBase64: btoa('Loaded image: app:v1\n') },
          {
            type: 'data',
            stream: 'stderr',
            dataBase64: btoa('Loaded image content does not match the source'),
          },
          { type: 'data', stream: 'stdout', dataBase64: btoa('final diagnostic without newline') },
          {
            type: 'state',
            state: 'failed',
            code: 'LOG_COMMAND',
            message: '日志读取失败，可能是权限、文件/容器不存在或日志驱动不支持',
          },
        ],
      };
    return original(r);
  });
  const update = vi.fn();
  await expect(
    runImageArchive('source', remoteRequest, '', new AbortController().signal, update),
  ).rejects.toThrow('远程镜像命令执行失败');
  expect(update.mock.calls.at(-1)?.[0].output).toContain(
    'Loaded image content does not match the source',
  );
  expect(update.mock.calls.at(-1)?.[0].output).toContain('final diagnostic without newline');
});

it('requires the source content digest before opening any target receive stream', async () => {
  remoteSetup();
  const original = api.call.getMockImplementation()!;
  let polls = 0;
  api.call.mockImplementation(async (r) =>
    r.kind === 'stream_poll'
      ? ++polls === 1
        ? prepared
        : {
            events: [
              { type: 'data', stream: 'stdout', dataBase64: btoa(`SD_ARCHIVE_READY:${nonce}\n`) },
            ],
          }
      : original(r),
  );
  await expect(
    runImageArchive('source', remoteRequest, '', new AbortController().signal, vi.fn()),
  ).rejects.toThrow('未取得来源镜像内容摘要');
  expect(api.invoke).toHaveBeenCalledOnce();
  expect(api.call.mock.calls.some(([r]) => r.kind === 'transfer_start')).toBe(false);
});
