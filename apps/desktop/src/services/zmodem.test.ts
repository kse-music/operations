import { afterEach, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import Zmodem from 'zmodem.js';
import { ZmodemUpload, type UploadProgress } from './zmodem';
import type { TerminalUploadSelection } from '../types/terminal';

interface Offer {
  get_details(): { name: string; size: number; mtime: Date };
  on(event: 'input', callback: (data: number[]) => void): void;
  accept(): Promise<void>;
  skip(): void;
}
interface Receiver {
  set_sender(callback: (data: number[]) => void): void;
  on(event: 'offer', callback: (offer: Offer) => void): void;
  consume(data: number[]): void;
  start(): void;
  abort(): void;
  has_ended(): boolean;
}
const Protocol = Zmodem as unknown as { Session: { Receive: new () => Receiver } };
const instances: ZmodemUpload[] = [];
afterEach(() => {
  instances.splice(0).forEach((upload) => upload.dispose());
  vi.useRealTimers();
});
function harness(
  files = [{ name: '中文 空格.bin', data: Uint8Array.from({ length: 20000 }, (_, i) => i % 256) }],
) {
  const peer = new Protocol.Session.Receive();
  const selection: TerminalUploadSelection = {
    token: 'selection',
    files: files.map((file) => ({ name: file.name, size: file.data.length, modified: 1645594860 })),
  };
  const received: { name: string; modified: number; data: number[] }[] = [];
  const output: number[] = [];
  const failed = vi.fn(),
    notice = vi.fn(),
    release = vi.fn().mockResolvedValue(undefined);
  const pick = vi.fn<() => Promise<TerminalUploadSelection>>().mockResolvedValue(selection);
  const read = vi.fn(async (_token: string, index: number, offset: number) =>
    Array.from(files[index]!.data.slice(offset, offset + 8192)),
  );
  let progress: UploadProgress | null = null;
  const snapshots: UploadProgress[] = [];
  const send = vi.fn(async (data: Uint8Array) => {
    for (let offset = 0; offset < data.length; offset += 16384)
      peer.consume(Array.from(data.subarray(offset, offset + 16384)));
  });
  const upload = new ZmodemUpload({
    write: (data) => output.push(...data),
    send,
    pick,
    read,
    release,
    failed,
    notice,
    progress: (value) => {
      progress = value;
      if (value) snapshots.push(value);
    },
  });
  instances.push(upload);
  peer.set_sender((data) => queueMicrotask(() => upload.consume(Uint8Array.from(data))));
  peer.on('offer', (offer) => {
    const details = offer.get_details();
    const item = {
      name: details.name,
      modified: details.mtime.getTime() / 1000,
      data: [] as number[],
    };
    received.push(item);
    offer.on('input', (data) => item.data.push(...data));
    void offer.accept();
  });
  return {
    upload,
    peer,
    received,
    output,
    failed,
    notice,
    release,
    pick,
    read,
    send,
    selection,
    files,
    snapshots,
    progress: () => progress,
  };
}

it('uploads binary, Unicode filenames and empty files through the real protocol codec', async () => {
  const h = harness([
    { name: '中文 空格.bin', data: Uint8Array.from({ length: 90000 }, (_, i) => i % 256) },
    { name: 'empty.txt', data: new Uint8Array() },
  ]);
  h.peer.start();
  await vi.waitFor(() =>
    expect(h.notice).toHaveBeenCalledWith('ZMODEM 上传完成：2 个文件，远端跳过 0 个文件。'),
  );
  expect(h.received.map((file) => [file.name, Uint8Array.from(file.data)])).toEqual(
    h.files.map((file) => [file.name, file.data]),
  );
  expect(h.release).toHaveBeenCalledExactlyOnceWith('selection');
  expect(h.received.map((file) => file.modified)).toEqual([1645594860, 1645594860]);
  expect(h.failed).not.toHaveBeenCalled();
  expect(h.progress()).toBeNull();
  expect(h.upload.busy).toBe(false);
});

it('transfers 64 KiB reads losslessly with bounded coalesced writes and throttled progress', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const h = harness([
    { name: 'bulk.bin', data: Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 256) },
  ]);
  h.read.mockImplementation(async (_token, index, offset) => [
    ...h.files[index]!.data.slice(offset, offset + 65536),
  ]);
  h.peer.start();
  await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
  expect(h.read).toHaveBeenCalledTimes(16);
  expect(Buffer.from(h.received[0]!.data).equals(Buffer.from(h.files[0]!.data))).toBe(true);
  expect(h.send.mock.calls.length).toBeLessThan(24);
  expect(h.send.mock.calls.every(([data]) => data.length <= 256 * 1024)).toBe(true);
  expect(h.snapshots.filter((progress) => progress.phase === 'uploading').length).toBeLessThan(16);
  expect(h.failed).not.toHaveBeenCalled();
});

it('prefetches at most one block and waits for the active batch and cancel frame before releasing', async () => {
  const h = harness([{ name: 'cancel.bin', data: new Uint8Array(4 * 65536).fill(7) }]);
  h.read.mockImplementation(async (_token, index, offset) => [
    ...h.files[index]!.data.slice(offset, offset + 65536),
  ]);
  let accept!: () => void;
  h.send.mockImplementation(async (data) => {
    for (let offset = 0; offset < data.length; offset += 16384)
      h.peer.consume([...data.subarray(offset, offset + 16384)]);
    if (data.length > 65536)
      await new Promise<void>((resolve) => {
        accept = resolve;
      });
  });
  h.peer.start();
  await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  h.upload.cancel();
  await Promise.resolve();
  expect(h.upload.busy).toBe(true);
  expect(h.release).not.toHaveBeenCalled();
  expect(h.read).toHaveBeenCalledTimes(2);
  accept();
  await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
  expect(h.send.mock.calls.at(-1)![0].slice(0, 5)).toEqual(Uint8Array.of(24, 24, 24, 24, 24));
  expect(h.upload.busy).toBe(false);
});

it('reports a failed prefetch and aborts without sending a following file block', async () => {
  const h = harness([{ name: 'changed.bin', data: new Uint8Array(2 * 65536).fill(7) }]);
  h.read
    .mockResolvedValueOnce([...h.files[0]!.data.slice(0, 65536)])
    .mockRejectedValueOnce(new Error('prefetched file changed'));
  h.peer.start();
  await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
  expect(h.failed).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'prefetched file changed' }),
  );
  expect(h.received[0]!.data).toHaveLength(65536);
  expect(h.notice).not.toHaveBeenCalled();
});

it('reports current file timing and speed without counting time spent choosing files', async () => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const h = harness();
  h.pick.mockImplementation(async () => {
    now += 10000;
    return h.selection;
  });
  h.read.mockImplementation(async (_token, index, offset) => {
    now += 1000;
    return [...h.files[index]!.data.slice(offset, offset + 8192)];
  });
  let release!: () => void;
  h.release.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  h.peer.start();
  await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
  expect(h.snapshots).toContainEqual(
    expect.objectContaining({
      phase: 'uploading',
      sent: 8192,
      elapsedSeconds: 2,
      bytesPerSecond: 4096,
    }),
  );
  expect(h.progress()).toEqual({
    phase: 'finishing',
    files: ['中文 空格.bin'],
    name: '中文 空格.bin',
    sent: 20000,
    size: 20000,
    elapsedSeconds: 3,
    bytesPerSecond: 20000 / 3,
  });
  release();
  await vi.waitFor(() => expect(h.progress()).toBeNull());
  expect(h.failed).not.toHaveBeenCalled();
});

it('refreshes stalled transfer timing and stops updates when the session is disposed', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.read.mockReturnValue(new Promise(() => {}));
  h.peer.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.progress()).toMatchObject({
    phase: 'uploading',
    sent: 0,
    elapsedSeconds: 2,
    bytesPerSecond: 0,
  });
  h.upload.dispose();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.progress()).toBeNull();
  expect(h.release).toHaveBeenCalledOnce();
  const count = h.snapshots.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.snapshots).toHaveLength(count);
});

it('recognizes every split point without displaying the handshake or losing surrounding terminal text', async () => {
  const source = new Protocol.Session.Receive();
  let header: number[] = [];
  source.set_sender((data) => {
    header = data;
  });
  source.start();
  for (let split = 1; split < header.length; split++) {
    const h = harness([]);
    h.pick.mockReturnValue(new Promise(() => {}));
    const before = new TextEncoder().encode('long ordinary terminal output '.repeat(4));
    h.upload.consume(Uint8Array.from([...before, ...header.slice(0, split)]));
    h.upload.consume(Uint8Array.from(header.slice(split)));
    expect(h.pick).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(Uint8Array.from(h.output))).toBe(
      new TextDecoder().decode(before),
    );
    h.upload.dispose();
  }
});

it('preserves malformed header text and never opens a picker for ordinary output', () => {
  const h = harness();
  const text = new TextEncoder().encode('abc **\x18B0100000023ffff\r\n normal output');
  for (const byte of text) h.upload.consume(Uint8Array.of(byte));
  expect(h.output).toEqual(Array.from(text));
  expect(h.pick).not.toHaveBeenCalled();
});

it('closes the protocol cleanly when file selection is cancelled', async () => {
  const h = harness([]);
  h.peer.start();
  await vi.waitFor(() => expect(h.notice).toHaveBeenCalledWith('已取消 ZMODEM 文件选择。'));
  expect(h.read).not.toHaveBeenCalled();
  expect(h.failed).not.toHaveBeenCalled();
  expect(h.peer.has_ended()).toBe(true);
  expect(h.release).toHaveBeenCalledTimes(1);
});

it('keeps the shell prompt when it shares a packet with the final protocol response', async () => {
  const h = harness([]);
  const prompt = new TextEncoder().encode('\r\n[root@test ~]# ');
  h.peer.set_sender((data) => {
    const final = data[4] === 48 && data[5] === 56;
    queueMicrotask(() => h.upload.consume(Uint8Array.from([...data, ...(final ? prompt : [])])));
  });
  h.peer.start();
  await vi.waitFor(() => expect(h.release).toHaveBeenCalledTimes(1));
  expect(new TextDecoder().decode(Uint8Array.from(h.output))).toContain('[root@test ~]# ');
  expect(h.failed).not.toHaveBeenCalled();
});

it('rejects unsupported receiver flags without breaking the terminal output callback', async () => {
  const h = harness();
  h.send.mockResolvedValue(undefined);
  const codec = Zmodem as unknown as {
    Header: { build(name: string, flags: string[]): { to_hex(): number[] } };
  };
  const unsupported = codec.Header.build('ZRINIT', []).to_hex();
  expect(() => h.upload.consume(Uint8Array.from(unsupported))).not.toThrow();
  expect(h.pick).not.toHaveBeenCalled();
  expect(h.failed).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('参数不受支持') }),
  );
  expect(Array.from(h.send.mock.calls[0]![0]).slice(0, 5)).toEqual([24, 24, 24, 24, 24]);
  h.upload.consume(new TextEncoder().encode('shell remains usable'));
  expect(new TextDecoder().decode(Uint8Array.from(h.output))).toContain('shell remains usable');
});

it('reports remote skip without claiming that the file uploaded', async () => {
  const h = harness();
  // Use a separate receiver which declines every offer.
  const peer = new Protocol.Session.Receive();
  peer.set_sender((data) => queueMicrotask(() => h.upload.consume(Uint8Array.from(data))));
  peer.on('offer', (offer) => offer.skip());
  h.send.mockImplementation(async (data) => peer.consume(Array.from(data)));
  peer.start();
  await vi.waitFor(() =>
    expect(h.notice).toHaveBeenCalledWith('ZMODEM 上传完成：0 个文件，远端跳过 1 个文件。'),
  );
  expect(h.read).not.toHaveBeenCalled();
  expect(h.failed).not.toHaveBeenCalled();
});

it('aborts and releases the selected files on a local read failure', async () => {
  const h = harness();
  h.read.mockRejectedValue(new Error('file unavailable'));
  h.peer.start();
  await vi.waitFor(() => expect(h.release).toHaveBeenCalledTimes(1));
  expect(h.failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'file unavailable' }));
  expect(h.notice).not.toHaveBeenCalled();
  expect(h.upload.busy).toBe(false);
});

it('does not read or send files selected after disconnect, and releases the late grant', async () => {
  const h = harness();
  let choose!: (selection: TerminalUploadSelection) => void;
  h.pick.mockReturnValue(
    new Promise((resolve) => {
      choose = resolve;
    }),
  );
  h.peer.start();
  await vi.waitFor(() => expect(h.pick).toHaveBeenCalledTimes(1));
  h.upload.dispose();
  const sentBefore = h.send.mock.calls.length;
  choose(h.selection);
  await vi.waitFor(() => expect(h.release).toHaveBeenCalledWith('selection'));
  expect(h.read).not.toHaveBeenCalled();
  expect(h.send).toHaveBeenCalledTimes(sentBefore);
  expect(h.notice).not.toHaveBeenCalled();
});

it('times out a stalled receiver and releases the selection', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.send.mockResolvedValue(undefined);
  h.peer.start();
  await vi.advanceTimersByTimeAsync(31000);
  expect(h.failed).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('超时') }),
  );
  expect(h.release).toHaveBeenCalledWith('selection');
  expect(h.upload.busy).toBe(false);
});
