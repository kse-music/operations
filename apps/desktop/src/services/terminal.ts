import { Channel, invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type {
  LocalTerminalSession,
  TerminalEvent,
  TerminalSession,
  TerminalSize,
  TerminalUploadSelection,
  TerminalDropSelection,
  TerminalDropPrepared,
} from '../types/terminal';
import type { ForwardInfo, ForwardInput } from '../types/connection';

export const terminalApi = {
  openLink: (url: string): Promise<void> => {
    ensureDesktop();
    return invoke('terminal_open_link', { url });
  },
  claimDrop: (id: string, grant: string): Promise<TerminalDropSelection> =>
    invoke('terminal_upload_claim_drop', { id, grant }),
  prepareDrop: (id: string, token: string): Promise<TerminalDropPrepared> =>
    invoke('terminal_upload_prepare_drop', { id, token, confirmed: true }),
  uploadPick: (id: string): Promise<TerminalUploadSelection> => {
    ensureDesktop();
    return invoke('terminal_upload_pick', { id });
  },
  uploadRead: (id: string, token: string, index: number, offset: number): Promise<number[]> =>
    invoke('terminal_upload_read', { id, token, index, offset }),
  uploadRelease: (id: string, token: string): Promise<void> =>
    invoke('terminal_upload_release', { id, token }),
  openLocal(
    size: TerminalSize,
    receive: (event: TerminalEvent) => void,
    elevated = false,
  ): Promise<LocalTerminalSession> {
    ensureDesktop();
    const events = new Channel<TerminalEvent>();
    events.onmessage = receive;
    return invoke(elevated ? 'terminal_local_open_elevated' : 'terminal_local_open', {
      size,
      events,
    });
  },
  forwardStart: (id: string, input: ForwardInput): Promise<ForwardInfo> =>
    invoke('forward_start', { id, input }),
  forwardList: (id: string): Promise<ForwardInfo[]> => invoke('forward_list', { id }),
  forwardStop: (id: string): Promise<void> => invoke('forward_stop', { id }),
  open(
    hostId: string,
    size: TerminalSize,
    receive: (event: TerminalEvent) => void,
  ): Promise<TerminalSession> {
    ensureDesktop();
    const open = async (): Promise<TerminalSession> => {
      for (let attempt = 0; ; attempt++) {
        const events = new Channel<TerminalEvent>();
        events.onmessage = receive;
        try {
          return await invoke<TerminalSession>('terminal_open', { hostId, size, events });
        } catch (error) {
          if (
            attempt >= 5 ||
            typeof error !== 'object' ||
            error === null ||
            !('code' in error) ||
            error.code !== 'BUSY'
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
    };
    return open();
  },
  input: (id: string, data: Uint8Array): Promise<void> =>
    invoke('terminal_input', { id, data: Array.from(data) }),
  resize: (id: string, size: TerminalSize): Promise<void> =>
    invoke('terminal_resize', { id, size: { cols: size.cols, rows: size.rows } }),
  ack: (id: string, sequence: number): Promise<void> => invoke('terminal_ack', { id, sequence }),
  trust: (id: string, accept: boolean): Promise<void> => invoke('terminal_trust', { id, accept }),
  close: (id: string): Promise<void> => invoke('terminal_close', { id }),
  closeHost: (hostId: string): Promise<void> => invoke('terminal_close_host', { hostId }),
};
