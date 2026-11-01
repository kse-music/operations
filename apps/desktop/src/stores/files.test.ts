import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia, getActivePinia, disposePinia } from 'pinia';
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  list: vi.fn(),
  local: vi.fn(),
  tasks: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../services/files', () => ({ filesApi: mocks }));
import { useFilesStore } from './files';
import type { Host } from '../types/hosts';
const host = { id: 'host', name: 'Actual host' } as Host;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
  mocks.local.mockResolvedValue({ path: 'local', parent: null, entries: [] });
});
afterEach(() => disposePinia(getActivePinia()!));
describe('file workspace ownership', () => {
  it('opens through the real IPC boundary and never disconnects just because the page changes', async () => {
    mocks.open.mockImplementation(async (_host, receive) => {
      receive({ type: 'state', state: 'connected' });
      return { id: 'session' };
    });
    mocks.list.mockResolvedValue({ path: '/home/user', parent: '/home', entries: [] });
    const store = useFilesStore();
    await store.open(host);
    expect(store.current?.state).toBe('connected');
    expect(mocks.list).toHaveBeenCalledWith('session', '.');
    expect(store.current?.path).toBe('/home/user');
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it('does not replace a newer directory response with stale in-flight navigation', async () => {
    mocks.open.mockImplementation(async (_host, receive) => {
      receive({ type: 'state', state: 'connected' });
      return { id: 'session' };
    });
    mocks.list.mockResolvedValue({ path: '/home', parent: '/', entries: [] });
    const store = useFilesStore();
    await store.open(host);
    let finish: (value: unknown) => void = () => {};
    mocks.list
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({ path: '/new', parent: '/', entries: [] });
    const slow = store.navigate('/old');
    await store.navigate('/new');
    finish({ path: '/old', parent: '/', entries: [] });
    await slow;
    expect(store.current?.path).toBe('/new');
  });
});
