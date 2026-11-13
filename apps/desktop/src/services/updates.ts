import { Channel, invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';

export interface UpdateProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}
export interface UpdateStatus extends UpdateProgress {
  supported: boolean;
  phase:
    | 'idle'
    | 'checking'
    | 'upToDate'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'installing'
    | 'error';
  release: { version: string; notes: string } | null;
  error: string | null;
  preferences: {
    version: 1;
    autoCheck: boolean;
    lastAttemptAt: number | null;
    lastCheckedAt: number | null;
  };
}
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  ensureDesktop();
  return invoke(command, args);
}
export const updatesApi = {
  status: () => call<UpdateStatus>('app_update_status'),
  check: (automatic: boolean) => call<UpdateStatus>('app_update_check', { automatic }),
  autoCheck: (enabled: boolean) => call<UpdateStatus>('app_update_auto_check', { enabled }),
  download(receive: (progress: UpdateProgress) => void): Promise<UpdateStatus> {
    const events = new Channel<UpdateProgress>();
    events.onmessage = receive;
    return call('app_update_download', { events });
  },
  cancel: () => call<void>('app_update_cancel'),
  install: () => call<void>('app_update_install', { confirmed: true }),
};
