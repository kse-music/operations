import { tr } from '../i18n/messages';
export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';
export interface FileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number | null;
  modified: number | null;
  permissions: number | null;
  owner?: string | null;
  uid: number | null;
  gid: number | null;
}
export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}
export interface LocalDrive {
  path: string;
  name: string;
}
export interface FileLocation {
  path: string;
  name: string;
  depth?: number;
}
export interface SftpUser {
  username: string;
  serverPath: string;
  password: string | null;
}
export interface FileUserSession {
  session: import('./terminal').TerminalSession;
  listing: DirectoryListing;
}
export type RemoteAction =
  | { kind: 'mkdir'; path: string }
  | { kind: 'rename'; path: string; destination: string }
  | { kind: 'remove'; paths: string[]; recursive: boolean; confirmed: boolean };
export type ConflictPolicy = 'fail' | 'skip' | 'rename' | 'overwrite';
export type Direction = 'upload' | 'download';
export interface TransferInput {
  sessionId: string;
  direction: Direction;
  sources: string[];
  destination: string;
  conflict: ConflictPolicy;
  confirmOverwrite: boolean;
}
export interface TransferInfo {
  id: string;
  hostId: string;
  sessionId: string;
  direction: Direction;
  state: string;
  sources: string[];
  destination: string;
  totalBytes: number;
  transferredBytes: number;
  remainingBytes: number;
  bytesPerSecond: number;
  filesTotal: number;
  filesDone: number;
  skipped: number;
  message: string | null;
  recoveryPaths: string[];
}
export interface TextDocument {
  token: string;
  sessionId: string;
  path: string;
  content: string;
  sha256: string;
  permissions: number | null;
  uid: number | null;
  gid: number | null;
  atomicSave: boolean;
}
export interface SaveResult {
  document: TextDocument | null;
  recoveryPath: string | null;
  message: string | null;
}
export interface ExternalDocument {
  token: string;
  sessionId: string;
  path: string;
  localPath: string;
  transferId: string;
  atomicSave: boolean;
  ready: boolean;
}
export type FileTerminalAction = { kind: 'directory' | 'view' | 'tail'; path: string };
export const unfinished = (task: TransferInfo): boolean =>
  ['queued', 'scanning', 'running', 'verifying', 'cancelling'].includes(task.state);
export const taskLabels: Record<string, string> = {
  get queued() {
    return tr('排队中');
  },
  get scanning() {
    return tr('扫描中');
  },
  get running() {
    return tr('传输中');
  },
  get verifying() {
    return tr('校验中');
  },
  get cancelling() {
    return tr('取消中');
  },
  get completed() {
    return tr('已完成');
  },
  get failed() {
    return tr('失败');
  },
  get cancelled() {
    return tr('已取消');
  },
};
export function bytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let index = -1;
  do {
    value /= 1024;
    index++;
  } while (value >= 1024 && index < 3);
  return `${value.toFixed(1)} ${units[index]}`;
}
export function permissionText(value: number | null): string {
  if (value === null) return '—';
  const characters = [
    value & 0o400 ? 'r' : '-',
    value & 0o200 ? 'w' : '-',
    value & 0o100 ? 'x' : '-',
    value & 0o040 ? 'r' : '-',
    value & 0o020 ? 'w' : '-',
    value & 0o010 ? 'x' : '-',
    value & 0o004 ? 'r' : '-',
    value & 0o002 ? 'w' : '-',
    value & 0o001 ? 'x' : '-',
  ];
  if (value & 0o4000) characters[2] = value & 0o100 ? 's' : 'S';
  if (value & 0o2000) characters[5] = value & 0o010 ? 's' : 'S';
  if (value & 0o1000) characters[8] = value & 0o001 ? 't' : 'T';
  return characters.join('');
}
export function remoteJoin(parent: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0'))
    throw new Error(tr('名称不能包含 / 或 NUL'));
  return `${parent.replace(/\/+$/, '')}/${name}`;
}
export function remoteDirectoryLocations(path: string): FileLocation[] {
  if (!path.startsWith('/')) return [];
  const parts = path.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return [];
  const items: FileLocation[] = [{ path: '/', name: '/ <root>', depth: 0 }];
  let parent = '';
  for (const [index, name] of parts.entries()) {
    parent += `/${name}`;
    items.push({ path: parent, name, depth: index + 1 });
  }
  return items;
}
