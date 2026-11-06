import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { createPinia, setActivePinia } from 'pinia';
import { filterHosts, useHostsStore } from './hosts';
import { hostInput, type Host } from '../types/hosts';
import { hostsApi } from '../services/hosts';

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, 'isTauri');
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});
const fixtures: Host[] = [
  {
    ...hostInput(),
    id: 'a',
    name: '生产',
    hostname: 'prod.example',
    username: 'ops',
    tags: ['Linux'],
    favorite: true,
    createdAt: '2026-01-01',
    updatedAt: '2026-02-02',
  },
  {
    ...hostInput(),
    id: 'b',
    name: '开发',
    hostname: 'dev.example',
    username: 'dev',
    description: '测试备注',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  },
];
describe('host search and mutation boundary', () => {
  it('searches names, addresses and usernames using the fixed default name order', () => {
    for (const query of ['生产', ' PROD.EXAMPLE ', 'OPS'])
      expect(filterHosts(fixtures, query).map((h) => h.id)).toEqual(['a']);
    const named = [
      { ...fixtures[0]!, name: 'B' },
      { ...fixtures[1]!, name: 'A' },
      { ...fixtures[1]!, id: 'c', name: 'A' },
    ];
    expect(filterHosts(named, '').map((h) => h.id)).toEqual(['b', 'c', 'a']);
    expect(named.map((h) => h.id)).toEqual(['a', 'b', 'c']);
  });
  it('ignores legacy tags, notes and favorite status when listing hosts', () => {
    expect(filterHosts(fixtures, 'linux')).toEqual([]);
    expect(filterHosts(fixtures, '备注')).toEqual([]);
    expect(filterHosts(fixtures, '')).toHaveLength(2);
  });
  it('does not pass display-only host fields into create/update payloads', () => {
    expect(hostInput(fixtures[0])).not.toHaveProperty('id');
    expect(hostInput(fixtures[0])).not.toHaveProperty('updatedAt');
  });
  it('searches and sorts unnamed hosts by their displayed address', () => {
    const hosts = ['192.0.2.20', '192.0.2.10'].map((hostname, i) => ({
      ...fixtures[0]!,
      id: String(i),
      name: '',
      hostname,
      port: 2222,
    }));
    expect(filterHosts(hosts, '192.0.2.10:2222').map((h) => h.id)).toEqual(['1']);
    expect(filterHosts(hosts, '').map((h) => h.id)).toEqual(['1', '0']);
  });
  it('keeps the dialog failure observable and does not create a frontend-only host', async () => {
    Reflect.set(window, 'isTauri', true);
    setActivePinia(createPinia());
    mockIPC((command) => {
      if (command === 'host_list')
        return { hosts: [], groups: [], credentials: [], pendingSecretDeletions: 0 };
      throw { code: 'VALIDATION', message: '地址无效' };
    });
    const store = useHostsStore();
    await store.load();
    expect(
      (await store.run(() => hostsApi.create(hostInput(), undefined, 'fixture-test'))).ok,
    ).toBe(false);
    expect(store.catalog?.hosts).toHaveLength(0);
    expect(store.error).toBe('地址无效');
    expect(store.busy).toBe(false);
  });
});
