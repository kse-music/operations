import { tr } from '../i18n/messages';
import type { Host, HostGroup } from '../types/hosts';

export function folderAncestors(groups: HostGroup[], id: string | null): string[] {
  const map = new Map(groups.map((group) => [group.id, group]));
  const ancestors: string[] = [];
  while (id !== null && map.has(id) && !ancestors.includes(id)) {
    ancestors.push(id);
    id = map.get(id)!.parentId ?? null;
  }
  return ancestors;
}

export function folderPath(groups: HostGroup[], id: string | null): string {
  return [
    tr('根目录'),
    ...folderAncestors(groups, id)
      .reverse()
      .map((key) => groups.find((g) => g.id === key)!.name),
  ].join(' / ');
}

export interface HostFolderRow {
  id: string | null;
  name: string;
  depth: number;
  count: number;
  hosts: Host[];
}

export function hostFolderRows(
  groups: HostGroup[],
  hosts: Host[],
  collapsed: string[],
  searching: boolean,
  limit: number,
): HostFolderRow[] {
  const children = new Map<string | null, HostGroup[]>();
  for (const group of groups) {
    const parent = group.parentId ?? null;
    const siblings = children.get(parent) ?? [];
    siblings.push(group);
    children.set(parent, siblings);
  }
  const counts = new Map<string | null, number>([[null, hosts.length]]);
  for (const host of hosts)
    for (const id of folderAncestors(groups, host.groupId))
      counts.set(id, (counts.get(id) ?? 0) + 1);
  const byFolder = new Map<string | null, Host[]>();
  for (const host of hosts.slice(0, limit)) {
    const rows = byFolder.get(host.groupId) ?? [];
    rows.push(host);
    byFolder.set(host.groupId, rows);
  }
  const result: HostFolderRow[] = [];
  const stack = [{ id: null as string | null, name: tr('根目录'), depth: 0 }];
  while (stack.length) {
    const row = stack.pop()!;
    result.push({ ...row, count: counts.get(row.id) ?? 0, hosts: byFolder.get(row.id) ?? [] });
    if (!searching && collapsed.includes(row.id ?? 'root')) continue;
    for (const child of [...(children.get(row.id) ?? [])].reverse()) {
      if (searching && !counts.has(child.id)) continue;
      stack.push({ id: child.id, name: child.name, depth: row.depth + 1 });
    }
  }
  return result;
}
