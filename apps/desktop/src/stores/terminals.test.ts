import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, getActivePinia, setActivePinia } from 'pinia';
vi.mock('../services/terminal', () => ({
  terminalApi: {
    close: vi.fn(),
    closeHost: vi.fn(),
  },
}));
import { terminalApi } from '../services/terminal';
import { useTerminalsStore } from './terminals';
import { usePluginsStore } from './plugins';
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
  it('keeps an upload and its session when close confirmation is declined', async () => {
    const store = useTerminalsStore();
    store.open(host);
    const pane = store.panes[0]!;
    store.update(pane.key, { sessionId: 'upload-session' });
    const stop = vi.fn(async () => {});
    store.registerUpload(pane.key, () => true, stop);
    vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(false);
    await store.closePane(pane.key);
    expect(stop).not.toHaveBeenCalled();
    expect(terminalApi.close).not.toHaveBeenCalled();
    expect(store.panes).toHaveLength(1);
  });
  it('waits for upload cancellation before closing its channel', async () => {
    const store = useTerminalsStore();
    store.open(host);
    const pane = store.panes[0]!;
    store.update(pane.key, { sessionId: 'upload-session' });
    let finish!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    store.registerUpload(pane.key, () => true, stop);
    vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(true);
    const closing = store.closePane(pane.key);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(terminalApi.close).not.toHaveBeenCalled();
    finish();
    await closing;
    expect(terminalApi.close).toHaveBeenCalledExactlyOnceWith('upload-session');
    expect(store.panes).toEqual([]);
  });
  it('confirms once for all upload panes in a host and unregisters old handlers', async () => {
    const store = useTerminalsStore();
    store.open(host);
    const first = store.panes[0]!;
    const stop = vi.fn(async () => {});
    const remove = store.registerUpload(first.key, () => true, stop);
    remove();
    store.open(host);
    store.registerUpload(store.panes[1]!.key, () => true, stop);
    const ask = vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(true);
    await store.closeAll(store.active);
    expect(ask).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(store.panes).toEqual([]);
  });
  it('resets empty-host counters and does not consume numbers on rejected opens', async () => {
    const store = useTerminalsStore();
    store.open(null);
    store.open(host);
    store.open({ ...host, id: 'other' });
    expect(store.tabs.map((tab) => tab.sessionNumber)).toEqual([1, 1, 1]);
    await store.closePane(store.focused);
    store.open({ ...host, id: 'other' });
    expect(store.tabs.at(-1)!.sessionNumber).toBe(1);
    for (let index = 0; index < 29; index++) store.open(host);
    expect(store.panes).toHaveLength(32);
    store.open(host);
    expect(store.error).toContain('32');
    await store.close(store.active);
    store.open(host);
    expect(store.tabs.at(-1)!.sessionNumber).toBe(31);
    expect(store.hostTabs('').map((tab) => tab.sessionNumber)).toEqual([1]);
    expect(store.hostTabs('other').map((tab) => tab.sessionNumber)).toEqual([1]);
  });
  it('starts a new application run with no tabs, split panes or runtime sessions', () => {
    const original = useTerminalsStore();
    original.open(host);
    original.split(original.focused, 'rows');
    original.open(null);
    original.rename(original.active, '部署');
    original.update(original.focused, { state: 'connected', sessionId: 'old-session' });
    disposePinia(getActivePinia()!);
    setActivePinia(createPinia());
    const fresh = useTerminalsStore();
    expect(fresh.tabs).toEqual([]);
    expect(fresh.panes).toEqual([]);
    expect(fresh.active).toBe('');
    expect(fresh.focused).toBe('');
    expect(fresh.connectedCount).toBe(0);
    fresh.open(host);
    fresh.open(null);
    expect(fresh.tabs.map((tab) => tab.sessionNumber)).toEqual([1, 1]);
    expect(fresh.panes.every((pane) => !pane.sessionId && pane.connectRequested)).toBe(true);
    expect(terminalApi).not.toHaveProperty('workspaceLoad');
  });
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
  it('opens and splits local terminals without a fabricated SSH host', () => {
    const store = useTerminalsStore();
    store.open(null);
    expect(store.panes[0]!.host).toBeNull();
    store.split(store.focused, 'columns');
    expect(store.panes).toHaveLength(2);
    expect(store.panes.every((p) => p.host === null && p.connectRequested)).toBe(true);
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
  it('keeps only failed split panes when closing a tab and continues closing the other panes', async () => {
    const store = useTerminalsStore();
    store.open(host);
    const tab = store.tabs[0]!;
    store.update(store.focused, { sessionId: 'failed-pane' });
    store.split(store.focused, 'columns');
    store.update(store.focused, { sessionId: 'closed-pane' });
    const failed = tab.panes[0]!;
    vi.mocked(terminalApi.close).mockRejectedValueOnce({ message: 'close failed' });
    await store.close(tab.key);
    expect(tab.panes).toEqual([failed]);
    expect(tab.layout).toEqual({ kind: 'leaf', pane: failed.key });
    expect(terminalApi.close).toHaveBeenCalledWith('closed-pane');
    expect(store.error).toBe('close failed');
    store.open(host);
    expect(store.tabs.at(-1)?.sessionNumber).toBe(2);
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
    const saved = JSON.stringify(store.tabs);
    await store.close('missing');
    await store.closeAll('missing');
    expect(JSON.stringify(store.tabs)).toBe(saved);
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
  it('does not persist terminal tabs, names or split layouts as they change', async () => {
    vi.useFakeTimers();
    const store = useTerminalsStore();
    store.open(host);
    store.split(store.focused, 'columns');
    store.rename(store.active, '部署');
    await vi.advanceTimersByTimeAsync(1000);
    expect(terminalApi).not.toHaveProperty('workspaceSave');
    store.open(host);
    await store.closeAll(store.tabs[0]!.key);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.tabs).toEqual([]);
    expect(terminalApi).not.toHaveProperty('workspaceSave');
    expect(terminalApi).not.toHaveProperty('workspaceLoad');
  });
});
