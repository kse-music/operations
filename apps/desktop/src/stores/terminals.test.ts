import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, getActivePinia, setActivePinia } from 'pinia';
vi.mock('../services/terminal', () => ({
  terminalApi: {
    close: vi.fn(),
    closeHost: vi.fn(),
    savedLocalSessions: vi.fn(),
    saveLocalSession: vi.fn(),
    removeSavedLocalSession: vi.fn(),
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
  it('keeps local elevation on split and duplicate while ordinary and SSH sessions remain separate', () => {
    const store = useTerminalsStore();
    store.open(null, undefined, undefined, true);
    const admin = store.tabs[0]!;
    store.split(store.focused, 'rows');
    expect(admin.panes.every((pane) => pane.elevated)).toBe(true);
    store.duplicate(admin.key);
    expect(store.tabs[1]!.panes[0]!.elevated).toBe(true);
    store.open(null);
    expect(store.tabs[2]!.panes[0]!.elevated).toBe(false);
    store.open(host, undefined, undefined, true);
    expect(store.tabs[3]!.panes[0]!.elevated).toBeUndefined();
    expect(store.tabs).toHaveLength(4);
  });
  it.each([
    ['connected', false],
    ['idle', false],
    ['opening', false],
    ['connecting', false],
    ['authenticating', false],
    ['awaiting_trust', false],
    ['closing', false],
    ['unexpected', false],
    ['disconnected', true],
    ['closed', true],
    ['failed', true],
  ] as const)('only permits reconnect for an ended session (%s)', async (state, allowed) => {
    const store = useTerminalsStore();
    store.open(host);
    store.update(store.focused, { state, sessionId: 'session' });
    const change = vi.fn(async () => {});
    store.registerConnection(store.focused, change);
    expect(store.canReconnect(store.active)).toBe(allowed);
    await store.reconnect(store.active);
    expect(change).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(terminalApi.close).not.toHaveBeenCalled();
  });
  it('blocks reconnect when a split session still contains a connected pane', async () => {
    const store = useTerminalsStore();
    store.open(host);
    store.split(store.focused, 'rows');
    const tab = store.tabs[0]!;
    const changes = tab.panes.map((pane, index) => {
      store.update(pane.key, { state: index ? 'connected' : 'disconnected' });
      const change = vi.fn(async () => {});
      store.registerConnection(pane.key, change);
      return change;
    });
    expect(store.canReconnect(tab.key)).toBe(false);
    await store.reconnect(tab.key);
    expect(changes.every((change) => !change.mock.calls.length)).toBe(true);
    store.update(tab.panes[1]!.key, { state: 'closed' });
    expect(store.canReconnect(tab.key)).toBe(true);
    await store.reconnect(tab.key);
    for (const change of changes) expect(change).toHaveBeenCalledExactlyOnceWith('reconnect');
  });
  it.each(['reconnect', 'disconnect'] as const)(
    'confirms uploads once before %s and protects against duplicate actions',
    async (action) => {
      const store = useTerminalsStore();
      store.open(host);
      store.split(store.focused, 'rows');
      const tab = store.tabs[0]!;
      const changes = tab.panes.map((pane) => {
        store.update(pane.key, {
          state: action === 'reconnect' ? 'disconnected' : 'connected',
          sessionId: pane.key,
        });
        const change = vi.fn(async () => {});
        store.registerConnection(pane.key, change);
        return change;
      });
      let finish!: () => void;
      const stop = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      store.registerUpload(tab.panes[0]!.key, () => true, stop);
      const ask = vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(false);
      await store[action](tab.key);
      expect(stop).not.toHaveBeenCalled();
      expect(changes.every((change) => change.mock.calls.length === 0)).toBe(true);
      ask.mockResolvedValue(true);
      const changing = store[action](tab.key);
      await nextTick();
      await store[action](tab.key);
      await store.close(tab.key);
      expect(store.tabs).toHaveLength(1);
      expect(stop).toHaveBeenCalledOnce();
      expect(changes.every((change) => change.mock.calls.length === 0)).toBe(true);
      finish();
      await changing;
      expect(ask).toHaveBeenCalledTimes(2);
      for (const change of changes) expect(change).toHaveBeenCalledExactlyOnceWith(action);
      expect(store.changingConnections).toEqual([]);
    },
  );
  it('reports upload cancellation failure without disconnecting or reconnecting', async () => {
    const store = useTerminalsStore();
    store.open(host);
    const pane = store.panes[0]!;
    store.update(pane.key, { state: 'disconnected', sessionId: 'session' });
    const change = vi.fn(async () => {});
    store.registerConnection(pane.key, change);
    store.registerUpload(
      pane.key,
      () => true,
      async () => {
        throw new Error('stop failed');
      },
    );
    vi.spyOn(usePluginsStore(), 'ask').mockResolvedValue(true);
    await store.reconnect(store.active);
    expect(change).not.toHaveBeenCalled();
    expect(pane.state).toBe('disconnected');
    expect(store.error).toBe('stop failed');
    expect(store.changingConnections).toEqual([]);
  });
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

describe('manually saved local sessions', () => {
  const snapshot = (id: string, title: string) => ({
    id,
    title,
    panes: [{ directory: `C:\\${title}`, elevated: false }],
    layout: { kind: 'leaf' as const, pane: 0 },
  });
  beforeEach(() => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    vi.mocked(terminalApi.removeSavedLocalSession).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('starts only the first saved session and all its panes when entering local terminals without an opened session', async () => {
    const first = {
      ...snapshot('one', 'one'),
      panes: [snapshot('one', 'one').panes[0]!, { directory: 'C:\\admin', elevated: true }],
      layout: {
        kind: 'split' as const,
        axis: 'columns' as const,
        ratio: 50,
        first: { kind: 'leaf' as const, pane: 0 },
        second: { kind: 'leaf' as const, pane: 1 },
      },
    };
    vi.mocked(terminalApi.savedLocalSessions).mockResolvedValue([first, snapshot('two', 'two')]);
    const store = useTerminalsStore();
    await store.loadSaved();
    store.activateHost('');
    expect(store.panes.every((pane) => !pane.connectRequested)).toBe(true);
    store.activateLocal();
    expect(store.active).toBe(store.tabs[0]!.key);
    expect(store.tabs[0]!.panes.every((pane) => pane.connectRequested)).toBe(true);
    expect(store.tabs[1]!.panes[0]!.connectRequested).toBe(false);
    expect(store.tabs[0]!.panes[1]!.elevated).toBe(true);
    expect(terminalApi.saveLocalSession).not.toHaveBeenCalled();
  });
  it.each(['opening', 'connected', 'disconnected', 'closed', 'failed'])(
    'reuses an already opened local session in state %s instead of starting a saved one',
    async (state) => {
      vi.mocked(terminalApi.savedLocalSessions).mockResolvedValue([snapshot('one', 'one')]);
      const store = useTerminalsStore();
      await store.loadSaved();
      const saved = store.tabs[0]!;
      store.open(null);
      const opened = store.tabs[1]!;
      store.update(opened.panes[0]!.key, { state, connectRequested: false });
      store.select(saved.key, false);
      store.activateLocal();
      expect(store.active).toBe(opened.key);
      expect(saved.panes[0]!.connectRequested).toBe(false);
      expect(opened.panes[0]!.connectRequested).toBe(false);
      expect(opened.panes[0]!.state).toBe(state);
    },
  );
  it('restores multiple idle records and only starts the selected record; new and duplicated sessions have no saved source', async () => {
    vi.mocked(terminalApi.savedLocalSessions).mockResolvedValue([
      snapshot('one', 'one'),
      snapshot('two', 'two'),
    ]);
    const store = useTerminalsStore();
    await store.loadSaved();
    expect(store.tabs).toHaveLength(2);
    expect(store.active).toBe('');
    expect(store.panes.every((pane) => pane.state === 'idle' && !pane.connectRequested)).toBe(true);
    store.activateHost('');
    expect(store.panes.every((pane) => !pane.connectRequested)).toBe(true);
    const second = store.tabs[1]!;
    store.select(second.key);
    expect(second.panes[0]!.savedSource).toEqual({ id: 'two', pane: 0 });
    expect(second.panes[0]!.connectRequested).toBe(true);
    expect(store.tabs[0]!.panes[0]!.connectRequested).toBe(false);
    store.open(null);
    expect(store.tabs.at(-1)!.panes[0]!.savedSource).toBeUndefined();
    store.duplicate(second.key);
    expect(store.tabs.at(-1)!.panes[0]!.savedSource).toBeUndefined();
    expect(terminalApi.saveLocalSession).not.toHaveBeenCalled();
  });
  it('saves one named snapshot with every pane and only overwrites it on explicit save', async () => {
    const store = useTerminalsStore();
    store.open(null);
    store.split(store.focused, 'columns');
    const tab = store.tabs[0]!;
    tab.panes.forEach((pane, index) =>
      store.update(pane.key, { state: 'connected', sessionId: `local:${index}` }),
    );
    const record = {
      ...snapshot('one', '项目'),
      panes: [snapshot('a', 'a').panes[0]!, snapshot('b', 'b').panes[0]!],
      layout: {
        kind: 'split' as const,
        axis: 'columns' as const,
        ratio: 50,
        first: { kind: 'leaf' as const, pane: 0 },
        second: { kind: 'leaf' as const, pane: 1 },
      },
    };
    vi.mocked(terminalApi.saveLocalSession).mockResolvedValue(record);
    expect(await store.saveLocal(tab.key, '项目')).toBe(true);
    expect(terminalApi.saveLocalSession).toHaveBeenCalledExactlyOnceWith({
      id: null,
      title: '项目',
      sessionIds: ['local:0', 'local:1'],
      layout: record.layout,
    });
    expect(tab.savedId).toBe('one');
    expect(tab.title).toBe('项目');
    store.update(tab.panes[0]!.key, { cwd: 'C:\\changed' });
    store.resize(tab.key, tab.layout.kind === 'split' ? tab.layout.id : '', 60);
    await nextTick();
    expect(terminalApi.saveLocalSession).toHaveBeenCalledTimes(1);
    await store.saveLocal(tab.key, '更新');
    expect(vi.mocked(terminalApi.saveLocalSession).mock.calls[1]![0].id).toBe('one');
  });
  it('renames an idle saved record without launching or closing shells', async () => {
    const record = snapshot('one', '旧名称');
    vi.mocked(terminalApi.savedLocalSessions).mockResolvedValue([record]);
    const store = useTerminalsStore();
    await store.loadSaved();
    const tab = store.tabs[0]!;
    vi.mocked(terminalApi.saveLocalSession).mockResolvedValue({ ...record, title: '新名称' });
    expect(await store.saveLocal(tab.key, '新名称')).toBe(true);
    expect(terminalApi.saveLocalSession).toHaveBeenCalledExactlyOnceWith({
      id: 'one',
      title: '新名称',
      sessionIds: [],
      layout: null,
    });
    expect(tab.panes[0]!.connectRequested).toBe(false);
    expect(terminalApi.removeSavedLocalSession).not.toHaveBeenCalled();
    expect(store.tabs[0]!.savedId).toBe('one');
    expect(store.tabs[0]!.title).toBe('新名称');
    expect(terminalApi.close).not.toHaveBeenCalled();
  });
  it('removes a closed saved entry and its persistent record without starting a neighboring saved entry', async () => {
    vi.mocked(terminalApi.savedLocalSessions).mockResolvedValue([
      snapshot('one', 'one'),
      snapshot('two', 'two'),
    ]);
    const store = useTerminalsStore();
    await store.loadSaved();
    const first = store.tabs[0]!;
    store.select(first.key);
    store.update(first.panes[0]!.key, { state: 'connected', sessionId: 'local:one' });
    vi.mocked(terminalApi.close).mockResolvedValue(undefined);
    vi.mocked(terminalApi.removeSavedLocalSession).mockImplementation(async (id) => {
      expect(terminalApi.close).toHaveBeenCalledWith('local:one');
      expect(first.panes[0]!.state).toBe('closed');
      expect(id).toBe('one');
    });
    await store.close(first.key);
    expect(terminalApi.removeSavedLocalSession).toHaveBeenCalledExactlyOnceWith('one');
    expect(store.tabs.map((tab) => tab.savedId)).toEqual(['two']);
    expect(store.tabs[0]!.panes[0]!.connectRequested).toBe(false);
    expect(store.tabs[0]!.panes[0]!.state).toBe('idle');
  });
  it('closes idle saved entries permanently and leaves an empty list after closing the last entry', async () => {
    let saved = [snapshot('one', 'one')];
    vi.mocked(terminalApi.savedLocalSessions).mockImplementation(async () => saved);
    vi.mocked(terminalApi.removeSavedLocalSession).mockImplementation(async (id) => {
      saved = saved.filter((entry) => entry.id !== id);
    });
    const store = useTerminalsStore();
    await store.loadSaved();
    await store.close(store.tabs[0]!.key);
    expect(store.tabs).toEqual([]);
    expect(store.active).toBe('');
    expect(terminalApi.close).not.toHaveBeenCalled();
    expect(await terminalApi.savedLocalSessions()).toEqual([]);
    store.activateLocal();
    expect(store.tabs).toEqual([]);
  });
  it('keeps a saved entry when closing its shell fails and never deletes its persistent record', async () => {
    vi.mocked(terminalApi.savedLocalSessions).mockResolvedValue([snapshot('one', 'one')]);
    const store = useTerminalsStore();
    await store.loadSaved();
    const tab = store.tabs[0]!;
    const pane = tab.panes[0]!;
    store.update(pane.key, { state: 'connected', sessionId: 'local:one' });
    vi.mocked(terminalApi.close).mockRejectedValueOnce({ message: '关闭失败' });
    await store.close(tab.key);
    expect(store.tabs).toEqual([tab]);
    expect(pane.state).toBe('connected');
    expect(pane.sessionId).toBe('local:one');
    expect(terminalApi.removeSavedLocalSession).not.toHaveBeenCalled();
    expect(store.error).toBe('关闭失败');
  });
  it('keeps the ended entry visible after a delete failure and allows retry without reopening its shell', async () => {
    vi.mocked(terminalApi.savedLocalSessions).mockResolvedValue([snapshot('one', 'one')]);
    const store = useTerminalsStore();
    await store.loadSaved();
    const tab = store.tabs[0]!;
    const pane = tab.panes[0]!;
    store.select(tab.key);
    store.update(pane.key, { state: 'connected', sessionId: 'local:one' });
    vi.mocked(terminalApi.close).mockResolvedValue(undefined);
    vi.mocked(terminalApi.removeSavedLocalSession).mockRejectedValueOnce({ message: '删除失败' });
    await store.close(tab.key);
    expect(store.tabs[0]).toBe(tab);
    expect(pane.state).toBe('closed');
    expect(pane.sessionId).toBeUndefined();
    expect(pane.connectRequested).toBe(false);
    expect(tab.savedId).toBe('one');
    expect(store.error).toBe('删除失败');
    store.activateLocal();
    expect(pane.connectRequested).toBe(false);
    await store.close(tab.key);
    expect(store.tabs).toEqual([]);
    expect(terminalApi.close).toHaveBeenCalledOnce();
    expect(terminalApi.removeSavedLocalSession).toHaveBeenCalledTimes(2);
  });
  it('does not duplicate closes or reopen a session while its saved record is being deleted', async () => {
    vi.mocked(terminalApi.savedLocalSessions).mockResolvedValue([snapshot('one', 'one')]);
    const store = useTerminalsStore();
    await store.loadSaved();
    const tab = store.tabs[0]!;
    const pane = tab.panes[0]!;
    store.update(pane.key, { state: 'connected', sessionId: 'local:one' });
    vi.mocked(terminalApi.close).mockResolvedValue(undefined);
    let finish!: () => void;
    vi.mocked(terminalApi.removeSavedLocalSession).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const closing = store.close(tab.key);
    await vi.waitFor(() => expect(terminalApi.removeSavedLocalSession).toHaveBeenCalledOnce());
    await store.close(tab.key);
    store.select(tab.key);
    store.split(pane.key, 'columns');
    expect(store.canSaveLocal(tab.key)).toBe(false);
    expect(store.canReconnect(tab.key)).toBe(false);
    expect(tab.panes).toEqual([pane]);
    expect(pane.connectRequested).toBe(false);
    expect(terminalApi.close).toHaveBeenCalledOnce();
    finish();
    await closing;
    expect(store.tabs).toEqual([]);
  });
  it('retains a saved split snapshot until its final pane closes and removes saved entries on close all', async () => {
    vi.mocked(terminalApi.savedLocalSessions).mockResolvedValue([
      snapshot('one', 'one'),
      snapshot('two', 'two'),
    ]);
    const store = useTerminalsStore();
    await store.loadSaved();
    const tab = store.tabs[0]!;
    store.split(tab.panes[0]!.key, 'columns');
    await store.closePane(tab.panes[1]!.key);
    expect(terminalApi.removeSavedLocalSession).not.toHaveBeenCalled();
    store.open(host);
    const remote = store.tabs.at(-1)!;
    await store.closeAll(tab.key);
    expect(terminalApi.removeSavedLocalSession).toHaveBeenCalledTimes(2);
    expect(terminalApi.removeSavedLocalSession).toHaveBeenCalledWith('one');
    expect(terminalApi.removeSavedLocalSession).toHaveBeenCalledWith('two');
    expect(store.tabs).toEqual([remote]);
  });
  it('preserves the name and saved status when persistence fails', async () => {
    const store = useTerminalsStore();
    store.open(null);
    const tab = store.tabs[0]!;
    store.update(tab.panes[0]!.key, { state: 'connected', sessionId: 'local:one' });
    const title = tab.title;
    vi.mocked(terminalApi.saveLocalSession).mockRejectedValue({ message: '写入失败' });
    expect(await store.saveLocal(tab.key, '不能保存')).toBe(false);
    expect(tab.title).toBe(title);
    expect(tab.savedId).toBeUndefined();
    expect(store.error).toBe('写入失败');
  });
});
