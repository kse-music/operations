import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, getActivePinia, setActivePinia } from 'pinia';
vi.mock('../services/terminal', () => ({
  terminalApi: {
    close: vi.fn(),
    closeHost: vi.fn(),
    workspaceLoad: vi.fn(),
    workspaceSave: vi.fn(),
  },
}));
import { terminalApi } from '../services/terminal';
import { useTerminalsStore } from './terminals';
import type { Host } from '../types/hosts';
import { nextTick } from 'vue';
const host = { id: 'host', name: 'Host' } as Host;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});
afterEach(() => {
  disposePinia(getActivePinia()!);
  vi.useRealTimers();
});
describe('independent terminal tabs', () => {
  it('uses the address as the default terminal title for unnamed hosts', () => {
    const store = useTerminalsStore();
    store.open({ ...host, name: '', hostname: '192.0.2.10', port: 22 });
    expect(store.tabs[0]!.title).toBe('192.0.2.10');
    store.open({ ...host, name: '', hostname: '192.0.2.10', port: 2222 });
    expect(store.tabs[1]!.title).toBe('192.0.2.10:2222');
  });
  it('switches hosts without reopening sessions and remembers the last selected session per host', async () => {
    const store = useTerminalsStore();
    store.open(host);
    store.open(host);
    const last = store.active;
    await nextTick();
    store.open({ ...host, id: 'other' });
    const other = store.active;
    await nextTick();
    store.activateHost(host.id);
    expect(store.active).toBe(last);
    store.cycle(1);
    expect(store.active).toBe(store.tabs[0]!.key);
    store.cycle(1);
    expect(store.active).toBe(last);
    store.activateHost('other');
    expect(store.active).toBe(other);
    store.activateHost('');
    expect(store.active).toBe('');
    expect(store.panes).toHaveLength(3);
    expect(terminalApi.close).not.toHaveBeenCalled();
  });
  it('closes all sessions relative to the target host without switching to another host', async () => {
    const store = useTerminalsStore();
    store.open(host);
    const first = store.active;
    store.open({ ...host, id: 'other' });
    const other = store.active;
    store.open(host);
    await store.closeAll(first);
    expect(store.active).toBe('');
    expect(store.focused).toBe('');
    expect(store.tabs.map((t) => t.key)).toEqual([other]);
  });
  it('opens and restores local PTY metadata without a fabricated SSH host or stored commands', async () => {
    const store = useTerminalsStore();
    store.open(null);
    expect(store.panes[0]!.host).toBeNull();
    store.split(store.focused, 'columns');
    const saved = store.snapshot();
    expect(saved.tabs[0]!.panes.every((p) => p.hostId === null)).toBe(true);
    vi.mocked(terminalApi.workspaceLoad).mockResolvedValueOnce(saved);
    store.tabs = [];
    await store.restore([]);
    expect(store.panes).toHaveLength(2);
    expect(
      store.panes.every((p) => p.host === null && p.state === 'idle' && !p.connectRequested),
    ).toBe(true);
  });
  it('closing one session targets only its ID and selects the surviving tab', async () => {
    const store = useTerminalsStore();
    store.open(host);
    store.open(host);
    const first = store.tabs[0]!;
    const second = store.tabs[1]!;
    store.update(first.panes[0]!.key, { sessionId: 'first' });
    store.update(second.panes[0]!.key, { sessionId: 'second' });
    await store.close(second.key);
    expect(terminalApi.close).toHaveBeenCalledExactlyOnceWith('second');
    expect(store.tabs.map((tab) => tab.key)).toEqual([first.key]);
    expect(store.active).toBe(first.key);
  });
  it('closing the last pane selects a sibling session of the same host instead of a local terminal', async () => {
    const store = useTerminalsStore();
    store.open(null);
    const local = store.active;
    store.open(host);
    const first = store.active;
    store.open(host);
    await store.closePane(store.focused);
    expect(store.active).toBe(first);
    expect(store.panes.find((p) => p.key === store.focused)?.host?.id).toBe(host.id);
    await store.closePane(store.focused);
    expect(store.active).toBe('');
    expect(store.focused).toBe('');
    expect(store.tabs.map((t) => t.key)).toEqual([local]);
  });
  it('retains a tab on close failure and bounds the number of views', async () => {
    const store = useTerminalsStore();
    for (let i = 0; i < 33; i++) store.open(host);
    expect(store.tabs).toHaveLength(32);
    expect(store.error).toContain('32');
    const tab = store.tabs[0]!;
    store.update(tab.panes[0]!.key, { sessionId: 's' });
    vi.mocked(terminalApi.close).mockRejectedValueOnce({ message: 'close failed' });
    await store.close(tab.key);
    expect(store.tabs).toHaveLength(32);
    expect(store.error).toBe('close failed');
  });
  it('split, resize, rename and reorder retain the original live session', async () => {
    const store = useTerminalsStore();
    store.open(host);
    const first = store.tabs[0]!,
      pane = first.panes[0]!;
    store.update(pane.key, { sessionId: 'LIVE', state: 'connected' });
    store.split(pane.key, 'columns');
    expect(first.panes).toHaveLength(2);
    if (first.layout.kind === 'split') store.resize(first.key, first.layout.id, 30);
    store.rename(first.key, 'Renamed');
    store.open(host);
    const second = store.tabs[1]!;
    store.reorder(first.key, second.key);
    expect(store.panes.find((p) => p.key === pane.key)?.sessionId).toBe('LIVE');
    expect(terminalApi.close).not.toHaveBeenCalled();
    await store.closePane(first.panes[1]!.key);
    expect(first.layout).toEqual({ kind: 'leaf', pane: pane.key });
    expect(first.title).toBe('Renamed');
  });
  it.each(['remote', 'local'])(
    'closes every pane of the target %s host while preserving other hosts',
    async (kind) => {
      const store = useTerminalsStore();
      store.open({ ...host, id: 'other' });
      const other = store.tabs[0]!;
      store.update(other.panes[0]!.key, { sessionId: 'other-session' });
      const targetHost = kind === 'local' ? null : host;
      store.open(targetHost);
      const target = store.tabs[1]!;
      store.split(store.focused, 'columns');
      store.open(targetHost);
      const closingPanes = store.panes.filter((p) => p.host?.id !== 'other');
      for (const pane of closingPanes) store.update(pane.key, { sessionId: pane.key });
      store.select(other.key);
      await store.closeAll(target.key);
      expect(store.tabs.map((t) => t.key)).toEqual([other.key]);
      expect(store.active).toBe(other.key);
      expect(store.focused).toBe(other.panes[0]!.key);
      expect(terminalApi.close).toHaveBeenCalledTimes(3);
      expect(vi.mocked(terminalApi.close).mock.calls.flat().sort()).toEqual(
        closingPanes.map((p) => p.key).sort(),
      );
    },
  );
  it('retains a failed tab and reports its error while closing the remaining tabs in close-all', async () => {
    const store = useTerminalsStore();
    store.open(host);
    const failed = store.tabs[0]!;
    store.update(failed.panes[0]!.key, { sessionId: 'failed-session' });
    store.open(host);
    store.update(store.focused, { sessionId: 'closed-session' });
    vi.mocked(terminalApi.close).mockRejectedValueOnce({ message: 'close failed' });
    await store.closeAll(failed.key);
    expect(store.tabs.map((t) => t.key)).toEqual([failed.key]);
    expect(store.active).toBe(failed.key);
    expect(store.focused).toBe(failed.panes[0]!.key);
    expect(terminalApi.close).toHaveBeenCalledTimes(2);
    expect(terminalApi.close).toHaveBeenCalledWith('closed-session');
    expect(store.error).toBe('close failed');
  });
  it('keeps the current tab selected when closing another tab fails', async () => {
    const store = useTerminalsStore();
    store.open(host);
    const keep = store.tabs[0]!;
    store.open(host);
    const failed = store.active;
    store.update(store.focused, { sessionId: 'failed-session' });
    store.select(keep.key);
    vi.mocked(terminalApi.close).mockRejectedValueOnce({ message: 'close failed' });
    await store.close(failed);
    expect(store.tabs).toHaveLength(2);
    expect(store.active).toBe(keep.key);
    expect(store.focused).toBe(keep.panes[0]!.key);
    expect(terminalApi.close).toHaveBeenCalledExactlyOnceWith('failed-session');
    expect(store.error).toBe('close failed');
  });
  it('ignores stale menu targets without closing any sessions', async () => {
    const store = useTerminalsStore();
    store.open(host);
    const saved = store.snapshot();
    await store.close('missing');
    await store.closeAll('missing');
    expect(store.snapshot()).toEqual(saved);
    expect(terminalApi.close).not.toHaveBeenCalled();
  });
  it('preserves the focused split pane when closing another session', async () => {
    const store = useTerminalsStore();
    store.open(host);
    const closing = store.active;
    store.open(host);
    const target = store.active;
    store.split(store.focused, 'columns');
    const focused = store.focused;
    await store.close(closing);
    expect(store.tabs.map((t) => t.key)).toEqual([target]);
    expect(store.focused).toBe(focused);
  });
  it('restores metadata as disconnected panes without runtime IDs or automatic connection', async () => {
    const original = useTerminalsStore();
    original.open(host);
    const pane = original.panes[0]!;
    original.update(pane.key, { sessionId: 'SECRET_RUNTIME', state: 'connected' });
    original.split(pane.key, 'rows');
    const saved = original.snapshot();
    expect(JSON.stringify(saved)).not.toContain('SECRET_RUNTIME');
    setActivePinia(createPinia());
    vi.mocked(terminalApi.workspaceLoad).mockResolvedValueOnce(saved);
    const restored = useTerminalsStore();
    await restored.restore([host]);
    expect(restored.panes).toHaveLength(2);
    expect(
      restored.panes.every((p) => p.state === 'idle' && !p.connectRequested && !p.sessionId),
    ).toBe(true);
  });
  it('persists the empty workspace after the last tab closes without requiring a mounted view', async () => {
    vi.useFakeTimers();
    vi.mocked(terminalApi.workspaceLoad).mockResolvedValueOnce(null);
    const store = useTerminalsStore();
    await store.restore([host]);
    store.open(host);
    await vi.advanceTimersByTimeAsync(300);
    expect(terminalApi.workspaceSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tabs: [expect.objectContaining({ title: 'Host' })],
      }),
    );
    store.open(host);
    await store.closeAll(store.tabs[0]!.key);
    await vi.advanceTimersByTimeAsync(300);
    expect(terminalApi.workspaceSave).toHaveBeenLastCalledWith({
      version: 1,
      active: '',
      tabs: [],
    });
  });
});
