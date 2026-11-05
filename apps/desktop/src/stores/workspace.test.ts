import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, getActivePinia, setActivePinia } from 'pinia';
import { useWorkspaceStore } from './workspace';
import { useTerminalsStore } from './terminals';
import { terminalApi } from '../services/terminal';
import { usePluginsStore } from './plugins';
import { toolPluginState } from '../services/system-plugins.fixture';
import { pluginsApi } from '../services/plugins';
import type { Host } from '../types/hosts';

beforeEach(async () => {
  setActivePinia(createPinia());
  Object.assign(usePluginsStore(), toolPluginState());
  vi.spyOn(pluginsApi, 'context').mockResolvedValue();
});
afterEach(() => disposePinia(getActivePinia()!));

it.each(['', 'target'])(
  'retains workspace %s on partial session close failure and resets numbers only after the last successful close',
  async (hostId) => {
    const workspace = useWorkspaceStore(),
      terminals = useTerminalsStore();
    const host = hostId ? ({ id: hostId, name: 'Target' } as Host) : null;
    terminals.open(host);
    const failed = terminals.tabs[0]!;
    terminals.update(terminals.focused, { sessionId: 'failed' });
    terminals.open(host);
    terminals.update(terminals.focused, { sessionId: 'success' });
    workspace.navigate('terminals', hostId);
    const close = vi.spyOn(terminalApi, 'close').mockResolvedValue();
    close.mockRejectedValueOnce({ message: 'close failed' });
    await workspace.close(workspace.active);
    expect(workspace.current?.hostId).toBe(hostId);
    expect(terminals.tabs).toEqual([failed]);
    expect(terminals.error).toBe('close failed');
    expect(close).toHaveBeenCalledWith('success');
    terminals.open(host);
    expect(terminals.tabs.at(-1)?.sessionNumber).toBe(3);
    await workspace.close(workspace.active);
    expect(workspace.tabs).toHaveLength(0);
    expect(terminals.tabs).toHaveLength(0);
    terminals.open(host);
    expect(terminals.tabs[0]?.sessionNumber).toBe(1);
  },
);

it('keeps host plugins in their device tab across host switches', async () => {
  const w = useWorkspaceStore();
  w.navigate('files', 'b');
  await w.openPlugin('cn.hiboot.plugins.services', 'network', 'a');
  expect(w.active).toBe('host:a');
  expect(w.module).toBe('hosts');
  expect(w.tabs.filter((tab) => tab.hostId === 'a')).toHaveLength(1);
  w.selectHost('b');
  expect(w.current).toMatchObject({ view: 'files', hostId: 'b' });
  w.selectHost('a');
  expect(w.current).toMatchObject({ view: 'extension', pluginId: 'cn.hiboot.plugins.services' });
});

it('waits for close completion and prevents duplicate close requests for the same workspace', async () => {
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  terminals.open(null);
  terminals.update(terminals.focused, { sessionId: 'pending' });
  workspace.navigate('terminals', '');
  let finish: () => void = async () => {};
  const close = vi.spyOn(terminalApi, 'close').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = workspace.close('host:');
  await workspace.close('host:');
  expect(workspace.tabs).toHaveLength(1);
  expect(terminals.tabs).toHaveLength(1);
  expect(close).toHaveBeenCalledOnce();
  finish();
  await pending;
  expect(workspace.tabs).toHaveLength(0);
  expect(terminals.tabs).toHaveLength(0);
});

function openTabs() {
  const workspace = useWorkspaceStore();
  workspace.navigate('terminals', '');
  workspace.navigate('files', 'a');
  workspace.navigate('assistant');
  workspace.navigate('credentials');
  return workspace;
}

it.each([
  [
    'current',
    ['host:', 'extension:cn.hiboot.plugins.assistant:assistant:', 'credentials:'],
    'credentials:',
  ],
  ['right', ['host:', 'host:a'], 'host:a'],
  ['others', ['host:a'], 'host:a'],
  ['all', [], ''],
] as const)('closes %s relative to the requested inactive tab', async (scope, keys, active) => {
  const workspace = openTabs();
  await workspace.close('host:a', scope);
  expect(workspace.tabs.map((tab) => tab.key)).toEqual(keys);
  expect(workspace.active).toBe(active);
  expect(workspace.current?.key ?? '').toBe(active);
  if (active === 'host:a') expect(workspace.hostId).toBe('a');
});

it('preserves an active tab to the left of the closed range', async () => {
  const workspace = openTabs();
  workspace.activate('host:');
  await workspace.close('host:a', 'right');
  expect(workspace.active).toBe('host:');
  expect(workspace.hostId).toBe('');
  expect(workspace.tabs.map((tab) => tab.key)).toEqual(['host:', 'host:a']);
});

it('keeps adjacent-tab selection for closing the current tab', async () => {
  const workspace = openTabs();
  workspace.activate('host:a');
  await workspace.close('host:a');
  expect(workspace.active).toBe('extension:cn.hiboot.plugins.assistant:assistant:');
  await workspace.close('credentials:');
  await workspace.close('extension:cn.hiboot.plugins.assistant:assistant:');
  expect(workspace.active).toBe('host:');
  expect(workspace.hostId).toBe('');
});

it.each(['current', 'right', 'others', 'all'] as const)(
  'ignores a stale target for %s',
  async (scope) => {
    const workspace = openTabs();
    const before = JSON.stringify(workspace.$state);
    await workspace.close('missing', scope);
    expect(JSON.stringify(workspace.$state)).toBe(before);
  },
);

it('handles empty ranges and closing the last tab without creating replacements', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  await workspace.close('host:a', 'right');
  await workspace.close('host:a', 'others');
  expect(workspace.tabs.map((tab) => tab.key)).toEqual(['host:a']);
  await workspace.close('host:a', 'all');
  expect(workspace.tabs).toEqual([]);
  expect(workspace.active).toBe('');
  expect(workspace.current).toBeUndefined();
});

it('switches module menus without changing the active page or host context', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  workspace.selectModule('system');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'a' });
  workspace.navigate('assistant');
  workspace.navigate('credentials');
  workspace.selectModule('assets');
  workspace.navigate('backup');
  workspace.selectModule('system');
  expect(workspace.current?.view).toBe('backup');
  workspace.navigate('settings');
  expect(workspace.current?.view).toBe('settings');
  workspace.selectModule('hosts');
  expect(workspace.current?.view).toBe('settings');
  workspace.selectModule('system');
  expect(workspace.current?.view).toBe('settings');
  expect(workspace.module).toBe('system');
  expect(workspace.hostId).toBe('a');
  workspace.selectModule('assets');
  expect(workspace.current?.view).toBe('settings');
  workspace.activate('host:a');
  expect(workspace.module).toBe('hosts');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'a' });
});

it('does not choose another page or create a default when selecting a module after a tab closes', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('assistant');
  workspace.navigate('credentials');
  workspace.navigate('settings');
  await workspace.close('settings:');
  workspace.selectModule('system');
  expect(workspace.module).toBe('system');
  expect(workspace.current?.view).toBe('credentials');
  expect(workspace.tabs.some((tab) => tab.pluginId === 'cn.hiboot.plugins.assistant')).toBe(true);
  await workspace.close('extension:cn.hiboot.plugins.assistant:assistant:');
  workspace.selectModule('system');
  expect(workspace.current?.view).toBe('credentials');
  workspace.selectModule('system');
  expect(
    workspace.tabs.filter((tab) => tab.pluginId === 'cn.hiboot.plugins.assistant'),
  ).toHaveLength(0);
  workspace.activate('credentials:');
  expect(workspace.module).toBe('assets');
});

it.each(['hosts', 'assets', 'system'] as const)(
  'selects the %s module without opening or selecting any page',
  (id) => {
    const workspace = useWorkspaceStore();
    workspace.selectModule(id);
    workspace.selectModule(id);
    expect(workspace.module).toBe(id);
    expect(workspace.active).toBe('');
    expect(workspace.current).toBeUndefined();
    expect(workspace.tabs).toEqual([]);
  },
);

it('reuses plugin settings under the system module when reactivating from other modules', () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  workspace.openPluginSettings('cn.hiboot.plugins.assistant');
  const settings = workspace.current;
  expect(workspace.module).toBe('system');
  expect(settings).toMatchObject({ view: 'pluginSettings', hostId: '' });
  workspace.selectModule('assets');
  workspace.openPluginSettings('cn.hiboot.plugins.assistant');
  expect(workspace.current).toBe(settings);
  workspace.activate('host:a');
  workspace.activate(settings!.key);
  expect(workspace.module).toBe('system');
  expect(workspace.hostId).toBe('a');
  expect(workspace.tabs.filter((tab) => tab.view === 'pluginSettings')).toHaveLength(1);
});

it('keeps the current page and selected module when an unrelated inactive tab is closed', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('terminals', 'a');
  workspace.navigate('files', 'b');
  workspace.selectModule('assets');
  await workspace.close('host:a');
  expect(workspace.module).toBe('assets');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'b' });
  expect(workspace.tabs.map((tab) => tab.key)).toEqual(['host:b']);
});
