import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), desktop: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  Channel: class {
    onmessage: unknown;
  },
}));
vi.mock('./ipc', () => ({ ensureDesktop: mocks.desktop }));
import { terminalApi } from './terminal';
describe('terminal IPC contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('starts native binary upload with an opaque grant and streams progress without file bytes', async () => {
    const receive = vi.fn();
    mocks.invoke.mockResolvedValue({ code: null, committed: 2, recovery: null });
    await terminalApi.runDrop('session', 'native-token', receive);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('terminal_upload_run_drop', {
      id: 'session',
      token: 'native-token',
      confirmed: true,
      events: expect.objectContaining({ onmessage: receive }),
    });
    await terminalApi.cancelDrop('session', 'native-token');
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_upload_cancel_drop', {
      id: 'session',
      token: 'native-token',
    });
  });
  it('uses raw binary ZMODEM payloads and binds writes to the terminal file grant', async () => {
    const bytes = new Uint8Array([0, 24, 255]);
    mocks.invoke.mockResolvedValueOnce(bytes.buffer);
    expect([...(await terminalApi.zmodemRead('session', 'grant', 2, 65536))]).toEqual([...bytes]);
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_zmodem_read', {
      id: 'session',
      token: 'grant',
      index: 2,
      offset: 65536,
    });
    await terminalApi.zmodemWrite('session', 'grant', bytes);
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_zmodem_write', bytes, {
      headers: { 'x-serverdeck-session': 'session', 'x-serverdeck-token': 'grant' },
    });
  });
  it('opens links through restricted desktop IPC and propagates browser failures', async () => {
    const url = 'http://localhost:8080/login?state=abc&next=%2Fhome#result';
    mocks.invoke.mockResolvedValueOnce(undefined);
    await terminalApi.openLink(url);
    expect(mocks.desktop).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('terminal_open_link', { url });
    mocks.invoke.mockRejectedValueOnce({ code: 'BROWSER_OPEN', message: '无法打开默认浏览器' });
    await expect(terminalApi.openLink(url)).rejects.toMatchObject({ code: 'BROWSER_OPEN' });
  });
  it('opens the fixed local shell through a streaming IPC without host or command input', async () => {
    const receive = vi.fn();
    mocks.invoke.mockResolvedValueOnce({ id: 'local:session', shell: 'PowerShell' });
    await terminalApi.openLocal({ cols: 80, rows: 24 }, receive);
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_local_open', {
      size: { cols: 80, rows: 24 },
      events: expect.objectContaining({ onmessage: receive }),
    });
  });
  it('uses a streaming channel and preserves binary input and acknowledgement sequence', async () => {
    mocks.invoke.mockResolvedValue({ id: 's', transportId: 't', hostId: 'h' });
    const receive = vi.fn();
    await terminalApi.open('h', { cols: 100, rows: 40 }, receive);
    const args = mocks.invoke.mock.calls[0]![1] as {
      events: { onmessage: (value: unknown) => void };
    };
    args.events.onmessage({ type: 'data', sequence: 1, data: [0, 255, 27] });
    expect(receive).toHaveBeenCalledWith({ type: 'data', sequence: 1, data: [0, 255, 27] });
    await terminalApi.input('s', new Uint8Array([3, 26, 255]));
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_input', {
      id: 's',
      data: [3, 26, 255],
    });
    await terminalApi.ack('s', 4);
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_ack', { id: 's', sequence: 4 });
    const resizeEvent = { cols: 120, rows: 40, colsChanged: true, rowsChanged: true };
    await terminalApi.resize('s', resizeEvent);
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_resize', {
      id: 's',
      size: { cols: 120, rows: 40 },
    });
  });
  it('requests elevation only explicitly and propagates UAC cancellation without retry', async () => {
    const receive = vi.fn();
    mocks.invoke.mockRejectedValueOnce({ code: 'LOCAL_TERMINAL', message: '已取消管理员终端授权' });
    await expect(
      terminalApi.openLocal({ cols: 80, rows: 24 }, receive, true),
    ).rejects.toMatchObject({ message: '已取消管理员终端授权' });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('terminal_local_open_elevated', {
      size: { cols: 80, rows: 24 },
      events: expect.objectContaining({ onmessage: receive }),
    });
  });
  it('requires desktop IPC and propagates a failed host-key decision', async () => {
    mocks.desktop.mockImplementationOnce(() => {
      throw new Error('desktop unavailable');
    });
    expect(() => terminalApi.open('h', { cols: 80, rows: 24 }, vi.fn())).toThrow(
      'desktop unavailable',
    );
    mocks.invoke.mockRejectedValueOnce({ code: 'SSH_HOST_KEY_CHANGED', message: 'changed' });
    await expect(terminalApi.trust('s', true)).rejects.toMatchObject({
      code: 'SSH_HOST_KEY_CHANGED',
    });
  });
  it('creates a fresh stream after local admission is busy and never retries authentication', async () => {
    mocks.invoke.mockClear();
    mocks.invoke.mockRejectedValueOnce({ code: 'BUSY' }).mockResolvedValueOnce({ id: 's' });
    await terminalApi.open('h', { cols: 80, rows: 24 }, vi.fn());
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls[0]![1].events).not.toBe(mocks.invoke.mock.calls[1]![1].events);
    mocks.invoke.mockClear();
    mocks.invoke.mockRejectedValueOnce({ code: 'SSH_AUTH_FAILED' });
    await expect(terminalApi.open('h', { cols: 80, rows: 24 }, vi.fn())).rejects.toMatchObject({
      code: 'SSH_AUTH_FAILED',
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
