import { beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
const isTauri = vi.hoisted(() => vi.fn(() => true));
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  isTauri,
  Channel: class {
    onmessage: unknown;
  },
}));
import { pluginsApi } from './plugins';

describe('plugin IPC boundary', () => {
  beforeEach(() => {
    invoke.mockReset();
    isTauri.mockReturnValue(true);
  });
  it('passes development acknowledgement, upgrade binding and cleanup choice explicitly', async () => {
    await pluginsApi.install('local.sdplugin', true, '1.0.0');
    expect(invoke).toHaveBeenLastCalledWith('plugin_install', {
      input: {
        path: 'local.sdplugin',
        developmentConfirmed: true,
        expectedVersion: '1.0.0',
        expectedDigest: null,
      },
    });
    await pluginsApi.uninstall('dev.example', false, true);
    expect(invoke).toHaveBeenLastCalledWith('plugin_uninstall', {
      input: { id: 'dev.example', clearData: false, confirmed: true },
    });
  });
  it('propagates backend rejection and rejects browser preview without faking a list', async () => {
    invoke.mockRejectedValueOnce({ code: 'PLUGIN_INVALID', message: 'invalid package' });
    await expect(pluginsApi.preview('bad.sdplugin')).rejects.toMatchObject({
      code: 'PLUGIN_INVALID',
    });
    isTauri.mockReturnValue(false);
    expect(() => pluginsApi.list()).toThrow('未连接 Rust 后端');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('keeps capability requests separate from grant and one-shot approval commands', async () => {
    const request = {
      apiVersion: 1,
      requestId: 'read',
      operation: { kind: 'platform' as const, request: { kind: 'hosts' as const }, bindings: [] },
    };
    await pluginsApi.capability('dev.example', request);
    expect(invoke).toHaveBeenLastCalledWith('plugin_capability', {
      id: 'dev.example',
      owner: 'default',
      request,
    });
    await pluginsApi.approve('one-shot-token', false);
    expect(invoke).toHaveBeenLastCalledWith('plugin_approve', {
      id: 'one-shot-token',
      confirmed: false,
    });
    await pluginsApi.revoke('dev.example');
    expect(invoke).toHaveBeenLastCalledWith('plugin_revoke', { id: 'dev.example' });
  });
  it('binds the shell ticket and exact target while excluding host-only plugin attribution from the native DTO', async () => {
    const receive = vi.fn();
    await pluginsApi.platformTerminalOpen(
      'dev.example',
      'owner',
      'ticket',
      'host',
      { cols: 80, rows: 24 },
      receive,
    );
    const args = invoke.mock.calls.at(-1)!;
    expect(args[0]).toBe('plugin_platform_terminal_open');
    expect(args[1]).toMatchObject({
      id: 'dev.example',
      owner: 'owner',
      ticket: 'ticket',
      expectedHost: 'host',
      size: { cols: 80, rows: 24 },
    });
    expect(args[1]).not.toHaveProperty('expected');
    expect(args[1].events.onmessage).toBe(receive);
  });
});
