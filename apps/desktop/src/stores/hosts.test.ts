import { afterEach, describe, expect, it, vi } from 'vitest';
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
        return {
          hosts: [],
          groups: [],
          credentials: [],
          pendingSecretDeletions: 0,
          environmentTags: { tags: [], assignments: {} },
        };
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
  it('persists a host name through the existing IPC without authentication input or catalog reload', async () => {
    Reflect.set(window, 'isTauri', true);
    setActivePinia(createPinia());
    const store = useHostsStore();
    const original = {
      ...fixtures[0]!,
      authType: 'password' as const,
      credentialId: 'existing-ref',
    };
    store.catalog = {
      hosts: [original],
      groups: [],
      credentials: [],
      pendingSecretDeletions: 0,
      environmentTags: { tags: [], assignments: {} },
    };
    store.selectedId = original.id;
    store.search = 'prod';
    const invoke = vi.fn((command, args) => {
      expect(command).toBe('host_update');
      expect(args).toEqual({
        id: original.id,
        input: { ...hostInput(original), name: '新名称' },
        authentication: undefined,
      });
      return { ...original, name: '新名称', updatedAt: 'server-time' };
    });
    mockIPC(invoke);
    expect(await store.renameHost(original.id, '新名称')).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(store.catalog.hosts[0]).toEqual({
      ...original,
      name: '新名称',
      updatedAt: 'server-time',
    });
    expect(store.selectedId).toBe(original.id);
    expect(store.search).toBe('prod');
  });
  it('persists folder names through the existing IPC and keeps server metadata', async () => {
    Reflect.set(window, 'isTauri', true);
    setActivePinia(createPinia());
    const store = useHostsStore();
    const original = { id: 'folder', name: '旧名称', parentId: 'parent', sortOrder: 9 };
    store.catalog = {
      hosts: fixtures,
      groups: [original],
      credentials: [],
      pendingSecretDeletions: 0,
      environmentTags: { tags: [], assignments: {} },
    };
    const invoke = vi.fn((command, args) => {
      expect(command).toBe('group_save');
      expect(args).toEqual({
        id: original.id,
        input: { name: '新名称', parentId: 'parent', sortOrder: 9 },
      });
      return { ...original, name: '新名称' };
    });
    mockIPC(invoke);
    expect(await store.renameGroup(original.id, '新名称')).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(store.catalog.groups[0]).toEqual({ ...original, name: '新名称' });
    expect(store.catalog.hosts).toEqual(fixtures);
  });
});
