import { afterEach, expect, it, vi } from 'vitest';
import {
  archiveFileName,
  imageReference,
  runImageArchive,
  validArchiveName,
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
  events: [{ type: 'data', stream: 'stdout', dataBase64: btoa(`SD_ARCHIVE_READY:${nonce}\n`) }],
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
