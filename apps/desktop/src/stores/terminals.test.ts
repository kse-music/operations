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
  it('closes only the requested right or other tabs', async () => {
    const store = useTerminalsStore();
    store.open(host);
    store.open(host);
    store.open(host);
    const [a, b, c] = store.tabs;
    await store.closeOthers(b!.key, true);
    expect(store.tabs.map((t) => t.key)).toEqual([a!.key, b!.key]);
    expect(store.tabs.some((t) => t.key === c!.key)).toBe(false);
    await store.closeOthers(b!.key);
    expect(store.tabs.map((t) => t.key)).toEqual([b!.key]);
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
    await store.close(store.tabs[0]!.key);
    await vi.advanceTimersByTimeAsync(300);
    expect(terminalApi.workspaceSave).toHaveBeenLastCalledWith({
      version: 1,
      active: '',
      tabs: [],
    });
  });
});
