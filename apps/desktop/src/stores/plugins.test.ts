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
it('guards dirty close and host switch without closing core terminal sessions', async () => {
  const p = fixture(),
    w = useWorkspaceStore(),
    t = useTerminalsStore();
  const context = vi.spyOn(pluginsApi, 'context').mockResolvedValue();
  t.open(null);
  await w.openPlugin('dev.example', 'host', 'a');
  expect(w.module).toBe('plugins');
  const key = w.active;
  p.drafts[key] = { values: { content: 'edits' }, output: null, dirty: true, revision: 'r1' };
  const declined = w.openPlugin('dev.example', 'host', 'b');
  expect(p.prompt).not.toBeNull();
  p.decide(false);
  await declined;
  expect(w.current?.hostId).toBe('a');
  expect(context).not.toHaveBeenCalled();
  const accepted = w.openPlugin('dev.example', 'host', 'b');
  expect(p.prompt).not.toBeNull();
  p.decide(true);
  await accepted;
  expect(w.current?.hostId).toBe('b');
  expect(t.tabs).toHaveLength(1);
  expect(p.drafts[key]).toBeUndefined();
  expect(context).toHaveBeenCalledWith('dev.example', null);
  w.navigate('plugins');
  expect(w.module).toBe('system');
  w.activate(w.tabs.find((tab) => tab.pluginId === 'dev.example')!.key);
  expect(w.module).toBe('plugins');
  expect(w.current?.hostId).toBe('b');
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
