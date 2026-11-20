import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';

export type FileSide = 'local' | 'remote';
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
export interface PropertyChange {
  expected: FileEntry;
  permissions: number | null;
  uid: number | null;
  gid: number | null;
  recursive: boolean;
  directoryExecute: boolean;
  confirmed: boolean;
}
export type PropertyOperation =
  { kind: 'size' | 'checksum' } | { kind: 'apply'; change: PropertyChange };
export interface PropertyRequest {
  requestId: string;
  path: string;
  operation: PropertyOperation;
}
export interface PropertyResult {
  bytes: number;
  files: number;
  directories: number;
  skippedLinks: number;
  changed: number;
  checksum: string | null;
  cancelled: boolean;
  message: string | null;
}
export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}
export interface DirectoryBookmark {
  name: string;
  path: string;
}
export interface FileSearchInput {
  requestId: string;
  path: string;
  query: string;
  recursive: boolean;
  includeHidden: boolean;
}
export type FileSearchStatus = 'running' | 'completed' | 'cancelled' | 'limited' | 'failed';
export interface FileSearchResult {
  entry: FileEntry;
  parent: string;
}
export interface FileSearchEvent {
  requestId: string;
  status: FileSearchStatus;
  entries: FileSearchResult[];
  issues: { path: string; message: string }[];
  scannedDirectories: number;
  scannedEntries: number;
  skippedDirectories: number;
  currentPath: string | null;
  message: string | null;
}
export type FileSearchOptions = Pick<
  FileSearchInput,
  'path' | 'query' | 'recursive' | 'includeHidden'
>;
export interface FileSearchState extends FileSearchOptions {
  sessionId: string;
  requestId: string;
  status: FileSearchStatus | 'idle' | 'starting' | 'cancelling';
  entries: FileSearchResult[];
  issues: FileSearchEvent['issues'];
  scannedDirectories: number;
  scannedEntries: number;
  skippedDirectories: number;
  currentPath: string | null;
  message: string | null;
}
export const fileSearchActive = (search?: FileSearchState): boolean =>
  !!search && ['starting', 'running', 'cancelling'].includes(search.status);
export interface LocalDrive {
  path: string;
  name: string;
}
export interface LocalRecycle {
  parent: string;
  paths: string[];
  confirmed: boolean;
}
export interface LocalRename {
  parent: string;
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
export interface NewDirectorySettings {
  permissions: number | null;
}
export interface NewDirectoryInput extends NewDirectorySettings {
  name: string;
  remember: boolean;
}
export type RemoteAction =
  | { kind: 'mkdir'; path: string; permissions: number | null }
  | { kind: 'rename'; path: string; destination: string }
  | { kind: 'remove'; paths: string[]; recursive: boolean; confirmed: boolean };
export type ConflictPolicy = 'fail' | 'skip' | 'rename' | 'overwrite';
export interface RemoteCopyInput {
  sessionId: string;
  targetSessionId?: string | null;
  sources: string[];
  destination: string;
  name: string | null;
  conflict: Exclude<ConflictPolicy, 'rename'>;
  confirmed: boolean;
  confirmOverwrite: boolean;
}
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
  restartPrompt?: {
    token: string;
    target: string;
    partialBytes: number;
  } | null;
  resumedBytes?: number;
  id: string;
  hostId: string;
  sessionId: string;
  direction: Direction;
  remoteCopy?: boolean;
  remoteName?: string | null;
  remoteTargetHostId?: string | null;
  remoteTargetSessionId?: string | null;
  state: string;
  sources: string[];
  destination: string;
  totalBytes: number;
  transferredBytes: number;
  remainingBytes: number;
  bytesPerSecond: number;
  elapsedSeconds: number;
  dragExport: boolean;
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
export const unfinished = (task: TransferInfo): boolean =>
  ['queued', 'scanning', 'running', 'verifying', 'awaitingRestart', 'cancelling'].includes(
    task.state,
  );
export const transferUsesHost = (task: TransferInfo, hostId: string): boolean =>
  task.hostId === hostId || task.remoteTargetHostId === hostId;
export const taskLabels: Record<string, string> = {
  get queued() {
    return tr('排队中');
  },
  get awaitingRestart() {
    return tr('等待确认重新上传');
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
export function transferDuration(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0');
  return `${hours}:${minutes}:${String(total % 60).padStart(2, '0')}`;
}
export function transferRemainingTime(task: TransferInfo): string {
  if (task.state === 'completed') return transferDuration(0);
  if (task.state === 'verifying' || (task.state === 'running' && task.remainingBytes === 0))
    return tr('校验中');
  if (task.state === 'running' && task.bytesPerSecond > 0)
    return transferDuration(Math.ceil(task.remainingBytes / task.bytesPerSecond));
  if (['queued', 'scanning', 'running'].includes(task.state)) return tr('估算中');
  return '—';
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

/** Keep the native paths from a confirmed local listing, including Windows verbatim prefixes. */
export function localDirectoryLocations(path: string): FileLocation[] {
  if (path.startsWith('/')) return remoteDirectoryLocations(path);
  const drive = /^(?:\\\\\?\\)?[a-z]:[\\/]/i;
  const share = /^\\\\(?:\?\\UNC\\|(?![.?]\\))[^\\]+\\[^\\]+(?:\\|$)/i;
  const volume = /^\\\\\?\\Volume\{[^}]+\}\\/i;
  const root = drive.exec(path)?.[0] ?? share.exec(path)?.[0] ?? volume.exec(path)?.[0];
  if (!root) return [];
  const locations: FileLocation[] = [{ path: root, name: displayLocalPath(root) }];
  const separator = root.includes('\\') ? '\\' : '/';
  let offset = root.length;
  for (const name of path.slice(offset).split(separator)) {
    if (name === '.' || name === '..') return [];
    offset += name.length;
    if (name) locations.push({ path: path.slice(0, offset), name });
    offset++;
  }
  return locations;
}
