import { beforeEach, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useWorkspaceStore } from './workspace';

beforeEach(() => setActivePinia(createPinia()));

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
