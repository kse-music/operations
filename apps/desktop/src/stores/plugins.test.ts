import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, getActivePinia, setActivePinia } from 'pinia';
import { usePluginsStore } from './plugins';
import { useWorkspaceStore } from './workspace';
import { useTerminalsStore } from './terminals';
import { pluginsApi } from '../services/plugins';
import type { InstalledPlugin, PluginGrant } from '../types/plugins';
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  vi.restoreAllMocks();
  disposePinia(getActivePinia()!);
});
function fixture() {
  const plugins = usePluginsStore();
  plugins.installed = [
    {
      enabled: true,
      revision: 'r1',
      manifest: {
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
it('keeps per-host drafts across switches and only asks before closing their workspace', async () => {
  const p = fixture(),
    w = useWorkspaceStore(),
    t = useTerminalsStore();
  const context = vi.spyOn(pluginsApi, 'context').mockResolvedValue();
  t.open(null);
  await w.openPlugin('dev.example', 'host', 'a');
  expect(w.module).toBe('hosts');
  expect(w.active).toBe('host:a');
  const key = w.activePluginKey;
  p.drafts[key] = { values: { content: 'edits for a' }, output: null, dirty: true, revision: 'r1' };
  await w.openPlugin('dev.example', 'host', 'b');
  expect(p.prompt).toBeNull();
  expect(w.current?.hostId).toBe('b');
  expect(p.drafts[key]?.values.content).toBe('edits for a');
  expect(w.pluginPages).toHaveLength(2);
  w.selectHost('a');
  expect(w.activePluginKey).toBe(key);
  expect(w.current?.pluginId).toBe('dev.example');
  const declined = w.close('host:a');
  expect(p.prompt).not.toBeNull();
  p.decide(false);
  await declined;
  expect(w.current?.hostId).toBe('a');
  const accepted = w.close('host:a');
  p.decide(true);
  await accepted;
  expect(w.tabs.map((tab) => tab.key)).toEqual(['host:b']);
  expect(w.pluginPages.map((page) => page.hostId)).toEqual(['b']);
  expect(p.drafts[key]).toBeUndefined();
  expect(context).not.toHaveBeenCalled();
  expect(t.tabs).toHaveLength(1);
});
it('does not let a delayed release from one page clear another host binding', async () => {
  const p = fixture();
  const context = vi.spyOn(pluginsApi, 'context').mockResolvedValue();
  await p.bind('dev.example', { hostId: 'a', opsSession: 'ops-a', fileSession: null }, 'page-a');
  await p.bind('dev.example', { hostId: 'b', opsSession: 'ops-b', fileSession: null }, 'page-b');
  await p.release('dev.example', 'page-a');
  expect(p.owns('dev.example', 'page-b')).toBe(true);
  expect(context).toHaveBeenCalledTimes(2);
  await p.release('dev.example', 'page-b');
  expect(context).toHaveBeenLastCalledWith('dev.example', null);
});
it('serializes clears even for global tools and deduplicates stable host bindings; caller observes failures', async () => {
  const p = fixture(),
    context = vi.spyOn(pluginsApi, 'context').mockResolvedValue();
  await Promise.all([p.bind('dev.example', null), p.bind('dev.example', null)]);
  expect(context).toHaveBeenCalledTimes(2);
  p.clearPlugin('dev.example');
  context.mockRejectedValueOnce(new Error('closed'));
  await expect(p.bind('dev.example', null)).rejects.toThrow('closed');
  await p.bind('dev.example', null);
  expect(context).toHaveBeenCalledTimes(4);
  const host = { hostId: 'a', opsSession: null, fileSession: null };
  await Promise.all([p.bind('dev.example', host), p.bind('dev.example', host)]);
  expect(context).toHaveBeenCalledTimes(5);
});

it('keeps a failed context release retryable and does not pretend it was cleared', async () => {
  const p = fixture(),
    context = vi.spyOn(pluginsApi, 'context').mockResolvedValue();
  await p.bind('dev.example', { hostId: 'a', opsSession: null, fileSession: null }, 'page-a');
  context.mockRejectedValueOnce(new Error('release failed'));
  await expect(p.release('dev.example', 'page-a')).rejects.toThrow('release failed');
  expect(p.owns('dev.example', 'page-a')).toBe(true);
  await p.release('dev.example', 'page-a');
  expect(context).toHaveBeenCalledTimes(3);
  expect(context).toHaveBeenLastCalledWith('dev.example', null);
});

it('serializes activation with release and reactivation before a cached page can use its context', async () => {
  const p = fixture();
  p.installed[0]!.manifest.entry = { backend: 'backend.wasm', ui: null };
  const order: string[] = [];
  vi.spyOn(pluginsApi, 'context').mockImplementation(async (_id, input) => {
    order.push(input?.hostId ?? 'release');
  });
  let finish!: () => void;
  const activate = vi.spyOn(pluginsApi, 'activate').mockImplementation(async () => {
    order.push('activate');
    return { state: 'active' } as never;
  });
  activate.mockImplementationOnce(async () => {
    order.push('activate');
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { state: 'active' } as never;
  });
  const first = p.bind('dev.example', { hostId: 'a', opsSession: null, fileSession: null }, 'a');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const release = p.release('dev.example', 'a');
  const resumed = p.bind('dev.example', { hostId: 'b', opsSession: null, fileSession: null }, 'b');
  expect(order).toEqual(['a', 'activate']);
  finish();
  await Promise.all([first, release, resumed]);
  expect(order).toEqual(['a', 'activate', 'release', 'b', 'activate']);
  expect(p.owns('dev.example', 'b')).toBe(true);
  p.statuses = [{ id: 'dev.example', state: 'crashed' } as never];
  await p.release('dev.example', 'b');
  await p.bind('dev.example', null, 'global');
  expect(activate).toHaveBeenCalledTimes(2);
});

it('activates the latest owner when rapid contributions share the same host context', async () => {
  const p = fixture();
  p.installed[0]!.manifest.entry = { backend: 'backend.wasm', ui: null };
  const context = vi.spyOn(pluginsApi, 'context').mockResolvedValue();
  const activate = vi.spyOn(pluginsApi, 'activate').mockResolvedValue({ state: 'active' } as never);
  const host = { hostId: 'a', opsSession: null, fileSession: null };
  await Promise.all([p.bind('dev.example', host, 'first'), p.bind('dev.example', host, 'second')]);
  expect(context).toHaveBeenCalledTimes(1);
  expect(activate).toHaveBeenCalledTimes(1);
  expect(p.owns('dev.example', 'second')).toBe(true);
});
