import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useWorkspaceStore } from './workspace';
import { useOpsStore } from './ops';
import { hostInput } from '../types/hosts';
import { pidPorts, sameHostConnection } from '../services/product-links';
import { globalKey } from '../types/product';
vi.mock('../services/ops', () => ({ opsApi: { close: vi.fn(), connections: vi.fn() } }));
vi.mock('../services/terminal', () => ({ terminalApi: { trust: vi.fn() } }));
import { opsApi } from '../services/ops';
import { terminalApi } from '../services/terminal';
describe('product integration boundaries', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });
  it('keys workspaces by host and module, keeps independent contexts, and never creates sessions', () => {
    const w = useWorkspaceStore();
    w.navigate('files', 'a');
    const a = w.current.key;
    w.navigate('files', 'b');
    expect(w.tabs.filter((t) => t.view === 'files')).toHaveLength(2);
    w.navigate('operations', 'a', 'processes');
    expect(w.current.section).toBe('processes');
    w.navigate('files', 'a');
    expect(w.current.key).toBe(a);
    w.close(a);
    expect(w.current.key).not.toBe(a);
    w.navigate('settings', 'b');
    expect(w.current.hostId).toBe('');
    expect(opsApi.close).not.toHaveBeenCalled();
  });
  it('closing a navigation tab leaves background sessions alone and caps retained navigation', () => {
    const w = useWorkspaceStore();
    for (let n = 0; n < 40; n++) w.navigate('monitor', `host-${n}`);
    expect(w.tabs).toHaveLength(24);
    const last = w.current.key;
    w.close(last);
    expect(w.current.key).not.toBe(last);
    expect(opsApi.close).not.toHaveBeenCalled();
  });
  it('targets trust and close by explicit host even when a multi-host dialog changes active host', async () => {
    const ops = useOpsStore();
    ops.connections.a = {
      host: { id: 'a' },
      state: 'connected',
      session: { id: 'session-a' },
      trust: null,
      error: null,
    } as never;
    ops.connections.b = {
      host: { id: 'b' },
      state: 'connected',
      session: { id: 'session-b' },
      trust: null,
      error: null,
    } as never;
    ops.active = 'b';
    await ops.trust(true, 'a');
    await ops.close('a');
    expect(terminalApi.trust).toHaveBeenCalledWith('session-a', true);
    expect(opsApi.close).toHaveBeenCalledWith('session-a');
    expect(ops.connections.b!.state).toBe('connected');
  });
  it('associates ports only from exact reported PID and preserves unknown ownership', () => {
    const rows = [
      { process: 'users:(("node",pid=12,fd=4))', local: ':80' },
      { process: 'users:(("node",pid=123,fd=5))', local: ':81' },
      { process: null, local: ':12' },
    ];
    expect(pidPorts(rows, 12)).toEqual([rows[0]]);
    expect(pidPorts(rows, 1)).toEqual([]);
    expect(pidPorts(rows, NaN)).toEqual([]);
  });
  it('keeps connection identity separate from edited host metadata and detects endpoint/route changes', () => {
    const a = hostInput();
    a.hostname = 'server.example';
    const renamed = { ...a, name: 'new display name', favorite: true };
    expect(sameHostConnection(a, renamed)).toBe(true);
    expect(sameHostConnection(a, { ...a, port: 23 })).toBe(false);
    expect(sameHostConnection(a, { ...a, ssh: { ...a.ssh, jumpHostId: 'different-route' } })).toBe(
      false,
    );
  });
  it('global shortcuts require a modifier, ignore composition and repeat', () => {
    expect(globalKey(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))).toBe('Ctrl+K');
    expect(
      globalKey(new KeyboardEvent('keydown', { key: 'j', metaKey: true, shiftKey: true })),
    ).toBe('Ctrl+Shift+J');
    expect(globalKey(new KeyboardEvent('keydown', { key: 'k' }))).toBeNull();
    expect(
      globalKey(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, isComposing: true })),
    ).toBeNull();
  });
});
