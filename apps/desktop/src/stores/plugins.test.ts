import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, getActivePinia, setActivePinia } from 'pinia';
import { usePluginsStore } from './plugins';
import { pluginsApi } from '../services/plugins';
import { filesApi } from '../services/files';
import { useNotificationsStore } from './notifications';
import type { InstalledPlugin, PluginGrant, PluginInventory } from '../types/plugins';
beforeEach(() => {
  setActivePinia(createPinia());
  vi.spyOn(pluginsApi, 'reset').mockResolvedValue();
  vi.spyOn(pluginsApi, 'scopeVisibility').mockResolvedValue();
  vi.spyOn(pluginsApi, 'closeScope').mockResolvedValue();
  vi.spyOn(pluginsApi, 'activate').mockResolvedValue({ state: 'active' } as never);
  vi.spyOn(filesApi, 'tasks').mockResolvedValue([]);
  vi.spyOn(filesApi, 'connections').mockResolvedValue([]);
  vi.spyOn(filesApi, 'clearTransfers').mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  disposePinia(getActivePinia()!);
  vi.useRealTimers();
});
function fixture() {
  const plugins = usePluginsStore();
  plugins.installed = [
    {
      enabled: true,
      revision: 'r1',
      manifest: {
        entry: { backend: null, ui: 'ui.json' },
        id: 'dev.example',
        name: 'Example',
        contributions: [{ id: 'host', label: 'Example', kind: 'workspace' }],
      },
    } as InstalledPlugin,
  ];
  plugins.grants = {
    'dev.example': {
      revision: 'r1',
      permissions: ['ui.contribute'],
      operations: ['ui.contribute'],
    } as PluginGrant,
  };
  return plugins;
}
it('joins manual refreshes to an in-flight background poll and reports failures for manual retry', async () => {
  const p = usePluginsStore();
  let reject!: (cause: unknown) => void;
  const inventory = vi
    .spyOn(pluginsApi, 'inventory')
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue({ installed: [], problems: [], availableBundled: [] });
  vi.spyOn(pluginsApi, 'statuses').mockResolvedValue([]);
  const background = p.refresh(true);
  expect(p.loading).toBe(false);
  const manual = p.refresh();
  expect(p.loading).toBe(true);
  const duplicate = p.refresh(true);
  expect(p.loading).toBe(true);
  expect(inventory).toHaveBeenCalledTimes(1);
  reject({ message: 'Repository unavailable' });
  await Promise.all([background, manual, duplicate]);
  expect(p.loading).toBe(false);
  expect(p.error).toBe('Repository unavailable');
  expect(p.loaded).toBe(false);
  const retry = p.refresh();
  expect(p.loading).toBe(true);
  await retry;
  expect(inventory).toHaveBeenCalledTimes(2);
  expect(p.loading).toBe(false);
  expect(p.error).toBeNull();
  expect(p.loaded).toBe(true);
});
it('preserves the loaded list and existing error when a background poll fails', async () => {
  const p = fixture();
  p.loaded = true;
  p.error = 'Previous operation failed';
  const installed = p.installed;
  let reject!: (cause: unknown) => void;
  vi.spyOn(pluginsApi, 'inventory').mockImplementationOnce(
    () =>
      new Promise<PluginInventory>((_, fail) => {
        reject = fail;
      }),
  );
  const background = p.refresh(true);
  expect(p.loading).toBe(false);
  reject({ message: 'Background read failed' });
  await background;
  expect(p.installed).toBe(installed);
  expect(p.loaded).toBe(true);
  expect(p.loading).toBe(false);
  expect(p.error).toBe('Previous operation failed');
});
it('deduplicates runtime polls, preserves state on BUSY and reports other failures once', async () => {
  vi.useFakeTimers();
  const p = fixture();
  p.loaded = true;
  p.error = 'Previous operation failed';
  const inventory = vi.spyOn(pluginsApi, 'inventory');
  let finish!: () => void;
  const statuses = vi.spyOn(pluginsApi, 'statuses').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
  );
  p.start();
  await vi.advanceTimersByTimeAsync(6000);
  expect(statuses).toHaveBeenCalledTimes(1);
  expect(inventory).not.toHaveBeenCalled();
  expect(p.loading).toBe(false);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  statuses.mockRejectedValueOnce({ code: 'BUSY' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(p.statuses).toEqual([]);
  expect(useNotificationsStore().items).toHaveLength(1);
  statuses.mockRejectedValue({ message: 'Runtime unavailable' });
  await vi.advanceTimersByTimeAsync(4000);
  expect(p.error).toBe('Previous operation failed');
  expect(
    useNotificationsStore().items.filter((item) => item.text === 'Runtime unavailable'),
  ).toHaveLength(1);
  statuses.mockResolvedValue([]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(p.loading).toBe(false);
  const reads = statuses.mock.calls.length;
  p.stop();
  await vi.advanceTimersByTimeAsync(4000);
  expect(statuses).toHaveBeenCalledTimes(reads);
});
it('withdraws extension registration on disable, revoke or revision change', () => {
  const p = fixture();
  expect(p.extensions).toHaveLength(1);
  p.installed[0]!.enabled = false;
  expect(p.extensions).toHaveLength(0);
  p.installed[0]!.enabled = true;
  p.grants['dev.example']!.revision = 'old';
  expect(p.extensions).toHaveLength(0);
  p.grants['dev.example'] = null;
  expect(p.extensions).toHaveLength(0);
});

it.each(['system', 'user'] as const)(
  'shares a root with isolated owners for all package sources: %s',
  async (source) => {
    const p = fixture();
    p.installed[0]!.source = source;
    await p.bind('dev.example', 'a');
    const version = p.contextVersion('dev.example');
    await p.bind('dev.example', 'b');
    expect(p.contextVersion('dev.example')).toBe(version);
    expect(pluginsApi.reset).toHaveBeenCalledExactlyOnceWith('dev.example');
    await p.release('dev.example', 'a');
    expect(p.owns('dev.example', 'a')).toBe(false);
    expect(p.owns('dev.example', 'b')).toBe(true);
    expect(pluginsApi.closeScope).toHaveBeenCalledWith('dev.example', 'a');
    expect(pluginsApi.reset).toHaveBeenCalledTimes(1);
    await p.release('dev.example', 'b');
    expect(pluginsApi.reset).toHaveBeenCalledTimes(2);
    expect(p.contextVersion('dev.example')).toBeGreaterThan(version);
  },
);
it('invalidates every owner and drafts on revoke/revision replacement', async () => {
  const p = fixture();
  await p.bind('dev.example', 'a');
  await p.bind('dev.example', 'b');
  p.setDraftDirty('a', 'dev.example', true);
  const version = p.contextVersion('dev.example');
  p.clearPlugin('dev.example');
  expect(p.owns('dev.example', 'a')).toBe(false);
  expect(p.owns('dev.example', 'b')).toBe(false);
  expect(p.dirty).toBe(false);
  expect(p.contextVersion('dev.example')).toBeGreaterThan(version);
});
it('keeps another host owner when an older page is released', async () => {
  const p = fixture();
  await p.bind('dev.example', 'a');
  await Promise.all([p.release('dev.example', 'a'), p.bind('dev.example', 'b')]);
  expect(p.owns('dev.example', 'b')).toBe(true);
  expect(pluginsApi.reset).toHaveBeenCalledTimes(1);
});
it('keeps resource close and final reset failures retryable', async () => {
  const p = fixture();
  await p.bind('dev.example', 'a');
  vi.mocked(pluginsApi.closeScope).mockRejectedValueOnce(new Error('close failed'));
  await expect(p.release('dev.example', 'a')).rejects.toThrow('close failed');
  expect(p.owns('dev.example', 'a')).toBe(true);
  vi.mocked(pluginsApi.reset).mockRejectedValueOnce(new Error('reset failed'));
  await expect(p.release('dev.example', 'a')).rejects.toThrow('reset failed');
  expect(p.owns('dev.example', 'a')).toBe(true);
  await p.release('dev.example', 'a');
  expect(p.owns('dev.example', 'a')).toBe(false);
});
it('serializes reset/activation with scope release and makes errors observable', async () => {
  const p = fixture();
  p.installed[0]!.manifest.entry.backend = 'backend.wasm';
  const order: string[] = [];
  let finish!: () => void;
  vi.mocked(pluginsApi.reset).mockImplementation(async () => {
    order.push('reset');
  });
  vi.mocked(pluginsApi.activate).mockImplementationOnce(async () => {
    order.push('activate');
    await new Promise<void>((resolve) => (finish = resolve));
    return { state: 'active' } as never;
  });
  vi.mocked(pluginsApi.closeScope).mockImplementation(async () => {
    order.push('close');
  });
  const bound = p.bind('dev.example', 'a');
  for (let i = 0; i < 15; i++) await Promise.resolve();
  const released = p.release('dev.example', 'a');
  expect(order).toEqual(['reset', 'activate']);
  finish();
  await Promise.all([bound, released]);
  expect(order).toEqual(['reset', 'activate', 'close', 'reset']);
  vi.mocked(pluginsApi.reset).mockRejectedValueOnce(new Error('unavailable'));
  await expect(p.bind('dev.example', 'b')).rejects.toThrow('unavailable');
  await p.bind('dev.example', 'b');
  expect(p.owns('dev.example', 'b')).toBe(true);
});
it('serializes explicit reset requests and deduplicates stable owner roots', async () => {
  const p = fixture();
  await Promise.all([p.bind('dev.example'), p.bind('dev.example')]);
  expect(pluginsApi.reset).toHaveBeenCalledTimes(2);
  await Promise.all([p.bind('dev.example', 'same'), p.bind('dev.example', 'same')]);
  expect(pluginsApi.reset).toHaveBeenCalledTimes(3);
});
