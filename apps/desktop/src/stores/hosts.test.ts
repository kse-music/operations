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
  it('searches the actual fields, filters tags/favorites, and sorts deterministically', () => {
    expect(filterHosts(fixtures, 'linux', true, 'Linux', 'name').map((h) => h.id)).toEqual(['a']);
    expect(filterHosts(fixtures, '备注', false, '', 'name').map((h) => h.id)).toEqual(['b']);
    expect(filterHosts(fixtures, '', false, '', 'hostname').map((h) => h.id)).toEqual(['b', 'a']);
    expect(filterHosts(fixtures, '', false, '', 'updated').map((h) => h.id)).toEqual(['a', 'b']);
  });
  it('does not pass display-only host fields into create/update payloads', () => {
    expect(hostInput(fixtures[0])).not.toHaveProperty('id');
    expect(hostInput(fixtures[0])).not.toHaveProperty('updatedAt');
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
    expect((await store.run(() => hostsApi.create(hostInput()))).ok).toBe(false);
    expect(store.catalog?.hosts).toHaveLength(0);
    expect(store.error).toBe('地址无效');
    expect(store.busy).toBe(false);
  });
});
