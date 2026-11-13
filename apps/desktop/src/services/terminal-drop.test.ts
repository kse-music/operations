import { expect, it, vi } from 'vitest';
import { TerminalDropUpload } from './terminal-drop';
import type { TerminalDropProgress, TerminalDropResult } from '../types/terminal';

const snapshot = (phase: TerminalDropProgress['phase'] = 'uploading'): TerminalDropProgress => ({
  phase,
  sent: 4194304,
  size: 8388608,
  bytesPerSecond: 100 * 1024 ** 2,
  elapsedSeconds: 1,
  uid: '1001',
  username: '运维账户',
  directory: '/srv/current',
});
function harness() {
  let receive!: (p: TerminalDropProgress) => void;
  let finish!: (p: TerminalDropResult) => void;
  let reject!: (e: unknown) => void;
  const failed = vi.fn(),
    notice = vi.fn(),
    progress = vi.fn();
  const release = vi.fn(async () => {}),
    cancel = vi.fn(async () => {});
  const run = vi.fn((callback: typeof receive) => {
    receive = callback;
    return new Promise<TerminalDropResult>((resolve, fail) => {
      finish = resolve;
      reject = fail;
    });
  });
  const upload = new TerminalDropUpload({ run, cancel, release, progress, failed, notice });
  return {
    upload,
    run,
    cancel,
    release,
    progress,
    failed,
    notice,
    receive: (p: TerminalDropProgress) => receive(p),
    finish: (code: string | null = null, committed = 2, recovery: string | null = null) =>
      finish({ code, committed, recovery }),
    reject: (e: unknown) => reject(e),
  };
}
it('occupies input immediately and uses native progress without moving file payload through the UI', async () => {
  const h = harness();
  const running = h.upload.run();
  expect(h.upload.busy).toBe(true);
  expect(h.progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'preparing', sent: 0 }));
  h.receive(snapshot());
  expect(h.progress).toHaveBeenLastCalledWith(snapshot());
  h.receive({ ...snapshot('verifying'), sent: 8388608, bytesPerSecond: 0, elapsedSeconds: 2 });
  expect(h.release).not.toHaveBeenCalled();
  h.finish();
  await running;
  expect(h.notice).toHaveBeenCalledWith('上传完成：2 个项目。');
  expect(h.failed).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledOnce();
  expect(h.progress).toHaveBeenLastCalledWith(null);
  expect(h.upload.busy).toBe(false);
});
it.each(['preparing', 'uploading', 'verifying', 'committing'] as const)(
  'cancels once in %s and waits for native recovery and grant release',
  async (phase) => {
    const h = harness();
    let released!: () => void;
    h.release.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          released = resolve;
        }),
    );
    const running = h.upload.run();
    h.receive(snapshot(phase));
    h.upload.cancel();
    h.upload.cancel();
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.upload.busy).toBe(true);
    h.finish('CANCELLED', 0);
    await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
    expect(h.upload.busy).toBe(true);
    released();
    await running;
    expect(h.notice).toHaveBeenCalledWith('已取消上传。');
    expect(h.failed).not.toHaveBeenCalled();
    expect(h.upload.busy).toBe(false);
  },
);
it.each([
  'CONFLICT',
  'CHECKSUM',
  'EXTRACT',
  'METADATA',
  'RECEIVE',
  'COMMIT',
  'PERMISSION',
  'LOCAL_READ',
  'CLEANUP',
])('preserves native %s failures and the committed count even after cancellation', async (code) => {
  const h = harness();
  const running = h.upload.run();
  h.upload.cancel();
  h.finish(code, 1, code === 'CLEANUP' ? './.serverdeck-upload.test' : null);
  await running;
  expect(h.failed).toHaveBeenCalledOnce();
  expect(String(h.failed.mock.calls[0]![0])).toContain('已确认提交 1 个项目');
  if (code === 'CLEANUP')
    expect(String(h.failed.mock.calls[0]![0])).toContain('./.serverdeck-upload.test');
  expect(h.notice).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledOnce();
});
it('propagates transport and recovery failures without reporting success', async () => {
  const h = harness();
  const running = h.upload.run();
  h.reject(new Error('无法恢复终端设置，已关闭此会话'));
  await running;
  expect(String(h.failed.mock.calls[0]![0])).toContain('无法恢复终端设置');
  expect(h.notice).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledOnce();
});
it('keeps input occupied when a cancellation request fails until the native operation returns', async () => {
  const h = harness();
  h.cancel.mockRejectedValue(new Error('cancel IPC failed'));
  const running = h.upload.run();
  h.upload.cancel();
  await vi.waitFor(() => expect(h.failed).toHaveBeenCalledOnce());
  expect(h.upload.busy).toBe(true);
  h.finish('CANCELLED', 0);
  await running;
  expect(h.upload.busy).toBe(false);
});
it('disposes once, cancels native I/O and ignores late progress and completion', async () => {
  const h = harness();
  const running = h.upload.run();
  h.upload.dispose();
  h.upload.dispose();
  const calls = h.progress.mock.calls.length;
  h.receive(snapshot());
  h.finish();
  await running;
  expect(h.progress).toHaveBeenCalledTimes(calls);
  expect(h.cancel).toHaveBeenCalledOnce();
  expect(h.release).toHaveBeenCalledOnce();
  expect(h.notice).not.toHaveBeenCalled();
  expect(h.upload.busy).toBe(false);
});
it('reports a failed authorization release without falsely keeping native input occupied', async () => {
  const h = harness();
  h.release.mockRejectedValue(new Error('release failed'));
  const running = h.upload.run();
  h.finish();
  await running;
  expect(String(h.failed.mock.calls[0]![0])).toContain('release failed');
  expect(h.upload.busy).toBe(false);
});
