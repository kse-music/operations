import { expect, it } from 'vitest';
import { folderAncestors, folderPath, hostFolderRows } from './host-tree';
import { hostInput, type Host, type HostGroup } from '../types/hosts';

const groups: HostGroup[] = [
  { id: 'child', name: '上海', parentId: 'parent', sortOrder: 0 },
  { id: 'parent', name: '生产', parentId: null, sortOrder: 0 },
  { id: 'empty', name: '空文件夹', parentId: 'parent', sortOrder: 0 },
];
const hosts: Host[] = [null, 'child'].map((groupId, index) => ({
  ...hostInput(),
  id: String(index),
  groupId,
  name: `Host ${index}`,
  createdAt: '',
  updatedAt: '',
}));

it('has an empty persistent UI root and nests legacy folders and hosts by their actual parents', () => {
  expect(hostFolderRows([], [], [], false, 200)).toEqual([
    { id: null, name: '根目录', depth: 0, hosts: [], count: 0 },
  ]);
  const rows = hostFolderRows(groups, hosts, [], false, 200);
  expect(rows.map(({ id, depth, count }) => [id, depth, count])).toEqual([
    [null, 0, 2],
    ['parent', 1, 1],
    ['child', 2, 1],
    ['empty', 2, 0],
  ]);
  expect(rows[0]!.hosts[0]!.groupId).toBeNull();
  expect(rows[2]!.hosts[0]!.id).toBe('1');
  expect(folderPath(groups, 'child')).toBe('根目录 / 生产 / 上海');
  expect(folderAncestors(groups, 'child')).toEqual(['child', 'parent']);
});

it('collapses subtrees while search exposes matches with their ancestors and paging bounds hosts', () => {
  expect(hostFolderRows(groups, hosts, ['root'], false, 200).map((row) => row.id)).toEqual([null]);
  expect(hostFolderRows(groups, hosts, ['parent'], false, 200).map((row) => row.id)).toEqual([
    null,
    'parent',
  ]);
  const matches = hostFolderRows(groups, [hosts[1]!], ['root', 'parent'], true, 200);
  expect(matches.map((row) => row.id)).toEqual([null, 'parent', 'child']);
  expect(matches.at(-1)!.hosts).toEqual([hosts[1]]);
  const bounded = hostFolderRows(groups, hosts, [], false, 1);
  expect(bounded.flatMap((row) => row.hosts)).toEqual([hosts[0]]);
  expect(bounded[0]!.count).toBe(2);
});
