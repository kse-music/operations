import { afterEach, expect, it, vi } from 'vitest';
import { TerminalDropUpload, type DropProgress } from './terminal-drop';

const nonce = 'a'.repeat(32);
const encoder = new TextEncoder();
function frame(text: string): Uint8Array {
  return encoder.encode('\x1eSDU:' + nonce + ':' + text + '\x1f');
}
function fixture(size = 65540, result = 'DONE:2', username = 'root') {
  const bytes = Array.from({ length: size }, (_, i) => i % 256);
  const progress: (DropProgress | null)[] = [];
  const failed = vi.fn(),
    notice = vi.fn(),
    release = vi.fn(async () => {});
  const output: number[] = [],
    payload: number[] = [];
  let seq = 0;
  const send = vi.fn(async (data: Uint8Array) => {
    const text = new TextDecoder().decode(data);
    if (text === 'start\r') {
      const encodedUsername = btoa(String.fromCharCode(...encoder.encode(username)));
      const ready = frame('READY:0:' + encodedUsername + ':' + btoa('/root/current\n'));
      for (const byte of ready) upload.consume(Uint8Array.of(byte));
    } else {
      payload.push(...Array.from(atob(text), (c) => c.charCodeAt(0)));
      upload.consume(frame('ACK:' + seq++));
      if (payload.length === size) {
        upload.consume(
          encoder.encode(
            '\x1eSDU:' +
              nonce +
              ':VERIFYING\x1f\x1eSDU:' +
              nonce +
              ':COMMITTING\x1f\x1eSDU:' +
              nonce +
              ':' +
              result +
              (result.startsWith('FAIL:')
                ? '\x1f'
                : '\x1f\x1eSDU:' + nonce + ':RETURN\x1fShell prompt'),
          ),
        );
      }
    }
  });
  const prepare = vi.fn(async () => ({
    size,
    nonce,
    sha256: 'a'.repeat(64),
    command: 'start\r',
  }));
  const interrupt = vi.fn(async () => {
    upload.consume(frame('ERROR:CANCELLED:0'));
    upload.consume(frame('RETURN'));
  });
  const read = vi.fn(async (offset: number) => bytes.slice(offset, offset + 65536));
  const upload = new TerminalDropUpload({
    prepare,
    read,
    release,
    send,
    interrupt,
    progress: (value) => progress.push(value),
    failed,
    notice,
    write: (data) => output.push(...data),
  });
  return {
    upload,
    prepare,
    read,
    release,
    send,
    interrupt,
    progress,
    failed,
    notice,
    output,
    bytes,
    payload,
  };
}
afterEach(() => vi.useRealTimers());

it('streams bounded binary blocks and handles byte-fragmented READY and immediate final frames', async () => {
  const h = fixture();
  await h.upload.run();
  expect(h.payload).toEqual(h.bytes);
  expect(h.send.mock.calls.slice(1).every(([data]) => data.length <= 87384)).toBe(true);
  expect(h.failed).not.toHaveBeenCalled();
  expect(h.notice).toHaveBeenCalledWith('上传完成：2 个项目。');
  expect(h.progress).toContainEqual(
    expect.objectContaining({ uid: '0', username: 'root', directory: '/root/current' }),
  );
  expect(new TextDecoder().decode(Uint8Array.from(h.output))).toBe('\r\x1b[2KShell prompt');
  expect(h.release).toHaveBeenCalledTimes(1);
  expect(h.upload.busy).toBe(false);
});

it.each(['deploy', '运维账户', ''])(
  'uses the receiver account name %j and retains the numeric UID for fallback',
  async (username) => {
    const h = fixture(10, 'DONE:2', username);
    await h.upload.run();
    expect(h.progress).toContainEqual(
      expect.objectContaining({
        uid: '0',
        username: username || undefined,
        directory: '/root/current',
      }),
    );
    expect(h.failed).not.toHaveBeenCalled();
    expect(h.payload).toEqual(h.bytes);
  },
);

it.each(['!', '/w==', btoa('root\n'), btoa('root\0')])(
  'rejects a malformed receiver account name %j before reading local files',
  async (username) => {
    const h = fixture(10);
    h.send.mockImplementationOnce(async () => {
      h.upload.consume(frame('READY:0:' + username + ':' + btoa('/root/current\n')));
    });
    await h.upload.run();
    expect(h.failed.mock.calls[0]![0].message).toContain('身份响应无效');
    expect(h.read).not.toHaveBeenCalled();
    expect(h.notice).not.toHaveBeenCalled();
  },
);

it('measures average acknowledged archive bytes from READY and excludes preparation and startup', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const h = fixture(65540);
  h.prepare.mockImplementation(async () => {
    now = 20000;
    return { size: 65540, nonce, sha256: 'a'.repeat(64), command: 'start\r' };
  });
  h.send
    .mockImplementationOnce(async () => {
      now = 30000;
      h.upload.consume(frame('READY:0:' + btoa('root') + ':' + btoa('/root/current\n')));
    })
    .mockImplementationOnce(async () => {
      expect(h.progress.at(-1)).toMatchObject({ sent: 0, bytesPerSecond: 0, elapsedSeconds: 0 });
      now += 2000;
      h.upload.consume(frame('ACK:0'));
    })
    .mockImplementationOnce(async () => {
      // Sending the second block has not advanced acknowledged progress.
      expect(h.progress.at(-1)).toMatchObject({
        sent: 65536,
        bytesPerSecond: 32768,
        elapsedSeconds: 2,
      });
      now += 2000;
      h.upload.consume(frame('ACK:1'));
    });
  const running = h.upload.run();
  await vi.waitFor(() => expect(h.progress.at(-1)?.sent).toBe(65540));
  expect(h.progress.at(-1)).toMatchObject({
    phase: 'uploading',
    bytesPerSecond: 16385,
    elapsedSeconds: 4,
  });
  now += 10000;
  h.upload.consume(frame('VERIFYING'));
  expect(h.progress.at(-1)).toMatchObject({
    phase: 'verifying',
    bytesPerSecond: 0,
    elapsedSeconds: 14,
  });
  h.upload.consume(frame('COMMITTING'));
  h.upload.consume(frame('DONE:2'));
  h.upload.consume(frame('RETURN'));
  await running;
  expect(h.failed).not.toHaveBeenCalled();
  expect(h.notice).toHaveBeenCalledWith('上传完成：2 个项目。');
});

it.each(['complete', 'cancel', 'dispose'] as const)(
  'updates elapsed time while awaiting ACK or verification and stops updates on %s',
  async (action) => {
    vi.useFakeTimers();
    const h = fixture(10);
    h.send
      .mockImplementationOnce(async () => {
        h.upload.consume(frame('READY:0:' + btoa('root') + ':' + btoa('/root/current\n')));
      })
      .mockResolvedValue();
    const running = h.upload.run();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.progress.at(-1)).toMatchObject({
      phase: 'uploading',
      sent: 0,
      elapsedSeconds: 2,
      bytesPerSecond: 0,
    });
    h.upload.consume(frame('ACK:0'));
    h.upload.consume(frame('VERIFYING'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.progress.at(-1)).toMatchObject({
      phase: 'verifying',
      sent: 10,
      elapsedSeconds: 3,
      bytesPerSecond: 0,
    });
    if (action === 'complete') {
      h.upload.consume(frame('COMMITTING'));
      h.upload.consume(frame('DONE:2'));
      h.upload.consume(frame('RETURN'));
    } else if (action === 'cancel') h.upload.cancel();
    else h.upload.dispose();
    await running;
    const count = h.progress.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.progress).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.failed).not.toHaveBeenCalled();
  },
);

it('keeps speed finite at zero elapsed time and clears it when cancelling', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const h = fixture();
  h.send
    .mockImplementationOnce(async () => {
      h.upload.consume(frame('READY:0:' + btoa('root') + ':' + btoa('/root/current\n')));
    })
    .mockImplementationOnce(async () => {
      h.upload.consume(frame('ACK:0'));
    })
    .mockImplementationOnce(async () => {});
  const running = h.upload.run();
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
  expect(h.progress.at(-1)).toMatchObject({ sent: 65536, bytesPerSecond: 0 });
  h.upload.cancel();
  await running;
  expect(h.progress).toContainEqual(
    expect.objectContaining({ phase: 'cancelling', bytesPerSecond: 0 }),
  );
  expect(
    h.progress.filter((value) => value).every((value) => Number.isFinite(value!.bytesPerSecond)),
  ).toBe(true);
  expect(h.interrupt).toHaveBeenCalledOnce();
  expect(h.failed).not.toHaveBeenCalled();
});

it('reports remote conflicts without claiming completion or replacing the cause', async () => {
  const h = fixture(10, 'ERROR:CONFLICT:0');
  await h.upload.run();
  expect(h.failed.mock.calls[0]![0].message).toContain('同名');
  expect(h.notice).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledTimes(1);
});

it('interrupts a quarantined peer failure and preserves the original conflict reason', async () => {
  const h = fixture(10, 'FAIL:CONFLICT:0');
  await h.upload.run();
  expect(h.interrupt).toHaveBeenCalledOnce();
  expect(h.failed.mock.calls[0]![0].message).toContain('同名');
  expect(h.upload.busy).toBe(false);
  expect(h.notice).not.toHaveBeenCalled();
});

it('cancels immediately while waiting for verification rather than waiting for timeout', async () => {
  const h = fixture(10);
  h.send
    .mockImplementationOnce(async () => {
      h.upload.consume(frame('READY:0:' + btoa('root') + ':' + btoa('/root/current\n')));
    })
    .mockImplementation(async () => {
      h.upload.consume(frame('ACK:0'));
      h.upload.consume(frame('VERIFYING'));
    });
  const running = h.upload.run();
  await vi.waitFor(() => expect(h.progress.at(-1)?.phase).toBe('verifying'));
  h.upload.cancel();
  await running;
  expect(h.interrupt).toHaveBeenCalledOnce();
  expect(h.upload.busy).toBe(false);
  expect(h.notice.mock.calls[0]![0]).toContain('取消');
});

it('keeps input isolated when the peer reports a terminal restoration failure', async () => {
  const h = fixture(10, 'ERROR:TTY_RESTORE:0');
  await h.upload.run();
  expect(h.upload.busy).toBe(true);
  expect(h.progress.at(-1)?.phase).toBe('blocked');
  expect(h.failed.mock.calls[0]![0].message).toContain('无法恢复');
  expect(h.release).toHaveBeenCalledOnce();
  h.upload.dispose();
});

it('rejects premature completion before READY and never reads local content', async () => {
  const h = fixture(10);
  h.send.mockImplementation(async () => {
    h.upload.consume(frame('DONE:1'));
    h.upload.consume(frame('RETURN'));
  });
  await h.upload.run();
  expect(h.failed.mock.calls[0]![0].message).toContain('提前报告完成');
  expect(h.read).not.toHaveBeenCalled();
  expect(h.notice).not.toHaveBeenCalled();
  expect(h.upload.busy).toBe(false);
});

it('never sends bytes from a preparation completed after cancellation', async () => {
  const h = fixture(10);
  let resolve!: (value: Awaited<ReturnType<typeof h.prepare>>) => void;
  h.prepare.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const running = h.upload.run();
  h.upload.cancel();
  resolve({ size: 10, nonce, sha256: 'a'.repeat(64), command: 'start\r' });
  await running;
  expect(h.send).not.toHaveBeenCalled();
  expect(h.read).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledTimes(1);
  expect(h.upload.busy).toBe(false);
});

it('interrupts and waits for confirmed peer exit on read failure', async () => {
  const h = fixture(10);
  h.read.mockRejectedValue(new Error('source failed'));
  await h.upload.run();
  expect(h.interrupt).toHaveBeenCalledTimes(1);
  expect(h.failed.mock.calls[0]![0].message).toBe('source failed');
  expect(h.release).toHaveBeenCalledTimes(1);
  expect(h.upload.busy).toBe(false);
});

it('keeps input occupied when the peer cannot confirm cancellation', async () => {
  vi.useFakeTimers();
  const h = fixture(10);
  h.send.mockResolvedValue();
  h.interrupt.mockResolvedValue();
  const running = h.upload.run();
  await vi.advanceTimersByTimeAsync(35001);
  await running;
  expect(h.upload.busy).toBe(true);
  expect(h.progress.at(-1)?.phase).toBe('blocked');
  expect(h.failed.mock.calls[0]![0].message).toContain('无法确认');
  expect(h.release).toHaveBeenCalledTimes(1);
  h.upload.dispose();
});

it('does not send, read or report success after the owning session is disposed', async () => {
  const h = fixture(10);
  h.send.mockImplementation(async () => {
    h.upload.dispose();
  });
  await h.upload.run();
  expect(h.read).not.toHaveBeenCalled();
  expect(h.notice).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledTimes(1);
});

it('suppresses command echo and diagnostics without accepting a wrong task nonce', async () => {
  const h = fixture(10);
  h.send.mockImplementationOnce(async () => {
    h.upload.consume(encoder.encode('before\x1eSDU:other:READY:0:abc\x1fafter'));
    h.upload.consume(frame('ERROR:PERMISSION:0'));
    h.upload.consume(frame('RETURN'));
  });
  await h.upload.run();
  expect(h.output).toEqual([]);
  expect(h.read).not.toHaveBeenCalled();
  expect(h.failed.mock.calls[0]![0].message).toContain('不能在当前目录');
});

it('waits for the parent Shell return fence and refreshes its later prompt in place', async () => {
  const h = fixture(10);
  h.send
    .mockImplementationOnce(async () => {
      h.upload.consume(encoder.encode("/bin/sh -c 'sd_nonce=$1\r\n> script body\r\n"));
      h.upload.consume(frame('READY:0:' + btoa('root') + ':' + btoa('/root/current\n')));
    })
    .mockImplementation(async () => {
      h.upload.consume(frame('ACK:0'));
      h.upload.consume(frame('VERIFYING'));
      h.upload.consume(frame('COMMITTING'));
      h.upload.consume(frame('DONE:1'));
      h.upload.consume(encoder.encode('owned trailing output'));
    });
  const running = h.upload.run();
  await vi.waitFor(() => expect(h.progress.at(-1)?.phase).toBe('committing'));
  expect(h.upload.busy).toBe(true);
  expect(h.notice).not.toHaveBeenCalled();
  expect(h.output).toEqual([]);
  const returning = frame('RETURN');
  for (const byte of returning) h.upload.consume(Uint8Array.of(byte));
  await running;
  expect(h.upload.pendingOutput).toBe(true);
  h.upload.consume(encoder.encode('user@host$ '));
  expect(new TextDecoder().decode(Uint8Array.from(h.output))).toBe('\r\x1b[2Kuser@host$ ');
  expect(h.upload.pendingOutput).toBe(false);
});

it('keeps cleanup failures visible when the user cancelled', async () => {
  const h = fixture(10);
  h.read.mockImplementation(async () => {
    h.upload.cancel();
    return [];
  });
  h.interrupt.mockImplementation(async () => {
    h.upload.consume(frame('ERROR:CLEANUP:0:' + btoa('./.serverdeck-upload.test')));
    h.upload.consume(frame('RETURN'));
  });
  await h.upload.run();
  expect(h.failed.mock.calls[0]![0].message).toContain('清理失败');
  expect(h.notice).not.toHaveBeenCalled();
});
