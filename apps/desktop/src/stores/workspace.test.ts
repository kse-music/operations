import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, getActivePinia, setActivePinia } from 'pinia';
import { useWorkspaceStore } from './workspace';
import { useTerminalsStore } from './terminals';
import { terminalApi } from '../services/terminal';
import type { Host } from '../types/hosts';

beforeEach(() => setActivePinia(createPinia()));
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

it('waits for close completion and prevents duplicate close requests for the same workspace', async () => {
  const workspace = useWorkspaceStore(),
    terminals = useTerminalsStore();
  terminals.open(null);
  terminals.update(terminals.focused, { sessionId: 'pending' });
  workspace.navigate('terminals', '');
  let finish: () => void = () => {};
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
  workspace.navigate('batch');
  workspace.navigate('network');
  return workspace;
}

it.each([
  ['current', ['host:', 'batch:', 'network:'], 'network:'],
  ['right', ['host:', 'host:a'], 'host:a'],
  ['others', ['host:a'], 'host:a'],
  ['all', [], ''],
] as const)('closes %s relative to the requested inactive tab', (scope, keys, active) => {
  const workspace = openTabs();
  workspace.close('host:a', scope);
  expect(workspace.tabs.map((tab) => tab.key)).toEqual(keys);
  expect(workspace.active).toBe(active);
  expect(workspace.current?.key ?? '').toBe(active);
  if (active === 'host:a') expect(workspace.hostId).toBe('a');
});

it('preserves an active tab to the left of the closed range', () => {
  const workspace = openTabs();
  workspace.activate('host:');
  workspace.close('host:a', 'right');
  expect(workspace.active).toBe('host:');
  expect(workspace.hostId).toBe('');
  expect(workspace.tabs.map((tab) => tab.key)).toEqual(['host:', 'host:a']);
});

it('keeps adjacent-tab selection for closing the current tab', () => {
  const workspace = openTabs();
  workspace.activate('host:a');
  workspace.close('host:a');
  expect(workspace.active).toBe('batch:');
  workspace.close('network:');
  workspace.close('batch:');
  expect(workspace.active).toBe('host:');
  expect(workspace.hostId).toBe('');
});

it.each(['current', 'right', 'others', 'all'] as const)(
  'ignores a stale target for %s',
  (scope) => {
    const workspace = openTabs();
    const before = JSON.stringify(workspace.$state);
    workspace.close('missing', scope);
    expect(JSON.stringify(workspace.$state)).toBe(before);
  },
);

it('handles empty ranges and closing the last tab without creating replacements', () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  workspace.close('host:a', 'right');
  workspace.close('host:a', 'others');
  expect(workspace.tabs.map((tab) => tab.key)).toEqual(['host:a']);
  workspace.close('host:a', 'all');
  expect(workspace.tabs).toEqual([]);
  expect(workspace.active).toBe('');
  expect(workspace.current).toBeUndefined();
});

it('switches module menus without changing the active page or host context', () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('files', 'a');
  workspace.selectModule('tools');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'a' });
  workspace.navigate('batch');
  workspace.navigate('network');
  workspace.selectModule('assets');
  workspace.navigate('backup');
  workspace.selectModule('system');
  expect(workspace.current?.view).toBe('backup');
  workspace.navigate('settings');
  expect(workspace.current?.view).toBe('settings');
  workspace.selectModule('hosts');
  expect(workspace.current?.view).toBe('settings');
  workspace.selectModule('tools');
  expect(workspace.current?.view).toBe('settings');
  expect(workspace.module).toBe('tools');
  expect(workspace.hostId).toBe('a');
  workspace.selectModule('assets');
  expect(workspace.current?.view).toBe('settings');
  workspace.activate('host:a');
  expect(workspace.module).toBe('hosts');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'a' });
});

it('does not choose another page or create a default when selecting a module after a tab closes', () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('batch');
  workspace.navigate('network');
  workspace.navigate('credentials');
  workspace.close('network:');
  workspace.selectModule('tools');
  expect(workspace.module).toBe('tools');
  expect(workspace.current?.view).toBe('credentials');
  expect(workspace.tabs.some((tab) => tab.view === 'batch')).toBe(true);
  workspace.close('batch:');
  workspace.selectModule('tools');
  expect(workspace.current?.view).toBe('credentials');
  workspace.selectModule('tools');
  expect(workspace.tabs.filter((tab) => tab.view === 'batch')).toHaveLength(0);
  workspace.activate('credentials:');
  expect(workspace.module).toBe('assets');
});

it.each(['hosts', 'tools', 'assets', 'system'] as const)(
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

it('keeps the current page and selected module when an unrelated inactive tab is closed', () => {
  const workspace = useWorkspaceStore();
  workspace.navigate('terminals', 'a');
  workspace.navigate('files', 'b');
  workspace.selectModule('assets');
  workspace.close('host:a');
  expect(workspace.module).toBe('assets');
  expect(workspace.current).toMatchObject({ view: 'files', hostId: 'b' });
  expect(workspace.tabs.map((tab) => tab.key)).toEqual(['host:b']);
});
