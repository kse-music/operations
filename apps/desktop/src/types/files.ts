export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';
export interface FileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number | null;
  modified: number | null;
  permissions: number | null;
  uid: number | null;
  gid: number | null;
}
export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
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
export type FileTerminalAction = { kind: 'directory' | 'view' | 'tail'; path: string };
export const unfinished = (task: TransferInfo): boolean =>
  ['queued', 'scanning', 'running', 'verifying', 'cancelling'].includes(task.state);
export const taskLabels: Record<string, string> = {
  queued: '排队中',
  scanning: '扫描中',
  running: '传输中',
  verifying: '校验中',
  cancelling: '取消中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
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
export function remoteJoin(parent: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0'))
    throw new Error('名称不能包含 / 或 NUL');
  return `${parent.replace(/\/+$/, '')}/${name}`;
}
