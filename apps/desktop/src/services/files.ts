import { Channel, invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type { TerminalEvent, TerminalSession, TerminalSize } from '../types/terminal';
import type {
  DirectoryListing,
  FileEntry,
  RemoteAction,
  TransferInput,
  TransferInfo,
  ConflictPolicy,
  TextDocument,
  SaveResult,
  FileTerminalAction,
  SftpUser,
  FileUserSession,
} from '../types/files';
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  ensureDesktop();
  return invoke(command, args);
}
export const filesApi = {
  switchUser: (id: string, user: SftpUser | null) =>
    call<FileUserSession>('files_switch_user', { id, user }),
  connections: () => call<TerminalSession[]>('files_connections'),
  open(hostId: string, receive: (event: TerminalEvent) => void): Promise<TerminalSession> {
    const events = new Channel<TerminalEvent>();
    events.onmessage = receive;
    return call('files_open', { hostId, events });
  },
  terminal(
    hostId: string,
    size: TerminalSize,
    action: FileTerminalAction,
    receive: (event: TerminalEvent) => void,
  ): Promise<TerminalSession> {
    const events = new Channel<TerminalEvent>();
    events.onmessage = receive;
    return call('file_terminal', { hostId, size, action, events });
  },
  list: (id: string, path: string) => call<DirectoryListing>('files_list', { id, path }),
  local: (path: string | null) => call<DirectoryListing>('files_local', { path }),
  properties: (id: string, path: string) => call<FileEntry>('files_properties', { id, path }),
  action: (id: string, action: RemoteAction) => call<void>('files_action', { id, action }),
  close: (id: string, cancel: boolean) => call<void>('files_close', { id, cancel }),
  pick: (kind: 'files' | 'folder') => call<string[]>('files_pick', { kind }),
  dragDownload: (sessionId: string, sources: string[]) =>
    call<void>('files_drag_download', { sessionId, sources }),
  start: (input: TransferInput) => call<TransferInfo>('transfer_start', { input }),
  tasks: () => call<TransferInfo[]>('transfer_list'),
  clearTransfers: (hostId: string) => call<void>('transfer_clear_host', { hostId }),
  cancel: (id: string) => call<void>('transfer_cancel', { id }),
  retry: (id: string, sessionId: string, conflict: ConflictPolicy, confirmed: boolean) =>
    call<TransferInfo>('transfer_retry', { id, sessionId, conflict, confirmed }),
  read: (id: string, path: string) => call<TextDocument>('text_read', { id, path }),
  save: (token: string, content: string, confirmReplace: boolean) =>
    call<SaveResult>('text_save', { input: { token, content, confirmReplace } }),
  dirty: (token: string, dirty: boolean) => call<void>('text_dirty', { token, dirty }),
  closeEditor: (token: string, discard: boolean) => call<void>('text_close', { token, discard }),
  exit: (confirmed = false) => call<void>('app_exit_confirm', { confirmed }),
};
