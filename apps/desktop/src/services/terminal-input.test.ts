import { describe, it, expect, vi } from 'vitest';
import { TerminalInputQueue } from './terminal-input';
describe('bounded terminal input', () => {
  it('flushes only after queued bytes are accepted, and rejects a disconnected flush', async () => {
    let accept!: () => void;
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            accept = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const queue = new TerminalInputQueue(send, vi.fn());
    queue.reset('first');
    queue.enqueue(new Uint8Array(20000));
    const flushed = vi.fn();
    const pending = queue.flush().then(flushed);
    expect(flushed).not.toHaveBeenCalled();
    accept();
    await pending;
    expect(send).toHaveBeenCalledTimes(2);
    queue.enqueue(Uint8Array.of(1));
    const interrupted = expect(queue.flush()).rejects.toThrow('会话已改变');
    queue.reset('replacement');
    await interrupted;
    queue.dispose();
  });
  it('never replays old input or consumes new queue entries after reconnect', async () => {
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const send = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined);
    const error = vi.fn();
    const pump = new TerminalInputQueue(send, error);
    pump.reset('old');
    pump.enqueue(new Uint8Array([1]));
    pump.enqueue(new Uint8Array([2]));
    pump.reset('new');
    pump.enqueue(new Uint8Array([3]));
    finish();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map((call) => [call[0], Array.from(call[1] as Uint8Array)])).toEqual([
      ['old', [1]],
      ['new', [3]],
    ]);
    expect(error).not.toHaveBeenCalled();
    pump.dispose();
  });
  it('bounds bytes and IPC chunks, and retries BUSY without dropping data', async () => {
    const send = vi.fn().mockRejectedValueOnce({ code: 'BUSY' }).mockResolvedValue(undefined);
    const pump = new TerminalInputQueue(send, vi.fn());
    pump.reset('session');
    expect(pump.enqueue(new Uint8Array(128 * 1024 + 1))).toBe(false);
    expect(pump.enqueue(new Uint8Array(2 * 1024 * 1024 + 33), true)).toBe(false);
    expect(pump.enqueue(new Uint8Array(32768), true)).toBe(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls.every((call) => (call[1] as Uint8Array).length <= 16384)).toBe(true);
    pump.dispose();
  });
});
