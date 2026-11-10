import { invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type { SaveResult, TextDocument } from '../types/files';
import type { Theme } from '../types/ipc';
import type { InterfaceFontSize } from '../types/preferences';

export type EditorDocument = Pick<TextDocument, 'token' | 'sessionId' | 'path'>;
export interface EditorStatus {
  document: EditorDocument | null;
  dirty: boolean;
}
export interface EditorBootstrap {
  document: TextDocument;
  theme: Theme;
  interfaceFontSize: InterfaceFontSize;
}
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  ensureDesktop();
  return invoke(command, args);
}
// The backend binds the caller's native window to its document. This API never
// accepts another document token, remote path, or SFTP connection from the editor.
export const editorApi = {
  load: () => call<EditorBootstrap>('editor_load'),
  dirty: (dirty: boolean) => call<void>('editor_dirty', { dirty }),
  save: (content: string) => call<SaveResult>('editor_save', { content }),
  reload: (discard: boolean) => call<TextDocument>('editor_reload', { discard }),
  close: (discard: boolean) => call<void>('editor_close', { discard }),
};
