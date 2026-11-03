import { afterEach, expect, it, vi } from 'vitest';
import Zmodem from 'zmodem.js';
import { ZmodemUpload, type UploadProgress } from './zmodem';
import type { TerminalUploadSelection } from '../types/terminal';

interface Offer {
  get_details(): { name: string; size: number };
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
    files: files.map((file) => ({ name: file.name, size: file.data.length })),
  };
  const received: { name: string; data: number[] }[] = [];
  const output: number[] = [];
  const failed = vi.fn(),
    notice = vi.fn(),
    release = vi.fn().mockResolvedValue(undefined);
  const pick = vi.fn<() => Promise<TerminalUploadSelection>>().mockResolvedValue(selection);
  const read = vi.fn(async (_token: string, index: number, offset: number) =>
    Array.from(files[index]!.data.slice(offset, offset + 8192)),
  );
  let progress: UploadProgress | null = null;
  const send = vi.fn(async (data: Uint8Array) => {
    peer.consume(Array.from(data));
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
    },
  });
  instances.push(upload);
  peer.set_sender((data) => queueMicrotask(() => upload.consume(Uint8Array.from(data))));
  peer.on('offer', (offer) => {
    const item = { name: offer.get_details().name, data: [] as number[] };
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
  expect(h.failed).not.toHaveBeenCalled();
  expect(h.progress()).toBeNull();
  expect(h.upload.busy).toBe(false);
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
