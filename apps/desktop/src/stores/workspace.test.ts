import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, getActivePinia, setActivePinia } from 'pinia';
import { useWorkspaceStore } from './workspace';
import { useTerminalsStore } from './terminals';
import { terminalApi } from '../services/terminal';
import { usePluginsStore } from './plugins';
import { toolPluginState } from '../services/system-plugins.fixture';
import { pluginsApi } from '../services/plugins';
import type { Host } from '../types/hosts';
import { filesApi } from '../services/files';
import { useFilesStore } from './files';

beforeEach(async () => {
  setActivePinia(createPinia());
  Object.assign(usePluginsStore(), toolPluginState());
  vi.spyOn(pluginsApi, 'reset').mockResolvedValue();
  vi.spyOn(pluginsApi, 'scopeVisibility').mockResolvedValue();
  vi.spyOn(pluginsApi, 'closeScope').mockResolvedValue();
  vi.spyOn(pluginsApi, 'cancelScope').mockResolvedValue();
  vi.spyOn(filesApi, 'tasks').mockResolvedValue([]);
  vi.spyOn(filesApi, 'connections').mockResolvedValue([]);
  vi.spyOn(filesApi, 'clearTransfers').mockResolvedValue();
});
afterEach(() => disposePinia(getActivePinia()!));

it('protects hidden plugin drafts before closing a host and clears them only after an accepted close', async () => {
  const workspace = useWorkspaceStore(),
    plugins = usePluginsStore(),
    files = useFilesStore();
  await workspace.openPlugin('cn.hiboot.plugins.docker', 'server', 'a');
  const page = workspace.pluginPages[0]!;
  plugins.setDraftDirty(page.key, page.pluginId!, true);
  workspace.navigate('terminals', 'a');
  const prepare = vi.spyOn(files, 'prepareHostClose').mockResolvedValue(true);
  const ask = vi.spyOn(plugins, 'ask').mockResolvedValue(false);
  await workspace.close('host:a');
  expect(workspace.tabs).toHaveLength(1);
  expect(plugins.dirty).toBe(true);
  expect(prepare).not.toHaveBeenCalled();
  ask.mockResolvedValue(true);
  await workspace.close('host:a');
  expect(workspace.tabs).toHaveLength(0);
  expect(plugins.dirty).toBe(false);
});

it('keeps the host and terminal intact when transfer cancellation is declined', async () => {
  const workspace = useWorkspaceStore(),
    files = useFilesStore(),
    terminals = useTerminalsStore();
  workspace.navigate('terminals', 'a');
  terminals.open({ id: 'a', name: 'A' } as Host);
  terminals.update(terminals.focused, { sessionId: 'shell-a' });
  const close = vi.spyOn(terminalApi, 'close').mockResolvedValue();
  vi.spyOn(files, 'prepareHostClose').mockResolvedValue(false);
  await workspace.close('host:a');
  expect(workspace.current?.hostId).toBe('a');
  expect(terminals.tabs).toHaveLength(1);
  expect(close).not.toHaveBeenCalled();
  expect(filesApi.clearTransfers).not.toHaveBeenCalled();
  expect(files.closingHosts).toEqual([]);
});

it('clears history only after a successful host close and reopens with no old records', async () => {
  const workspace = useWorkspaceStore(),
    files = useFilesStore();
  workspace.navigate('files', 'a');
  vi.spyOn(files, 'prepareHostClose').mockResolvedValue(true);
  vi.spyOn(filesApi, 'clearTransfers').mockRejectedValueOnce({ message: 'cleanup failed' });
  await workspace.close('host:a');
  expect(workspace.current?.hostId).toBe('a');
  expect(files.error).toBe('cleanup failed');
  await workspace.close('host:a');
  expect(workspace.tabs).toEqual([]);
  expect(files.tasks).toEqual([]);
  workspace.navigate('files', 'a');
  expect(files.tasks).toEqual([]);
  expect(files.closingHosts).toEqual([]);
});

it('blocks reopening tools while closing a host and removes completed closes before awaiting the next host', async () => {
  const workspace = useWorkspaceStore(),
    files = useFilesStore();
  workspace.navigate('terminals', 'a');
  workspace.navigate('terminals', 'b');
  let finish!: (accepted: boolean) => void;
  vi.spyOn(files, 'prepareHostClose')
    .mockResolvedValueOnce(true)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const pending = workspace.close('host:a', 'all');
  await vi.waitFor(() => expect(files.prepareHostClose).toHaveBeenCalledTimes(2));
  expect(workspace.tabs.map((tab) => tab.hostId)).toEqual(['b']);
  workspace.navigate('files', 'b');
  await workspace.openPlugin('cn.hiboot.plugins.docker', 'server', 'b');
  expect(workspace.current?.view).toBe('terminals');
  expect(workspace.pluginPages).toEqual([]);
  workspace.navigate('terminals', 'a');
  finish(false);
  await pending;
  expect(workspace.tabs.map((tab) => tab.hostId)).toEqual(['b', 'a']);
  expect(files.closingHosts).toEqual([]);
});

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
  await w.openPlugin('cn.hiboot.plugins.docker', 'images', 'a');
  expect(w.active).toBe('host:a');
  expect(w.tabs.filter((tab) => tab.hostId === 'a')).toHaveLength(1);
  w.selectHost('b');
  expect(w.current).toMatchObject({ view: 'files', hostId: 'b' });
  w.selectHost('a');
  expect(w.current).toMatchObject({ view: 'extension', pluginId: 'cn.hiboot.plugins.docker' });
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
  void workspace.openPlugin('cn.hiboot.plugins.assistant', 'assistant', '');
  workspace.navigate('plugins');
  return workspace;
}

it.each([
  [
    'current',
    ['host:', 'extension:cn.hiboot.plugins.assistant:assistant:'],
    'extension:cn.hiboot.plugins.assistant:assistant:',
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

it('closes all workspaces to the right and preserves the active tab', async () => {
  const workspace = openTabs();
  workspace.activate('host:');
  await workspace.close('host:', 'right');
  expect(workspace.active).toBe('host:');
  expect(workspace.hostId).toBe('');
  expect(workspace.tabs.map((tab) => tab.key)).toEqual(['host:']);
});

it('keeps adjacent-tab selection for closing the current tab', async () => {
  const workspace = openTabs();
  workspace.activate('host:a');
  await workspace.close('host:a');
  expect(workspace.active).toBe('extension:cn.hiboot.plugins.assistant:assistant:');
  expect(workspace.tabs.some((tab) => tab.view === 'plugins')).toBe(false);
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

it('opens settings categories without changing the current host or creating tabs', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  const current = workspace.current;
  for (const view of [
    'settings',
    'settingsTerminal',
    'settingsShortcuts',
    'settingsStorage',
    'models',
    'plugins',
    'about',
  ] as const) {
    workspace.navigate(view);
    expect(workspace.settingsView).toBe(view);
    expect(workspace.current).toBe(current);
    expect(workspace.hostId).toBe('a');
    expect(workspace.tabs).toEqual([current]);
  }
});

it('retains the settings window when its close guard declines and closes only after approval', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  workspace.navigate('settings');
  const guard = vi.fn(async () => false);
  workspace.settingsCloseGuard = guard;
  await workspace.closeSettings();
  expect(guard).toHaveBeenCalledOnce();
  expect(workspace.settingsView).toBe('settings');
  expect(workspace.current?.key).toBe('host:a');
  guard.mockResolvedValue(true);
  await workspace.closeSettings();
  expect(workspace.settingsView).toBeNull();
  expect(workspace.current?.key).toBe('host:a');
});

it.each(['right', 'others', 'all'] as const)(
  'keeps settings independent from the %s workspace close range',
  async (scope) => {
    const workspace = useWorkspaceStore();
    workspace.navigate('files', 'a');
    workspace.navigate('plugins');
    workspace.navigate('settingsTerminal');
    const guard = vi.fn(async () => false);
    workspace.settingsCloseGuard = guard;
    await workspace.close('host:a', scope);
    expect(guard).not.toHaveBeenCalled();
    expect(workspace.settingsView).toBe('settingsTerminal');
    expect(workspace.tabs.map((tab) => tab.key)).toEqual(scope === 'all' ? [] : ['host:a']);
  },
);

it('opens settings from welcome without creating or activating a host workspace', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('about');
  expect(workspace.tabs).toEqual([]);
  expect(workspace.current).toBeUndefined();
  expect(workspace.settingsView).toBe('about');
  await workspace.closeSettings();
  expect(workspace.settingsView).toBeNull();
});

it('shows the host controls for a plugin without a settings contribution in the existing workspace', () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  workspace.openPluginSettings('cn.hiboot.plugins.docker');
  workspace.openPluginSettings('cn.hiboot.plugins.docker');
  expect(workspace.pluginConfiguration).toEqual({
    pluginId: 'cn.hiboot.plugins.docker',
    contributionId: null,
  });
  expect(workspace.current?.view).toBe('files');
  expect(workspace.hostId).toBe('a');
  expect(workspace.tabs).toHaveLength(1);
});

it('opens an authorized settings contribution without navigating or creating a workspace tab', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  const active = workspace.current;
  await workspace.openPlugin('cn.hiboot.plugins.assistant', 'settings', 'a');
  expect(workspace.pluginConfiguration).toEqual({
    pluginId: 'cn.hiboot.plugins.assistant',
    contributionId: 'settings',
  });
  expect(workspace.current).toBe(active);
  expect(workspace.hostId).toBe('a');
  expect(workspace.tabs).toEqual([active]);
  expect(workspace.pluginPages).toEqual([]);
  expect(workspace.settingsView).toBeNull();
  await workspace.closePluginSettings();
  expect(workspace.pluginConfiguration).toBeUndefined();
  expect(workspace.current).toBe(active);
});

it.each(['save', 'mutation'] as const)(
  'blocks settings navigation and closing during a plugin %s',
  async (operation) => {
    const workspace = useWorkspaceStore(),
      plugins = usePluginsStore();
    workspace.navigate('files', 'a');
    workspace.navigate('plugins');
    workspace.openPluginSettings('cn.hiboot.plugins.assistant');
    const current = workspace.current,
      configuration = workspace.pluginConfiguration;
    const guard = vi.fn(async () => true);
    workspace.settingsCloseGuard = guard;
    if (operation === 'save') workspace.pluginSettingsBusy = true;
    else plugins.busy = true;
    workspace.navigate('models');
    workspace.navigate('plugins');
    await workspace.closeSettings();
    expect(workspace.settingsView).toBe('plugins');
    expect(workspace.pluginConfiguration).toBe(configuration);
    expect(workspace.current).toBe(current);
    expect(guard).not.toHaveBeenCalled();
    workspace.pluginSettingsBusy = false;
    plugins.busy = false;
    workspace.navigate('models');
    expect(workspace.pluginConfiguration).toBeUndefined();
    expect(workspace.settingsView).toBe('models');
    await workspace.closeSettings();
    expect(workspace.settingsView).toBeNull();
    expect(workspace.tabs).toEqual([current]);
  },
);

it.each(['save', 'mutation'] as const)(
  'keeps standalone plugin settings open during a plugin %s',
  async (operation) => {
    const workspace = useWorkspaceStore(),
      plugins = usePluginsStore();
    workspace.navigate('files', 'a');
    workspace.openPluginSettings('cn.hiboot.plugins.assistant');
    const current = workspace.current,
      configuration = workspace.pluginConfiguration;
    const guard = vi.fn(async () => false);
    workspace.settingsCloseGuard = guard;
    if (operation === 'save') workspace.pluginSettingsBusy = true;
    else plugins.busy = true;
    await workspace.closePluginSettings();
    workspace.navigate('models');
    expect(workspace.pluginConfiguration).toBe(configuration);
    expect(workspace.settingsView).toBeNull();
    workspace.pluginSettingsBusy = false;
    plugins.busy = false;
    await workspace.closePluginSettings();
    expect(workspace.pluginConfiguration).toBeUndefined();
    expect(workspace.settingsView).toBeNull();
    expect(workspace.current).toBe(current);
    expect(guard).not.toHaveBeenCalled();
  },
);

it('keeps the current page and settings window when an unrelated inactive tab is closed', async () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('terminals', 'a');
  workspace.navigate('files', 'b');
  workspace.navigate('settings');
  await workspace.close('host:a');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'b' });
  expect(workspace.tabs.map((tab) => tab.key)).toEqual(['host:b']);
});
