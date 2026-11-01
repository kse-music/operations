import { invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type {
  BackgroundSnapshot,
  BackupPreview,
  RestoreInput,
  RestoreResult,
} from '../types/product';
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  ensureDesktop();
  return invoke(command, args);
}
export const productApi = {
  export: () => call<string>('backup_export'),
  preview: (text: string) => call<BackupPreview>('backup_preview', { text }),
  restore: (input: RestoreInput) => call<RestoreResult>('backup_restore', { input }),
  tasks: () => call<BackgroundSnapshot>('background_tasks'),
};
