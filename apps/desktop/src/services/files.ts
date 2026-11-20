import { Channel, invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type { EditorDocument, EditorStatus } from './editor';
import type { TerminalEvent, TerminalSession, TerminalSize } from '../types/terminal';
import type {
  DirectoryBookmark,
  DirectoryListing,
  LocalDrive,
  LocalRecycle,
  LocalRename,
  FileEntry,
  FileSide,
  PropertyRequest,
  PropertyResult,
  RemoteAction,
  RemoteCopyInput,
  TransferInput,
  TransferInfo,
  ConflictPolicy,
  TextDocument,
  SaveResult,
  SftpUser,
  FileUserSession,
  ExternalDocument,
  FileSearchInput,
  FileSearchEvent,
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
    directory: string,
    receive: (event: TerminalEvent) => void,
  ): Promise<TerminalSession> {
    const events = new Channel<TerminalEvent>();
    events.onmessage = receive;
    return call('file_terminal', { hostId, size, directory, events });
  },
  list: (id: string, path: string) => call<DirectoryListing>('files_list', { id, path }),
  lastDirectory: (hostId: string, side: FileSide) =>
    call<string | null>('files_last_directory', { hostId, side }),
  rememberDirectory: (hostId: string, path: string, side: FileSide) =>
    call<void>('files_remember_directory', { hostId, path, side }),
  bookmarks: (hostId: string) => call<DirectoryBookmark[]>('files_bookmarks', { hostId }),
  addBookmark: (hostId: string, bookmark: DirectoryBookmark) =>
    call<DirectoryBookmark[]>('files_add_bookmark', { hostId, bookmark }),
  removeBookmark: (hostId: string, path: string) =>
    call<DirectoryBookmark[]>('files_remove_bookmark', { hostId, path }),
  search(
    id: string,
    input: FileSearchInput,
    receive: (event: FileSearchEvent) => void,
  ): Promise<void> {
    const events = new Channel<FileSearchEvent>();
    events.onmessage = receive;
    return call('files_search_start', { id, input, events });
  },
  cancelSearch: (id: string, requestId: string) =>
    call<void>('files_search_cancel', { id, requestId }),
  local: (path: string | null) => call<DirectoryListing>('files_local', { path }),
  localRecycle: (input: LocalRecycle) => call<void>('files_local_recycle', { input }),
  localRename: (input: LocalRename) => call<string>('files_local_rename', { input }),
  localDrives: () => call<LocalDrive[]>('files_local_drives'),
  properties: (id: string, path: string) => call<FileEntry>('files_properties', { id, path }),
  localProperties: (path: string) => call<void>('files_local_properties', { path }),
  propertyOperation: (id: string, input: PropertyRequest) =>
    call<PropertyResult>('files_property_operation', { id, input }),
  propertyCancel: (id: string, requestId: string) =>
    call<void>('files_property_cancel', { id, requestId }),
  action: (id: string, action: RemoteAction) => call<void>('files_action', { id, action }),
  remoteCopy: (input: RemoteCopyInput) => call<TransferInfo>('files_remote_copy', { input }),
  close: (id: string, cancel: boolean) => call<void>('files_close', { id, cancel }),
  pick: (kind: 'files' | 'folder') => call<string[]>('files_pick', { kind }),
  dragDownload: (sessionId: string, sources: string[]) =>
    call<void>('files_drag_download', { sessionId, sources }),
  start: (input: TransferInput) => call<TransferInfo>('transfer_start', { input }),
  tasks: () => call<TransferInfo[]>('transfer_list'),
  clearTransfers: (hostId: string) => call<void>('transfer_clear_host', { hostId }),
  cancel: (id: string) => call<void>('transfer_cancel', { id }),
  confirmRestart: (id: string, token: string) =>
    call<void>('confirm_upload_restart', { id, token }),
  retry: (id: string, sessionId: string, conflict: ConflictPolicy, confirmed: boolean) =>
    call<TransferInfo>('transfer_retry', { id, sessionId, conflict, confirmed }),
  read: (id: string, path: string) => call<TextDocument>('text_read', { id, path }),
  openEditor: (id: string, path: string, connectionCaption: string) =>
    call<EditorDocument>('editor_open', { id, path, connectionCaption }),
  createEditor: (id: string, path: string, connectionCaption: string) =>
    call<EditorDocument>('editor_open', { id, path, connectionCaption, create: true }),
  editorStatus: () => call<EditorStatus>('editor_status'),
  openLocal: (path: string) => call<boolean>('files_open_local', { path }),
  externalPrepare: (id: string, path: string) =>
    call<ExternalDocument>('external_prepare', { id, path }),
  externalReady: (token: string) => call<ExternalDocument>('external_ready', { token }),
  externalSave: (token: string, confirmed: boolean) =>
    call<SaveResult>('external_save', { token, confirmed }),
  externalCancel: (token: string) => call<void>('external_cancel', { token }),
  save: (token: string, content: string, confirmReplace: boolean) =>
    call<SaveResult>('text_save', { input: { token, content, confirmReplace } }),
  dirty: (token: string, dirty: boolean) => call<void>('text_dirty', { token, dirty }),
  closeEditor: (token: string, discard: boolean) => call<void>('text_close', { token, discard }),
  exit: (confirmed = false) => call<void>('app_exit_confirm', { confirmed }),
};
